import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { assertSafeTestDatabaseUrl } from '../../src/config/testDbGuard.js';
import {
  appPool,
  closeDatabasePools,
  EXPECTED_CORE_TABLES,
  EXPECTED_MIGRATIONS,
  inspectSearchIndexCapabilities,
} from '../../src/config/database.js';
import { connectMongo, disconnectMongo, ensureMongoIndexes, isMongoReady } from '../../src/config/mongodb.js';
import {
  CustomerSummaryModel,
  DashboardSnapshotModel,
  ProductSearchModel,
  READ_MODEL_MODELS,
} from '../../src/modules/readModels/models.js';
import { APP_DATA_MODELS } from '../../src/modules/appData/models.js';
import {
  computeOutboxBacklogWakeStatus,
  ReadModelOutboxWorker,
  readModelOutboxWorker,
} from '../../src/modules/readModels/readModelOutbox.worker.js';
import { readModelSyncService, upsertProjectionWithTimestampGuard } from '../../src/modules/readModels/readModelSync.service.js';
import {
  buildCustomerCursorQueryContext,
  buildProductCursorQueryContext,
  encodeCursor,
  readModelsQueryService,
} from '../../src/modules/readModels/readModelsQuery.service.js';
import { productsService } from '../../src/modules/products/products.service.js';
import { khataService } from '../../src/modules/khata/khata.service.js';
import { storageService } from '../../src/services/storage.service.js';
import { storageCleanupService } from '../../src/services/storageCleanup.service.js';
import { StorageCleanupWorker } from '../../src/services/storageCleanup.worker.js';
import {
  checkIdempotencyRecord,
  hashIdempotencyPayload,
  storeIdempotencyRecord,
} from '../../src/services/idempotency.service.js';

const { Pool } = pg;
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
const requireTestDb = process.env.REQUIRE_TEST_DATABASE_URL === 'true';

if (requireTestDb && !testDbUrl) {
  throw new Error(
    '[TEST DB GUARD] REQUIRE_TEST_DATABASE_URL=true requires TEST_DATABASE_URL to run Release 030 integration tests.'
  );
}
if (requireTestDb && testDbUrl) {
  assertSafeTestDatabaseUrl(testDbUrl);
}

const describeIntegration = testDbUrl || requireTestDb ? describe : describe.skip;
const TARGET_MONGO_URI = process.env.TEST_MONGODB_URI?.trim() || 'mongodb://127.0.0.1:27017';
const TARGET_MONGO_DB = 'khata_release030_integration_test';
const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

async function dropPublicSchemaObjects(client: pg.PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS "storage_upload_intents" CASCADE;
    DROP TABLE IF EXISTS "storage_cleanup_jobs" CASCADE;
    DROP TABLE IF EXISTS "app_outbox_events" CASCADE;
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
}

async function applyMigrationsList(
  client: pg.PoolClient,
  migrationFiles: readonly string[],
  recordTracking = true
): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  if (recordTracking) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "version" VARCHAR(255) PRIMARY KEY,
        "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      if (recordTracking) {
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [file]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
}

async function loginAuthenticatedAgent(app: ReturnType<typeof createApp>) {
  const agent = request.agent(app);
  const csrfRes = await agent.get('/api/v1/auth/csrf-token').expect(200);
  const preLoginCsrf = csrfRes.body.csrfToken as string;
  const loginRes = await agent
    .post('/api/v1/auth/login')
    .set('X-CSRF-Token', preLoginCsrf)
    .send({ phone: TEST_PHONE, password: TEST_PASSWORD })
    .expect(200);
  const csrfToken = (loginRes.body.csrfToken || preLoginCsrf) as string;
  return { agent, csrfToken };
}

