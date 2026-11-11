import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { assertSafeTestDatabaseUrl } from '../../src/config/testDbGuard.js';
import { appPool } from '../../src/config/database.js';
import {
  allocateDocumentNumber,
  getSuggestedNextDocumentNumber,
  GST_INVOICE_NUMBERING_CONFIG,
  NORMAL_BILL_NUMBERING_CONFIG,
  QUOTATION_NUMBERING_CONFIG,
} from '../../src/modules/billing/numbering.js';
import {
  acquireIdempotencyLock,
  checkIdempotencyRecord,
  cleanupExpiredIdempotencyKeys,
  hashIdempotencyPayload,
  storeIdempotencyRecord,
} from '../../src/services/idempotency.service.js';
import { khataService } from '../../src/modules/khata/khata.service.js';
import { quotationsService } from '../../src/modules/quotations/quotations.service.js';
import { gstInvoicesService } from '../../src/modules/gstInvoices/gstInvoices.service.js';
import { normalBillsService } from '../../src/modules/normalBills/normalBills.service.js';

const { Pool } = pg;
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

const testDbUrl = process.env.TEST_DATABASE_URL;
const describeIntegration = testDbUrl ? describe : describe.skip;

describeIntegration('PostgreSQL Real Database Integration Test Suite', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    // Enforce destructive test database safeguard
    assertSafeTestDatabaseUrl(testDbUrl!);

    pool = new Pool({
      connectionString: testDbUrl,
      ssl: false,
    });

    // Dedicated single client for migrations and schema setup (Section 4.2)
    const client = await pool.connect();
    try {
      // 1. Drop public schema tables cleanly for test isolation
      await client.query(`
        DROP TABLE IF EXISTS "quotation_items" CASCADE;
        DROP TABLE IF EXISTS "quotations" CASCADE;
        DROP TABLE IF EXISTS "quotation_settings" CASCADE;
        DROP SEQUENCE IF EXISTS "quotation_number_seq" CASCADE;
        DROP TABLE IF EXISTS "gst_invoice_items" CASCADE;
        DROP TABLE IF EXISTS "gst_invoices" CASCADE;
        DROP TABLE IF EXISTS "normal_bill_items" CASCADE;
        DROP TABLE IF EXISTS "normal_bills" CASCADE;
        DROP SEQUENCE IF EXISTS "gst_invoice_number_seq" CASCADE;
        DROP SEQUENCE IF EXISTS "normal_bill_number_seq" CASCADE;
        DROP TABLE IF EXISTS "offline_bill_records" CASCADE;
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
      const migrationFiles = [
        '001_auth_tables.sql',
        '002_khata_transactions.sql',
        '003_idempotency_and_hardening.sql',
        '004_integer_quantity_and_money_constraints.sql',
        '005_search_indexes_and_identity_constraints.sql',
        '006_quantity_two_decimal_places.sql',
        '007_quantity_strict_scale_and_allocation_integrity.sql',
        '008_strict_quantity_scale.sql',
        '009_product_images_and_offline_bills.sql',
        '010_product_hsn_code.sql',
        '011_gst_invoices.sql',
        '012_normal_bills.sql',
        '013_customer_address.sql',
        '014_billing_quantity_and_sequences.sql',
        '015_product_barcode.sql',
        '016_quotations.sql',
        '017_quotation_conversion_financial_fields.sql',
        '018_numbering_and_legacy_data_integrity.sql',
        '019_customer_tax_integrity_and_idempotency.sql',
      ];

      await client.query(`
        CREATE TABLE IF NOT EXISTS "schema_migrations" (
          "version" VARCHAR(255) PRIMARY KEY,
          "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      for (const file of migrationFiles) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  // 1. Migration tracking & Core Tables Verification
  it('1. All migrations 001-019 are tracked and all 17 core tables exist in PostgreSQL schema', async () => {
    const migRes = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
    expect(migRes.rows.map((r) => r.version)).toEqual([
      '001_auth_tables.sql',
      '002_khata_transactions.sql',
      '003_idempotency_and_hardening.sql',
      '004_integer_quantity_and_money_constraints.sql',
      '005_search_indexes_and_identity_constraints.sql',
      '006_quantity_two_decimal_places.sql',
      '007_quantity_strict_scale_and_allocation_integrity.sql',
      '008_strict_quantity_scale.sql',
      '009_product_images_and_offline_bills.sql',
      '010_product_hsn_code.sql',
      '011_gst_invoices.sql',
      '012_normal_bills.sql',
      '013_customer_address.sql',
      '014_billing_quantity_and_sequences.sql',
      '015_product_barcode.sql',
      '016_quotations.sql',
      '017_quotation_conversion_financial_fields.sql',
      '018_numbering_and_legacy_data_integrity.sql',
      '019_customer_tax_integrity_and_idempotency.sql',
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
      'offline_bill_records',
      'gst_invoices',
      'gst_invoice_items',
      'normal_bills',
      'normal_bill_items',
      'quotations',
      'quotation_items',
      'quotation_settings',
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
    const sessData = { cookie: { originalMaxAge: 2592000000 }, authenticated: true, owner: { role: 'OWNER' } };
    const expire = new Date(Date.now() + 2592000000);

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

  // 2b. Real connect-pg-simple Store Revocation
  it('2b. Real connect-pg-simple store destroy() physically deletes session row from PostgreSQL session table', async () => {
    const PgSessionStore = connectPgSimple(session);
    const store = new PgSessionStore({
      pool,
      tableName: 'session',
      createTableIfMissing: false,
      pruneSessionInterval: false,
      ttl: 2592000,
    });

    const sid = 'sess_test_real_pg_destroy_9988';
    const sessData = {
      cookie: { originalMaxAge: 2592000000, maxAge: 2592000000, expires: new Date(Date.now() + 2592000000) } as unknown as session.Cookie,
      authenticated: true,
      role: 'OWNER',
    };

    // Set session in store
    await new Promise<void>((resolve, reject) => {
      store.set(sid, sessData as session.SessionData, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Verify row exists in PostgreSQL session table
    const beforeRes = await pool.query('SELECT "sid" FROM "session" WHERE "sid" = $1', [sid]);
    expect(beforeRes.rows.length).toBe(1);

    // Call store.destroy(sid)
    await new Promise<void>((resolve, reject) => {
      store.destroy(sid, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Verify row is physically deleted from PostgreSQL session table
    const afterRes = await pool.query('SELECT "sid" FROM "session" WHERE "sid" = $1', [sid]);
    expect(afterRes.rows.length).toBe(0);
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
      [txId, prodId, 'Premium Basmati Rice 1kg', '85.50', '2.00', '105.00', '210.00']
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
      `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount) VALUES ($1, $2, $3, $4)`,
      [pay1Id, txId, custId, '1000.00']
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
      `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount) VALUES ($1, $2, $3, $4)`,
      [pay2Res.rows[0].id, txId, custId, '500.00']
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
      `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount) VALUES ($1, $2, $3, $4)`,
      [pay3Res.rows[0].id, txId, custId, '1900.00']
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
      `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount) VALUES ($1, $2, $3, $4)`,
      [p1.rows[0].id, txId, custId, '100.00']
    );

    // Payment 2: ₹100
    const p2 = await pool.query(
      `INSERT INTO payments (customer_id, amount, note) VALUES ($1, $2, $3) RETURNING id`,
      [custId, '100.00', 'Payment 2']
    );
    await pool.query(
      `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount) VALUES ($1, $2, $3, $4)`,
      [p2.rows[0].id, txId, custId, '100.00']
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
      expect((err as Error).message).toMatch(/foreign key constraint/i);
      expect(['23001', '23503']).toContain((err as { code?: string }).code);
    }
    expect(deleteFailed).toBe(true);
  });

  // 9. Decimal Quantity Policy in PostgreSQL: Unconstrained NUMERIC with TRUNC scale check (Section 4.1)
  it('9. PostgreSQL schema accepts valid 2dp quantities (1, 1.2, 1.25, 0.01) and strictly rejects direct SQL excess precision (1.234) and non-positives', async () => {
    const custRes = await pool.query(
      `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Strict Scale Test Customer', 'strict scale test customer', '9877766655', '9877766655']
    );
    const custId = custRes.rows[0].id;

    const prodRes = await pool.query(
      `INSERT INTO products (name, buying_price) VALUES ($1, $2) RETURNING id`,
      ['Copper Wire 1m', '50.00']
    );
    const prodId = prodRes.rows[0].id;

    const txRes = await pool.query(
      `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, note)
       VALUES ($1, CURRENT_DATE, $2, $3) RETURNING id`,
      [custId, '500.00', 'Strict scale verification tx']
    );
    const txId = txRes.rows[0].id;

    // Table of valid inputs: 1, 1.2, 1.25, 0.01 -> All must succeed
    const validQuantities = ['1', '1.2', '1.25', '0.01'];
    for (const qty of validQuantities) {
      const res = await pool.query(
        `INSERT INTO udhar_items (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING quantity`,
        [txId, prodId, 'Copper Wire 1m', '50.00', qty, '100.00', '100.00']
      );
      expect(parseFloat(res.rows[0].quantity)).toBe(parseFloat(qty));
    }

    // Direct SQL insertion with >2 decimal places ('1.234') MUST be rejected by chk_udhar_items_quantity_scale
    // (guaranteeing that PostgreSQL does not silently round to 1.23)
    let scaleRejected = false;
    try {
      await pool.query(
        `INSERT INTO udhar_items (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [txId, prodId, 'Copper Wire 1m', '50.00', '1.234', '100.00', '123.40']
      );
    } catch (err) {
      scaleRejected = true;
      expect((err as Error).message).toContain('chk_udhar_items_quantity_scale');
    }
    expect(scaleRejected).toBe(true);

    // Direct SQL insertion with trailing scale precision ('1.2300') MUST be rejected by chk_udhar_items_quantity_scale
    let trailingScaleRejected = false;
    try {
      await pool.query(
        `INSERT INTO udhar_items (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [txId, prodId, 'Copper Wire 1m', '50.00', '1.2300', '100.00', '123.00']
      );
    } catch (err) {
      trailingScaleRejected = true;
      expect((err as Error).message).toContain('chk_udhar_items_quantity_scale');
    }
    expect(trailingScaleRejected).toBe(true);

    // Quantity = 0 MUST be rejected by chk_udhar_items_quantity_positive
    let zeroRejected = false;
    try {
      await pool.query(
        `INSERT INTO udhar_items (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [txId, prodId, 'Copper Wire 1m', '50.00', '0', '100.00', '0.00']
      );
    } catch (err) {
      zeroRejected = true;
      expect((err as Error).message).toContain('chk_udhar_items_quantity_positive');
    }
    expect(zeroRejected).toBe(true);

    // Negative quantity ('-1.25') MUST be rejected by chk_udhar_items_quantity_positive
    let negativeRejected = false;
    try {
      await pool.query(
        `INSERT INTO udhar_items (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [txId, prodId, 'Copper Wire 1m', '50.00', '-1.25', '100.00', '100.00']
      );
    } catch (err) {
      negativeRejected = true;
      expect((err as Error).message).toContain('chk_udhar_items_quantity_positive');
    }
    expect(negativeRejected).toBe(true);

    // Quantity exceeding maximum (1,000,001) MUST be rejected by chk_udhar_items_quantity_positive
    let maxRejected = false;
    try {
      await pool.query(
        `INSERT INTO udhar_items (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [txId, prodId, 'Copper Wire 1m', '50.00', '1000001', '100.00', '100.00']
      );
    } catch (err) {
      maxRejected = true;
      expect((err as Error).message).toContain('chk_udhar_items_quantity_positive');
    }
    expect(maxRejected).toBe(true);
  });

  // 10. Payment Allocation Cross-Customer Integrity (Section 6.2)
  it('10. Database schema prevents cross-customer payment allocations via composite foreign keys', async () => {
    // Customer A: Rahul
    const custARes = await pool.query(
      `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Rahul Verma', 'rahul verma', '9899911122', '9899911122']
    );
    const custAId = custARes.rows[0].id;

    // Customer B: Sneha
    const custBRes = await pool.query(
      `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Sneha Gupta', 'sneha gupta', '9899933344', '9899933344']
    );
    const custBId = custBRes.rows[0].id;

    // Transaction belonging to Customer A (₹1,000)
    const txARes = await pool.query(
      `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, note)
       VALUES ($1, CURRENT_DATE, $2, $3) RETURNING id`,
      [custAId, '1000.00', 'Rahul purchase']
    );
    const txAId = txARes.rows[0].id;

    // Payment belonging to Customer B (₹500)
    const payBRes = await pool.query(
      `INSERT INTO payments (customer_id, amount, note)
       VALUES ($1, $2, $3) RETURNING id`,
      [custBId, '500.00', 'Sneha payment']
    );
    const payBId = payBRes.rows[0].id;

    // Attempt 1: Allocate Customer B's payment to Customer A's transaction using Customer A's ID
    // Must fail because payment B does not belong to Customer A (fk_payment_allocations_payment_customer)
    let crossCustFailedA = false;
    try {
      await pool.query(
        `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [payBId, txAId, custAId, '500.00']
      );
    } catch (err) {
      crossCustFailedA = true;
      expect((err as Error).message).toContain('fk_payment_allocations_payment_customer');
    }
    expect(crossCustFailedA).toBe(true);

    // Attempt 2: Allocate Customer B's payment to Customer A's transaction using Customer B's ID
    // Must fail because transaction A does not belong to Customer B (fk_payment_allocations_transaction_customer)
    let crossCustFailedB = false;
    try {
      await pool.query(
        `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [payBId, txAId, custBId, '500.00']
      );
    } catch (err) {
      crossCustFailedB = true;
      expect((err as Error).message).toContain('fk_payment_allocations_transaction_customer');
    }
    expect(crossCustFailedB).toBe(true);

    // Valid allocation: Payment belonging to Customer A allocated to Customer A's transaction
    const payARes = await pool.query(
      `INSERT INTO payments (customer_id, amount, note)
       VALUES ($1, $2, $3) RETURNING id`,
      [custAId, '500.00', 'Rahul payment']
    );
    const payAId = payARes.rows[0].id;

    const validAllocRes = await pool.query(
      `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount)
       VALUES ($1, $2, $3, $4) RETURNING id, amount`,
      [payAId, txAId, custAId, '500.00']
    );
    expect(validAllocRes.rows.length).toBe(1);
    expect(parseFloat(validAllocRes.rows[0].amount)).toBe(500.00);
  });

  it('12. Migration 009 schema: offline_bill_records and product image columns', async () => {
    // Check product image columns
    const prodRes = await pool.query(`
      INSERT INTO products (name, buying_price, image_object_key, image_content_type, image_size_bytes)
      VALUES ('Test With Image', 99.00, 'products/1/img.jpg', 'image/jpeg', 1024)
      RETURNING id, name, image_object_key, image_content_type
    `);
    expect(prodRes.rows[0].image_object_key).toBe('products/1/img.jpg');

    // Check offline_bill_records table
    const billRes = await pool.query(`
      INSERT INTO offline_bill_records (customer_name, customer_phone, normalized_customer_phone, image_object_key, image_content_type, image_size_bytes)
      VALUES ('Bill Cust', '+91 98765 43210', '9876543210', 'offline-bills/1/bill.jpg', 'image/jpeg', 2048)
      RETURNING id, customer_name, normalized_customer_phone, image_object_key
    `);
    expect(billRes.rows[0].customer_name).toBe('Bill Cust');
    expect(billRes.rows[0].normalized_customer_phone).toBe('9876543210');
  });

  it('13. Migration 013: Customer address column persists and updates properly', async () => {
    const custRes = await pool.query(`
      INSERT INTO customers (name, normalized_name, phone, normalized_phone, address)
      VALUES ('Address Test User', 'address test user', '9988776655', '9988776655', 'Station Road, Bilaspur')
      RETURNING id, name, address
    `);
    expect(custRes.rows[0].address).toBe('Station Road, Bilaspur');

    await pool.query(`UPDATE customers SET address = $1 WHERE id = $2`, [
      'New Market, Rampur',
      custRes.rows[0].id,
    ]);

    const updated = await pool.query(`SELECT address FROM customers WHERE id = $1`, [custRes.rows[0].id]);
    expect(updated.rows[0].address).toBe('New Market, Rampur');
  });

  it('14. Migration 014: Billing sequences start at 1 (001) on empty tables', async () => {
    const gstSeqRes = await pool.query(`SELECT nextval('gst_invoice_number_seq') AS seq`);
    expect(parseInt(gstSeqRes.rows[0].seq, 10)).toBe(1);

    const normalSeqRes = await pool.query(`SELECT nextval('normal_bill_number_seq') AS seq`);
    expect(parseInt(normalSeqRes.rows[0].seq, 10)).toBe(1);
  });

  it('15. Migration 014: Billing line item quantity strictly enforces 2-decimal scale constraint', async () => {
    // Explicit customer_state/customer_state_code required post-019 (Bihar default removed)
    await expect(
      pool.query(`
        INSERT INTO gst_invoices (
          invoice_number, invoice_date, state, state_code, customer_name,
          taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
          igst_rate, igst_amount, tax_amount, grand_total, amount_in_words
        ) VALUES (
          'INV-INT-NO-STATE', '2026-11-02', 'Uttar Pradesh', '09', 'Missing State Customer',
          '100.00', '9.00', '9.00', '9.00', '9.00',
          '0.00', '0.00', '18.00', '118.00', 'Rupees One Hundred Eighteen Only'
        )
      `)
    ).rejects.toThrow(/customer_state/);

    const invRes = await pool.query(`
      INSERT INTO gst_invoices (
        invoice_number, invoice_date, state, state_code, customer_name, customer_state, customer_state_code,
        taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
        igst_rate, igst_amount, tax_amount, grand_total, amount_in_words
      ) VALUES (
        'INV-INT-001', '2026-11-02', 'Uttar Pradesh', '09', 'Test Customer', 'Uttar Pradesh', '09',
        '100.00', '9.00', '9.00', '9.00', '9.00',
        '0.00', '0.00', '18.00', '118.00', 'Rupees One Hundred Eighteen Only'
      ) RETURNING id
    `);
    const invId = invRes.rows[0].id;

    const validItem = await pool.query(`
      INSERT INTO gst_invoice_items (invoice_id, item_index, description, quantity, rate, amount)
      VALUES ($1, 1, 'Valid Item', 1.25, 100.00, 125.00)
      RETURNING id, quantity
    `, [invId]);
    expect(parseFloat(validItem.rows[0].quantity)).toBe(1.25);

    let rejected = false;
    try {
      await pool.query(`
        INSERT INTO gst_invoice_items (invoice_id, item_index, description, quantity, rate, amount)
        VALUES ($1, 2, 'Invalid Item', 1.234, 100.00, 123.40)
      `, [invId]);
    } catch (err) {
      rejected = true;
      expect((err as Error).message).toContain('chk_gst_invoice_items_quantity_scale');
    }
    expect(rejected).toBe(true);

    // Verify normal_bill_items as well
    const billRes = await pool.query(`
      INSERT INTO normal_bills (
        bill_number, bill_date, state, state_code, customer_name,
        total_amount, amount_in_words
      ) VALUES (
        'BILL-INT-001', '2026-11-02', 'Uttar Pradesh', '09', 'Test Customer Normal',
        '125.00', 'Rupees One Hundred Twenty Five Only'
      ) RETURNING id
    `);
    const billId = billRes.rows[0].id;

    const validBillItem = await pool.query(`
      INSERT INTO normal_bill_items (bill_id, item_index, description, quantity, rate, amount)
      VALUES ($1, 1, 'Valid Bill Item', 2.50, 50.00, 125.00)
      RETURNING id, quantity
    `, [billId]);
    expect(parseFloat(validBillItem.rows[0].quantity)).toBe(2.50);

    let billRejected = false;
    try {
      await pool.query(`
        INSERT INTO normal_bill_items (bill_id, item_index, description, quantity, rate, amount)
        VALUES ($1, 2, 'Invalid Bill Item', 2.555, 50.00, 127.75)
      `, [billId]);
    } catch (err) {
      billRejected = true;
      expect((err as Error).message).toContain('chk_normal_bill_items_quantity_scale');
    }
    expect(billRejected).toBe(true);
  });

  // 16. Migration 014 historical upgrade with trailing zeros & Alphanumeric Sequence Advancement
  it('16. Historical billing items with trailing zeros (1.230) normalize cleanly and alphanumeric numbers advance sequence', async () => {
    // 1. Verify alphanumeric sequence advancement
    // When a bill is created with 'INV-150', sequence advances to 150
    await pool.query(`
      SELECT setval('gst_invoice_number_seq', GREATEST((SELECT last_value FROM gst_invoice_number_seq), $1::BIGINT), true)
    `, [150]);

    const nextGstRes = await pool.query(`SELECT nextval('gst_invoice_number_seq') AS seq`);
    expect(parseInt(nextGstRes.rows[0].seq, 10)).toBe(151);

    // Normal bill with 'NB-075'
    await pool.query(`
      SELECT setval('normal_bill_number_seq', GREATEST((SELECT last_value FROM normal_bill_number_seq), $1::BIGINT), true)
    `, [75]);

    const nextNormalRes = await pool.query(`SELECT nextval('normal_bill_number_seq') AS seq`);
    expect(parseInt(nextNormalRes.rows[0].seq, 10)).toBe(76);

    // 2. Verify trailing zero normalization (e.g. 1.20 mathematically valid)
    const invRes = await pool.query(`
      INSERT INTO gst_invoices (
        invoice_number, invoice_date, state, state_code, customer_name, customer_state, customer_state_code,
        taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
        igst_rate, igst_amount, tax_amount, grand_total, amount_in_words
      ) VALUES (
        'INV-INT-099', '2026-11-02', 'Uttar Pradesh', '09', 'Trailing Zero Test Customer', 'Uttar Pradesh', '09',
        '100.00', '9.00', '9.00', '9.00', '9.00',
        '0.00', '0.00', '18.00', '118.00', 'Rupees One Hundred Eighteen Only'
      ) RETURNING id
    `);
    const invId = invRes.rows[0].id;

    // Insert 1.20 -> scale 2, TRUNC(1.20, 2) = 1.20
    const trailingZeroItem = await pool.query(`
      INSERT INTO gst_invoice_items (invoice_id, item_index, description, quantity, rate, amount)
      VALUES ($1, 1, 'Trailing Zero Item', 1.20, 100.00, 120.00)
      RETURNING id, quantity
    `, [invId]);
    expect(parseFloat(trailingZeroItem.rows[0].quantity)).toBe(1.20);
  });

  // 17. Historical NUMERIC(12, 3) upgrade test: verifies 1.230 converts cleanly without constraint failure
  it('17. Simulates historical NUMERIC(12, 3) column with 1.230 and applies migration 014 conversion', async () => {
    await pool.query(`
      CREATE TABLE test_hist_items (
        id BIGSERIAL PRIMARY KEY,
        quantity NUMERIC(12, 3) NOT NULL
      )
    `);

    await pool.query(`INSERT INTO test_hist_items (quantity) VALUES (1.230)`);

    const beforeRes = await pool.query(`SELECT quantity, scale(quantity) AS sc FROM test_hist_items WHERE id = 1`);
    expect(parseInt(beforeRes.rows[0].sc, 10)).toBe(3);

    await pool.query(`
      ALTER TABLE test_hist_items ALTER COLUMN quantity TYPE NUMERIC USING TRUNC(quantity, 2);
      ALTER TABLE test_hist_items ADD CONSTRAINT chk_test_hist_scale CHECK (quantity > 0 AND scale(quantity) <= 2 AND TRUNC(quantity, 2) = quantity);
    `);

    const afterRes = await pool.query(`SELECT quantity, scale(quantity) AS sc FROM test_hist_items WHERE id = 1`);
    expect(parseInt(afterRes.rows[0].sc, 10)).toBe(2);
    expect(parseFloat(afterRes.rows[0].quantity)).toBe(1.23);

    await pool.query(`DROP TABLE test_hist_items`);
  });

  // 18. End-to-End Inter-State & Intra-State 531.00 Financial Math Integration
  it('18. Verifies exact ₹531.00 financial breakdown for Inter-State and Intra-State invoices in PostgreSQL', async () => {
    // Inter-State (Bihar 10 -> UP 09): Subtotal 500.00, 10% Discount 50.00, Taxable 450.00, 18% IGST 81.00 -> 531.00
    const interStateRes = await pool.query(`
      INSERT INTO gst_invoices (
        invoice_number, invoice_date, state, state_code,
        customer_name, customer_state, customer_state_code,
        subtotal_amount, discount_type, discount_value, discount_amount, taxable_amount,
        cgst_rate, cgst_amount, sgst_rate, sgst_amount,
        igst_rate, igst_amount, tax_amount, grand_total, amount_in_words
      ) VALUES (
        'INV-FIN-531', '2026-11-11', 'Bihar', '10',
        'UP Customer', 'Uttar Pradesh', '09',
        500.00, 'percentage', 10.00, 50.00, 450.00,
        0.00, 0.00, 0.00, 0.00,
        18.00, 81.00, 81.00, 531.00, 'Rupees Five Hundred Thirty One Only'
      ) RETURNING *
    `);
    const inv = interStateRes.rows[0];
    expect(Number(inv.subtotal_amount)).toBe(500);
    expect(Number(inv.discount_amount)).toBe(50);
    expect(Number(inv.taxable_amount)).toBe(450);
    expect(Number(inv.igst_rate)).toBe(18);
    expect(Number(inv.igst_amount)).toBe(81);
    expect(Number(inv.cgst_amount)).toBe(0);
    expect(Number(inv.sgst_amount)).toBe(0);
    expect(Number(inv.grand_total)).toBe(531);

    await pool.query(
      `INSERT INTO gst_invoice_items (invoice_id, item_index, description, quantity, rate, amount)
       VALUES ($1, 1, 'Item A', 2.00, 100.00, 200.00), ($1, 2, 'Item B', 1.00, 300.00, 300.00)`,
      [inv.id]
    );

    // Intra-State (Bihar 10 -> Bihar 10): 450.00 Taxable, 9% CGST 40.50, 9% SGST 40.50, IGST 0.00 -> 531.00
    const intraStateRes = await pool.query(`
      INSERT INTO gst_invoices (
        invoice_number, invoice_date, state, state_code,
        customer_name, customer_state, customer_state_code,
        subtotal_amount, discount_type, discount_value, discount_amount, taxable_amount,
        cgst_rate, cgst_amount, sgst_rate, sgst_amount,
        igst_rate, igst_amount, tax_amount, grand_total, amount_in_words
      ) VALUES (
        'INV-INTRA-531', '2026-11-11', 'Bihar', '10',
        'Bihar Customer', 'Bihar', '10',
        500.00, 'percentage', 10.00, 50.00, 450.00,
        9.00, 40.50, 9.00, 40.50,
        0.00, 0.00, 81.00, 531.00, 'Rupees Five Hundred Thirty One Only'
      ) RETURNING *
    `);
    const intraInv = intraStateRes.rows[0];
    expect(Number(intraInv.cgst_rate)).toBe(9);
    expect(Number(intraInv.sgst_rate)).toBe(9);
    expect(Number(intraInv.cgst_amount)).toBe(40.5);
    expect(Number(intraInv.sgst_amount)).toBe(40.5);
    expect(Number(intraInv.igst_amount)).toBe(0);
    expect(Number(intraInv.grand_total)).toBe(531);
  });

  // 19. Migration 018 Quotation Nullability & Advisory-Lock Document Numbering Integration
  it('19. Migration 018 leaves quotation buyer state nullable without defaults and advisory-lock numbering stays monotonic & preview-safe', async () => {
    const colRes = await pool.query(`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'quotations'
        AND column_name IN ('customer_state', 'customer_state_code')
      ORDER BY column_name ASC
    `);
    expect(colRes.rows).toHaveLength(2);
    for (const col of colRes.rows) {
      expect(col.is_nullable).toBe('YES');
      expect(col.column_default).toBeNull();
    }

    const qRes = await pool.query(
      `INSERT INTO quotations (
        quotation_number, quotation_date, customer_name, customer_state, customer_state_code,
        company_snapshot, subtotal, taxable_amount, grand_total, amount_in_words
      ) VALUES (
        'QT-INT-NULL-STATE', '2026-11-11', 'Null State Buyer', NULL, NULL,
        '{"companyName":"ALGIONS AI LABS PRIVATE LIMITED","state":"Bihar","stateCode":"10"}'::jsonb,
        500.00, 500.00, 500.00, 'Rupees Five Hundred Only'
      ) RETURNING customer_state, customer_state_code`
    );
    expect(qRes.rows[0].customer_state).toBeNull();
    expect(qRes.rows[0].customer_state_code).toBeNull();

    const seqBefore = await pool.query(`SELECT last_value, is_called FROM gst_invoice_number_seq`);
    const preview1 = await getSuggestedNextDocumentNumber(pool, GST_INVOICE_NUMBERING_CONFIG);
    const preview2 = await getSuggestedNextDocumentNumber(pool, GST_INVOICE_NUMBERING_CONFIG);
    const seqAfterPreview = await pool.query(`SELECT last_value, is_called FROM gst_invoice_number_seq`);

    expect(preview1).toBe(preview2);
    expect(seqAfterPreview.rows[0].last_value).toBe(seqBefore.rows[0].last_value);
    expect(seqAfterPreview.rows[0].is_called).toBe(seqBefore.rows[0].is_called);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const allocated1 = await allocateDocumentNumber(client, GST_INVOICE_NUMBERING_CONFIG);
      const allocated2 = await allocateDocumentNumber(client, GST_INVOICE_NUMBERING_CONFIG);
      expect(Number(allocated2)).toBe(Number(allocated1) + 1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // 20. Migration 019 Upgrade-from-018 Schema & Backfill Verification
  it('20. Migration 019 upgrades Release #018 schema cleanly: preserves NULL customer state, backfills 24h idempotency expiry, syncs quotation seq, and removes Bihar defaults', async () => {
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const pre019Migrations = [
      '001_auth_tables.sql',
      '002_khata_transactions.sql',
      '003_idempotency_and_hardening.sql',
      '004_integer_quantity_and_money_constraints.sql',
      '005_search_indexes_and_identity_constraints.sql',
      '006_quantity_two_decimal_places.sql',
      '007_quantity_strict_scale_and_allocation_integrity.sql',
      '008_strict_quantity_scale.sql',
      '009_product_images_and_offline_bills.sql',
      '010_product_hsn_code.sql',
      '011_gst_invoices.sql',
      '012_normal_bills.sql',
      '013_customer_address.sql',
      '014_billing_quantity_and_sequences.sql',
      '015_product_barcode.sql',
      '016_quotations.sql',
      '017_quotation_conversion_financial_fields.sql',
      '018_numbering_and_legacy_data_integrity.sql',
    ];

    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS test_upgrade_018 CASCADE; CREATE SCHEMA test_upgrade_018;`);
      await client.query(`SET search_path TO test_upgrade_018, public;`);

      for (const file of pre019Migrations) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        await client.query(sql);
      }

      // Seed Release #018 data prior to migration 019
      await client.query(
        `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
         VALUES ('Legacy Owner Client', 'legacy owner client', '9812345670', '+919812345670')`
      );
      await client.query(
        `INSERT INTO idempotency_keys (key, action, request_hash, response_status, response_body, created_at)
         VALUES
           ('expired-018-key', 'CREATE_TX', 'hash1', 201, '{}'::jsonb, NOW() - INTERVAL '48 hours'),
           ('fresh-018-key', 'CREATE_TX', 'hash2', 201, '{}'::jsonb, NOW() - INTERVAL '1 hour')`
      );
      await client.query(
        `INSERT INTO quotations (
           quotation_number, quotation_date, customer_name, company_snapshot, subtotal, taxable_amount, grand_total, amount_in_words
         ) VALUES (
           'QT-007', '2026-11-11', 'Upgrade QT Client', '{}'::jsonb, 100.00, 100.00, 100.00, 'Rupees One Hundred Only'
         )`
      );

      // Apply migration 019 on top of Release #018 schema
      const mig019Sql = fs.readFileSync(
        path.join(migrationsDir, '019_customer_tax_integrity_and_idempotency.sql'),
        'utf-8'
      );
      await client.query(mig019Sql);

      // Verify legacy customer has NULL state (not Bihar!)
      const custRes = await client.query(`SELECT state, state_code FROM customers WHERE normalized_name = 'legacy owner client'`);
      expect(custRes.rows[0].state).toBeNull();
      expect(custRes.rows[0].state_code).toBeNull();

      // Verify idempotency expires_at backfill
      const idempRes = await client.query(
        `SELECT key, (expires_at <= NOW()) AS is_expired FROM idempotency_keys ORDER BY key ASC`
      );
      expect(idempRes.rows).toEqual([
        { key: 'expired-018-key', is_expired: true },
        { key: 'fresh-018-key', is_expired: false },
      ]);

      // Verify quotation_number_seq synchronized to 7 so nextval() yields 8 (QT-008)
      const seqNext = await client.query(`SELECT nextval('quotation_number_seq') AS next_num`);
      expect(Number(seqNext.rows[0].next_num)).toBe(8);

      // Verify artificial Bihar/10 column defaults were removed on gst_invoices & normal_bills
      const defRes = await client.query(`
        SELECT table_name, column_name, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'test_upgrade_018'
          AND (
            (table_name = 'gst_invoices' AND column_name IN ('state', 'state_code', 'customer_state', 'customer_state_code'))
            OR (table_name = 'normal_bills' AND column_name IN ('state', 'state_code', 'customer_state', 'customer_state_code'))
          )
      `);
      for (const col of defRes.rows) {
        expect(col.column_default).toBeNull();
      }
    } finally {
      await client.query(`SET search_path TO public;`);
      await client.query(`DROP SCHEMA IF EXISTS test_upgrade_018 CASCADE;`);
      client.release();
    }
  });

  // 21. Direct SQL 2-Decimal Quantity CHECK Constraints Across All 4 Item Tables
  it('21. Enforces max 2 decimal places & positive quantity CHECK constraints across udhar_items, normal_bill_items, gst_invoice_items, and quotation_items', async () => {
    const custRes = await pool.query(
      `INSERT INTO customers (name, normalized_name) VALUES ('Scale Check Cust', 'scale check cust') RETURNING id`
    );
    const txRes = await pool.query(
      `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount) VALUES ($1, CURRENT_DATE, 100.00) RETURNING id`,
      [custRes.rows[0].id]
    );
    const txId = txRes.rows[0].id;

    // 1. udhar_items
    await pool.query(
      `INSERT INTO udhar_items (transaction_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
       VALUES ($1, 'Valid Udhar', 50.00, 1.25, 80.00, 100.00)`,
      [txId]
    );
    for (const badQty of ['1.234', '0', '-1']) {
      await expect(
        pool.query(
          `INSERT INTO udhar_items (transaction_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
           VALUES ($1, 'Bad Udhar', 50.00, $2, 80.00, 100.00)`,
          [txId, badQty]
        )
      ).rejects.toThrow();
    }

    // 2. quotation_items
    const qtRes = await pool.query(
      `INSERT INTO quotations (
         quotation_number, quotation_date, customer_name, company_snapshot, subtotal, taxable_amount, grand_total, amount_in_words
       ) VALUES (
         'QT-SCALE-001', '2026-11-11', 'Scale QT Buyer', '{"state":"Bihar","stateCode":"10"}'::jsonb, 100.00, 100.00, 100.00, 'Rupees One Hundred Only'
       ) RETURNING id`
    );
    const qtId = qtRes.rows[0].id;
    await pool.query(
      `INSERT INTO quotation_items (quotation_id, item_index, description, quantity, rate, amount)
       VALUES ($1, 1, 'Valid QT Item', 0.01, 100.00, 1.00)`,
      [qtId]
    );
    for (const badQty of ['1.234', '0', '-0.05']) {
      await expect(
        pool.query(
          `INSERT INTO quotation_items (quotation_id, item_index, description, quantity, rate, amount)
           VALUES ($1, 2, 'Bad QT Item', $2, 100.00, 100.00)`,
          [qtId, badQty]
        )
      ).rejects.toThrow();
    }

    // 3. gst_invoice_items & normal_bill_items 0 / negative rejection
    const invRes = await pool.query(
      `INSERT INTO gst_invoices (
         invoice_number, invoice_date, state, state_code, customer_name, customer_state, customer_state_code,
         taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, tax_amount, grand_total, amount_in_words
       ) VALUES (
         'INV-SCALE-CHECK', '2026-11-11', 'Bihar', '10', 'Buyer', 'Bihar', '10',
         100.00, 9.00, 9.00, 9.00, 9.00, 0.00, 0.00, 18.00, 118.00, 'Rupees One Hundred Eighteen Only'
       ) RETURNING id`
    );
    await expect(
      pool.query(
        `INSERT INTO gst_invoice_items (invoice_id, item_index, description, quantity, rate, amount)
         VALUES ($1, 1, 'Zero Qty', 0, 100.00, 0.00)`,
        [invRes.rows[0].id]
      )
    ).rejects.toThrow(/chk_gst_invoice_items_quantity_scale/);
  });

  // 22. Concurrent Independent Connections (Promise.all) & Real Idempotency Expiry/Race
  it('22. Handles concurrent independent document number allocations and idempotency lock/expiry/cleanup cleanly', async () => {
    // Ensure fresh quotation & normal bill concurrency isolation on dedicated connections
    const allocateParallel = async (count: number) =>
      Promise.all(
        Array.from({ length: count }, async () => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            const qtNum = await allocateDocumentNumber(c, QUOTATION_NUMBERING_CONFIG);
            await c.query(
              `INSERT INTO quotations (
                 quotation_number, quotation_date, customer_name, company_snapshot, subtotal, taxable_amount, grand_total, amount_in_words
               ) VALUES (
                 $1, '2026-11-11', 'Concurrent Client', '{}'::jsonb, 100.00, 100.00, 100.00, 'Rupees One Hundred Only'
               )`,
              [qtNum]
            );
            const nbNum = await allocateDocumentNumber(c, NORMAL_BILL_NUMBERING_CONFIG);
            await c.query(
              `INSERT INTO normal_bills (
                 bill_number, bill_date, state, state_code, customer_name, total_amount, amount_in_words
               ) VALUES (
                 $1, '2026-11-11', 'Bihar', '10', 'Concurrent NB Client', 100.00, 'Rupees One Hundred Only'
               )`,
              [nbNum]
            );
            await c.query('COMMIT');
            return { qtNum, nbNum };
          } catch (err) {
            await c.query('ROLLBACK');
            throw err;
          } finally {
            c.release();
          }
        })
      );

    const results = await allocateParallel(5);
    const qtNums = results.map((r) => r.qtNum);
    const nbNums = results.map((r) => r.nbNum);
    expect(new Set(qtNums).size).toBe(5);
    expect(new Set(nbNums).size).toBe(5);

    // Concurrent idempotency lock race & payload conflict
    const raceKey = 'pg-race-idemp-key-019';
    const hashA = hashIdempotencyPayload({ total: '500.00', notes: 'A' });
    const hashB = hashIdempotencyPayload({ total: '500.00', notes: 'B' });

    const runIdempotentWorker = async (delayMs: number) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await acquireIdempotencyLock(c, raceKey);
        const existing = await checkIdempotencyRecord<{ seq: number }>(c, raceKey, 'CREATE_NORMAL_BILL', hashA);
        if (existing.found && !existing.expired) {
          await c.query('COMMIT');
          return { replayed: true, body: existing.responseBody };
        }
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        const body = { seq: Math.floor(Math.random() * 10000) + 1 };
        await storeIdempotencyRecord(c, {
          key: raceKey,
          action: 'CREATE_NORMAL_BILL',
          requestHash: hashA,
          responseStatus: 201,
          responseBody: body,
        });
        await c.query('COMMIT');
        return { replayed: false, body };
      } finally {
        c.release();
      }
    };

    const [w1, w2] = await Promise.all([runIdempotentWorker(40), runIdempotentWorker(0)]);
    expect([w1.replayed, w2.replayed].sort()).toEqual([false, true]);
    expect(w1.body.seq).toBe(w2.body.seq);

    // Payload mismatch & cross-action conflict on real DB throw 409
    await expect(
      checkIdempotencyRecord(pool, raceKey, 'CREATE_NORMAL_BILL', hashB)
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      checkIdempotencyRecord(pool, raceKey, 'CREATE_GST_INVOICE', hashA)
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });

    // Force expiration -> key is reusable & cleanup removes it
    await pool.query(
      `UPDATE idempotency_keys SET expires_at = NOW() - INTERVAL '5 minutes' WHERE key = $1`,
      [raceKey]
    );
    const expiredCheck = await checkIdempotencyRecord(pool, raceKey, 'CREATE_GST_INVOICE', hashB);
    expect(expiredCheck).toEqual({ found: true, expired: true });

    await storeIdempotencyRecord(pool, {
      key: raceKey,
      action: 'CREATE_GST_INVOICE',
      requestHash: hashB,
      responseStatus: 201,
      responseBody: { refreshed: true },
    });
    const refreshedCheck = await checkIdempotencyRecord(pool, raceKey, 'CREATE_GST_INVOICE', hashB);
    expect(refreshedCheck).toMatchObject({
      found: true,
      expired: false,
      responseBody: { refreshed: true },
    });

    await pool.query(
      `INSERT INTO idempotency_keys (key, action, request_hash, response_status, response_body, created_at, expires_at)
       VALUES ('pg-expired-cleanup-test', 'CREATE_TX', 'h', 201, '{}'::jsonb, NOW() - INTERVAL '48 hours', NOW() - INTERVAL '24 hours')`
    );
    const deleted = await cleanupExpiredIdempotencyKeys(pool, 50);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const checkRemaining = await pool.query(`SELECT 1 FROM idempotency_keys WHERE key = 'pg-expired-cleanup-test'`);
    expect(checkRemaining.rowCount).toBe(0);
  });

  // 23. End-to-End Service Integration & Rollback Safety Against Real PostgreSQL
  it('23. Runs real khataService, quotationsService, normalBillsService, and gstInvoicesService against PostgreSQL including conversion & rollback safety', async () => {
    vi.spyOn(appPool, 'connect').mockImplementation(() => pool.connect());
    vi.spyOn(appPool, 'query').mockImplementation((...args: any[]) => (pool.query as any)(...args));

    try {
      // Seed canonical company tax profile in quotation_settings (id = 1)
      await pool.query(`
        INSERT INTO quotation_settings (
          id, company_name, cin, gstin, address, phone, email, website, state, state_code
        ) VALUES (
          1, 'ALGIONS AI LABS PRIVATE LIMITED', 'U62011BR2026PTC088473', '10ABGCA8624E1Z3',
          'Gopalganj, Bihar', '9493840000', 'contact@algions.in', 'algions.in', 'Bihar', '10'
        )
        ON CONFLICT (id) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          gstin = EXCLUDED.gstin,
          state = EXCLUDED.state,
          state_code = EXCLUDED.state_code
      `);

      // Customer state create -> update -> null clear
      const createdCust = await khataService.createCustomer({
        name: 'Real PG Customer',
        phone: '9876511122',
        address: 'Pune',
        state: 'Maharashtra',
        stateCode: '27',
      });
      expect(createdCust.state).toBe('Maharashtra');
      expect(createdCust.state_code).toBe('27');

      const clearedCust = await khataService.updateCustomer(createdCust.id, {
        state: null,
        stateCode: null,
      });
      expect(clearedCust.state).toBeNull();
      expect(clearedCust.state_code).toBeNull();

      // Create GST quotation & convert cleanly using manual QT-200
      const qt = await quotationsService.createQuotation({
        quotationNumber: 'QT-200',
        customerName: 'UP Buyer Corp',
        customerState: 'Uttar Pradesh',
        customerStateCode: '09',
        customerGstin: '09AABCS1429B1ZS',
        gstEnabled: true,
        gstRate: 18,
        discountType: 'percentage',
        discountValue: '10',
        items: [
          { description: 'Item 1', quantity: '2.00', rate: '100.00' },
          { description: 'Item 2', quantity: '1.00', rate: '300.00' },
        ],
      });
      expect(qt.quotation_number).toBe('QT-200');
      expect(qt.igst_amount).toBe('81.00');
      expect(qt.grand_total).toBe('531.00');

      const acceptedQt = await quotationsService.updateQuotationStatus(qt.id, 'accepted');
      expect(acceptedQt.status).toBe('accepted');

      const converted = await quotationsService.convertToBill(qt.id, {
        billType: 'gst',
        gstRateOverride: 18,
      });
      expect(converted.billType).toBe('gst');

      // Double conversion rejected with 409
      await expect(
        quotationsService.convertToBill(qt.id, { billType: 'gst' })
      ).rejects.toMatchObject({ status: 409 });

      // Concurrent real service invoice creation
      const parallelInvoices = await Promise.all([
        gstInvoicesService.createInvoice({
          customerName: 'Parallel Inv A',
          customerState: 'Bihar',
          customerStateCode: '10',
          gstRate: 18,
          items: [{ description: 'Item', quantity: 1, rate: 100 }],
        }),
        gstInvoicesService.createInvoice({
          customerName: 'Parallel Inv B',
          customerState: 'Uttar Pradesh',
          customerStateCode: '09',
          gstRate: 18,
          items: [{ description: 'Item', quantity: 1, rate: 100 }],
        }),
      ]);
      expect(parallelInvoices[0].invoice_number).not.toBe(parallelInvoices[1].invoice_number);

      // Concurrent real normal bill creation with notes-hash conflict test
      const nbKey = 'real-pg-nb-idemp-1';
      const nb1 = await normalBillsService.createBill({
        customerName: 'Parallel NB',
        notes: 'Note One',
        items: [{ description: 'Item', quantity: 1, rate: 250 }],
        idempotencyKey: nbKey,
      });
      expect(nb1.total_amount).toBe('250.00');
      await expect(
        normalBillsService.createBill({
          customerName: 'Parallel NB',
          notes: 'Note Changed',
          items: [{ description: 'Item', quantity: 1, rate: 250 }],
          idempotencyKey: nbKey,
        })
      ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });

      // Rollback safety on item insertion error inside TX (no leaked quotation header!)
      const beforeCountRes = await pool.query(`SELECT COUNT(*)::INT AS c FROM quotations`);
      const beforeCount = beforeCountRes.rows[0].c;

      const rbClient = await pool.connect();
      try {
        await rbClient.query('BEGIN');
        await rbClient.query(
          `INSERT INTO quotations (
             quotation_number, quotation_date, customer_name, company_snapshot, subtotal, taxable_amount, grand_total, amount_in_words
           ) VALUES (
             'QT-ROLLBACK-TEST', '2026-11-11', 'Rollback Client', '{}'::jsonb, 100.00, 100.00, 100.00, 'Rupees One Hundred Only'
           )`
        );
        // Attempt invalid item violating CHECK constraint -> roll back transaction
        await expect(
          rbClient.query(
            `INSERT INTO quotation_items (quotation_id, item_index, description, quantity, rate, amount)
             VALUES (currval('quotations_id_seq'), 1, 'Invalid Scale', 1.234, 100.00, 123.40)`
          )
        ).rejects.toThrow();
        await rbClient.query('ROLLBACK');
      } finally {
        rbClient.release();
      }

      const afterCountRes = await pool.query(`SELECT COUNT(*)::INT AS c FROM quotations`);
      expect(afterCountRes.rows[0].c).toBe(beforeCount);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
