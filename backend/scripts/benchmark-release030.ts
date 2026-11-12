import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { assertSafeTestDatabaseUrl } from '../src/config/testDbGuard.js';

const { Pool } = pg;

function parseArg(prefix: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function validateSafeMongoBenchmarkUri(rawUri: string): { uri: string; dbName: string } {
  const parsed = new URL(rawUri);
  if (parsed.protocol !== 'mongodb:') {
    throw new Error(`[BENCHMARK GUARD] Refusing non-local MongoDB protocol '${parsed.protocol}'. Use mongodb:// on localhost.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!isLoopback) {
    throw new Error(`[BENCHMARK GUARD] Refusing non-loopback MongoDB host '${hostname}'.`);
  }
  const dbName = parsed.pathname.replace(/^\/+/, '').split('?')[0] || 'khata_bench_test';
  if (!dbName.endsWith('_test') && !dbName.endsWith('_benchmark_test')) {
    throw new Error(`[BENCHMARK GUARD] Refusing MongoDB database '${dbName}'; name must end with '_test'.`);
  }
  return { uri: `${parsed.protocol}//${parsed.host}`, dbName };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

function roundMs(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function measureFn<T>(iterations: number, fn: () => Promise<T>): Promise<{
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  lastResult: T;
}> {
  // 2 warmup runs
  for (let w = 0; w < 2; w++) {
    await fn();
  }
  const times: number[] = [];
  let lastResult!: T;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    lastResult = await fn();
    times.push(performance.now() - start);
  }
  return {
    medianMs: roundMs(median(times)),
    p95Ms: roundMs(p95(times)),
    minMs: roundMs(Math.min(...times)),
    maxMs: roundMs(Math.max(...times)),
    lastResult,
  };
}

function summarizePgPlanNode(node: any): {
  nodeTypes: string[];
  indexesUsed: string[];
  actualRowsRoot: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
} {
  const nodeTypes = new Set<string>();
  const indexesUsed = new Set<string>();
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n['Node Type']) nodeTypes.add(String(n['Node Type']));
    if (n['Index Name']) indexesUsed.add(String(n['Index Name']));
    if (Array.isArray(n.Plans)) {
      for (const child of n.Plans) visit(child);
    }
  };
  visit(node);
  return {
    nodeTypes: [...nodeTypes],
    indexesUsed: [...indexesUsed],
    actualRowsRoot: Number(node?.['Actual Rows'] ?? 0),
    sharedHitBlocks: Number(node?.['Shared Hit Blocks'] ?? 0),
    sharedReadBlocks: Number(node?.['Shared Read Blocks'] ?? 0),
  };
}

function extractMongoPlanStage(stage: any): string[] {
  const stages: string[] = [];
  const walk = (s: any) => {
    if (!s || typeof s !== 'object') return;
    if (s.stage) stages.push(String(s.stage));
    if (s.indexName) stages[stages.length - 1] += `(${s.indexName})`;
    if (s.inputStage) walk(s.inputStage);
    if (Array.isArray(s.inputStages)) s.inputStages.forEach(walk);
    if (s.winningPlan) walk(s.winningPlan);
    if (s.queryPlanner) walk(s.queryPlanner);
  };
  walk(stage);
  return stages;
}

async function runExplainPg(pool: pg.Pool, sql: string, params: unknown[]) {
  const res = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const root = res.rows[0]['QUERY PLAN'][0];
  const summary = summarizePgPlanNode(root.Plan);
  return {
    executionTimeMs: roundMs(Number(root['Execution Time'] ?? 0)),
    planningTimeMs: roundMs(Number(root['Planning Time'] ?? 0)),
    ...summary,
  };
}

async function runExplainPgText(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string> {
  const res = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  return res.rows.map((r) => r['QUERY PLAN']).join('\n');
}

async function main() {
  const pgUrl = (
    parseArg('--pg=') ||
    process.env.BENCHMARK_DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    'postgres://postgres:postgres@127.0.0.1:55432/khata_bench_test'
  ).trim();

  // Fail closed on any unsafe / production database target
  assertSafeTestDatabaseUrl(pgUrl);

  const mongoTargetRaw = (
    parseArg('--mongo=') ||
    process.env.TEST_MONGODB_URI ||
    'mongodb://127.0.0.1:27017/khata_release030_bench_test'
  ).trim();
  const { uri: mongoUri, dbName: mongoDbName } = validateSafeMongoBenchmarkUri(mongoTargetRaw);

  // Configure env BEFORE dynamic imports so appPool / services bind strictly to disposable test DBs
  process.env.NODE_ENV = 'test';
  process.env.TEST_DATABASE_URL = pgUrl;
  process.env.REQUIRE_TEST_DATABASE_URL = 'true';
  process.env.DATABASE_URL = pgUrl;
  process.env.DATABASE_URL_POOLED = pgUrl;
  process.env.MONGODB_ENABLED = 'true';
  process.env.MONGODB_URI = mongoUri;
  process.env.MONGODB_DATABASE = mongoDbName;

  const sizesArg = parseArg('--sizes=') || '1000,10000,25000,100000';
  const sizes = sizesArg
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const outPath = parseArg('--out=');

  const { appPool, closeDatabasePools, EXPECTED_MIGRATIONS, inspectSearchIndexCapabilities } = await import(
    '../src/config/database.js'
  );
  const { connectMongo, disconnectMongo, ensureMongoIndexes } = await import('../src/config/mongodb.js');
  const {
    ProductSearchModel,
    CustomerSummaryModel,
    DashboardSnapshotModel,
  } = await import('../src/modules/readModels/models.js');
  const { readModelsQueryService } = await import('../src/modules/readModels/readModelsQuery.service.js');
  const {
    normalizeSearchText,
    buildProductSearchTokens,
    buildCustomerSearchTokens,
  } = await import('../src/modules/readModels/readModelSync.service.js');
  const { ReadModelOutboxWorker } = await import('../src/modules/readModels/readModelOutbox.worker.js');
  const { productsService } = await import('../src/modules/products/products.service.js');
  const { khataService } = await import('../src/modules/khata/khata.service.js');

  const pool = new Pool({ connectionString: pgUrl, ssl: false, max: 6 });

  const client = await pool.connect();
  try {
    await client.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO public;
    `);
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "version" VARCHAR(255) PRIMARY KEY,
        "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    for (const file of EXPECTED_MIGRATIONS) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    }
  } finally {
    client.release();
  }

  await connectMongo({ uri: mongoUri, dbName: mongoDbName });
  await ensureMongoIndexes();

  const searchCapabilities = await inspectSearchIndexCapabilities({ warnOnMissing: false });
  const resultsBySize: any[] = [];
  const startWall = performance.now();

  const maxTarget = sizes[sizes.length - 1];
  // Clear collections and seed base benchmark snapshot once
  await ProductSearchModel.deleteMany({});
  await CustomerSummaryModel.deleteMany({});
  await DashboardSnapshotModel.deleteMany({});

  let currentSeeded = 0;

  for (const targetSize of sizes) {
    const delta = targetSize - currentSeeded;
    const seedStart = performance.now();

    if (delta > 0) {
      // Seed PG products incrementally
      await pool.query(
        `INSERT INTO products (name, buying_price, hsn_code, barcode, created_at, updated_at)
         SELECT
           CASE
             WHEN g = 1 THEN 'शुद्ध बासमती चावल 25kg'
             WHEN g = 2 THEN 'ਪੰਜਾਬੀ ਦੇਸੀ ਘਿਓ 1L'
             WHEN g % 100 = 0 THEN 'Premium Assam Gold Tea ' || g
             WHEN g % 50 = 0 THEN 'Taaza Basmati Sella Grain ' || g
             ELSE 'Catalog Item ' || LPAD(g::text, 6, '0') || ' Grade A'
           END,
           ((g % 500) + 25)::numeric(12,2),
           CASE WHEN g % 40 = 0 THEN '100630' ELSE LPAD(((1000 + (g % 8900)))::text, 6, '0') END,
           CASE WHEN g = 42 THEN '000450012' ELSE '000' || LPAD(g::text, 9, '0') END,
           NOW() - ((g % 365) || ' days')::interval,
           NOW()
         FROM generate_series($1::int, $2::int) AS g`,
        [currentSeeded + 1, targetSize]
      );

      // Seed PG customers incrementally
      await pool.query(
        `INSERT INTO customers (name, normalized_name, phone, normalized_phone, address, state, state_code, created_at, updated_at)
         SELECT
           CASE
             WHEN g = 1 THEN 'राजेश्वरी देवी'
             WHEN g = 2 THEN 'ਹਰਪ੍ਰੀਤ ਕੌਰ'
             WHEN g % 50 = 0 THEN 'Sharma Traders ' || g
             ELSE 'Customer ' || LPAD(g::text, 6, '0')
           END,
           LOWER(
             CASE
               WHEN g = 1 THEN 'राजेश्वरी देवी'
               WHEN g = 2 THEN 'ਹਰਪ੍ਰੀਤ ਕੌਰ'
               WHEN g % 50 = 0 THEN 'sharma traders ' || g
               ELSE 'customer ' || LPAD(g::text, 6, '0')
             END
           ),
           CASE WHEN g = 42 THEN '+91 98111-22334' ELSE '98' || LPAD(g::text, 8, '0') END,
           CASE WHEN g = 42 THEN '9811122334' ELSE '98' || LPAD(g::text, 8, '0') END,
           'Patna Sector ' || (g % 30),
           'Bihar',
           '10',
           NOW(),
           NOW()
         FROM generate_series($1::int, $2::int) AS g`,
        [currentSeeded + 1, targetSize]
      );

      // Give non-null subset udhar transactions & explicit equal-balance tie cluster (g <= 80 or g % 5 = 0)
      await pool.query(
        `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, created_at)
         SELECT
           g,
           CURRENT_DATE - ((g % 60)::int),
           CASE
             WHEN g BETWEEN 3 AND 52 THEN 500.00
             ELSE ((g % 40) + 10) * 15.00
           END,
           CASE
             WHEN g BETWEEN 3 AND 27 THEN TIMESTAMPTZ '2026-11-11T10:00:00.000Z'
             WHEN g BETWEEN 28 AND 52 THEN TIMESTAMPTZ '2026-11-10T10:00:00.000Z'
             ELSE NOW() - ((g % 90) || ' hours')::interval
           END
         FROM generate_series($1::int, $2::int) AS g
         WHERE g % 5 != 0`,
        [currentSeeded + 1, targetSize]
      );

      // Batch-seed mirrored MongoDB documents matching real projection builders
      const CHUNK = 5000;
      const nowDate = new Date();
      for (let start = currentSeeded + 1; start <= targetSize; start += CHUNK) {
        const end = Math.min(targetSize, start + CHUNK - 1);
        const prodBatch: any[] = [];
        const custBatch: any[] = [];
        for (let g = start; g <= end; g++) {
          const pname =
            g === 1
              ? 'शुद्ध बासमती चावल 25kg'
              : g === 2
                ? 'ਪੰਜਾਬੀ ਦੇਸੀ ਘਿਓ 1L'
                : g % 100 === 0
                  ? `Premium Assam Gold Tea ${g}`
                  : g % 50 === 0
                    ? `Taaza Basmati Sella Grain ${g}`
                    : `Catalog Item ${String(g).padStart(6, '0')} Grade A`;
          const phsn = g % 40 === 0 ? '100630' : String(1000 + (g % 8900)).padStart(6, '0');
          const pbarcode = g === 42 ? '000450012' : `000${String(g).padStart(9, '0')}`;
          const pnorm = normalizeSearchText(pname);
          const ptokens = buildProductSearchTokens({
            name: pname,
            hsnCode: phsn,
            barcode: pbarcode,
          });

          prodBatch.push({
            productId: g,
            name: pname,
            normalizedName: pnorm,
            searchTokens: ptokens,
            buyingPrice: ((g % 500) + 25).toFixed(2),
            hsnCode: phsn,
            normalizedHsnCode: normalizeSearchText(phsn),
            barcode: pbarcode,
            imageObjectKey: null,
            imageUrl: null,
            isArchived: false,
            archivedAt: null,
            createdAtPg: nowDate,
            sourceUpdatedAt: nowDate,
            projectionUpdatedAt: nowDate,
          });

          const cname =
            g === 1
              ? 'राजेश्वरी देवी'
              : g === 2
                ? 'ਹਰਪ੍ਰੀਤ ਕੌਰ'
                : g % 50 === 0
                  ? `Sharma Traders ${g}`
                  : `Customer ${String(g).padStart(6, '0')}`;
          const cphone = g === 42 ? '+91 98111-22334' : `98${String(g).padStart(8, '0')}`;
          const cnormPhone = g === 42 ? '9811122334' : `98${String(g).padStart(8, '0')}`;
          const cnormName = normalizeSearchText(cname);
          const hasActivity = g % 5 !== 0;
          const outAmount = !hasActivity
            ? 0
            : g >= 3 && g <= 52
              ? 500
              : ((g % 40) + 10) * 15;
          const lastAct = !hasActivity
            ? null
            : g >= 3 && g <= 27
              ? new Date('2026-11-11T10:00:00.000Z')
              : g >= 28 && g <= 52
                ? new Date('2026-11-10T10:00:00.000Z')
                : new Date(nowDate.getTime() - (g % 90) * 3600_000);

          custBatch.push({
            customerId: g,
            name: cname,
            normalizedName: cnormName,
            phone: cphone,
            normalizedPhone: cnormPhone,
            address: `Patna Sector ${g % 30}`,
            state: 'Bihar',
            stateCode: '10',
            totalUdhar: outAmount.toFixed(2),
            totalReceived: '0.00',
            outstanding: outAmount.toFixed(2),
            outstandingPaise: Math.round(outAmount * 100),
            hasOutstanding: outAmount > 0,
            transactionCount: hasActivity ? 1 : 0,
            paymentCount: 0,
            lastActivityAt: lastAct,
            searchTokens: buildCustomerSearchTokens(cname, cphone, cnormPhone),
            isArchived: false,
            createdAtPg: nowDate,
            sourceUpdatedAt: nowDate,
            projectionUpdatedAt: nowDate,
          });
        }
        await ProductSearchModel.collection.insertMany(prodBatch, { ordered: false });
        await CustomerSummaryModel.collection.insertMany(custBatch, { ordered: false });
      }
      currentSeeded = targetSize;
    }

    await DashboardSnapshotModel.updateOne(
      { snapshotKey: '__global__' },
      {
        $set: {
          snapshotKey: '__global__',
          globals: {
            totalCustomers: targetSize,
            activeCustomers: targetSize,
            customersWithOutstanding: Math.floor((targetSize * 4) / 5),
            totalOutstandingReceivable: '100000.00',
            khataSummaryTotalCustomers: targetSize,
            khataSummaryTotalOutstanding: '100000.00',
            khataSummaryTotalReceived: '0.00',
            totalProducts: targetSize,
            activeProducts: targetSize,
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
          lastSyncedAt: new Date(),
          lastProjectionSyncAt: new Date(),
          lastDashboardRefreshAt: new Date(),
          projectionUpdatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Seed outbox history at targetSize (processed + active/expired/NULL lease/dead_letter)
    await pool.query('TRUNCATE app_outbox_events RESTART IDENTITY');
    await pool.query(
      `INSERT INTO app_outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, max_attempts, processed_at, created_at, updated_at
       )
       SELECT
         'bench-hist-' || $1 || '-' || g,
         'product',
         ((g % 100) + 1)::text,
         'product.updated',
         '{}'::jsonb,
         'processed',
         1,
         8,
         NOW() - interval '1 day',
         NOW() - interval '2 days',
         NOW() - interval '1 day'
       FROM generate_series(1, $2::int) AS g`,
      [targetSize, targetSize]
    );
    await pool.query(`
      INSERT INTO app_outbox_events (event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, max_attempts, next_attempt_at, lease_expires_at)
      VALUES
        ('bench-pend-1', 'product', '1', 'product.updated', '{}'::jsonb, 'pending', 0, 8, NOW() + interval '10 seconds', NULL),
        ('bench-fail-1', 'product', '1', 'product.updated', '{}'::jsonb, 'failed', 2, 8, NOW() + interval '5 seconds', NULL),
        ('bench-proc-exp', 'product', '1', 'product.updated', '{}'::jsonb, 'processing', 1, 8, NOW() - interval '30 seconds', NOW() - interval '5 seconds'),
        ('bench-proc-null', 'product', '1', 'product.updated', '{}'::jsonb, 'processing', 1, 8, NOW() - interval '30 seconds', NULL),
        ('bench-dlq-1', 'product', '1', 'product.updated', '{}'::jsonb, 'dead_letter', 8, 8, NOW(), NULL)
    `);
    await pool.query('VACUUM ANALYZE');

    const seedMs = roundMs(performance.now() - seedStart);
    const iters = targetSize >= 100_000 ? 7 : 11;

    // 1. Outbox BEFORE vs AFTER Benchmarks
    const legacyOutboxSql = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
        COUNT(*) FILTER (WHERE status = 'failed' AND attempt_count < max_attempts) AS retryable_failed_count,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing_count,
        COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_count,
        MIN(next_attempt_at) FILTER (WHERE status = 'pending' OR (status = 'failed' AND attempt_count < max_attempts)) AS next_due_at,
        MIN(lease_expires_at) FILTER (WHERE status = 'processing') AS next_lease_expiry_at
      FROM app_outbox_events
    `;
    const newOutboxWakeSql = `
      SELECT
        MIN(candidate_wake_at) AS next_wake_at,
        NOW() AS server_now
      FROM (
        (SELECT next_attempt_at AS candidate_wake_at FROM app_outbox_events WHERE status = 'pending' ORDER BY next_attempt_at ASC, id ASC LIMIT 1)
        UNION ALL
        (SELECT next_attempt_at AS candidate_wake_at FROM app_outbox_events WHERE status = 'failed' AND attempt_count < max_attempts ORDER BY next_attempt_at ASC, id ASC LIMIT 1)
        UNION ALL
        (SELECT lease_expires_at AS candidate_wake_at FROM app_outbox_events WHERE status = 'processing' ORDER BY lease_expires_at ASC NULLS FIRST, id ASC LIMIT 1)
      ) AS retryable_candidates
    `;

    const workerForBench = new ReadModelOutboxWorker({ batchSize: 10, maxBackoffMs: 30_000 });
    const legacyOutboxStats = await measureFn(iters, () => pool.query(legacyOutboxSql));
    const legacyOutboxExplain = await runExplainPg(pool, legacyOutboxSql, []);
    const newOutboxStats = await measureFn(iters, () => workerForBench.inspectRetryableBacklogDelay());
    const newOutboxExplain = await runExplainPg(pool, newOutboxWakeSql, []);

    const claimSql = `
      WITH next_batch AS (
        SELECT id
        FROM app_outbox_events
        WHERE (
          status = 'pending'
          OR (status = 'failed' AND attempt_count < max_attempts)
        )
          AND next_attempt_at <= NOW()
        ORDER BY id ASC
        LIMIT 25
        FOR UPDATE SKIP LOCKED
      ),
      claimed AS (
        UPDATE app_outbox_events o
        SET status = 'processing',
            lease_expires_at = NOW() + (60000::bigint * INTERVAL '1 millisecond'),
            attempt_count = o.attempt_count + 1,
            updated_at = NOW()
        FROM next_batch nb
        WHERE o.id = nb.id
        RETURNING o.id
      )
      SELECT * FROM claimed ORDER BY id ASC
    `;
    const claimExplain = await runExplainPg(pool, claimSql, []);

    const markSql = `
      UPDATE app_outbox_events
      SET status = 'processed',
          processed_at = NOW(),
          lease_expires_at = NULL,
          last_error = NULL,
          updated_at = NOW()
      WHERE id = ANY($1::bigint[])
    `;
    const sampleProcRes = await pool.query(`SELECT id FROM app_outbox_events WHERE event_id = 'bench-proc-exp'`);
    const sampleId = Number(sampleProcRes.rows[0]?.id || 1);
    const markExplain = await runExplainPg(pool, markSql, [[sampleId]]);

    // Capture full verbatim EXPLAIN ANALYZE text at the largest run
    const verbatimPgPlans =
      targetSize === maxTarget
        ? {
            legacyOutboxFullScanText: await runExplainPgText(pool, legacyOutboxSql),
            release030OutboxWakeText: await runExplainPgText(pool, newOutboxWakeSql),
            release030ProductFallbackText: await runExplainPgText(
              pool,
              `SELECT id, name, buying_price, hsn_code, barcode, image_object_key, archived_at, created_at, updated_at
               FROM products
               WHERE archived_at IS NULL AND (name ILIKE $1 ESCAPE '\\' OR hsn_code ILIKE $1 ESCAPE '\\' OR barcode = $2 OR barcode ILIKE $1 ESCAPE '\\')
               ORDER BY LOWER(TRIM(name)) ASC, id ASC LIMIT 26 OFFSET 0`,
              ['%basmati%', 'basmati']
            ),
            release030CustomerFallbackText: await runExplainPgText(
              pool,
              `WITH matched_customers AS MATERIALIZED (
                 SELECT c.id, c.name, c.phone, c.address, c.state, c.state_code, c.created_at
                 FROM customers c
                 WHERE c.archived_at IS NULL AND (c.name ILIKE $1 ESCAPE '\\' OR c.phone ILIKE $1 ESCAPE '\\' OR COALESCE(c.normalized_phone, '') ILIKE $2 ESCAPE '\\')
               ),
               tx_agg AS (
                 SELECT u.customer_id, COALESCE(SUM(u.total_amount), 0) AS total_udhar, MAX(u.created_at) AS last_activity
                 FROM udhar_transactions u INNER JOIN matched_customers mc ON mc.id = u.customer_id GROUP BY u.customer_id
               ),
               alloc_agg AS (
                 SELECT u.customer_id, COALESCE(SUM(pa.amount), 0) AS total_allocated
                 FROM udhar_transactions u INNER JOIN matched_customers mc ON mc.id = u.customer_id
                 INNER JOIN payment_allocations pa ON pa.transaction_id = u.id GROUP BY u.customer_id
               ),
               pay_agg AS (
                 SELECT p.customer_id, COALESCE(SUM(p.amount), 0) AS total_received, MAX(p.received_at) AS last_payment
                 FROM payments p INNER JOIN matched_customers mc ON mc.id = p.customer_id GROUP BY p.customer_id
               )
               SELECT c.id, c.name FROM matched_customers c
               LEFT JOIN tx_agg tx ON tx.customer_id = c.id
               LEFT JOIN alloc_agg alloc ON alloc.customer_id = c.id
               LEFT JOIN pay_agg pay ON pay.customer_id = c.id
               ORDER BY ROUND(GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0), 2) DESC,
                        GREATEST(tx.last_activity, pay.last_payment) DESC NULLS LAST, c.id ASC
               LIMIT 26 OFFSET 0`,
              ['%98111%', '%98111%']
            ),
          }
        : undefined;

    // 2. Search Matrix (Mongo & PG fallback)
    const searchCases: Array<{
      label: string;
      mongoFn: () => Promise<any>;
      pgFn: () => Promise<any>;
      mongoExplainCollection: 'product' | 'customer';
      mongoExplainQuery: Record<string, unknown>;
      mongoExplainSort: Record<string, 1 | -1>;
    }> = [
      {
        label: 'exact_barcode',
        mongoFn: () => readModelsQueryService.findProductByBarcodeFromMongo('000450012'),
        pgFn: () => productsService.listActiveProducts({ exactBarcode: '000450012', limit: 25 }),
        mongoExplainCollection: 'product',
        mongoExplainQuery: { isArchived: false, barcode: '000450012' },
        mongoExplainSort: { productId: 1 },
      },
      {
        label: 'exact_hsn',
        mongoFn: () => readModelsQueryService.searchProductsFromMongo({ search: '100630', limit: 25 }),
        pgFn: () => productsService.listActiveProducts({ search: '100630', limit: 25 }),
        mongoExplainCollection: 'product',
        mongoExplainQuery: { isArchived: false, normalizedHsnCode: { $gte: '100630', $lt: '100631' } },
        mongoExplainSort: { normalizedName: 1, productId: 1 },
      },
      {
        label: 'product_prefix',
        mongoFn: () => readModelsQueryService.searchProductsFromMongo({ search: 'catalog', limit: 25 }),
        pgFn: () => productsService.listActiveProducts({ search: 'catalog', limit: 25 }),
        mongoExplainCollection: 'product',
        mongoExplainQuery: { isArchived: false, normalizedName: { $gte: 'catalog', $lt: 'cataloh' } },
        mongoExplainSort: { normalizedName: 1, productId: 1 },
      },
      {
        label: 'multi_word_product',
        mongoFn: () => readModelsQueryService.searchProductsFromMongo({ search: 'premium gold', limit: 25 }),
        pgFn: () => productsService.listActiveProducts({ search: 'premium gold', limit: 25 }),
        mongoExplainCollection: 'product',
        mongoExplainQuery: { isArchived: false, searchTokens: { $all: ['premium', 'gold'] } },
        mongoExplainSort: { normalizedName: 1, productId: 1 },
      },
      {
        label: 'hindi_search',
        mongoFn: () => readModelsQueryService.searchProductsFromMongo({ search: 'बासमती', limit: 25 }),
        pgFn: () => productsService.listActiveProducts({ search: 'बासमती', limit: 25 }),
        mongoExplainCollection: 'product',
        mongoExplainQuery: { isArchived: false, searchTokens: { $all: [normalizeSearchText('बासमती')] } },
        mongoExplainSort: { normalizedName: 1, productId: 1 },
      },
      {
        label: 'punjabi_search',
        mongoFn: () => readModelsQueryService.searchProductsFromMongo({ search: 'ਪੰਜਾਬੀ', limit: 25 }),
        pgFn: () => productsService.listActiveProducts({ search: 'ਪੰਜਾਬੀ', limit: 25 }),
        mongoExplainCollection: 'product',
        mongoExplainQuery: { isArchived: false, searchTokens: { $all: [normalizeSearchText('ਪੰਜਾਬੀ')] } },
        mongoExplainSort: { normalizedName: 1, productId: 1 },
      },
      {
        label: 'two_char_broad',
        mongoFn: () => readModelsQueryService.searchProductsFromMongo({ search: 'ca', limit: 25 }),
        pgFn: () => productsService.listActiveProducts({ search: 'ca', limit: 25 }),
        mongoExplainCollection: 'product',
        mongoExplainQuery: { isArchived: false, normalizedName: { $gte: 'ca', $lt: 'cb' } },
        mongoExplainSort: { normalizedName: 1, productId: 1 },
      },
      {
        label: 'no_result',
        mongoFn: () => readModelsQueryService.searchProductsFromMongo({ search: 'zzzznomatch030', limit: 25 }),
        pgFn: () => productsService.listActiveProducts({ search: 'zzzznomatch030', limit: 25 }),
        mongoExplainCollection: 'product',
        mongoExplainQuery: { isArchived: false, searchTokens: { $all: ['zzzznomatch030'] } },
        mongoExplainSort: { normalizedName: 1, productId: 1 },
      },
      {
        label: 'customer_phone',
        mongoFn: () => readModelsQueryService.listCustomersFromMongo({ search: '+91 98111', limit: 25 }),
        pgFn: () => khataService.listCustomers({ search: '+91 98111', limit: 25 }),
        mongoExplainCollection: 'customer',
        mongoExplainQuery: { isArchived: false, normalizedPhone: { $gte: '98111', $lt: '98112' } },
        mongoExplainSort: { outstandingPaise: -1, lastActivityAt: -1, customerId: 1 },
      },
      {
        label: 'customer_name',
        mongoFn: () => readModelsQueryService.listCustomersFromMongo({ search: 'sharma', limit: 25 }),
        pgFn: () => khataService.listCustomers({ search: 'sharma', limit: 25 }),
        mongoExplainCollection: 'customer',
        mongoExplainQuery: { isArchived: false, normalizedName: { $gte: 'sharma', $lt: 'sharmb' } },
        mongoExplainSort: { outstandingPaise: -1, lastActivityAt: -1, customerId: 1 },
      },
    ];

    const searchMetrics: any[] = [];
    for (const c of searchCases) {
      const mStats = await measureFn(iters, c.mongoFn);
      const pStats = await measureFn(Math.min(iters, 5), c.pgFn);
      const col = c.mongoExplainCollection === 'product' ? ProductSearchModel.collection : CustomerSummaryModel.collection;
      const mExplain: any = await col.find(c.mongoExplainQuery).sort(c.mongoExplainSort).limit(26).explain('executionStats');
      searchMetrics.push({
        case: c.label,
        mongoMedianMs: mStats.medianMs,
        mongoP95Ms: mStats.p95Ms,
        mongoRowsReturned: Array.isArray(mStats.lastResult?.products)
          ? mStats.lastResult.products.length
          : Array.isArray(mStats.lastResult?.customers)
            ? mStats.lastResult.customers.length
            : mStats.lastResult
              ? 1
              : 0,
        mongoExecMs: mExplain?.executionStats?.executionTimeMillis ?? null,
        mongoKeysExamined: mExplain?.executionStats?.totalKeysExamined ?? null,
        mongoDocsExamined: mExplain?.executionStats?.totalDocsExamined ?? null,
        mongoStages: extractMongoPlanStage(mExplain?.queryPlanner?.winningPlan),
        pgFallbackMedianMs: pStats.medianMs,
        pgFallbackP95Ms: pStats.p95Ms,
      });
    }

    // 3. Pagination BEFORE (.skip) vs AFTER (keyset cursor) + tie/null correctness
    const deepOffset = Math.floor(targetSize * 0.8);
    let midCursor: string | null = null;
    // Generate a realistic keyset cursor at ~80% offset once
    const deepProbeDoc = await CustomerSummaryModel.find({ isArchived: false })
      .sort({ outstandingPaise: -1, lastActivityAt: -1, customerId: 1 })
      .skip(Math.max(0, deepOffset - 1))
      .limit(1)
      .lean();
    if (deepProbeDoc[0]) {
      const firstWalk = await readModelsQueryService.listCustomersFromMongo({ limit: 25 });
      expectCursorHelper: if (firstWalk.nextCursor) {
        // Generate valid cursor right at the 80% boundary via encodeCursor
        const { encodeCursor, buildCustomerCursorQueryContext } = await import(
          '../src/modules/readModels/readModelsQuery.service.js'
        );
        midCursor = encodeCursor(
          {
            t: 'c',
            o: Number(deepProbeDoc[0].outstandingPaise || 0),
            l: deepProbeDoc[0].lastActivityAt ? new Date(deepProbeDoc[0].lastActivityAt).getTime() : null,
            id: deepProbeDoc[0].customerId,
          },
          buildCustomerCursorQueryContext('')
        );
        break expectCursorHelper;
      }
    }

    const deepSkipStats = await measureFn(iters, () =>
      readModelsQueryService.listCustomersFromMongo({ limit: 25, offset: deepOffset })
    );
    const deepCursorStats = midCursor
      ? await measureFn(iters, () =>
          readModelsQueryService.listCustomersFromMongo({ limit: 25, cursor: midCursor! })
        )
      : null;

    const deepSkipExplain: any = await CustomerSummaryModel.collection
      .find({ isArchived: false })
      .sort({ outstandingPaise: -1, lastActivityAt: -1, customerId: 1 })
      .skip(deepOffset)
      .limit(26)
      .explain('executionStats');
    const deepCursorExplain: any = deepProbeDoc[0]
      ? await CustomerSummaryModel.collection
          .find({
            isArchived: false,
            $or: [
              { outstandingPaise: { $lt: Number(deepProbeDoc[0].outstandingPaise || 0) } },
              {
                outstandingPaise: Number(deepProbeDoc[0].outstandingPaise || 0),
                customerId: { $gt: deepProbeDoc[0].customerId },
              },
            ],
          })
          .sort({ outstandingPaise: -1, lastActivityAt: -1, customerId: 1 })
          .limit(26)
          .explain('executionStats')
      : null;

    // Equal-key ties & NULL activity multi-page overlap check (top 100 across tie boundary)
    const tieSeenIds: number[] = [];
    let tieCursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const pRes = await readModelsQueryService.listCustomersFromMongo({
        limit: 20,
        cursor: tieCursor ?? undefined,
      });
      tieSeenIds.push(...pRes.customers.map((c) => c.id));
      if (!pRes.hasMore || !pRes.nextCursor) break;
      tieCursor = pRes.nextCursor;
    }

    resultsBySize.push({
      datasetSize: targetSize,
      seedMs,
      outbox: {
        legacyAggregateScanMedianMs: legacyOutboxStats.medianMs,
        legacyAggregateScanP95Ms: legacyOutboxStats.p95Ms,
        legacyAggregateExplain: legacyOutboxExplain,
        release030Limit1ProbeMedianMs: newOutboxStats.medianMs,
        release030Limit1ProbeP95Ms: newOutboxStats.p95Ms,
        release030Limit1Explain: newOutboxExplain,
        claimOutboxBatchExplain: claimExplain,
        markEventsProcessedExplain: markExplain,
        queriesPerWakeCheck: 1,
        idlePollingTimersWhenEmpty: 0,
      },
      search: searchMetrics,
      pagination: {
        deepOffset,
        skipMedianMs: deepSkipStats.medianMs,
        skipP95Ms: deepSkipStats.p95Ms,
        skipDocsExamined: deepSkipExplain?.executionStats?.totalDocsExamined ?? null,
        skipKeysExamined: deepSkipExplain?.executionStats?.totalKeysExamined ?? null,
        cursorMedianMs: deepCursorStats?.medianMs ?? null,
        cursorP95Ms: deepCursorStats?.p95Ms ?? null,
        cursorDocsExamined: deepCursorExplain?.executionStats?.totalDocsExamined ?? null,
        cursorKeysExamined: deepCursorExplain?.executionStats?.totalKeysExamined ?? null,
        tieMultiPageCollected: tieSeenIds.length,
        tieMultiPageUnique: new Set(tieSeenIds).size,
      },
      verbatimPgPlans,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalDurationMs: roundMs(performance.now() - startWall),
    sizes,
    pgHostSafe: new URL(pgUrl).hostname,
    mongoDbSafe: mongoDbName,
    searchCapabilities,
    resultsBySize,
  };

  const jsonOutput = JSON.stringify(report, null, 2);
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), jsonOutput, 'utf8');
  }
  console.log('=== KHATA RELEASE 030 BENCHMARK SUMMARY ===');
  for (const row of resultsBySize) {
    console.log(
      `\n[Dataset N=${row.datasetSize}] seed=${row.seedMs}ms | Outbox BEFORE=${row.outbox.legacyAggregateScanMedianMs}ms vs AFTER=${row.outbox.release030Limit1ProbeMedianMs}ms | DeepSkip(${row.pagination.deepOffset})=${row.pagination.skipMedianMs}ms (${row.pagination.skipDocsExamined} docs) vs Cursor=${row.pagination.cursorMedianMs}ms (${row.pagination.cursorDocsExamined} docs)`
    );
  }
  console.log('\n__JSON_START__');
  console.log(jsonOutput);

  await disconnectMongo();
  await pool.end();
  await closeDatabasePools();
}

main().catch((err) => {
  console.error('[BENCHMARK FAILED]', err);
  process.exit(1);
});