describeIntegration('Release #030 — Real PostgreSQL 18.6 & MongoDB 8.2.4 Integration Suite', () => {
  let pool: pg.Pool;
  let prevEnv: Record<string, any>;

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDbUrl!);
    pool = new Pool({ connectionString: testDbUrl, ssl: false });
    prevEnv = {
      MONGODB_ENABLED: env.MONGODB_ENABLED,
      MONGODB_URI: env.MONGODB_URI,
      MONGODB_DATABASE: env.MONGODB_DATABASE,
      OWNER_PHONE: env.OWNER_PHONE,
      OWNER_PASSWORD_HASH: env.OWNER_PASSWORD_HASH,
      SESSION_COOKIE_SECURE: env.SESSION_COOKIE_SECURE,
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET_NAME: env.R2_BUCKET_NAME,
    };
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(appPool, 'connect').mockImplementation(() => pool.connect());
    vi.spyOn(appPool, 'query').mockImplementation((...args: any[]) => (pool.query as any)(...args));
    env.OWNER_PHONE = TEST_PHONE;
    env.OWNER_PASSWORD_HASH = TEST_HASH;
    env.SESSION_COOKIE_SECURE = false;
    if (process.env.TEST_MONGODB_URI) {
      env.MONGODB_ENABLED = true;
      env.MONGODB_URI = process.env.TEST_MONGODB_URI;
      env.MONGODB_DATABASE = TARGET_MONGO_DB;
      try {
        await connectMongo();
        await ensureMongoIndexes();
      } catch (err) {
        console.error('[TEST MONGO ERROR]', err);
      }
    }
  });

  afterEach(async () => {
    await readModelOutboxWorker.stop().catch(() => {});
    await disconnectMongo().catch(() => {});
    vi.restoreAllMocks();
    Object.assign(env, prevEnv);
  });

  afterAll(async () => {
    await disconnectMongo().catch(() => {});
    if (pool) {
      await pool.end();
    }
    await closeDatabasePools().catch(() => {});
  });

  it('1. Clean installation applies migrations 001-031, registers storage_cleanup_jobs & search indexes, and reports pg_trgm capabilities', async () => {
    const client = await pool.connect();
    try {
      await dropPublicSchemaObjects(client);
      await applyMigrationsList(client, EXPECTED_MIGRATIONS);
    } finally {
      client.release();
    }

    const migRes = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
    expect(migRes.rows.map((r) => r.version)).toEqual(EXPECTED_MIGRATIONS);

    const tablesRes = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [EXPECTED_CORE_TABLES]
    );
    expect(tablesRes.rows.map((r) => r.table_name).sort()).toEqual([...EXPECTED_CORE_TABLES].sort());

    const idxRes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    );
    const indexNames = new Set(idxRes.rows.map((r) => r.indexname));
    for (const requiredIdx of [
      'idx_storage_cleanup_active_object',
      'idx_storage_cleanup_pending_ready',
      'idx_storage_cleanup_failed_retryable',
      'idx_storage_cleanup_processing_wake',
      'idx_storage_cleanup_completed_at',
      'idx_app_outbox_pending_wake',
      'idx_app_outbox_failed_retryable',
      'idx_app_outbox_processing_wake',
      'idx_app_outbox_processed_at',
      'idx_products_active_barcode_prefix',
      'idx_products_active_hsn_prefix',
      'idx_customers_active_normalized_name_id',
      'idx_customers_active_phone_digits',
    ]) {
      expect(indexNames.has(requiredIdx)).toBe(true);
    }

    const caps = await inspectSearchIndexCapabilities({ warnOnMissing: false });
    expect(caps.pgTrgmInstalled).toBe(true);
    expect(caps.missingOptionalIndexes).toEqual([]);
    expect(caps.fallbackSearchMode).toBe('pg_trgm_gin');
  });

  it('2. Upgrade from migration 029 -> 031 preserves existing financial & operational records and re-runs idempotently', async () => {
    const pre030Migrations = EXPECTED_MIGRATIONS.slice(0, 29);
    const post029Migrations = EXPECTED_MIGRATIONS.slice(29);
    expect(post029Migrations).toEqual([
      '030_storage_cleanup_jobs.sql',
      '031_outbox_worker_search_indexes.sql',
      '032_storage_cleanup_claim_fencing.sql',
      '033_storage_upload_intents.sql',
    ]);

    const client = await pool.connect();
    try {
      await dropPublicSchemaObjects(client);
      await applyMigrationsList(client, pre030Migrations);
    } finally {
      client.release();
    }

    // Seed real data while database is strictly at migration 029
    const seededProd = await productsService.createProduct('Legacy Upgrade Salt', '22.50', '2501', '000998877');
    const seededCust = await khataService.createCustomer({
      name: 'Legacy Upgrade Customer',
      phone: '9800011223',
      address: 'Patna Main Rd',
      state: 'Bihar',
      stateCode: '10',
    });
    const udhar = await khataService.createTransaction({
      customer: { id: seededCust.id, name: seededCust.name, phone: seededCust.phone },
      items: [{ productId: seededProd.id, quantity: '4.50', sellingPrice: '30.00' }],
      initialPayment: '35.00',
      note: 'Pre-030 udhar preserved',
    });

    const upgradeClient = await pool.connect();
    try {
      await applyMigrationsList(upgradeClient, post029Migrations, true);
      // Apply 030 & 031 a SECOND time to prove SQL idempotency
      await applyMigrationsList(upgradeClient, post029Migrations, true);
    } finally {
      upgradeClient.release();
    }

    const migRes = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
    expect(migRes.rows.map((r) => r.version)).toEqual(EXPECTED_MIGRATIONS);

    const custLedger = await khataService.getCustomerDetail(seededCust.id);
    expect(custLedger?.totalUdhar).toBe('135.00');
    expect(custLedger?.totalReceived).toBe('35.00');
    expect(custLedger?.outstanding).toBe('100.00');
    expect(udhar.transactionId).toBeGreaterThan(0);

    const prodRow = await productsService.getProductById(seededProd.id);
    expect(prodRow?.barcode).toBe('000998877');
  });

  it(
    '3. Outbox wakeup uses LIMIT 1 index probes (EXPLAIN ANALYZE) across 100k processed rows, recovers NULL/expired leases, and separates freshness timestamps',
    { timeout: 90_000 },
    async () => {
      await readModelOutboxWorker.stop();
      env.MONGODB_ENABLED = true;
      env.MONGODB_URI = TARGET_MONGO_URI;
      env.MONGODB_DATABASE = TARGET_MONGO_DB;
      await connectMongo({ uri: TARGET_MONGO_URI, dbName: TARGET_MONGO_DB });
      expect(isMongoReady()).toBe(true);
      await ensureMongoIndexes();
      for (const Model of [...READ_MODEL_MODELS, ...APP_DATA_MODELS]) {
        await Model.deleteMany({});
      }

      // Clear prior outbox events cleanly
      await pool.query('TRUNCATE app_outbox_events RESTART IDENTITY');

      // Seed 100,000 historical processed events + active edge cases
      await pool.query(`
        INSERT INTO app_outbox_events (
          event_id, aggregate_type, aggregate_id, event_type, payload, status,
          attempt_count, max_attempts, processed_at, created_at, updated_at
        )
        SELECT
          'hist-' || g,
          'product',
          ((g % 500) + 1)::text,
          'product.updated',
          '{}'::jsonb,
          'processed',
          1,
          8,
          NOW() - interval '2 days',
          NOW() - interval '3 days',
          NOW() - interval '2 days'
        FROM generate_series(1, 100000) AS g
      `);

      // Seed 1 live product whose events correspond to our NULL-lease & expired-lease recovery rows
      const realProd = await productsService.createProduct('Outbox Lease Recovery Tea', '145.00', '0902', '8903000010011');
      await pool.query(`TRUNCATE app_outbox_events`);

      // Re-insert 100,000 processed rows cleanly around real probes
      await pool.query(`
        INSERT INTO app_outbox_events (
          event_id, aggregate_type, aggregate_id, event_type, payload, status,
          attempt_count, max_attempts, processed_at, created_at, updated_at
        )
        SELECT
          'hist-r-' || g,
          'product',
          '999999',
          'product.updated',
          '{}'::jsonb,
          'processed',
          1,
          8,
          NOW() - interval '1 day',
          NOW() - interval '2 days',
          NOW() - interval '1 day'
        FROM generate_series(1, 100000) AS g
      `);

      // Future pending event + expired lease processing + NULL lease processing + 3 dead_letter rows
      await pool.query(
        `INSERT INTO app_outbox_events (
           event_id, aggregate_type, aggregate_id, event_type, payload, status, next_attempt_at, lease_expires_at
         ) VALUES
         ('pending-future-1', 'product', $1, 'product.updated', '{}'::jsonb, 'pending', NOW() + interval '15 seconds', NULL),
         ('proc-expired-lease', 'product', $1, 'product.updated', '{}'::jsonb, 'processing', NOW() - interval '60 seconds', NOW() - interval '15 seconds'),
         ('proc-null-lease', 'product', $1, 'product.updated', '{}'::jsonb, 'processing', NOW() - interval '60 seconds', NULL),
         ('dlq-1', 'product', $1, 'product.updated', '{}'::jsonb, 'dead_letter', NOW(), NULL),
         ('dlq-2', 'product', $1, 'product.updated', '{}'::jsonb, 'dead_letter', NOW(), NULL),
         ('dlq-3', 'product', $1, 'product.updated', '{}'::jsonb, 'dead_letter', NOW(), NULL)`,
        [String(realProd.id)]
      );

      await pool.query('VACUUM ANALYZE app_outbox_events');

      // Verify exact inspectRetryableBacklogDelay query plan avoids sequential scan over 100k rows
      const explainRes = await pool.query(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT
          MIN(candidate_wake_at) AS next_wake_at,
          NOW() AS server_now
        FROM (
          (
            SELECT next_attempt_at AS candidate_wake_at
            FROM app_outbox_events
            WHERE status = 'pending'
            ORDER BY next_attempt_at ASC, id ASC
            LIMIT 1
          )
          UNION ALL
          (
            SELECT next_attempt_at AS candidate_wake_at
            FROM app_outbox_events
            WHERE status = 'failed'
              AND attempt_count < max_attempts
            ORDER BY next_attempt_at ASC, id ASC
            LIMIT 1
          )
          UNION ALL
          (
            SELECT lease_expires_at AS candidate_wake_at
            FROM app_outbox_events
            WHERE status = 'processing'
            ORDER BY lease_expires_at ASC NULLS FIRST, id ASC
            LIMIT 1
          )
        ) AS retryable_candidates
      `);
      const planJsonText = JSON.stringify(explainRes.rows[0]['QUERY PLAN']);
      expect(planJsonText).not.toContain('Seq Scan');
      expect(planJsonText).toContain('idx_app_outbox_pending_wake');
      expect(planJsonText).toContain('idx_app_outbox_failed_retryable');
      expect(planJsonText).toContain('idx_app_outbox_processing_wake');

      const planRoot = explainRes.rows[0]['QUERY PLAN'][0].Plan;
      expect(planRoot['Actual Rows']).toBeLessThanOrEqual(3);

      // Start worker catchUpOnStartup -> drains expired + NULL lease processing rows immediately and reads dead_letter_count=3
      const pastDashboardTs = new Date(Date.now() - 30 * 60_000);
      await DashboardSnapshotModel.create({
        snapshotKey: '__global__',
        globals: {
          totalCustomers: 0,
          activeCustomers: 0,
          customersWithOutstanding: 0,
          totalOutstandingReceivable: '0.00',
          khataSummaryTotalCustomers: 0,
          khataSummaryTotalOutstanding: '0.00',
          khataSummaryTotalReceived: '0.00',
          totalProducts: 1,
          activeProducts: 1,
          archivedProducts: 0,
          totalSuppliers: 0,
          activeSuppliers: 0,
          supplierTotalPurchases: '0.00',
          supplierBillsCount: 0,
          supplierCancelledBillsCount: 0,
          supplierTotalPaymentsMade: '0.00',
          supplierPaymentsCount: 0,
          supplierTotalPaymentsReversed: '0.00',
          supplierTotalOutstandingPayable: '0.00',
          supplierTotalAdvanceCredit: '0.00',
          supplierTotalUnallocatedPayments: '0.00',
        },
        allTimeOverview: {},
        lastOutboxEventId: 0,
        lastSyncedAt: pastDashboardTs,
        lastProjectionSyncAt: pastDashboardTs,
        lastDashboardRefreshAt: pastDashboardTs,
        projectionUpdatedAt: pastDashboardTs,
      });

      const worker = new ReadModelOutboxWorker({
        batchSize: 10,
        dashboardRefreshMinIntervalMs: 600_000,
        baseBackoffMs: 500,
        maxBackoffMs: 30_000,
      });

      try {
        await worker.catchUpOnStartup();
        expect(readModelsQueryService.getOutboxDeadLetterCount()).toBe(3);

        // Both NULL-lease and expired-lease processing rows must now be processed
        const recoveredRes = await pool.query(
          `SELECT event_id, status FROM app_outbox_events WHERE event_id IN ('proc-expired-lease', 'proc-null-lease') ORDER BY event_id`
        );
        expect(recoveredRes.rows).toEqual([
          { event_id: 'proc-expired-lease', status: 'processed' },
          { event_id: 'proc-null-lease', status: 'processed' },
        ]);

        // Future pending event must have scheduled bounded wakeup without permanent idle polling
        expect(worker.hasRetryTimerScheduled()).toBe(true);
        const wakeStatus = computeOutboxBacklogWakeStatus(new Date(Date.now() + 10_000), new Date(), {
          maxBackoffMs: 30_000,
          minDelayMs: 500,
        });
        expect(wakeStatus.hasBacklog).toBe(true);

        // Mark future event processed and drain again -> clears wakeup timer cleanly
        await pool.query(
          `UPDATE app_outbox_events SET status = 'processed', processed_at = NOW() WHERE event_id = 'pending-future-1'`
        );
        await worker.drainNow();
        expect(worker.hasRetryTimerScheduled()).toBe(false);

        // Freshness separation: projection sync timestamp advances even when dashboard snapshot refresh is skipped
        await DashboardSnapshotModel.updateOne(
          { snapshotKey: '__global__' },
          { $set: { lastDashboardRefreshAt: pastDashboardTs, lastProjectionSyncAt: pastDashboardTs } }
        );
        await pool.query(`UPDATE products SET buying_price = '155.00', updated_at = NOW() WHERE id = $1`, [
          realProd.id,
        ]);
        await readModelSyncService.applyOutboxBatch(
          [
            {
              id: 9999999,
              event_id: 'evt-proj-only-030',
              aggregate_type: 'product',
              aggregate_id: String(realProd.id),
              event_type: 'product.updated',
              payload: {},
              created_at: new Date(),
            },
          ],
          { skipDashboardSnapshot: true }
        );
        const snapAfter = await DashboardSnapshotModel.findOne({ snapshotKey: '__global__' }).lean();
        expect(new Date(snapAfter!.lastProjectionSyncAt!).getTime()).toBeGreaterThan(pastDashboardTs.getTime());
        expect(new Date(snapAfter!.lastDashboardRefreshAt!).getTime()).toBe(pastDashboardTs.getTime());

        // Monotonic sourceUpdatedAt guard prevents stale upsert overwrite in MongoDB
        const newerTs = new Date(Date.now() + 60_000);
        const olderTs = new Date(Date.now() - 60_000);
        await upsertProjectionWithTimestampGuard(
          ProductSearchModel,
          { productId: realProd.id },
          { buyingPrice: '199.00', sourceUpdatedAt: newerTs },
          newerTs
        );
        const staleAttempt = await upsertProjectionWithTimestampGuard(
          ProductSearchModel,
          { productId: realProd.id },
          { buyingPrice: '1.00', sourceUpdatedAt: olderTs },
          olderTs
        );
        expect(staleAttempt).toBe('skipped_stale');
        const latestDoc = await ProductSearchModel.findOne({ productId: realProd.id }).lean();
        expect(latestDoc?.buyingPrice).toBe('199.00');
      } finally {
        await worker.stop();
      }
    }
  );

  it(
    '4. 100-event burst, PG/Mongo customer sort parity (ties & NULL activity), Hindi/Punjabi search, phone normalization, and cursor tamper/replay rejection',
    { timeout: 60_000 },
    async () => {
      await readModelOutboxWorker.stop();
      env.MONGODB_ENABLED = true;
      env.MONGODB_URI = TARGET_MONGO_URI;
      env.MONGODB_DATABASE = TARGET_MONGO_DB;
      await connectMongo({ uri: TARGET_MONGO_URI, dbName: TARGET_MONGO_DB });
      await ensureMongoIndexes();
      for (const Model of [...READ_MODEL_MODELS, ...APP_DATA_MODELS]) {
        await Model.deleteMany({});
      }

      // Clean transactional tables cleanly while keeping schema intact
      const client = await pool.connect();
      try {
        await client.query(`
          TRUNCATE payment_allocations, payments, udhar_items, udhar_transactions,
                   customers, products, app_outbox_events RESTART IDENTITY CASCADE
        `);
      } finally {
        client.release();
      }

      // Seed diverse Unicode, barcode, HSN, special-char products (60 events+)
      const hindiProd = await productsService.createProduct('शुद्ध बासमती चावल', '92.00', '100630', '000450012');
      const punjabiProd = await productsService.createProduct('ਪੰਜਾਬੀ ਦੇਸੀ ਘਿਓ', '540.00', '040590', '000450099');
      const shortUnicodeProd = await productsService.createProduct('ਅਦਰਕ ਪਾਊਡਰ', '65.00', '0910', null);
      const escapeProd = await productsService.createProduct('Bond 50%_Tape', '40.00', '3919', '000501122');

      const bulkProducts: number[] = [];
      for (let i = 1; i <= 40; i++) {
        const p = await productsService.createProduct(
          `R30 Parity Item ${String(i).padStart(2, '0')}`,
          `${(10 + i).toFixed(2)}`,
          `84${String(i).padStart(2, '0')}`,
          `8903000${String(i).padStart(5, '0')}`
        );
        bulkProducts.push(p.id);
      }

      // Seed customers covering ties, NULL lastActivityAt, phone formats, Hindi/Punjabi
      const cHigh = await khataService.createCustomer({ name: 'High Balance Trader', phone: '9811100001' });
      const cTieOlder = await khataService.createCustomer({ name: 'Tie Older Activity', phone: '9811100002' });
      const cTieSameTsA = await khataService.createCustomer({ name: 'Tie SameTs A', phone: '9811100003' });
      const cTieSameTsB = await khataService.createCustomer({ name: 'Tie SameTs B', phone: '+91 98111-22334' });
      const cHindi = await khataService.createCustomer({ name: 'राजेश्वरी देवी', phone: '9822200005' });
      const cPunjabi = await khataService.createCustomer({ name: 'ਹਰਪ੍ਰੀਤ ਕੌਰ', phone: '9822200006' });
      const cNullZeroA = await khataService.createCustomer({ name: 'Zero Null A', phone: '9833300007' });
      const cNullZeroB = await khataService.createCustomer({ name: 'Zero Null B', phone: '9833300008' });

      await khataService.createTransaction({
        customer: { id: cHigh.id, name: cHigh.name, phone: cHigh.phone },
        items: [{ productId: hindiProd.id, quantity: '10', sellingPrice: '120.00' }],
      });
      await khataService.createTransaction({
        customer: { id: cTieOlder.id, name: cTieOlder.name, phone: cTieOlder.phone },
        items: [{ productId: hindiProd.id, quantity: '5', sellingPrice: '100.00' }],
      });
      await khataService.createTransaction({
        customer: { id: cTieSameTsA.id, name: cTieSameTsA.name, phone: cTieSameTsA.phone },
        items: [{ productId: hindiProd.id, quantity: '5', sellingPrice: '100.00' }],
      });
      await khataService.createTransaction({
        customer: { id: cTieSameTsB.id, name: cTieSameTsB.name, phone: cTieSameTsB.phone },
        items: [{ productId: hindiProd.id, quantity: '5', sellingPrice: '100.00' }],
      });
      // Pin cTieSameTsA & cTieSameTsB to identical created_at and cTieOlder strictly earlier
      await pool.query(`UPDATE udhar_transactions SET created_at = '2026-11-10T10:00:00.000Z' WHERE customer_id = $1`, [
        cTieOlder.id,
      ]);
      await pool.query(
        `UPDATE udhar_transactions SET created_at = '2026-11-11T10:00:00.000Z' WHERE customer_id IN ($1, $2)`,
        [cTieSameTsA.id, cTieSameTsB.id]
      );
      // Mark tie customers dirty in outbox so worker re-syncs pinned lastActivityAt timestamps cleanly
      await pool.query(
        `INSERT INTO app_outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES
           ('tie-sync-a-' || $1, 'customer', $1::text, 'customer.updated', '{}'::jsonb),
           ('tie-sync-b-' || $2, 'customer', $2::text, 'customer.updated', '{}'::jsonb),
           ('tie-sync-o-' || $3, 'customer', $3::text, 'customer.updated', '{}'::jsonb)`,
        [cTieSameTsA.id, cTieSameTsB.id, cTieOlder.id]
      );

      // Confirm 100+ event burst was generated & drains cleanly with zero leftovers
      const burstCountRes = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM app_outbox_events WHERE status IN ('pending', 'processing', 'failed')`
      );
      expect(Number(burstCountRes.rows[0].cnt)).toBeGreaterThanOrEqual(45);

      const worker = new ReadModelOutboxWorker({ batchSize: 25, dashboardRefreshMinIntervalMs: 1000 });
      try {
        await worker.catchUpOnStartup();
        let safety = 0;
        while (safety < 20) {
          safety += 1;
          const res = await worker.drainNow();
          if (res.processedCount === 0) break;
        }
      } finally {
        await worker.stop();
      }

      // Compare PG customer ordering vs MongoDB customer ordering -> must match identically
      const pgCustList = await khataService.listCustomers({ limit: 50, offset: 0 });
      const mongoCustList = await readModelsQueryService.listCustomersFromMongo({ limit: 50, offset: 0 });
      expect(mongoCustList.customers.map((c) => c.id)).toEqual(pgCustList.customers.map((c) => c.id));
      expect(cNullZeroA.id).toBeLessThan(cNullZeroB.id);
      expect(pgCustList.customers[0].id).toBe(cHigh.id);
      // Among ₹500 ties: identical newer ts ordered ASC by customerId, then older ts
      const tieSlice = pgCustList.customers.slice(1, 4).map((c) => c.id);
      expect(tieSlice).toEqual([cTieSameTsA.id, cTieSameTsB.id, cTieOlder.id]);
      // Zero/null-activity customers ordered deterministically by customerId ASC
      const zeroIds = pgCustList.customers.filter((c) => c.outstanding === '0.00').map((c) => c.id);
      expect(zeroIds).toEqual([...zeroIds].sort((a, b) => a - b));

      // Verify HTTP search completeness (Mongo enabled + PG fallback), Hindi/Punjabi, short query, cursor replay
      const app = createApp({ useMemoryStoreInTest: true });
      const { agent } = await loginAuthenticatedAgent(app);

      // Mongo-backed HTTP checks
      const mHindi = await agent.get('/api/v1/products?search=' + encodeURIComponent('बासमती')).expect(200);
      expect(mHindi.body.data.some((p: any) => p.id === hindiProd.id)).toBe(true);

      const mPunjabi = await agent.get('/api/v1/products?search=' + encodeURIComponent('ਪੰਜਾਬੀ')).expect(200);
      expect(mPunjabi.body.data.some((p: any) => p.id === punjabiProd.id)).toBe(true);

      const mBarcode = await agent.get('/api/v1/products/barcode/000450012').expect(200);
      expect(mBarcode.body.data.id).toBe(hindiProd.id);

      const mPhone = await agent.get('/api/v1/khata/customers?search=' + encodeURIComponent('+91 98111')).expect(200);
      expect(mPhone.body.customers.some((c: any) => c.id === cTieSameTsB.id)).toBe(true);

      const mShort = await agent.get('/api/v1/products?search=' + encodeURIComponent('ਅ')).expect(200);
      expect(mShort.body.data.some((p: any) => p.id === shortUnicodeProd.id)).toBe(true);

      // Force PG fallback and verify identical completeness across name, HSN, exact barcode, escaped %, phone partial & +91
      const pgFallbackProd = await productsService.listActiveProducts({ search: '50%_' });
      expect(pgFallbackProd.products.some((p) => p.id === escapeProd.id)).toBe(true);

      const pgFallbackHsn = await productsService.listActiveProducts({ search: '100630' });
      expect(pgFallbackHsn.products.some((p) => p.id === hindiProd.id)).toBe(true);

      const pgFallbackBarcode = await productsService.listActiveProducts({ exactBarcode: '000450012' });
      expect(pgFallbackBarcode.products.map((p) => p.id)).toEqual([hindiProd.id]);

      const pgFallbackCustPhone = await khataService.listCustomers({ search: '22334' });
      expect(pgFallbackCustPhone.customers.some((c) => c.id === cTieSameTsB.id)).toBe(true);

      const pgFallbackCustZeroPhone = await khataService.listCustomers({ search: '09811100001' });
      expect(pgFallbackCustZeroPhone.customers.some((c) => c.id === cHigh.id)).toBe(true);

      // Cursor walk without duplicates or gaps + tampering & cross-endpoint replay rejection
      const seenProductIds: number[] = [];
      let pCursor: string | null = null;
      for (let pageNo = 0; pageNo < 25; pageNo++) {
        const url = pCursor
          ? `/api/v1/products?search=R30&limit=3&cursor=${encodeURIComponent(pCursor)}`
          : '/api/v1/products?search=R30&limit=3';
        const res = await agent.get(url).expect(200);
        for (const item of res.body.data) {
          seenProductIds.push(item.id);
        }
        if (!res.body.pagination.hasMore) break;
        pCursor = res.body.pagination.nextCursor;
      }
      expect(seenProductIds).toHaveLength(40);
      expect(new Set(seenProductIds).size).toBe(40);

      // Tampering & cross-endpoint replay
      const cursorFor00045 = encodeCursor(
        { t: 'p', n: 'z', id: 1 },
        buildProductCursorQueryContext('00045')
      );
      const mismatchRes = await agent
        .get(`/api/v1/products?search=45&cursor=${encodeURIComponent(cursorFor00045)}`)
        .expect(400);
      expect(mismatchRes.body.code).toBe('INVALID_PAGINATION_CURSOR');

      const replayRes = await agent
        .get(`/api/v1/khata/customers?search=00045&cursor=${encodeURIComponent(cursorFor00045)}`)
        .expect(400);
      expect(replayRes.body.code).toBe('INVALID_PAGINATION_CURSOR');

      const custTampered = encodeCursor(
        { t: 'c', o: 50000, l: null, id: 1 },
        buildCustomerCursorQueryContext('')
      );
      await agent
        .get(`/api/v1/khata/customers?cursor=${encodeURIComponent(custTampered.slice(0, -3) + 'XYZ')}`)
        .expect(400);

      // Real Mongo explain confirms IXSCAN on product & customer collections
      const prodExplain = await ProductSearchModel.collection
        .find({ isArchived: false, normalizedName: { $gte: 'r', $lt: 's' } })
        .sort({ normalizedName: 1, productId: 1 })
        .limit(26)
        .explain('executionStats');
      expect(JSON.stringify(prodExplain)).toContain('IXSCAN');
      expect(JSON.stringify(prodExplain)).not.toContain('COLLSCAN');
    }
  );

  it('5. Durable storage_cleanup_jobs: 6-table live-reference guard, active ON CONFLICT dedup, completed-key reuse, concurrent SKIP LOCKED & dead-letter', async () => {
    await pool.query('TRUNCATE storage_cleanup_jobs RESTART IDENTITY');

    // Seed 1 live object key reference into EACH of the 6 R2-backed tables
    const custRes = await pool.query(
      `INSERT INTO customers (name, normalized_name, phone, normalized_phone)
       VALUES ('Ref Cust', 'ref cust', '9844400001', '9844400001') RETURNING id`
    );
    const custId = Number(custRes.rows[0].id);

    await pool.query(
      `INSERT INTO products (name, buying_price, image_object_key, image_content_type, image_size_bytes)
       VALUES ('Ref Product', 10.00, 'products/live-ref.jpg', 'image/jpeg', 120)`
    );
    await pool.query(
      `INSERT INTO offline_bill_records (customer_name, customer_phone, normalized_customer_phone, image_object_key, image_content_type, image_size_bytes)
       VALUES ('Ref Offline', '9844400002', '9844400002', 'offline-bills/live-ref.jpg', 'image/jpeg', 220)`
    );
    const supRes = await pool.query(
      `INSERT INTO suppliers (name, normalized_name) VALUES ('Ref Supplier', 'ref supplier') RETURNING id`
    );
    await pool.query(
      `INSERT INTO supplier_purchase_bills (
         supplier_id, invoice_number, normalized_invoice_number, invoice_date,
         subtotal_amount, taxable_amount, grand_total, attachment_object_key
       ) VALUES ($1, 'SUP-REF-1', 'sup-ref-1', CURRENT_DATE, 100.00, 100.00, 100.00, 'suppliers/live-ref.pdf')`,
      [supRes.rows[0].id]
    );
    await pool.query(
      `INSERT INTO gst_invoices (
         invoice_number, state, state_code, customer_id, customer_name, customer_state, customer_state_code,
         taxable_amount, grand_total, amount_in_words, r2_object_key
       ) VALUES ('GST-REF-1', 'Bihar', '10', $1, 'Ref Cust', 'Bihar', '10', 100.00, 118.00, 'One Hundred Eighteen', 'invoices/gst-live-ref.pdf')`,
      [custId]
    );
    await pool.query(
      `INSERT INTO normal_bills (
         bill_number, state, state_code, customer_id, customer_name, customer_state, customer_state_code,
         total_amount, amount_in_words, r2_object_key
       ) VALUES ('BILL-REF-1', 'Bihar', '10', $1, 'Ref Cust', 'Bihar', '10', 100.00, 'One Hundred', 'bills/normal-live-ref.pdf')`,
      [custId]
    );
    await pool.query(
      `UPDATE quotation_settings SET logo_url = 'logos/quotation-live-ref.png' WHERE id = 1`
    );

    const deleteSpy = vi.spyOn(storageService, 'deleteObject').mockResolvedValue(undefined);
    const tableChecks: Array<[string, string]> = [
      ['products/live-ref.jpg', 'products'],
      ['offline-bills/live-ref.jpg', 'offline_bill_records'],
      ['suppliers/live-ref.pdf', 'supplier_purchase_bills'],
      ['invoices/gst-live-ref.pdf', 'gst_invoices'],
      ['bills/normal-live-ref.pdf', 'normal_bills'],
      ['logos/quotation-live-ref.png', 'quotation_settings'],
    ];
    for (const [key, expectedTable] of tableChecks) {
      const outcome = await storageCleanupService.attemptDeleteOrEnqueue({
        objectKey: key,
        objectKind: 'other',
        reason: 'live_reference_guard_check',
      });
      expect(outcome.outcome).toBe('skipped_referenced');
      expect(outcome.referencedIn).toContain(expectedTable);
    }
    expect(deleteSpy).not.toHaveBeenCalled();

    // ON CONFLICT deduplication across active states + allows new job after completed
    const job1 = await storageCleanupService.enqueueCleanupJob({
      objectKey: 'products/reusable-key.jpg',
      objectKind: 'product_image',
      reason: 'first_enqueue',
      initialDelayMs: 0,
    });
    const job2 = await storageCleanupService.enqueueCleanupJob({
      objectKey: 'products/reusable-key.jpg',
      objectKind: 'product_image',
      reason: 'duplicate_active_enqueue',
      initialDelayMs: 0,
    });
    expect(job1).toBe(job2);
    const activeCountRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM storage_cleanup_jobs WHERE object_key = 'products/reusable-key.jpg'`
    );
    expect(activeCountRes.rows[0].cnt).toBe(1);

    const wSingle = new StorageCleanupWorker({ batchSize: 10, registerGlobalListener: false });
    await wSingle.drainNow();
    await wSingle.dispose();

    const completedRow = await pool.query(
      `SELECT status FROM storage_cleanup_jobs WHERE id = $1`,
      [job1]
    );
    expect(completedRow.rows[0].status).toBe('completed');

    const jobAfterComplete = await storageCleanupService.enqueueCleanupJob({
      objectKey: 'products/reusable-key.jpg',
      objectKind: 'product_image',
      reason: 'post_complete_reuse',
      initialDelayMs: 0,
    });
    expect(jobAfterComplete).toBeGreaterThan(job1!);

    // Concurrent SKIP LOCKED workers + NULL/expired lease recovery: each job deleted strictly ONCE
    await pool.query('TRUNCATE storage_cleanup_jobs RESTART IDENTITY');
    await pool.query(`
      INSERT INTO storage_cleanup_jobs (object_key, object_kind, reason, status, attempt_count, max_attempts, next_attempt_at, lease_expires_at)
      VALUES
        ('products/c1.jpg', 'product_image', 't', 'pending', 0, 5, NOW() - interval '1 second', NULL),
        ('products/c2.jpg', 'product_image', 't', 'pending', 0, 5, NOW() - interval '1 second', NULL),
        ('products/c3.jpg', 'product_image', 't', 'pending', 0, 5, NOW() - interval '1 second', NULL),
        ('products/c4.jpg', 'product_image', 't', 'pending', 0, 5, NOW() - interval '1 second', NULL),
        ('products/expired-lease.jpg', 'product_image', 't', 'processing', 1, 5, NOW() - interval '30 seconds', NOW() - interval '10 seconds'),
        ('products/null-lease.jpg', 'product_image', 't', 'processing', 1, 5, NOW() - interval '30 seconds', NULL)
    `);

    const deletedKeys: string[] = [];
    deleteSpy.mockImplementation(async (key: string) => {
      await new Promise((r) => setTimeout(r, 15));
      deletedKeys.push(key);
    });

    const wA = new StorageCleanupWorker({ batchSize: 2, registerGlobalListener: false });
    const wB = new StorageCleanupWorker({ batchSize: 2, registerGlobalListener: false });
    await Promise.all([wA.drainNow(), wB.drainNow()]);
    await Promise.all([wA.dispose(), wB.dispose()]);

    expect(deletedKeys).toHaveLength(6);
    expect(new Set(deletedKeys).size).toBe(6);

    // Exhaustion -> dead_letter with redacted error message
    vi.spyOn(console, 'error').mockImplementation(() => {});
    deleteSpy.mockRejectedValue(
      new Error('R2 503 https://bucket.r2.dev/products/fail.jpg?X-Amz-Signature=supersecret999')
    );
    const deadJobId = await storageCleanupService.enqueueCleanupJob({
      objectKey: 'products/fail-dlq.jpg',
      objectKind: 'product_image',
      reason: 'dlq_test',
      maxAttempts: 2,
      initialDelayMs: 0,
    });
    const wDlq = new StorageCleanupWorker({ batchSize: 5, baseBackoffMs: 0, maxBackoffMs: 0, registerGlobalListener: false });
    await wDlq.drainNow(); // attempt 1 -> failed
    await pool.query(`UPDATE storage_cleanup_jobs SET next_attempt_at = NOW() - interval '1 second' WHERE id = $1`, [
      deadJobId,
    ]);
    await wDlq.drainNow(); // attempt 2 -> dead_letter
    await wDlq.dispose();

    const dlqCheck = await pool.query(
      `SELECT status, attempt_count, last_error FROM storage_cleanup_jobs WHERE id = $1`,
      [deadJobId]
    );
    expect(dlqCheck.rows[0].status).toBe('dead_letter');
    expect(Number(dlqCheck.rows[0].attempt_count)).toBe(2);
    expect(dlqCheck.rows[0].last_error).toContain('[redacted-signed-url]');
    expect(dlqCheck.rows[0].last_error).not.toContain('supersecret999');
  });

  it('6. Real PG Financial Invariants (ROUND_HALF_UP, FIFO, Concurrent Overpay Guard, Idempotency) & Session/CSRF Logout Revocation', async () => {
    const prod = await productsService.createProduct('Financial Precision Sugar', '40.00', '1701', null);
    const cust = await khataService.createCustomer({ name: 'Financial Audit Buyer', phone: '9866600001' });

    // 1.25 * 10.02 = 12.525 -> ROUND_HALF_UP => 12.53
    const tx = await khataService.createTransaction({
      customer: { id: cust.id, name: cust.name, phone: cust.phone },
      items: [{ productId: prod.id, quantity: '1.25', sellingPrice: '10.02' }],
      initialPayment: '2.53',
      note: 'Rounding precision check',
    });
    expect(tx.totalAmount).toBe('12.53');

    // Concurrent overpay race against remaining ₹10.00 -> strictly one ₹8.00 payment succeeds
    const [p1, p2] = await Promise.allSettled([
      khataService.recordPayment(cust.id, '8.00', 'Concurrent pay 1'),
      khataService.recordPayment(cust.id, '8.00', 'Concurrent pay 2'),
    ]);
    expect([p1, p2].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect([p1, p2].filter((r) => r.status === 'rejected')).toHaveLength(1);

    const ledger = await khataService.getCustomerDetail(cust.id);
    expect(ledger?.totalUdhar).toBe('12.53');
    expect(ledger?.totalReceived).toBe('10.53');
    expect(ledger?.outstanding).toBe('2.00');

    // Idempotency helper store + replay check
    const payloadHash = hashIdempotencyPayload({ customerId: cust.id, amount: '2.00' });
    await storeIdempotencyRecord(pool, {
      key: 'r30-idem-key-1',
      action: 'POST:/api/v1/khata/payments',
      requestHash: payloadHash,
      responseStatus: 200,
      responseBody: { success: true, remaining: '0.00' },
    });
    const replayed = await checkIdempotencyRecord(
      pool,
      'r30-idem-key-1',
      'POST:/api/v1/khata/payments',
      payloadHash
    );
    expect(replayed).toEqual({
      found: true,
      expired: false,
      responseStatus: 200,
      responseBody: { success: true, remaining: '0.00' },
    });

    // Session & CSRF HTTP enforcement + server-side logout destruction in PG session table
    const app = createApp();
    const { agent, csrfToken } = await loginAuthenticatedAgent(app);

    await agent
      .post('/api/v1/products')
      .send({ name: 'Missing CSRF', buying_price: '10.00' })
      .expect(403);

    await agent
      .post('/api/v1/products')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'CSRF Validated Product', buying_price: '15.00' })
      .expect(201);

    await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrfToken).expect(200);
    await agent.get('/api/v1/auth/me').expect(401);
  });
});
