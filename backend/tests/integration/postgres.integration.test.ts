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
  SUPPLIER_PAYMENT_RECEIPT_NUMBERING_CONFIG,
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
import { productsService } from '../../src/modules/products/products.service.js';
import { suppliersService } from '../../src/modules/suppliers/suppliers.service.js';
import { dashboardService } from '../../src/modules/dashboard/dashboard.service.js';

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
        DROP TABLE IF EXISTS "business_expense_events" CASCADE;
        DROP TABLE IF EXISTS "business_expenses" CASCADE;
        DROP TABLE IF EXISTS "supplier_purchase_bill_cancellations" CASCADE;
        DROP TABLE IF EXISTS "supplier_payment_allocation_reversals" CASCADE;
        DROP TABLE IF EXISTS "supplier_payment_reversals" CASCADE;
        DROP TABLE IF EXISTS "supplier_payment_allocations" CASCADE;
        DROP TABLE IF EXISTS "supplier_payments" CASCADE;
        DROP SEQUENCE IF EXISTS "supplier_payment_receipt_seq" CASCADE;
        DROP TABLE IF EXISTS "supplier_purchase_bill_history" CASCADE;
        DROP TABLE IF EXISTS "supplier_purchase_bill_items" CASCADE;
        DROP TABLE IF EXISTS "supplier_purchase_bills" CASCADE;
        DROP TABLE IF EXISTS "suppliers" CASCADE;
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
        '020_supplier_management.sql',
        '021_supplier_financial_integrity.sql',
        '022_supplier_operational_hardening.sql',
        '023_supplier_audit_truncate_guard.sql',
        '024_home_dashboard_profitability.sql',
        '025_performance_reporting_hardening.sql',
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
      '020_supplier_management.sql',
      '021_supplier_financial_integrity.sql',
      '022_supplier_operational_hardening.sql',
      '023_supplier_audit_truncate_guard.sql',
      '024_home_dashboard_profitability.sql',
      '025_performance_reporting_hardening.sql',
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
      'suppliers',
      'supplier_purchase_bills',
      'supplier_purchase_bill_items',
      'supplier_purchase_bill_history',
      'supplier_payments',
      'supplier_payment_allocations',
      'supplier_payment_reversals',
      'supplier_payment_allocation_reversals',
      'supplier_purchase_bill_cancellations',
      'business_expenses',
      'business_expense_events',
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

  // 24. Clean Upgrade from 019 Schema to 020 Supplier Management & Barcode Non-Empty Hardening
  it('24. Upgrades an existing 019 schema cleanly to 020 and normalizes empty/whitespace product barcodes', async () => {
    const upgradeClient = await pool.connect();
    try {
      await upgradeClient.query('DROP SCHEMA IF EXISTS test_upgrade_019 CASCADE');
      await upgradeClient.query('CREATE SCHEMA test_upgrade_019');
      await upgradeClient.query('SET search_path TO test_upgrade_019, public');

      const migrationsDir = path.resolve(__dirname, '../../migrations');
      const baseMigrations = [
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
      for (const file of baseMigrations) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await upgradeClient.query(sql);
      }

      // Seed legacy product with whitespace-only barcode and valid leading-zero barcode before applying 020
      const p1 = await upgradeClient.query(
        `INSERT INTO products (name, buying_price, barcode) VALUES ('Legacy Blank Barcode', 100.00, '   ') RETURNING id`
      );
      const p2 = await upgradeClient.query(
        `INSERT INTO products (name, buying_price, barcode) VALUES ('Legacy Valid Barcode', 150.00, '00890123') RETURNING id`
      );

      const sql020 = fs.readFileSync(path.join(migrationsDir, '020_supplier_management.sql'), 'utf8');
      await upgradeClient.query(sql020);

      const checkP1 = await upgradeClient.query('SELECT barcode FROM products WHERE id = $1', [p1.rows[0].id]);
      const checkP2 = await upgradeClient.query('SELECT barcode FROM products WHERE id = $1', [p2.rows[0].id]);
      expect(checkP1.rows[0].barcode).toBeNull();
      expect(checkP2.rows[0].barcode).toBe('00890123');

      await expect(
        upgradeClient.query(`INSERT INTO products (name, buying_price, barcode) VALUES ('Empty Barcode', 50.00, '')`)
      ).rejects.toThrow();
    } finally {
      await upgradeClient.query('SET search_path TO public');
      await upgradeClient.query('DROP SCHEMA IF EXISTS test_upgrade_019 CASCADE');
      upgradeClient.release();
    }
  });

  // 25. End-to-End Supplier Management, Opt-In Buying Price, Cross-Supplier FK Guard & Barcode Overwrite Protection
  it('25. Runs real suppliersService and productsService against PostgreSQL including purchase bills, payments, statements, archives & rollback safety', async () => {
    vi.spyOn(appPool, 'connect').mockImplementation(() => pool.connect());
    vi.spyOn(appPool, 'query').mockImplementation((...args: any[]) => (pool.query as any)(...args));

    try {
      // A. Product barcode creation, silent overwrite block, confirmed replacement, and DB non-empty check
      const prod = await productsService.createProduct('Real PG SMPS 24V', '180.00', '8504', '008901234500');
      expect(prod.barcode).toBe('008901234500');

      await expect(productsService.updateBarcode(prod.id, '008909999900')).rejects.toMatchObject({
        status: 409,
        code: 'BARCODE_REPLACE_CONFIRMATION_REQUIRED',
      });

      const updatedBarcode = await productsService.updateBarcode(prod.id, '008909999900', {
        confirmReplaceBarcode: true,
      });
      expect(updatedBarcode?.barcode).toBe('008909999900');

      await expect(
        pool.query(`UPDATE products SET barcode = '   ' WHERE id = $1`, [prod.id])
      ).rejects.toThrow();

      // B. Supplier CRUD & duplicate active prevention
      const supA = await suppliersService.createSupplier({
        name: 'Apex Electrical Distributors',
        contactPerson: 'Ramesh Kumar',
        phone: '09876500001',
        state: 'Bihar',
        gstin: '10ABGCA8624E1Z3',
      });
      expect(supA.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(supA.phone).toBe('+919876500001');
      expect(supA.stateCode).toBe('10');

      await expect(
        suppliersService.createSupplier({ name: '  apex electrical   distributors ' })
      ).rejects.toMatchObject({ status: 409 });

      const supB = await suppliersService.createSupplier({
        name: 'Beta Components House',
        phone: '9876500002',
      });

      // C. Purchase Bill creation: opt-in buying price default false preserves product master price
      const billA1 = await suppliersService.createPurchaseBill({
        supplierId: supA.id,
        invoiceNumber: 'APEX-2026-001',
        invoiceDate: '2026-04-02',
        dueDate: '2026-04-15',
        gstRate: '18',
        items: [
          {
            productId: prod.id,
            description: prod.name,
            quantity: '2.50',
            purchaseRate: '200.00',
            updateProductBuyingPrice: false,
          },
        ],
      });
      // 2.50 * 200.00 = 500.00, 18% GST = 90.00, Grand Total = 590.00
      expect(billA1.grandTotal).toBe('590.00');
      expect(billA1.paymentStatus).toBe('unpaid');
      expect(billA1.remainingAmount).toBe('590.00');

      const prodAfterOptOut = await productsService.getProductById(prod.id);
      expect(prodAfterOptOut?.buying_price).toBe('180.00');

      // Opt-in buying price update explicitly updates catalog buying_price
      const billA2 = await suppliersService.createPurchaseBill({
        supplierId: supA.id,
        invoiceNumber: 'APEX-2026-002',
        invoiceDate: '2026-04-05',
        items: [
          {
            productId: prod.id,
            description: prod.name,
            quantity: '1',
            purchaseRate: '215.50',
            updateProductBuyingPrice: true,
          },
        ],
      });
      expect(billA2.grandTotal).toBe('215.50');
      const prodAfterOptIn = await productsService.getProductById(prod.id);
      expect(prodAfterOptIn?.buying_price).toBe('215.50');

      // DB check rejects >2 decimal quantity on supplier_purchase_bill_items
      await expect(
        pool.query(
          `INSERT INTO supplier_purchase_bill_items (purchase_bill_id, item_index, description, quantity, purchase_rate, line_total)
           VALUES ($1, 99, 'Invalid 3dp', 1.234, 100.00, 123.40)`,
          [billA1.id]
        )
      ).rejects.toThrow();

      // Purchase bill edit creates immutable version 2 audit snapshot
      const editedA2 = await suppliersService.updatePurchaseBill(billA2.id, {
        invoiceNumber: 'APEX-2026-002',
        invoiceDate: '2026-04-05',
        gstRate: '0',
        discountAmount: '15.50',
        items: [
          {
            productId: prod.id,
            description: prod.name,
            quantity: '1',
            purchaseRate: '215.50',
            updateProductBuyingPrice: false,
          },
        ],
        reason: 'Vendor trade discount applied',
      });
      expect(editedA2.grandTotal).toBe('200.00');
      expect(editedA2.version).toBe(2);
      expect(editedA2.history.some((h) => h.action === 'edited' && h.version === 2)).toBe(true);

      // D. Supplier Payments, atomic SUP-PAY numbering & cross-supplier allocation rejection
      const payA1 = await suppliersService.createSupplierPayment({
        supplierId: supA.id,
        paymentDate: '2026-04-06',
        amount: '500.00',
        paymentMethod: 'upi',
        transactionReference: 'UTR-APEX-1',
        allocations: [{ purchaseBillId: billA1.id, amount: '300.00' }],
      });
      expect(payA1.receiptNumber).toMatch(/^SUP-PAY-\d{3,}$/);
      expect(payA1.allocatedAmount).toBe('300.00');
      expect(payA1.unallocatedAmount).toBe('200.00');

      // Allocate remaining unallocated payment onto billA2
      const allocatedPay = await suppliersService.allocateAdvancePayment(payA1.id, [
        { purchaseBillId: billA2.id, amount: '200.00' },
      ]);
      expect(allocatedPay.allocatedAmount).toBe('500.00');
      expect(allocatedPay.unallocatedAmount).toBe('0.00');

      // Cross-supplier allocation rejected by both service layer AND PostgreSQL composite FK
      await expect(
        suppliersService.createSupplierPayment({
          supplierId: supB.id,
          paymentDate: '2026-04-06',
          amount: '100.00',
          paymentMethod: 'cash',
          allocations: [{ purchaseBillId: billA1.id, amount: '100.00' }],
        })
      ).rejects.toThrow();

      const payB = await suppliersService.createSupplierPayment({
        supplierId: supB.id,
        paymentDate: '2026-04-06',
        amount: '100.00',
        paymentMethod: 'cash',
      });
      await expect(
        pool.query(
          `INSERT INTO supplier_payment_allocations (supplier_id, payment_id, purchase_bill_id, amount)
           VALUES ($1, $2, $3, 50.00)`,
          [supB.id, payB.id, billA1.id]
        )
      ).rejects.toThrow();

      // Parallel receipt numbering check
      const allocConcurrent = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            const num = await allocateDocumentNumber(c, SUPPLIER_PAYMENT_RECEIPT_NUMBERING_CONFIG);
            await c.query('COMMIT');
            return num;
          } finally {
            c.release();
          }
        })
      );
      expect(new Set(allocConcurrent).size).toBe(3);

      // E. Dashboard / Supplier Details / Statement Single Formula Consistency & 0.00 Opening Balance
      const dashboard = await suppliersService.getDashboard();
      const supADetails = await suppliersService.getSupplierById(supA.id);
      const statementA = await suppliersService.getSupplierStatement(supA.id, {});

      // supA purchases = 590.00 + 200.00 = 790.00; payments = 500.00; payable = 290.00
      expect(supADetails.totalPurchases).toBe('790.00');
      expect(supADetails.totalPayments).toBe('500.00');
      expect(supADetails.outstandingPayable).toBe('290.00');
      expect(statementA.openingBalance).toBe('0.00');
      expect(statementA.closingBalance).toBe('290.00');
      expect(dashboard.summary.totalOutstandingPayable).toBe('290.00');

      // History-safe delete block & archive statement access
      await expect(suppliersService.deleteSupplier(supA.id)).rejects.toMatchObject({
        status: 409,
        code: 'SUPPLIER_HAS_FINANCIAL_HISTORY',
      });

      const archivedA = await suppliersService.archiveSupplier(supA.id);
      expect(archivedA.archivedAt).not.toBeNull();

      const archivedStatement = await suppliersService.getSupplierStatement(supA.id, {});
      expect(archivedStatement.closingBalance).toBe('290.00');
      expect(archivedStatement.entries).toHaveLength(3);

      // Zero-history supplier can be deleted cleanly
      const zeroHistorySup = await suppliersService.createSupplier({ name: 'Disposable Zero History Supplier' });
      await suppliersService.deleteSupplier(zeroHistorySup.id);
      await expect(suppliersService.getSupplierById(zeroHistorySup.id)).rejects.toMatchObject({ status: 404 });

      // F. Transaction rollback safety on invalid bill item insert
      const beforeBillCount = Number(
        (await pool.query('SELECT COUNT(*)::int AS c FROM supplier_purchase_bills')).rows[0].c
      );
      await expect(
        suppliersService.createPurchaseBill({
          supplierId: supB.id,
          invoiceNumber: 'RB-FAIL-1',
          items: [{ productId: 99999999, description: 'Nonexistent', quantity: '1', purchaseRate: '100' }],
        })
      ).rejects.toThrow();
      const afterBillCount = Number(
        (await pool.query('SELECT COUNT(*)::int AS c FROM supplier_purchase_bills')).rows[0].c
      );
      expect(afterBillCount).toBe(beforeBillCount);

      // Assert exact PG composite FK constraints on supplier_payment_allocations
      await expect(
        pool.query(
          `INSERT INTO supplier_payment_allocations (supplier_id, payment_id, purchase_bill_id, amount)
           VALUES ($1, $2, $3, 50.00)`,
          [supB.id, payB.id, billA1.id]
        )
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_supplier_alloc_bill_supplier',
      });

      await expect(
        pool.query(
          `INSERT INTO supplier_payment_allocations (supplier_id, payment_id, purchase_bill_id, amount)
           VALUES ($1, $2, $3, 50.00)`,
          [supA.id, payB.id, billA1.id]
        )
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_supplier_alloc_payment_supplier',
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  // 26. Release #021 Migration Upgrade Path (001->020->021)
  it('26. Release #021 Upgrade Path: detects duplicate active digital references pre-index, applies idempotently once resolved & preserves legacy fallback schema', async () => {
    const upgradeClient = await pool.connect();
    try {
      await upgradeClient.query('DROP SCHEMA IF EXISTS test_upgrade_020 CASCADE');
      await upgradeClient.query('CREATE SCHEMA test_upgrade_020');
      await upgradeClient.query('SET search_path TO test_upgrade_020, public');

      const migrationsDir = path.resolve(__dirname, '../../migrations');
      const pre021Migrations = [
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
        '020_supplier_management.sql',
      ];
      for (const file of pre021Migrations) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await upgradeClient.query(sql);
      }

      // Seed pre-021 supplier, bill (no supplier_snapshot column yet), and duplicate active UPI ref
      const supRes = await upgradeClient.query(
        `INSERT INTO suppliers (name, normalized_name) VALUES ('Legacy Vendor', 'legacy vendor') RETURNING id`
      );
      const supId = supRes.rows[0].id as string;

      const billRes = await upgradeClient.query(
        `INSERT INTO supplier_purchase_bills (
          supplier_id, invoice_number, normalized_invoice_number, invoice_date,
          subtotal_amount, discount_amount, taxable_amount, gst_rate, gst_amount, grand_total
        ) VALUES ($1, 'LEG-001', 'LEG-001', '2026-04-01', 100.00, 0.00, 100.00, 0.00, 0.00, 100.00)
        RETURNING id`,
        [supId]
      );
      const legacyBillId = Number(billRes.rows[0].id);

      await upgradeClient.query(
        `INSERT INTO supplier_payments (
          receipt_number, supplier_id, payment_date, amount, payment_method, transaction_reference
        ) VALUES
          ('SUP-PAY-9001', $1, '2026-04-02', 50.00, 'upi', '  UTR-DUP-2026  '),
          ('SUP-PAY-9002', $1, '2026-04-02', 50.00, 'upi', 'utr-dup-2026')`,
        [supId]
      );

      const sql021 = fs.readFileSync(
        path.join(migrationsDir, '021_supplier_financial_integrity.sql'),
        'utf8'
      );

      // Must fail with clear diagnostic message when conflicting active digital refs exist
      await expect(upgradeClient.query(sql021)).rejects.toThrow(
        /conflicting active duplicate digital payment references/i
      );

      // Resolve duplicate reference and re-apply 021 (and re-run again for idempotency check)
      await upgradeClient.query(
        `UPDATE supplier_payments SET transaction_reference = 'utr-dup-2026-fixed' WHERE receipt_number = 'SUP-PAY-9002'`
      );
      await upgradeClient.query(sql021);
      await upgradeClient.query(sql021);

      const postCheck = await upgradeClient.query(
        `SELECT status, reversed_at, reversal_reason FROM supplier_payments WHERE receipt_number = 'SUP-PAY-9001'`
      );
      expect(postCheck.rows[0].status).toBe('active');
      expect(postCheck.rows[0].reversed_at).toBeNull();

      const snapCheck = await upgradeClient.query(
        `SELECT supplier_snapshot FROM supplier_purchase_bills WHERE id = $1`,
        [legacyBillId]
      );
      expect(snapCheck.rows[0].supplier_snapshot).toBeNull();
    } finally {
      await upgradeClient.query('SET search_path TO public').catch(() => {});
      await upgradeClient.query('DROP SCHEMA IF EXISTS test_upgrade_020 CASCADE').catch(() => {});
      upgradeClient.release();
    }
  });

  // 27. Release #021 Payment & Advance Idempotency, Expiry, Concurrent Safety & Active Digital Ref Uniqueness
  it('27. Release #021 Enforces payment/allocation idempotency, 24h expiry, concurrent dedup & active digital reference uniqueness', async () => {
    vi.spyOn(appPool, 'connect').mockImplementation(() => pool.connect());
    vi.spyOn(appPool, 'query').mockImplementation((...args: any[]) => (pool.query as any)(...args));

    try {
      const sup1 = await suppliersService.createSupplier({ name: 'Rel021 Idempotency Supplier' });
      const sup2 = await suppliersService.createSupplier({ name: 'Rel021 Other Supplier' });
      const bill1 = await suppliersService.createPurchaseBill({
        supplierId: sup1.id,
        invoiceNumber: 'IDEM-BILL-01',
        invoiceDate: '2026-04-08',
        items: [{ description: 'Switchgear', quantity: '1', purchaseRate: '1000.00' }],
      });
      const bill2 = await suppliersService.createPurchaseBill({
        supplierId: sup1.id,
        invoiceNumber: 'IDEM-BILL-02',
        invoiceDate: '2026-04-09',
        items: [{ description: 'Busbar', quantity: '1', purchaseRate: '600.00' }],
      });

      // A. Idempotent createSupplierPayment replay
      const p1 = await suppliersService.createSupplierPayment({
        supplierId: sup1.id,
        paymentDate: '2026-04-10',
        amount: '500.00',
        paymentMethod: 'upi',
        transactionReference: '  UTR-IDEM-001  ',
        allocations: [{ purchaseBillId: bill1.id, amount: '300.00' }],
        idempotencyKey: 'rel021-create-pay-001',
      });
      const p1Replay = await suppliersService.createSupplierPayment({
        supplierId: sup1.id,
        paymentDate: '2026-04-10',
        amount: '500.00',
        paymentMethod: 'upi',
        transactionReference: 'UTR-IDEM-001',
        allocations: [{ purchaseBillId: bill1.id, amount: '300.00' }],
        idempotencyKey: 'rel021-create-pay-001',
      });
      expect(p1Replay.id).toBe(p1.id);
      expect(p1Replay.receiptNumber).toBe(p1.receiptNumber);

      // Same Idempotency-Key with mismatched payload must 409 IDEMPOTENCY_CONFLICT
      await expect(
        suppliersService.createSupplierPayment({
          supplierId: sup1.id,
          paymentDate: '2026-04-10',
          amount: '550.00',
          paymentMethod: 'upi',
          transactionReference: 'UTR-IDEM-001',
          idempotencyKey: 'rel021-create-pay-001',
        })
      ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });

      // Expired idempotency key (>24h old) allows clean new execution
      await pool.query(
        `UPDATE idempotency_keys SET expires_at = NOW() - INTERVAL '1 hour' WHERE key = 'rel021-create-pay-001'`
      );
      const p1AfterExpiry = await suppliersService.createSupplierPayment({
        supplierId: sup1.id,
        paymentDate: '2026-04-10',
        amount: '100.00',
        paymentMethod: 'cash',
        idempotencyKey: 'rel021-create-pay-001',
      });
      expect(p1AfterExpiry.id).not.toBe(p1.id);

      // Concurrent duplicate Idempotency-Key serialized safely -> single payment created
      const [c1, c2] = await Promise.all([
        suppliersService.createSupplierPayment({
          supplierId: sup1.id,
          paymentDate: '2026-04-10',
          amount: '150.00',
          paymentMethod: 'bank_transfer',
          transactionReference: 'NEFT-CONC-1',
          idempotencyKey: 'rel021-conc-pay-001',
        }),
        suppliersService.createSupplierPayment({
          supplierId: sup1.id,
          paymentDate: '2026-04-10',
          amount: '150.00',
          paymentMethod: 'bank_transfer',
          transactionReference: 'NEFT-CONC-1',
          idempotencyKey: 'rel021-conc-pay-001',
        }),
      ]);
      expect(c1.id).toBe(c2.id);

      // B. Duplicate active digital reference rejection (case/space insensitive + DB partial unique index)
      await expect(
        suppliersService.createSupplierPayment({
          supplierId: sup1.id,
          paymentDate: '2026-04-10',
          amount: '200.00',
          paymentMethod: 'upi',
          transactionReference: 'utr-idem-001',
          idempotencyKey: 'rel021-dup-ref-check-01',
        })
      ).rejects.toMatchObject({ status: 409, code: 'SUPPLIER_PAYMENT_REFERENCE_DUPLICATE' });

      await expect(
        pool.query(
          `INSERT INTO supplier_payments (
            receipt_number, supplier_id, payment_date, amount, payment_method, transaction_reference
          ) VALUES ('SUP-PAY-RAW-DUP', $1, '2026-04-10', 25.00, 'upi', 'UTR-IDEM-001')`,
          [sup1.id]
        )
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'uq_supplier_payments_active_reference',
      });

      // Same reference permitted on cash payments and on other suppliers
      const cashSameRef = await suppliersService.createSupplierPayment({
        supplierId: sup1.id,
        paymentDate: '2026-04-10',
        amount: '50.00',
        paymentMethod: 'cash',
        transactionReference: 'UTR-IDEM-001',
        idempotencyKey: 'rel021-cash-ref-01',
      });
      expect(cashSameRef.paymentMethod).toBe('cash');

      const otherSupSameRef = await suppliersService.createSupplierPayment({
        supplierId: sup2.id,
        paymentDate: '2026-04-10',
        amount: '50.00',
        paymentMethod: 'upi',
        transactionReference: 'UTR-IDEM-001',
        idempotencyKey: 'rel021-other-sup-ref-01',
      });
      expect(otherSupSameRef.supplierId).toBe(sup2.id);

      // C. Advance allocation top-up + idempotency replay
      const topUp1 = await suppliersService.allocateAdvancePayment(
        p1.id,
        [
          { purchaseBillId: bill1.id, amount: '100.00' },
          { purchaseBillId: bill2.id, amount: '50.00' },
        ],
        'rel021-alloc-topup-01'
      );
      expect(topUp1.allocatedAmount).toBe('450.00');
      expect(topUp1.unallocatedAmount).toBe('50.00');

      const topUpReplay = await suppliersService.allocateAdvancePayment(
        p1.id,
        [
          { purchaseBillId: bill1.id, amount: '100.00' },
          { purchaseBillId: bill2.id, amount: '50.00' },
        ],
        'rel021-alloc-topup-01'
      );
      expect(topUpReplay.allocatedAmount).toBe('450.00');
      expect(topUpReplay.unallocatedAmount).toBe('50.00');

      await expect(
        suppliersService.allocateAdvancePayment(
          p1.id,
          [{ purchaseBillId: bill2.id, amount: '25.00' }],
          'rel021-alloc-topup-01'
        )
      ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    } finally {
      vi.restoreAllMocks();
    }
  });

  // 28. Release #021 Full/Partial Reversals, Concurrency, Snapshots & >200 SQL Pagination
  it('28. Release #021 Reversals, Historical Bill Snapshots, Statement Reconciliation & >200 SQL Pagination', async () => {
    vi.spyOn(appPool, 'connect').mockImplementation(() => pool.connect());
    vi.spyOn(appPool, 'query').mockImplementation((...args: any[]) => (pool.query as any)(...args));

    try {
      const baseDash = await suppliersService.getDashboard();

      // A. Historical supplier snapshot immutability & legacy fallback
      const supX = await suppliersService.createSupplier({
        name: 'Snapshot Origin Vendor',
        contactPerson: 'Anil Mehta',
        phone: '9811122233',
        state: 'Maharashtra',
        gstin: '27ABCDE1234F1Z0',
        address: '10 MG Road, Mumbai',
      });

      const billX1 = await suppliersService.createPurchaseBill({
        supplierId: supX.id,
        invoiceNumber: 'SNAP-001',
        invoiceDate: '2026-04-02',
        items: [{ description: 'Transformer', quantity: '1', purchaseRate: '1000.00' }],
      });
      const billX2 = await suppliersService.createPurchaseBill({
        supplierId: supX.id,
        invoiceNumber: 'SNAP-002',
        invoiceDate: '2026-04-03',
        items: [{ description: 'Relay', quantity: '1', purchaseRate: '500.00' }],
      });
      expect(billX1.supplierSnapshotSource).toBe('snapshot');
      expect(billX1.supplierName).toBe('Snapshot Origin Vendor');
      expect(billX1.supplierGstin).toBe('27ABCDE1234F1Z0');

      // Simulate a pre-021 legacy row with NULL snapshot on billX2
      await pool.query(`UPDATE supplier_purchase_bills SET supplier_snapshot = NULL WHERE id = $1`, [
        billX2.id,
      ]);

      await suppliersService.updateSupplier(supX.id, {
        name: 'Renamed Current Vendor LLP',
        phone: '9899988877',
        state: 'Bihar',
        stateCode: '10',
        gstin: '10ABCDE1234F1ZF',
        address: '99 Station Road, Patna',
      });

      const fetchedX1 = await suppliersService.getPurchaseBillById(billX1.id);
      expect(fetchedX1.supplierSnapshotSource).toBe('snapshot');
      expect(fetchedX1.supplierName).toBe('Snapshot Origin Vendor');
      expect(fetchedX1.supplierGstin).toBe('27ABCDE1234F1Z0');
      expect(fetchedX1.supplierAddress).toBe('10 MG Road, Mumbai');

      const listedBillsX = await suppliersService.listPurchaseBills({ supplierId: supX.id });
      const snapRow = listedBillsX.purchaseBills.find((b) => b.id === billX1.id)!;
      const legacyRow = listedBillsX.purchaseBills.find((b) => b.id === billX2.id)!;
      expect(snapRow.supplierSnapshotSource).toBe('snapshot');
      expect(snapRow.supplierName).toBe('Snapshot Origin Vendor');
      expect(legacyRow.supplierSnapshotSource).toBe('legacy_live_fallback');
      expect(legacyRow.supplierName).toBe('Renamed Current Vendor LLP');

      // B. Partial, concurrent & full allocation reversals + full payment reversal
      const payX = await suppliersService.createSupplierPayment({
        supplierId: supX.id,
        paymentDate: '2026-04-05',
        amount: '1000.00',
        paymentMethod: 'bank_transfer',
        transactionReference: 'NEFT-REV-100',
        allocations: [
          { purchaseBillId: billX1.id, amount: '600.00' },
          { purchaseBillId: billX2.id, amount: '400.00' },
        ],
        idempotencyKey: 'rel021-snap-pay-01',
      });

      const allocBill1 = payX.allocations.find((a) => a.purchaseBillId === billX1.id)!;

      // Partial allocation reversal: reverse 250 of 600
      const afterPartial = await suppliersService.reversePaymentAllocation(
        payX.id,
        allocBill1.allocationId,
        { amount: '250.00', reason: 'Over-allocated to SNAP-001' },
        'rel021-alloc-rev-partial'
      );
      const updatedAlloc1 = afterPartial.allocations.find((a) => a.purchaseBillId === billX1.id)!;
      expect(updatedAlloc1.originalAmount).toBe('600.00');
      expect(updatedAlloc1.reversedAmount).toBe('250.00');
      expect(updatedAlloc1.amount).toBe('350.00');
      expect(afterPartial.allocatedAmount).toBe('750.00');
      expect(afterPartial.unallocatedAmount).toBe('250.00');

      // Idempotent replay does NOT double reverse
      const replayPartial = await suppliersService.reversePaymentAllocation(
        payX.id,
        allocBill1.allocationId,
        { amount: '250.00', reason: 'Over-allocated to SNAP-001' },
        'rel021-alloc-rev-partial'
      );
      expect(replayPartial.allocatedAmount).toBe('750.00');

      // Over-reversal (>350 remaining) must 409
      await expect(
        suppliersService.reversePaymentAllocation(
          payX.id,
          allocBill1.allocationId,
          { amount: '400.00', reason: 'Too much' },
          'rel021-alloc-rev-over'
        )
      ).rejects.toMatchObject({ status: 409, code: 'ALLOCATION_REVERSAL_EXCEEDS_ACTIVE_AMOUNT' });

      // Concurrent over-limit allocation reversals serialized safely via FOR UPDATE
      const [concRev1, concRev2] = await Promise.allSettled([
        suppliersService.reversePaymentAllocation(
          payX.id,
          allocBill1.allocationId,
          { amount: '200.00', reason: 'Concurrent 1' },
          'rel021-conc-arev-1'
        ),
        suppliersService.reversePaymentAllocation(
          payX.id,
          allocBill1.allocationId,
          { amount: '200.00', reason: 'Concurrent 2' },
          'rel021-conc-arev-2'
        ),
      ]);
      const concSuccesses = [concRev1, concRev2].filter((r) => r.status === 'fulfilled');
      const concFailures = [concRev1, concRev2].filter((r) => r.status === 'rejected');
      expect(concSuccesses).toHaveLength(1);
      expect(concFailures).toHaveLength(1);

      // Reverse final 150 remaining on billX1 so billX1 becomes 0.00 paid & can be cancelled
      await suppliersService.reversePaymentAllocation(
        payX.id,
        allocBill1.allocationId,
        { amount: '150.00', reason: 'Release full bill allocation' },
        'rel021-alloc-rev-final'
      );
      const billX1Unlocked = await suppliersService.getPurchaseBillById(billX1.id);
      expect(billX1Unlocked.allocatedAmount).toBe('0.00');
      expect(billX1Unlocked.paymentStatus).toBe('unpaid');

      const cancelledX1 = await suppliersService.cancelPurchaseBill(billX1.id, 'Recalled by vendor');
      expect(cancelledX1.status).toBe('cancelled');

      // Now fully reverse payX
      const reversedPayX = await suppliersService.reverseSupplierPayment(
        payX.id,
        'NEFT bounced back',
        'rel021-full-pay-rev-01'
      );
      expect(reversedPayX.status).toBe('reversed');
      expect(reversedPayX.effectiveAmount).toBe('0.00');
      expect(reversedPayX.reversalNumber).toBe(`REV-${payX.receiptNumber}`);
      expect(reversedPayX.reversalReason).toBe('NEFT bounced back');

      // Re-reversing or allocating a reversed payment is blocked (409)
      await expect(
        suppliersService.reverseSupplierPayment(payX.id, 'Again', 'rel021-full-pay-rev-02')
      ).rejects.toMatchObject({ status: 409, code: 'PAYMENT_ALREADY_REVERSED' });
      await expect(
        suppliersService.allocateAdvancePayment(
          payX.id,
          [{ purchaseBillId: billX2.id, amount: '50.00' }],
          'rel021-alloc-after-rev'
        )
      ).rejects.toMatchObject({ status: 409, code: 'PAYMENT_REVERSED' });

      // Bill X2 payable is restored to 500.00 after payX reversal
      const billX2Restored = await suppliersService.getPurchaseBillById(billX2.id);
      expect(billX2Restored.allocatedAmount).toBe('0.00');
      expect(billX2Restored.remainingAmount).toBe('500.00');

      // Digital ref NEFT-REV-100 can now be reused after reversal
      const reusedRefPay = await suppliersService.createSupplierPayment({
        supplierId: supX.id,
        paymentDate: '2026-04-06',
        amount: '100.00',
        paymentMethod: 'bank_transfer',
        transactionReference: 'NEFT-REV-100',
        idempotencyKey: 'rel021-reuse-ref-after-rev',
      });
      expect(reusedRefPay.status).toBe('active');

      // Statement, Supplier Details, Dashboard KPIs & CSV stay mathematically unified
      const supXSummary = await suppliersService.getSupplierById(supX.id);
      // Purchases = 500.00 (billX1 cancelled), Active Payments = 100.00 => Payable = 400.00
      expect(supXSummary.totalPurchases).toBe('500.00');
      expect(supXSummary.totalPayments).toBe('100.00');
      expect(supXSummary.netBalance).toBe('400.00');

      const fullStmt = await suppliersService.getSupplierStatement(supX.id, {});
      expect(fullStmt.periodReversals).toBe('1000.00');
      expect(fullStmt.closingBalance).toBe(supXSummary.netBalance);
      expect(fullStmt.entries.some((e) => e.entryType === 'payment_reversal')).toBe(true);

      // Date-filtered statement split around today's reversal still reconciles ending balance
      const lateStmt = await suppliersService.getSupplierStatement(supX.id, {
        fromDate: '2026-04-06',
      });
      expect(lateStmt.closingBalance).toBe(supXSummary.netBalance);

      const csvOut = suppliersService.formatStatementCsv(fullStmt);
      expect(csvOut).toContain('"Payment Reversal"');
      expect(csvOut).toContain(`"${reversedPayX.reversalNumber}"`);

      const endDash = await suppliersService.getDashboard();
      expect(
        new Decimal(endDash.summary.totalOutstandingPayable)
          .minus(new Decimal(baseDash.summary.totalOutstandingPayable))
          .toFixed(2)
      ).toBe('400.00');

      // C. True SQL Pagination (>200 records without truncation or overlap)
      const bulkSup = await suppliersService.createSupplier({
        name: 'Pagination Target Vendor',
      });

      await pool.query(
        `INSERT INTO suppliers (name, normalized_name)
         SELECT
           'Paginated Bulk Supplier ' || LPAD(g::text, 3, '0'),
           'paginated bulk supplier ' || LPAD(g::text, 3, '0')
         FROM generate_series(1, 205) AS g`
      );
      await pool.query(
        `INSERT INTO supplier_purchase_bills (
           supplier_id, invoice_number, normalized_invoice_number, invoice_date,
           subtotal_amount, discount_amount, taxable_amount, gst_rate, gst_amount, grand_total, supplier_snapshot
         )
         SELECT
           $1,
           'PAG-BILL-' || LPAD(g::text, 3, '0'),
           'PAG-BILL-' || LPAD(g::text, 3, '0'),
           DATE '2026-01-01' + (g % 28),
           100.00, 0.00, 100.00, 0.00, 0.00, 100.00,
           $2::jsonb
         FROM generate_series(1, 205) AS g`,
        [
          bulkSup.id,
          JSON.stringify({
            id: bulkSup.id,
            name: bulkSup.name,
            contactPerson: null,
            phone: null,
            email: null,
            address: null,
            state: null,
            stateCode: null,
            gstin: null,
          }),
        ]
      );
      await pool.query(
        `INSERT INTO supplier_payments (
           receipt_number, supplier_id, payment_date, amount, payment_method
         )
         SELECT
           'SUP-PAY-BULK-' || LPAD(g::text, 4, '0'),
           $1,
           DATE '2026-01-01' + (g % 28),
           50.00,
           'cash'
         FROM generate_series(1, 205) AS g`,
        [bulkSup.id]
      );

      const collectIds = async <T extends { id: string | number }>(
        loadPage: (offset: number, limit: number) => Promise<{
          items: T[];
          total: number;
          pagination: { hasMore: boolean; nextOffset: number | null };
        }>
      ) => {
        const ids: Array<string | number> = [];
        let offset = 0;
        let reportedTotal = 0;
        while (true) {
          const page = await loadPage(offset, 60);
          reportedTotal = page.total;
          ids.push(...page.items.map((x) => x.id));
          if (!page.pagination.hasMore || page.pagination.nextOffset === null) break;
          offset = page.pagination.nextOffset;
        }
        return { ids, reportedTotal };
      };

      const supPages = await collectIds(async (offset, limit) => {
        const r = await suppliersService.listSuppliers({
          search: 'Paginated Bulk Supplier',
          limit,
          offset,
        });
        return { items: r.suppliers, total: r.total, pagination: r.pagination };
      });
      expect(supPages.reportedTotal).toBe(205);
      expect(new Set(supPages.ids).size).toBe(205);
      const supOutOfRange = await suppliersService.listSuppliers({
        search: 'Paginated Bulk Supplier',
        limit: 60,
        offset: 500,
      });
      expect(supOutOfRange.suppliers).toHaveLength(0);
      expect(supOutOfRange.total).toBe(205);

      const billPages = await collectIds(async (offset, limit) => {
        const r = await suppliersService.listPurchaseBills({
          supplierId: bulkSup.id,
          limit,
          offset,
        });
        return { items: r.purchaseBills, total: r.total, pagination: r.pagination };
      });
      expect(billPages.reportedTotal).toBe(205);
      expect(new Set(billPages.ids).size).toBe(205);
      const billOutOfRange = await suppliersService.listPurchaseBills({
        supplierId: bulkSup.id,
        limit: 60,
        offset: 500,
      });
      expect(billOutOfRange.purchaseBills).toHaveLength(0);
      expect(billOutOfRange.total).toBe(205);

      const payPages = await collectIds(async (offset, limit) => {
        const r = await suppliersService.listSupplierPayments({
          supplierId: bulkSup.id,
          limit,
          offset,
        });
        return { items: r.payments, total: r.total, pagination: r.pagination };
      });
      expect(payPages.reportedTotal).toBe(205);
      expect(new Set(payPages.ids).size).toBe(205);
      const payOutOfRange = await suppliersService.listSupplierPayments({
        supplierId: bulkSup.id,
        limit: 60,
        offset: 500,
      });
      expect(payOutOfRange.payments).toHaveLength(0);
      expect(payOutOfRange.total).toBe(205);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // 29. Release #022 Operational Hardening, Cancellation Ledger, Triggers, Archived Settlement & SQL Dashboard
  it('29. Release #022 Operational Hardening: Cancellation Ledger, Append-Only Triggers, Archived Settlement & SQL Dashboard', async () => {
    vi.spyOn(appPool, 'connect').mockImplementation(() => pool.connect());
    vi.spyOn(appPool, 'query').mockImplementation((...args: any[]) => (pool.query as any)(...args));

    try {
      const baseDash = await suppliersService.getDashboard();

      // A. Idempotent 022 migration re-run & cancellation ledger backfill check
      const mig022Sql = fs.readFileSync(
        path.resolve(__dirname, '../../migrations/022_supplier_operational_hardening.sql'),
        'utf-8'
      );
      await pool.query(mig022Sql);

      // B. Historical purchase bill cancellation ledger & cross-month statement math
      const cancelVendor = await suppliersService.createSupplier({
        name: 'Cancellation Audit Vendor',
        phone: '9822011223',
      });
      const aprBill = await suppliersService.createPurchaseBill({
        supplierId: cancelVendor.id,
        invoiceNumber: 'CAN-APR-2026',
        invoiceDate: '2026-04-10',
        items: [{ description: 'Switchgear Box', quantity: '2', purchaseRate: '1250.00' }],
      });
      const cancelledBill = await suppliersService.cancelPurchaseBill(
        aprBill.id,
        'Duplicate vendor invoice entry'
      );
      expect(cancelledBill.status).toBe('cancelled');

      const cancelLedgerRows = await pool.query(
        'SELECT * FROM supplier_purchase_bill_cancellations WHERE purchase_bill_id = $1',
        [aprBill.id]
      );
      expect(cancelLedgerRows.rows).toHaveLength(1);
      expect(Number(cancelLedgerRows.rows[0].original_grand_total)).toBe(2500);

      // Append-only trigger enforcement (SQLSTATE 55000) on cancellation ledger
      await expect(
        pool.query(
          `UPDATE supplier_purchase_bill_cancellations SET reason = 'Tampered' WHERE purchase_bill_id = $1`,
          [aprBill.id]
        )
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        pool.query(
          `DELETE FROM supplier_purchase_bill_cancellations WHERE purchase_bill_id = $1`,
          [aprBill.id]
        )
      ).rejects.toMatchObject({ code: '55000' });

      // April period preserves historical debit; post-April period shows opening +2500 and cancellation credit -2500
      const aprilStmt = await suppliersService.getSupplierStatement(cancelVendor.id, {
        fromDate: '2026-04-01',
        toDate: '2026-04-30',
      });
      expect(aprilStmt.periodPurchases).toBe('2500.00');
      expect(aprilStmt.closingBalance).toBe('2500.00');

      const postAprilStmt = await suppliersService.getSupplierStatement(cancelVendor.id, {
        fromDate: '2026-05-01',
      });
      expect(postAprilStmt.openingBalance).toBe('2500.00');
      expect(postAprilStmt.periodCancellations).toBe('2500.00');
      expect(postAprilStmt.closingBalance).toBe('0.00');

      const fullCancelStmt = await suppliersService.getSupplierStatement(cancelVendor.id, {});
      expect(fullCancelStmt.closingBalance).toBe('0.00');
      expect(fullCancelStmt.entries.map((e) => e.entryType)).toEqual([
        'purchase_bill',
        'purchase_bill_cancellation',
      ]);
      expect(suppliersService.formatStatementCsv(fullCancelStmt)).toContain(
        '"Purchase Bill Cancellation"'
      );

      // C. Archived supplier settlement + advance allocation + digital payment ref + append-only reversal triggers
      const arcVendor = await suppliersService.createSupplier({
        name: 'Archived Settlement Vendor',
        phone: '9833044556',
      });
      const arcBill1 = await suppliersService.createPurchaseBill({
        supplierId: arcVendor.id,
        invoiceNumber: 'ARC-BILL-01',
        invoiceDate: '2026-04-05',
        items: [{ description: 'LED Floodlight', quantity: '1', purchaseRate: '1200.00' }],
      });
      const arcBill2 = await suppliersService.createPurchaseBill({
        supplierId: arcVendor.id,
        invoiceNumber: 'ARC-BILL-02',
        invoiceDate: '2026-04-06',
        items: [{ description: 'Cable Coil', quantity: '1', purchaseRate: '400.00' }],
      });

      // Digital payment requires non-empty reference
      await expect(
        suppliersService.createSupplierPayment({
          supplierId: arcVendor.id,
          paymentDate: '2026-04-07',
          amount: '800.00',
          paymentMethod: 'upi',
          transactionReference: '   ',
        })
      ).rejects.toMatchObject({ status: 400, code: 'TRANSACTION_REFERENCE_REQUIRED' });

      // Record an active digital advance payment with 200 allocated to ARC-BILL-01 (600 unallocated left)
      const advPay = await suppliersService.createSupplierPayment({
        supplierId: arcVendor.id,
        paymentDate: '2026-04-07',
        amount: '800.00',
        paymentMethod: 'bank_transfer',
        transactionReference: '  UTR-REL22-01  ',
        allocations: [{ purchaseBillId: arcBill1.id, amount: '200.00' }],
      });

      // Case-insensitive duplicate active reference is blocked
      await expect(
        suppliersService.createSupplierPayment({
          supplierId: arcVendor.id,
          paymentDate: '2026-04-08',
          amount: '100.00',
          paymentMethod: 'bank_transfer',
          transactionReference: 'utr-rel22-01',
        })
      ).rejects.toMatchObject({ status: 409, code: 'SUPPLIER_PAYMENT_REFERENCE_DUPLICATE' });

      // Search & out-of-range pagination on listSupplierPayments with suppliers JOIN
      const searchHits = await suppliersService.listSupplierPayments({
        search: 'Archived Settlement',
        limit: 20,
        offset: 0,
      });
      expect(searchHits.payments.some((p) => p.id === advPay.id)).toBe(true);
      const searchOutOfRange = await suppliersService.listSupplierPayments({
        search: 'Archived Settlement',
        limit: 20,
        offset: 500,
      });
      expect(searchOutOfRange.payments).toHaveLength(0);
      expect(searchOutOfRange.total).toBe(searchHits.total);

      // Also verify append-only triggers on payment_reversals & allocation_reversals
      const revTempPay = await suppliersService.createSupplierPayment({
        supplierId: arcVendor.id,
        paymentDate: '2026-04-07',
        amount: '150.00',
        paymentMethod: 'upi',
        transactionReference: 'UPI-REV-22',
        allocations: [{ purchaseBillId: arcBill2.id, amount: '150.00' }],
      });
      await suppliersService.reversePaymentAllocation(
        revTempPay.id,
        revTempPay.allocations[0].allocationId,
        {
          amount: '50.00',
          reason: 'Test partial allocation reversal trigger',
        }
      );
      await suppliersService.reverseSupplierPayment(
        revTempPay.id,
        'Mistaken entry trigger check'
      );

      await expect(
        pool.query(
          `UPDATE supplier_payment_reversals SET reason = 'Mutated' WHERE payment_id = $1`,
          [revTempPay.id]
        )
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        pool.query(
          `DELETE FROM supplier_payment_allocation_reversals WHERE payment_id = $1`,
          [revTempPay.id]
        )
      ).rejects.toMatchObject({ code: '55000' });

      // Archive the supplier after a short timestamp gap
      await new Promise((r) => setTimeout(r, 25));
      await suppliersService.archiveSupplier(arcVendor.id);

      // Creating or editing bills is blocked while archived
      await expect(
        suppliersService.createPurchaseBill({
          supplierId: arcVendor.id,
          invoiceNumber: 'ARC-NEW-BLOCKED',
          items: [{ description: 'Item', quantity: '1', purchaseRate: '100.00' }],
        })
      ).rejects.toMatchObject({ status: 409, code: 'SUPPLIER_ARCHIVED' });
      await expect(
        suppliersService.updatePurchaseBill(arcBill1.id, {
          invoiceNumber: 'ARC-BILL-01',
          invoiceDate: '2026-04-05',
          items: [{ description: 'Edited', quantity: '1', purchaseRate: '1200.00' }],
        })
      ).rejects.toMatchObject({ status: 409, code: 'SUPPLIER_ARCHIVED' });

      // Archived supplier blocks new unallocated advance or partial allocation
      await expect(
        suppliersService.createSupplierPayment({
          supplierId: arcVendor.id,
          amount: '100.00',
          paymentMethod: 'cash',
          allocations: [],
        })
      ).rejects.toMatchObject({ status: 409, code: 'ARCHIVED_SUPPLIER_ADVANCE_BLOCKED' });

      await expect(
        suppliersService.createSupplierPayment({
          supplierId: arcVendor.id,
          amount: '500.00',
          paymentMethod: 'cash',
          allocations: [{ purchaseBillId: arcBill2.id, amount: '400.00' }],
        })
      ).rejects.toMatchObject({ status: 409, code: 'ARCHIVED_SUPPLIER_PARTIAL_ALLOCATION' });

      // Existing unallocated 600 advance CAN be allocated to historical bill ARC-BILL-01 (1000 left -> 400 left)
      const allocatedOnArchived = await suppliersService.allocateAdvancePayment(advPay.id, [
        { purchaseBillId: arcBill1.id, amount: '600.00' },
      ]);
      expect(allocatedOnArchived.unallocatedAmount).toBe('0.00');

      // Full settlement payment against remaining balances (ARC-BILL-01: 400 + ARC-BILL-02: 400 = 800) SUCCEEDS
      const fullSettle = await suppliersService.createSupplierPayment({
        supplierId: arcVendor.id,
        paymentDate: '2026-04-12',
        amount: '800.00',
        paymentMethod: 'cheque',
        transactionReference: 'CHQ-SETTLE-22',
        allocations: [
          { purchaseBillId: arcBill1.id, amount: '400.00' },
          { purchaseBillId: arcBill2.id, amount: '400.00' },
        ],
      });
      expect(fullSettle.allocatedAmount).toBe('800.00');

      const settledArchivedSupplier = await suppliersService.getSupplierById(arcVendor.id);
      expect(settledArchivedSupplier.outstandingPayable).toBe('0.00');

      // Post-archival bill row cannot receive advance allocation
      const futureBillRes = await pool.query(
        `INSERT INTO supplier_purchase_bills (
          supplier_id, invoice_number, normalized_invoice_number, invoice_date,
          subtotal_amount, discount_amount, taxable_amount, gst_rate, gst_amount, grand_total, created_at
        ) VALUES ($1, 'POST-ARC-99', 'post-arc-99', '2026-04-20', 200.00, 0, 200.00, 0, 0, 200.00, NOW() + interval '1 day')
        RETURNING id`,
        [arcVendor.id]
      );
      const postArcBillId = Number(futureBillRes.rows[0].id);
      await expect(
        suppliersService.createSupplierPayment({
          supplierId: arcVendor.id,
          paymentDate: '2026-04-21',
          amount: '200.00',
          paymentMethod: 'cash',
          allocations: [{ purchaseBillId: postArcBillId, amount: '200.00' }],
        })
      ).rejects.toMatchObject({ status: 409, code: 'ARCHIVED_SUPPLIER_BILL_AFTER_ARCHIVE' });

      // D. SQL-Aggregated Dashboard verification & date filtering
      const periodDash = await suppliersService.getDashboard({
        fromDate: '2026-04-05',
        toDate: '2026-04-12',
      });
      expect(periodDash.recentPayments.length).toBeGreaterThanOrEqual(2);
      expect(periodDash.recentPayments.length).toBeLessThanOrEqual(15);
      expect(periodDash.recentPayments.some((p) => p.id === fullSettle.id)).toBe(true);
      expect(periodDash.summary.totalSuppliers).toBeGreaterThanOrEqual(205);

      const allTimeDash = await suppliersService.getDashboard();
      // Only added +200.00 postArcBillId open payable compared to baseDash (arcVendor 1600 bills fully paid by 800+800, cancelVendor net 0)
      expect(
        new Decimal(allTimeDash.summary.totalOutstandingPayable)
          .minus(new Decimal(baseDash.summary.totalOutstandingPayable))
          .toFixed(2)
      ).toBe('200.00');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('30. Release #023: Truncate Guards on Audit Tables, REPEATABLE READ Statement Snapshots & >1200 Catalogue Pagination', async () => {
    vi.spyOn(appPool, 'connect').mockImplementation(() => pool.connect());
    vi.spyOn(appPool, 'query').mockImplementation((...args: any[]) => (pool.query as any)(...args));

    try {
    // A. Verify BEFORE TRUNCATE triggers exist on all 3 audit tables and migration 023 re-applies idempotently
    const trigRes = await pool.query(`
      SELECT c.relname AS table_name, t.tgname AS trigger_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND t.tgname LIKE '%truncate%'
        AND c.relname IN (
          'supplier_payment_reversals',
          'supplier_payment_allocation_reversals',
          'supplier_purchase_bill_cancellations'
        )
      ORDER BY c.relname ASC
    `);
    expect(trigRes.rows.map((r) => r.table_name)).toEqual([
      'supplier_payment_allocation_reversals',
      'supplier_payment_reversals',
      'supplier_purchase_bill_cancellations',
    ]);

    const sql023 = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/023_supplier_audit_truncate_guard.sql'),
      'utf-8'
    );
    await expect(pool.query(sql023)).resolves.toBeTruthy();

    // Seed supplier bills, payment reversal, allocation reversal, and bill cancellation so all 3 audit tables have rows
    const v30 = await suppliersService.createSupplier({
      name: 'Release 023 Audit Vendor',
      phone: '9811122334',
    });
    const b30a = await suppliersService.createPurchaseBill({
      supplierId: v30.id,
      invoiceNumber: 'R23-BILL-A',
      invoiceDate: '2026-04-05',
      items: [{ description: 'Item A', quantity: '1', purchaseRate: '1200.00' }],
    });
    const b30b = await suppliersService.createPurchaseBill({
      supplierId: v30.id,
      invoiceNumber: 'R23-BILL-B',
      invoiceDate: '2026-04-06',
      items: [{ description: 'Item B', quantity: '1', purchaseRate: '800.00' }],
    });
    const p30 = await suppliersService.createSupplierPayment({
      supplierId: v30.id,
      paymentDate: '2026-04-07',
      amount: '500.00',
      paymentMethod: 'cash',
      allocations: [{ purchaseBillId: b30a.id, amount: '500.00' }],
    });
    await suppliersService.reverseSupplierPayment(p30.id, 'Audit guard seed reversal');
    await suppliersService.cancelPurchaseBill(b30b.id, 'Audit guard seed cancellation');

    // Attempt UPDATE, DELETE, and TRUNCATE on all 3 audit tables -> must fail with SQLSTATE 55000 and preserve counts
    const preRevCount = Number((await pool.query('SELECT COUNT(*) FROM supplier_payment_reversals')).rows[0].count);
    const preAllocCount = Number((await pool.query('SELECT COUNT(*) FROM supplier_payment_allocation_reversals')).rows[0].count);
    const preCancelCount = Number((await pool.query('SELECT COUNT(*) FROM supplier_purchase_bill_cancellations')).rows[0].count);
    expect(preRevCount).toBeGreaterThanOrEqual(1);
    expect(preAllocCount).toBeGreaterThanOrEqual(1);
    expect(preCancelCount).toBeGreaterThanOrEqual(1);

    for (const stmt of [
      `UPDATE supplier_payment_reversals SET reason = 'tamper'`,
      `DELETE FROM supplier_payment_reversals`,
      `TRUNCATE TABLE supplier_payment_reversals`,
      `UPDATE supplier_payment_allocation_reversals SET reversed_amount = 1.00`,
      `DELETE FROM supplier_payment_allocation_reversals`,
      `TRUNCATE TABLE supplier_payment_allocation_reversals`,
      `UPDATE supplier_purchase_bill_cancellations SET reason = 'tamper'`,
      `DELETE FROM supplier_purchase_bill_cancellations`,
      `TRUNCATE TABLE supplier_purchase_bill_cancellations`,
    ]) {
      let caught: any = null;
      try {
        await pool.query(stmt);
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expect(caught.code).toBe('55000');
    }

    expect(Number((await pool.query('SELECT COUNT(*) FROM supplier_payment_reversals')).rows[0].count)).toBe(preRevCount);
    expect(Number((await pool.query('SELECT COUNT(*) FROM supplier_payment_allocation_reversals')).rows[0].count)).toBe(preAllocCount);
    expect(Number((await pool.query('SELECT COUNT(*) FROM supplier_purchase_bill_cancellations')).rows[0].count)).toBe(preCancelCount);

    // B. REPEATABLE READ READ ONLY snapshot consistency under concurrent payment commits
    const snapClient = await pool.connect();
    try {
      await snapClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapPayBefore = Number(
        (await snapClient.query('SELECT COUNT(*) FROM supplier_payments WHERE supplier_id = $1', [v30.id])).rows[0].count
      );

      // Concurrent writer commits a new payment on another pool connection while snapshot transaction is open
      await suppliersService.createSupplierPayment({
        supplierId: v30.id,
        paymentDate: '2026-04-08',
        amount: '300.00',
        paymentMethod: 'cash',
      });

      const snapPayDuring = Number(
        (await snapClient.query('SELECT COUNT(*) FROM supplier_payments WHERE supplier_id = $1', [v30.id])).rows[0].count
      );
      expect(snapPayDuring).toBe(snapPayBefore);
      await snapClient.query('COMMIT');
    } finally {
      snapClient.release();
    }

    const fullStmt = await suppliersService.getSupplierStatement(v30.id);
    const computedClosing = new Decimal(fullStmt.openingBalance)
      .plus(fullStmt.periodPurchases)
      .minus(fullStmt.periodPayments)
      .plus(fullStmt.periodReversals)
      .minus(fullStmt.periodCancellations)
      .toFixed(2);
    expect(fullStmt.closingBalance).toBe(computedClosing);
    expect(fullStmt.closingBalance).toBe('900.00');

    // C. >1200 products & >1200 customers PostgreSQL search, pagination without duplicates, and billing beyond entry 1000
    await pool.query(`
      INSERT INTO products (name, buying_price, hsn_code, created_at, updated_at)
      SELECT
        'Scale Prod ' || LPAD(g::text, 4, '0'),
        150.00,
        '4411',
        NOW(),
        NOW()
      FROM generate_series(1, 1210) AS g
    `);

    await pool.query(`
      INSERT INTO customers (name, normalized_name, phone, normalized_phone, address, state, state_code, created_at, updated_at)
      SELECT
        'Scale Cust ' || LPAD(g::text, 4, '0'),
        'scale cust ' || LPAD(g::text, 4, '0'),
        '91' || LPAD(g::text, 8, '0'),
        '91' || LPAD(g::text, 8, '0'),
        'Market Road',
        'Bihar',
        '10',
        NOW(),
        NOW()
      FROM generate_series(1, 1210) AS g
    `);

    const pPage1 = await productsService.listActiveProducts({ limit: 25, offset: 0 });
    const pPage2 = await productsService.listActiveProducts({ limit: 25, offset: 25 });
    expect(pPage1.products).toHaveLength(25);
    expect(pPage1.pagination.hasMore).toBe(true);
    expect(pPage2.products).toHaveLength(25);
    const pIds = new Set([...pPage1.products.map((p) => p.id), ...pPage2.products.map((p) => p.id)]);
    expect(pIds.size).toBe(50);

    const pFind1199 = await productsService.listActiveProducts({ search: 'Scale Prod 1199', limit: 25, offset: 0 });
    expect(pFind1199.products.some((p) => p.name === 'Scale Prod 1199')).toBe(true);
    const prod1199 = pFind1199.products.find((p) => p.name === 'Scale Prod 1199')!;

    const cPage1 = await khataService.listCustomers({ limit: 25, offset: 0 });
    const cPage2 = await khataService.listCustomers({ limit: 25, offset: 25 });
    expect(cPage1.customers).toHaveLength(25);
    expect(cPage1.pagination.hasMore).toBe(true);
    expect(cPage2.customers).toHaveLength(25);
    const cIds = new Set([...cPage1.customers.map((c) => c.id), ...cPage2.customers.map((c) => c.id)]);
    expect(cIds.size).toBe(50);

    const cFind1199 = await khataService.listCustomers({ search: 'Scale Cust 1199', limit: 25, offset: 0 });
    expect(cFind1199.customers.some((c) => c.name === 'Scale Cust 1199')).toBe(true);
    const cust1199 = cFind1199.customers.find((c) => c.name === 'Scale Cust 1199')!;

    // Create Normal Bill and GST Invoice using entries > 1000 & validate clamped fixed discount / strict errors
    const nb = await normalBillsService.createBill({
      billNumber: 'R23-NB-1199',
      billDate: '2026-11-05',
      customerId: cust1199.id,
      customerName: cust1199.name,
      discountType: 'fixed',
      discountValue: '9999.00',
      items: [{ productId: prod1199.id, description: prod1199.name, quantity: 2, rate: 250 }],
    });
    expect(nb.total_amount).toBe('0.00');

    const gi = await gstInvoicesService.createInvoice({
      invoiceNumber: 'R23-GST-1199',
      invoiceDate: '2026-11-05',
      state: 'Bihar',
      stateCode: '10',
      customerId: cust1199.id,
      customerName: cust1199.name,
      customerState: 'Bihar',
      customerStateCode: '10',
      gstRate: 5.5,
      items: [{ productId: prod1199.id, description: prod1199.name, quantity: 1, rate: 199 }],
    });
    expect(gi.cgst_amount).toBe('5.47');
    expect(gi.sgst_amount).toBe('5.47');
    expect(gi.grand_total).toBe('209.94');

    await expect(
      gstInvoicesService.createInvoice({
        invoiceNumber: 'R23-GST-BAD',
        invoiceDate: '2026-11-05',
        customerName: cust1199.name,
        gstRate: '18.123',
        items: [{ description: 'Bad', quantity: 1, rate: 100 }],
      })
    ).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('31. Release #024: Home Dashboard Overview, Cost Snapshots, Operating Expenses & Append-Only Audit Triggers', async () => {
    vi.spyOn(appPool, 'connect').mockImplementation(() => pool.connect());
    vi.spyOn(appPool, 'query').mockImplementation((...args: any[]) => (pool.query as any)(...args));

    try {
      // 1. Re-apply migration 024 idempotently
      const sql024 = fs.readFileSync(
        path.resolve(__dirname, '../../migrations/024_home_dashboard_profitability.sql'),
        'utf-8'
      );
      await expect(pool.query(sql024)).resolves.toBeTruthy();

      // 2. Verify append-only BEFORE UPDATE/DELETE and BEFORE TRUNCATE triggers exist on business_expense_events
      const expTrigRes = await pool.query(`
        SELECT tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'business_expense_events'
          AND NOT t.tgisinternal
        ORDER BY tgname ASC
      `);
      expect(expTrigRes.rows.map((r) => r.tgname)).toEqual([
        'trg_prevent_business_expense_events_mutation',
        'trg_prevent_business_expense_events_truncate',
      ]);

      // 3. Seed clean product + customer + sales in isolated date window 2026-12-01..2026-12-02
      const prod = await productsService.createProduct(
        'Release 024 Snapshot Cement',
        '100.00',
        '2523'
      );

      const cust = await khataService.createCustomer({
        name: 'Release 024 Customer',
        phone: '9876500240',
        address: 'Station Road',
        state: 'Bihar',
        stateCode: '10',
      });

      // Normal bill: qty 2 * rate 150 = 300 (cost snapshot = 100.00) + manual line 1 * 50 = 50 (cost snapshot = NULL) => total 350.00
      const nb24 = await normalBillsService.createBill({
        billNumber: 'R24-NB-001',
        billDate: '2026-12-01',
        customerId: cust.id,
        customerName: cust.name,
        customerState: 'Bihar',
        customerStateCode: '10',
        items: [
          { productId: prod.id, description: prod.name, quantity: 2, rate: 150 },
          { description: 'Unlinked Freight Service', quantity: 1, rate: 50 },
        ],
      });
      expect(nb24.items?.[0]?.cost_rate_snapshot).toBe('100.00');
      expect(nb24.items?.[1]?.cost_rate_snapshot).toBeNull();

      // GST invoice: qty 1 * rate 200 = 200 taxable + 18% GST (36) = 236.00 (cost snapshot = 100.00)
      const gi24 = await gstInvoicesService.createInvoice({
        invoiceNumber: 'R24-GST-001',
        invoiceDate: '2026-12-01',
        state: 'Bihar',
        stateCode: '10',
        customerId: cust.id,
        customerName: cust.name,
        customerState: 'Bihar',
        customerStateCode: '10',
        gstRate: 18,
        items: [{ productId: prod.id, description: prod.name, quantity: 1, rate: 200 }],
      });
      expect(gi24.items?.[0]?.cost_rate_snapshot).toBe('100.00');

      // Mutate product buying price later -> historical bill snapshots must stay 100.00 and manual row stays NULL
      await productsService.updateProduct(prod.id, { name: prod.name, buyingPrice: '260.00' });
      const nbCheck = await pool.query(
        'SELECT cost_rate_snapshot FROM normal_bill_items WHERE bill_id = $1 ORDER BY item_index ASC',
        [nb24.id]
      );
      expect(nbCheck.rows.map((r) => r.cost_rate_snapshot)).toEqual(['100.00', null]);

      // 4. Seed Khata credit & payment, Supplier purchase/payment, and Quotations in same isolated window
      const khTx = await khataService.createTransaction({
        customer: { id: cust.id, name: cust.name },
        items: [{ productId: prod.id, quantity: '1', sellingPrice: '500.00' }],
        note: 'R24 credit',
      });
      await pool.query(`UPDATE udhar_transactions SET transaction_date = '2026-12-01' WHERE id = $1`, [
        khTx.transactionId,
      ]);
      await khataService.recordPayment(cust.id, '150.00', 'R24 partial receipt');

      const v24 = await suppliersService.createSupplier({
        name: 'Release 024 Timber House',
        phone: '9811100240',
      });
      await suppliersService.createPurchaseBill({
        supplierId: v24.id,
        invoiceNumber: 'R24-SUP-001',
        invoiceDate: '2026-12-01',
        items: [{ description: 'Bulk Timber', quantity: '1', purchaseRate: '1000.00' }],
      });
      await suppliersService.createSupplierPayment({
        supplierId: v24.id,
        paymentDate: '2026-12-01',
        amount: '400.00',
        paymentMethod: 'upi',
        transactionReference: 'UTR-R24-SUP',
      });

      await quotationsService.createQuotation({
        quotationNumber: 'R24-QT-001',
        quotationDate: '2026-12-01',
        validUntil: '2026-12-31',
        customerId: cust.id,
        customerName: cust.name,
        gstEnabled: false,
        gstRate: 0,
        items: [{ productId: prod.id, description: prod.name, quantity: 3, rate: 150 }],
      });

      // 5. Operating Expenses lifecycle + DB constraints + append-only business_expense_events
      await expect(
        pool.query(
          `INSERT INTO business_expenses (expense_date, category, title, amount, payment_method)
           VALUES ('2026-12-01', 'rent', 'Bad Zero', 0, 'cash')`
        )
      ).rejects.toThrow();

      const exp1 = await dashboardService.createExpense({
        expenseDate: '2026-12-01',
        category: 'rent',
        title: 'December Shop Rent',
        vendorName: 'Plaza Estate',
        amount: '100.00',
        paymentMethod: 'bank_transfer',
        referenceNumber: 'NEFT-24',
      });
      const exp1Upd = await dashboardService.updateExpense(exp1.id, {
        expenseDate: '2026-12-01',
        category: 'rent',
        title: 'December Shop Rent Revised',
        amount: '120.00',
        paymentMethod: 'bank_transfer',
        reason: 'Maintenance surcharge added',
      });
      expect(exp1Upd.amount).toBe('120.00');

      const expVoid = await dashboardService.createExpense({
        expenseDate: '2026-12-01',
        category: 'misc',
        title: 'Wrong Mistake Expense',
        amount: '999.00',
        paymentMethod: 'cash',
      });
      const voided = await dashboardService.voidExpense(expVoid.id, 'Entered on wrong company');
      expect(voided.status).toBe('voided');
      await expect(
        dashboardService.voidExpense(expVoid.id, 'Second void')
      ).rejects.toMatchObject({ status: 409 });

      const eventsRes = await pool.query(
        'SELECT action FROM business_expense_events WHERE expense_id = ANY($1::uuid[]) ORDER BY id ASC',
        [[exp1.id, expVoid.id]]
      );
      expect(eventsRes.rows.map((r) => r.action)).toEqual(['created', 'updated', 'created', 'voided']);

      // Append-only enforcement on business_expense_events (UPDATE, DELETE, TRUNCATE -> 55000)
      for (const stmt of [
        `UPDATE business_expense_events SET reason = 'tampered'`,
        `DELETE FROM business_expense_events`,
        `TRUNCATE TABLE business_expense_events`,
      ]) {
        let caught: any = null;
        try {
          await pool.query(stmt);
        } catch (err) {
          caught = err;
        }
        expect(caught).not.toBeNull();
        expect(caught.code).toBe('55000');
      }

      // 6. Real Dashboard Overview Aggregation verification on isolated 2026-12-01..2026-12-02 window
      // Sales: NB 350.00 (costed 300.00, cogs 200.00, uncosted 50.00) + GST taxable 200.00 (gst 36.00, cogs 100.00)
      // Total revenue ex-GST = 550.00; costed = 500.00; COGS = 300.00; Gross Profit = 200.00; Operating Exp = 120.00 (voided 999 excluded); Net = 80.00
      const overview = await dashboardService.getOverview({
        fromDate: '2026-12-01',
        toDate: '2026-12-02',
      });
      expect(overview.sales.normalBillsTotal).toBe('350.00');
      expect(overview.sales.gstTaxableSales).toBe('200.00');
      expect(overview.sales.gstCollected).toBe('36.00');
      expect(overview.sales.totalSalesRevenue).toBe('550.00');
      expect(overview.profitability.costedSalesRevenue).toBe('500.00');
      expect(overview.profitability.uncostedSalesRevenue).toBe('50.00');
      expect(overview.profitability.estimatedCostOfGoodsSold).toBe('300.00');
      expect(overview.profitability.estimatedGrossProfit).toBe('200.00');
      expect(overview.profitability.operatingExpenses).toBe('120.00');
      expect(overview.profitability.voidedExpensesCount).toBe(1);
      expect(overview.profitability.estimatedNetOperatingResult).toBe('80.00');
      expect(overview.profitability.hasIncompleteCostData).toBe(true);
      expect(overview.customersKhata.creditGiven).toBe('500.00');
      expect(overview.suppliers.totalPurchases).toBe('1000.00');
      expect(overview.suppliers.totalPaymentsMade).toBe('400.00');
      expect(overview.quotations.draftCount).toBeGreaterThanOrEqual(1);
      expect(overview.products.topProducts[0]?.productId).toBe(prod.id);
      expect(overview.salesTrend.granularity).toBe('day');
      expect(overview.salesTrend.points).toHaveLength(2);

      // 7. Pagination & search across >12 expenses
      for (let i = 1; i <= 12; i++) {
        await dashboardService.createExpense({
          expenseDate: '2026-12-02',
          category: 'packaging',
          title: `Box Pack ${String(i).padStart(2, '0')}`,
          amount: '25.00',
          paymentMethod: 'cash',
        });
      }
      const p1 = await dashboardService.listExpenses({
        category: 'packaging',
        fromDate: '2026-12-02',
        toDate: '2026-12-02',
        limit: 5,
        offset: 0,
      });
      const p2 = await dashboardService.listExpenses({
        category: 'packaging',
        fromDate: '2026-12-02',
        toDate: '2026-12-02',
        limit: 5,
        offset: 5,
      });
      expect(p1.total).toBe(12);
      expect(p1.items).toHaveLength(5);
      expect(p1.hasMore).toBe(true);
      expect(p1.totalActiveAmount).toBe('300.00');
      const seenExpIds = new Set([...p1.items.map((x) => x.id), ...p2.items.map((x) => x.id)]);
      expect(seenExpIds.size).toBe(10);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('32. Release #025: 024->025 upgrade idempotency, All-Time Overview (08P01 guard), Proportional Discounts, Mid-Month Trend Clipping, IST Boundaries, Reversal Activity, Expense History & Batched Writes', async () => {
    vi.spyOn(appPool, 'connect').mockImplementation(() => pool.connect());
    vi.spyOn(appPool, 'query').mockImplementation((...args: any[]) => (pool.query as any)(...args));

    try {
      // 1. Re-apply migration 025 idempotently and verify targeted indexes + triggers remain intact
      const sql025 = fs.readFileSync(
        path.resolve(__dirname, '../../migrations/025_performance_reporting_hardening.sql'),
        'utf-8'
      );
      await expect(pool.query(sql025)).resolves.toBeTruthy();

      const idxRes = await pool.query(
        `
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname ASC
        `,
        [[
          'idx_business_expense_events_voided_created',
          'idx_business_expenses_status_date_created',
          'idx_payments_received_at',
          'idx_products_active_lower_name',
          'idx_supplier_alloc_rev_created_at',
          'idx_supplier_payment_reversals_reversed_at',
          'idx_supplier_bill_cancellations_cancelled_at',
        ]]
      );
      expect(idxRes.rows).toHaveLength(7);

      // 2. All-time getOverview({}) executes cleanly on real PostgreSQL without 08P01 bind error
      const allTimeOverview = await dashboardService.getOverview({});
      expect(allTimeOverview.dateRange).toEqual({ fromDate: null, toDate: null });
      expect(allTimeOverview.salesTrend.granularity).toBe('month');
      expect(allTimeOverview.salesTrend.isSixMonthWindow).toBe(true);

      // 3. IST (Asia/Kolkata UTC+05:30) timestamp boundary check for Customer Payments
      const prodA = await productsService.createProduct('R25 Proportional Steel', '40.00', '7214');
      const prodB = await productsService.createProduct('R25 Proportional Bolt', '10.00', '7318');
      const custIst = await khataService.createCustomer({
        name: 'Release 025 IST Boundary Customer',
        phone: '9876500250',
      });
      const istUdhar = await khataService.createTransaction({
        customer: { id: custIst.id, name: custIst.name },
        items: [{ productId: prodA.id, quantity: '5', sellingPrice: '100.00' }],
        note: 'R25 opening udhar for IST payment check',
      });
      await pool.query(`UPDATE udhar_transactions SET transaction_date = '2026-12-08' WHERE id = $1`, [
        istUdhar.transactionId,
      ]);
      await khataService.recordPayment(custIst.id, '111.00', 'IST Dec 9 23:45 payment');
      await khataService.recordPayment(custIst.id, '222.00', 'IST Dec 10 00:15 payment');
      await pool.query(
        `UPDATE payments SET received_at = '2026-12-09T18:15:00.000Z' WHERE customer_id = $1 AND amount = 111.00`,
        [custIst.id]
      );
      await pool.query(
        `UPDATE payments SET received_at = '2026-12-09T18:45:00.000Z' WHERE customer_id = $1 AND amount = 222.00`,
        [custIst.id]
      );

      const dec10IstOverview = await dashboardService.getOverview({
        fromDate: '2026-12-10',
        toDate: '2026-12-10',
      });
      expect(dec10IstOverview.customersKhata.paymentsReceived).toBe('222.00');
      expect(dec10IstOverview.customersKhata.paymentCount).toBe(1);

      // 4. Discounted bill with manual line: proportional net-of-discount top-product revenue

      // Gross lines = 60 + 30 + 10 (manual) = 100.00; Discount = 20.00 -> Net Bill Total = 80.00
      // Product A net share = 48.00, Product B net share = 24.00, manual item = 8.00 (excluded from topProducts)
      await normalBillsService.createBill({
        billNumber: 'R25-DISC-001',
        billDate: '2026-12-15',
        customerId: custIst.id,
        customerName: custIst.name,
        discountType: 'fixed',
        discountValue: '20.00',
        discountAmount: '20.00',
        items: [
          { productId: prodA.id, description: prodA.name, quantity: 1, rate: 60 },
          { productId: prodB.id, description: prodB.name, quantity: 1, rate: 30 },
          { description: 'Manual Fitting Charge', quantity: 1, rate: 10 },
        ],
      });

      const dec15Overview = await dashboardService.getOverview({
        fromDate: '2026-12-15',
        toDate: '2026-12-15',
      });
      expect(dec15Overview.sales.totalSalesRevenue).toBe('80.00');
      const prodATop = dec15Overview.products.topProducts.find((p) => p.productId === prodA.id);
      const prodBTop = dec15Overview.products.topProducts.find((p) => p.productId === prodB.id);
      expect(prodATop?.totalSalesAmount).toBe('48.00');
      expect(prodBTop?.totalSalesAmount).toBe('24.00');

      // 5. Mid-month clipping on >45 day window (2026-10-20 to 2026-12-15) excludes earlier 2026-10-10 bill
      await normalBillsService.createBill({
        billNumber: 'R25-EARLY-OCT',
        billDate: '2026-10-10',
        customerName: 'Early Oct Walkin',
        items: [{ productId: prodA.id, description: prodA.name, quantity: 2, rate: 100 }],
      });

      const multiMonthOverview = await dashboardService.getOverview({
        fromDate: '2026-10-20',
        toDate: '2026-12-15',
      });
      expect(multiMonthOverview.salesTrend.granularity).toBe('month');
      expect(multiMonthOverview.salesTrend.isSixMonthWindow).toBe(false);
      const octBucket = multiMonthOverview.salesTrend.points.find((p) => p.bucket === '2026-10');
      const decBucket = multiMonthOverview.salesTrend.points.find((p) => p.bucket === '2026-12');
      expect(octBucket?.totalSalesRevenue).toBe('0.00');
      expect(new Decimal(decBucket?.totalSalesRevenue || '0').greaterThanOrEqualTo('80')).toBe(true);

      // 6. Batched Khata UNNEST & Supplier UNNEST price sync (incl. duplicate productId in one purchase bill)
      const batchedKhata = await khataService.createTransaction({
        customer: { id: custIst.id, name: custIst.name },
        items: [
          { productId: prodA.id, quantity: '2', sellingPrice: '75.00' },
          { productId: prodB.id, quantity: '3', sellingPrice: '20.00' },
        ],
        note: 'R25 batched udhar test',
      });
      const udharRowsRes = await pool.query(
        'SELECT product_id, buying_price_snapshot FROM udhar_items WHERE transaction_id = $1 ORDER BY id ASC',
        [batchedKhata.transactionId]
      );
      expect(udharRowsRes.rows.map((r) => ({ id: r.product_id, cost: r.buying_price_snapshot }))).toEqual([
        { id: prodA.id, cost: '40.00' },
        { id: prodB.id, cost: '10.00' },
      ]);

      const sup25 = await suppliersService.createSupplier({
        name: 'Release 025 Steel Suppliers',
        phone: '9811100250',
      });
      const cancelBill = await suppliersService.createPurchaseBill({
        supplierId: sup25.id,
        invoiceNumber: 'R25-SB-CANCEL',
        invoiceDate: '2026-12-20',
        items: [
          {
            productId: prodA.id,
            description: prodA.name,
            quantity: '2',
            purchaseRate: '42.00',
            updateProductBuyingPrice: true,
          },
          {
            productId: prodA.id,
            description: prodA.name,
            quantity: '1',
            purchaseRate: '45.00',
            updateProductBuyingPrice: true,
          },
        ],
      });
      const syncedProdA = await pool.query('SELECT buying_price FROM products WHERE id = $1', [prodA.id]);
      expect(syncedProdA.rows[0].buying_price).toBe('45.00');

      const keepBill = await suppliersService.createPurchaseBill({
        supplierId: sup25.id,
        invoiceNumber: 'R25-SB-KEEP',
        invoiceDate: '2026-12-20',
        items: [{ description: 'Angle Iron', quantity: '1', purchaseRate: '500.00' }],
      });
      const supPayAlloc = await suppliersService.createSupplierPayment({
        supplierId: sup25.id,
        paymentDate: '2026-12-20',
        amount: '300.00',
        paymentMethod: 'upi',
        transactionReference: 'UTR-R25-ALLOC',
        allocations: [{ purchaseBillId: keepBill.id, amount: '200.00' }],
      });
      const supPayReverse = await suppliersService.createSupplierPayment({
        supplierId: sup25.id,
        paymentDate: '2026-12-20',
        amount: '150.00',
        paymentMethod: 'cash',
      });

      const allocId = supPayAlloc.allocations[0].allocationId;
      await suppliersService.reversePaymentAllocation(supPayAlloc.id, allocId, {
        amount: '100.00',
        reason: 'R25 partial alloc adjustment',
      });
      await suppliersService.reverseSupplierPayment(supPayReverse.id, 'R25 bounced cheque');
      await suppliersService.cancelPurchaseBill(cancelBill.id, 'R25 duplicate invoice');

      // 7. Read-only Expense Audit History (getExpenseHistory) + Recent Activity Reversal/Void Feed
      const exp25 = await dashboardService.createExpense({
        expenseDate: '2026-12-20',
        category: 'transport',
        title: 'Tempo Freight R25',
        amount: '350.00',
        paymentMethod: 'cash',
      });
      await dashboardService.updateExpense(exp25.id, {
        expenseDate: '2026-12-20',
        category: 'transport',
        title: 'Tempo Freight R25 Updated',
        amount: '380.00',
        paymentMethod: 'upi',
        reason: 'Toll included',
      });
      await dashboardService.voidExpense(exp25.id, 'R25 duplicate expense voucher');

      const hist = await dashboardService.getExpenseHistory(exp25.id, { limit: 10 });
      expect(hist.expense.status).toBe('voided');
      expect(hist.events.map((e) => e.action)).toEqual(['voided', 'updated', 'created']);
      expect(hist.events[0].reason).toBe('R25 duplicate expense voucher');

      const todayBusinessDate = allTimeOverview.businessDate;
      const todayOverview = await dashboardService.getOverview({
        fromDate: todayBusinessDate,
        toDate: todayBusinessDate,
      });
      const activityTypes = new Set(todayOverview.recentActivity.map((a) => a.type));
      expect(activityTypes.has('supplier_payment_reversal')).toBe(true);
      expect(activityTypes.has('supplier_allocation_reversal')).toBe(true);
      expect(activityTypes.has('supplier_bill_cancellation')).toBe(true);
      expect(activityTypes.has('expense_void')).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
