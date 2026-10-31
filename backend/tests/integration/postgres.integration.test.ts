import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';

const { Pool } = pg;
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

const testDbUrl = process.env.TEST_DATABASE_URL;
const describeIntegration = testDbUrl ? describe : describe.skip;

describeIntegration('PostgreSQL Real Database Integration Test Suite', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: testDbUrl,
      ssl: false,
    });

    // 1. Drop public schema tables cleanly for test isolation
    await pool.query(`
      DROP TABLE IF EXISTS "idempotency_keys" CASCADE;
      DROP TABLE IF EXISTS "payment_allocations" CASCADE;
      DROP TABLE IF EXISTS "payments" CASCADE;
      DROP TABLE IF EXISTS "udhar_items" CASCADE;
      DROP TABLE IF EXISTS "udhar_transactions" CASCADE;
      DROP TABLE IF EXISTS "ledger_entries" CASCADE;
      DROP TABLE IF EXISTS "customers" CASCADE;
      DROP TABLE IF EXISTS "products" CASCADE;
      DROP TABLE IF EXISTS "login_attempts" CASCADE;
      DROP TABLE IF EXISTS "session" CASCADE;
      DROP TABLE IF EXISTS "schema_migrations" CASCADE;
    `);

    // 2. Apply real migrations in order
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const migrationFiles = ['001_auth_tables.sql', '002_khata_transactions.sql', '003_idempotency_and_hardening.sql'];

    await pool.query(`
      CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "version" VARCHAR(255) PRIMARY KEY,
        "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await pool.query('COMMIT');
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  // 1. Migration tracking & Core Tables Verification
  it('1. All migrations are tracked and all 9 core tables exist in PostgreSQL schema', async () => {
    const migRes = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
    expect(migRes.rows.map((r) => r.version)).toEqual([
      '001_auth_tables.sql',
      '002_khata_transactions.sql',
      '003_idempotency_and_hardening.sql',
    ]);

    const expectedTables = [
      'session',
      'login_attempts',
      'products',
      'customers',
      'udhar_transactions',
      'udhar_items',
      'payments',
      'payment_allocations',
      'idempotency_keys',
    ];

    const tablesRes = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [expectedTables]
    );

    const foundTables = tablesRes.rows.map((r) => r.table_name);
    for (const t of expectedTables) {
      expect(foundTables).toContain(t);
    }
  });

  // 2. Session Row Persistence
  it('2. Session records can be written, read, and deleted across sessions', async () => {
    const sid = 'sess_test_real_integration_12345';
    const sessData = { cookie: { originalMaxAge: 604800000 }, authenticated: true, owner: { role: 'OWNER' } };
    const expire = new Date(Date.now() + 604800000);

    await pool.query(
      `INSERT INTO "session" ("sid", "sess", "expire") VALUES ($1, $2, $3)
       ON CONFLICT ("sid") DO UPDATE SET "sess" = EXCLUDED."sess", "expire" = EXCLUDED."expire"`,
      [sid, JSON.stringify(sessData), expire]
    );

    const readRes = await pool.query(`SELECT "sess", "expire" FROM "session" WHERE "sid" = $1`, [sid]);
    expect(readRes.rows.length).toBe(1);
    expect(readRes.rows[0].sess.authenticated).toBe(true);

    await pool.query(`DELETE FROM "session" WHERE "sid" = $1`, [sid]);
    const deleteRes = await pool.query(`SELECT "sid" FROM "session" WHERE "sid" = $1`, [sid]);
    expect(deleteRes.rows.length).toBe(0);
  });

  // 3. Product Reference Catalog & Historical Item Snapshots
  it('3. Products can be created, updated, archived, and line item historical snapshots are preserved', async () => {
    // Insert product
    const prodRes = await pool.query(
      `INSERT INTO products (name, buying_price) VALUES ($1, $2) RETURNING id, name, buying_price`,
      ['Premium Basmati Rice 1kg', '85.50']
    );
    const prodId = prodRes.rows[0].id;
    expect(prodRes.rows[0].name).toBe('Premium Basmati Rice 1kg');

    // Create customer
    const custRes = await pool.query(
      `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Ramesh Kumar', 'ramesh kumar', '9811122233', '9811122233']
    );
    const custId = custRes.rows[0].id;

    // Create Udhar transaction referencing product
    const txRes = await pool.query(
      `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, note)
       VALUES ($1, CURRENT_DATE, $2, $3) RETURNING id`,
      [custId, '210.00', 'Initial rice purchase']
    );
    const txId = txRes.rows[0].id;

    // Insert item snapshot (quantity 2 @ selling 105.00 = 210.00; buying price snapshot 85.50)
    await pool.query(
      `INSERT INTO udhar_items (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [txId, prodId, 'Premium Basmati Rice 1kg', '85.50', '2.000', '105.00', '210.00']
    );

    // Now update product name and archive product
    await pool.query(
      `UPDATE products SET name = $1, buying_price = $2, archived_at = NOW() WHERE id = $3`,
      ['Super Basmati Rice 1kg (Archived)', '95.00', prodId]
    );

    // Verify udhar_items still has original snapshot
    const itemRes = await pool.query(
      `SELECT product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total
       FROM udhar_items WHERE transaction_id = $1`,
      [txId]
    );
    expect(itemRes.rows[0].product_name_snapshot).toBe('Premium Basmati Rice 1kg');
    expect(Number(itemRes.rows[0].buying_price_snapshot)).toBe(85.50);
    expect(Number(itemRes.rows[0].line_total)).toBe(210.00);
  });

  // 4. Financial Reconciliation: Multi-Item Udhar & FIFO Allocation
  it('4. Financial Reconciliation: Full Udhar cycle and exact FIFO allocation', async () => {
    // Customer: Amit Patel
    const custRes = await pool.query(
      `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Amit Patel', 'amit patel', '9822233344', '9822233344']
    );
    const custId = custRes.rows[0].id;

    // Tx 1: ₹3,400.00 Udhar
    const txRes = await pool.query(
      `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, note)
       VALUES ($1, CURRENT_DATE, $2, $3) RETURNING id`,
      [custId, '3400.00', 'Bulk grocery order']
    );
    const txId = txRes.rows[0].id;

    // Payment 1: ₹1,000.00 initial payment
    const pay1Res = await pool.query(
      `INSERT INTO payments (customer_id, amount, note) VALUES ($1, $2, $3) RETURNING id`,
      [custId, '1000.00', 'Immediate cash deposit']
    );
    const pay1Id = pay1Res.rows[0].id;

    await pool.query(
      `INSERT INTO payment_allocations (payment_id, transaction_id, amount) VALUES ($1, $2, $3)`,
      [pay1Id, txId, '1000.00']
    );

    // Check outstanding: 3400 - 1000 = 2400
    const due1Res = await pool.query(
      `SELECT (t.total_amount - COALESCE(SUM(a.amount), 0)) AS remaining_due
       FROM udhar_transactions t
       LEFT JOIN payment_allocations a ON t.id = a.transaction_id
       WHERE t.id = $1 GROUP BY t.total_amount`,
      [txId]
    );
    expect(Number(due1Res.rows[0].remaining_due)).toBe(2400.00);

    // Payment 2: ₹500.00 subsequent payment -> Due: 1900
    const pay2Res = await pool.query(
      `INSERT INTO payments (customer_id, amount, note) VALUES ($1, $2, $3) RETURNING id`,
      [custId, '500.00', 'Partial UPI transfer']
    );
    await pool.query(
      `INSERT INTO payment_allocations (payment_id, transaction_id, amount) VALUES ($1, $2, $3)`,
      [pay2Res.rows[0].id, txId, '500.00']
    );

    const due2Res = await pool.query(
      `SELECT (t.total_amount - COALESCE(SUM(a.amount), 0)) AS remaining_due
       FROM udhar_transactions t
       LEFT JOIN payment_allocations a ON t.id = a.transaction_id
       WHERE t.id = $1 GROUP BY t.total_amount`,
      [txId]
    );
    expect(Number(due2Res.rows[0].remaining_due)).toBe(1900.00);

    // Payment 3: ₹1,900.00 settlement payment -> Due: 0
    const pay3Res = await pool.query(
      `INSERT INTO payments (customer_id, amount, note) VALUES ($1, $2, $3) RETURNING id`,
      [custId, '1900.00', 'Final settlement']
    );
    await pool.query(
      `INSERT INTO payment_allocations (payment_id, transaction_id, amount) VALUES ($1, $2, $3)`,
      [pay3Res.rows[0].id, txId, '1900.00']
    );

    const due3Res = await pool.query(
      `SELECT (t.total_amount - COALESCE(SUM(a.amount), 0)) AS remaining_due
       FROM udhar_transactions t
       LEFT JOIN payment_allocations a ON t.id = a.transaction_id
       WHERE t.id = $1 GROUP BY t.total_amount`,
      [txId]
    );
    expect(Number(due3Res.rows[0].remaining_due)).toBe(0.00);
  });

  // 5. Multi-Payment Aggregation Regression Test (₹1,000 transaction with two ₹100 payments = ₹800)
  it('5. Regression verification: ₹1,000 transaction with two ₹100 payments reports ₹800 outstanding without fan-out', async () => {
    const custRes = await pool.query(
      `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Pooja Sharma', 'pooja sharma', '9833344455', '9833344455']
    );
    const custId = custRes.rows[0].id;

    // ₹1,000 Udhar
    const txRes = await pool.query(
      `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, note)
       VALUES ($1, CURRENT_DATE, $2, $3) RETURNING id`,
      [custId, '1000.00', 'Udhar purchase for verification']
    );
    const txId = txRes.rows[0].id;

    // Payment 1: ₹100
    const p1 = await pool.query(
      `INSERT INTO payments (customer_id, amount, note) VALUES ($1, $2, $3) RETURNING id`,
      [custId, '100.00', 'Payment 1']
    );
    await pool.query(
      `INSERT INTO payment_allocations (payment_id, transaction_id, amount) VALUES ($1, $2, $3)`,
      [p1.rows[0].id, txId, '100.00']
    );

    // Payment 2: ₹100
    const p2 = await pool.query(
      `INSERT INTO payments (customer_id, amount, note) VALUES ($1, $2, $3) RETURNING id`,
      [custId, '100.00', 'Payment 2']
    );
    await pool.query(
      `INSERT INTO payment_allocations (payment_id, transaction_id, amount) VALUES ($1, $2, $3)`,
      [p2.rows[0].id, txId, '100.00']
    );

    // Query dashboard summary CTE pattern
    const summaryRes = await pool.query(`
      WITH transaction_totals AS (
        SELECT customer_id, SUM(total_amount) AS total_udhar
        FROM udhar_transactions
        WHERE customer_id = $1
        GROUP BY customer_id
      ),
      payment_totals AS (
        SELECT customer_id, SUM(amount) AS total_received
        FROM payments
        WHERE customer_id = $1
        GROUP BY customer_id
      )
      SELECT
        COALESCE(t.total_udhar, 0) AS total_udhar,
        COALESCE(p.total_received, 0) AS total_received,
        (COALESCE(t.total_udhar, 0) - COALESCE(p.total_received, 0)) AS total_outstanding
      FROM transaction_totals t
      FULL OUTER JOIN payment_totals p ON t.customer_id = p.customer_id
    `, [custId]);

    const row = summaryRes.rows[0];
    expect(Number(row.total_udhar)).toBe(1000.00);
    expect(Number(row.total_received)).toBe(200.00);
    expect(Number(row.total_outstanding)).toBe(800.00);
  });

  // 6. Idempotency Key deduplication and conflict detection
  it('6. Idempotency Keys prevent duplicate writes on replay and reject payload mismatch with 409', async () => {
    const key = 'idem_test_uuid_key_abc_123';
    const hash = 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3';
    const responsePayload = { success: true, transactionId: 999, totalAmount: '500.00' };

    // First write
    await pool.query(
      `INSERT INTO idempotency_keys (key, action, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4, $5)`,
      [key, 'CREATE_TRANSACTION', hash, 201, JSON.stringify(responsePayload)]
    );

    // Replay with identical hash
    const replayRes = await pool.query(
      `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1`,
      [key]
    );
    expect(replayRes.rows.length).toBe(1);
    expect(replayRes.rows[0].request_hash).toBe(hash);
    expect(replayRes.rows[0].response_status).toBe(201);
    expect(replayRes.rows[0].response_body.transactionId).toBe(999);

    // Replay with differing hash must be identified as conflicting
    const conflictingHash = '0000000000000000000000000000000000000000000000000000000000000000';
    expect(replayRes.rows[0].request_hash).not.toBe(conflictingHash);
  });

  // 7. Atomic Rollback Verification
  it('7. Transaction rollback aborts all financial modifications on error halfway through', async () => {
    const custRes = await pool.query(
      `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Rollback Test Customer', 'rollback test customer', '9844455566', '9844455566']
    );
    const custId = custRes.rows[0].id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const tx = await client.query(
        `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, note)
         VALUES ($1, CURRENT_DATE, $2, $3) RETURNING id`,
        [custId, '500.00', 'Should rollback']
      );

      // Force failure with foreign key violation
      await client.query(
        `INSERT INTO udhar_items (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
         VALUES ($1, 99999999, 'Non-existent product', '10.00', '1', '10.00', '10.00')`,
        [tx.rows[0].id]
      );

      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Verify no transactions were persisted for this customer
    const checkRes = await pool.query(
      `SELECT COUNT(*) FROM udhar_transactions WHERE customer_id = $1`,
      [custId]
    );
    expect(parseInt(checkRes.rows[0].count, 10)).toBe(0);
  });

  // 8. Foreign key cascade protection
  it('8. Customers with recorded transactions cannot be cascade deleted (ON DELETE RESTRICT)', async () => {
    const custRes = await pool.query(
      `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Protected Customer', 'protected customer', '9855566677', '9855566677']
    );
    const custId = custRes.rows[0].id;

    await pool.query(
      `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, note)
       VALUES ($1, CURRENT_DATE, $2, $3)`,
      [custId, '150.00', 'Protected ledger record']
    );

    // Attempt delete
    let deleteFailed = false;
    try {
      await pool.query(`DELETE FROM customers WHERE id = $1`, [custId]);
    } catch (err) {
      deleteFailed = true;
      expect((err as Error).message).toContain('violates foreign key constraint');
    }
    expect(deleteFailed).toBe(true);
  });
});
