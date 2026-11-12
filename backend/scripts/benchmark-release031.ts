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
  // Warmup runs
  for (let w = 0; w < 2; w++) {
    try {
      await fn();
    } catch {
      // Warmup ignore
    }
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

async function runExplainPg(pool: pg.Pool, sql: string, params: unknown[] = []) {
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
    'mongodb://127.0.0.1:27017/khata_release031_bench_test'
  ).trim();
  const { uri: mongoUri, dbName: mongoDbName } = validateSafeMongoBenchmarkUri(mongoTargetRaw);

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
  const { acquireObjectSessionLock, releaseObjectSessionLock } = await import('../src/services/storageObjectLock.js');

  const pool = new Pool({ connectionString: pgUrl, ssl: false, max: 10 });

  console.log('[BENCHMARK] Applying migrations to disposable test database...');
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
  await ProductSearchModel.deleteMany({});
  await CustomerSummaryModel.deleteMany({});
  await DashboardSnapshotModel.deleteMany({});

  let currentSeeded = 0;

  for (const targetSize of sizes) {
    const delta = targetSize - currentSeeded;
    const seedStart = performance.now();

    if (delta > 0) {
      // Seed PG products
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

      // Seed PG customers
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

      // Seed udhar transactions
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

      // Seed MongoDB models
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

    // Release 031 Event Seeding Pattern:
    // Processed history: targetSize rows
    // Ready pending: 1,000 rows
    // Future pending: 500 rows
    // Expired leases: 200 rows
    // Null leases: 100 rows
    // Dead letters: 50 rows
    await pool.query('TRUNCATE app_outbox_events RESTART IDENTITY');
    console.log(`[BENCHMARK] Seeding outbox events for scale N=${targetSize}...`);

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

    // 1,000 ready pending events
    await pool.query(
      `INSERT INTO app_outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at
       )
       SELECT
         'bench-pend-due-' || g,
         'product',
         g::text,
         'product.updated',
         '{}'::jsonb,
         'pending',
         0,
         8,
         NOW() - ((g % 60) || ' seconds')::interval,
         NOW() - interval '10 minutes',
         NOW()
       FROM generate_series(1, 1000) AS g`
    );

    // 500 future pending events
    await pool.query(
      `INSERT INTO app_outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at
       )
       SELECT
         'bench-pend-future-' || g,
         'product',
         g::text,
         'product.updated',
         '{}'::jsonb,
         'pending',
         0,
         8,
         NOW() + ((g * 10) || ' seconds')::interval,
         NOW() - interval '5 minutes',
         NOW()
       FROM generate_series(1, 500) AS g`
    );

    // 200 expired leases
    await pool.query(
      `INSERT INTO app_outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, max_attempts, next_attempt_at, lease_expires_at, created_at, updated_at
       )
       SELECT
         'bench-proc-exp-' || g,
         'product',
         g::text,
         'product.updated',
         '{}'::jsonb,
         'processing',
         1,
         8,
         NOW() - interval '2 minutes',
         NOW() - ((g % 30 + 1) || ' seconds')::interval,
         NOW() - interval '10 minutes',
         NOW()
       FROM generate_series(1, 200) AS g`
    );

    // 100 null leases
    await pool.query(
      `INSERT INTO app_outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, max_attempts, next_attempt_at, lease_expires_at, created_at, updated_at
       )
       SELECT
         'bench-proc-null-' || g,
         'product',
         g::text,
         'product.updated',
         '{}'::jsonb,
         'processing',
         1,
         8,
         NOW() - interval '2 minutes',
         NULL,
         NOW() - interval '10 minutes',
         NOW()
       FROM generate_series(1, 100) AS g`
    );

    // 50 dead letters
    await pool.query(
      `INSERT INTO app_outbox_events (
         event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, max_attempts, dead_letter_at, last_error, created_at, updated_at
       )
       SELECT
         'bench-dlq-' || g,
         'product',
         g::text,
         'product.updated',
         '{}'::jsonb,
         'dead_letter',
         8,
         8,
         NOW() - interval '1 hour',
         'Exhausted max attempts after validation failure',
         NOW() - interval '2 hours',
         NOW()
       FROM generate_series(1, 50) AS g`
    );

    // Seed storage_cleanup_jobs for cleanup worker benchmark
    await pool.query('TRUNCATE storage_cleanup_jobs RESTART IDENTITY');
    await pool.query(
      `INSERT INTO storage_cleanup_jobs (
         object_key, object_kind, reason, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at
       )
       SELECT
         'products/bench/' || g || '.jpg',
         'product_image',
         'product_image_replace',
         'pending',
         0,
         5,
         NOW() - interval '10 seconds',
         NOW() - interval '1 minute',
         NOW()
       FROM generate_series(1, 500) AS g`
    );

    await pool.query('VACUUM ANALYZE');
    const seedMs = roundMs(performance.now() - seedStart);
    const iters = targetSize >= 100_000 ? 7 : 11;

    // Benchmark 1: Outbox Claim Batch Query (Release 031 index-backed FOR UPDATE SKIP LOCKED)
    const claimBatchSql = `
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
    const claimBatchStats = await measureFn(iters, () => pool.query(claimBatchSql));
    const claimBatchExplain = await runExplainPg(pool, claimBatchSql, []);

    // Benchmark 2: Outbox Backlog Check (Limit 1 Union Probe vs Legacy Aggregate Scan)
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
    const limit1WakeSql = `
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
    const legacyStats = await measureFn(iters, () => pool.query(legacyOutboxSql));
    const legacyExplain = await runExplainPg(pool, legacyOutboxSql, []);
    const limit1Stats = await measureFn(iters, () => pool.query(limit1WakeSql));
    const limit1Explain = await runExplainPg(pool, limit1WakeSql, []);

    // Benchmark 3: Storage Cleanup Worker Claim Query
    const cleanupClaimSql = `
      WITH next_jobs AS (
        SELECT id
        FROM storage_cleanup_jobs
        WHERE status IN ('pending', 'failed')
          AND next_attempt_at <= NOW()
        ORDER BY id ASC
        LIMIT 25
        FOR UPDATE SKIP LOCKED
      ),
      claimed AS (
        UPDATE storage_cleanup_jobs j
        SET status = 'processing',
            lease_expires_at = NOW() + INTERVAL '60 seconds',
            attempt_count = j.attempt_count + 1,
            updated_at = NOW()
        FROM next_jobs nj
        WHERE j.id = nj.id
        RETURNING j.id, j.object_key, j.object_kind, j.reason
      )
      SELECT * FROM claimed ORDER BY id ASC
    `;
    const cleanupClaimStats = await measureFn(iters, () => pool.query(cleanupClaimSql));
    const cleanupClaimExplain = await runExplainPg(pool, cleanupClaimSql, []);

    // Benchmark 4: Advisory Lock Contention
    // Test 4a: Parallel distinct key lock acquisition (5 workers)
    const distinctLockStats = await measureFn(iters, async () => {
      const clients = await Promise.all([
        pool.connect(),
        pool.connect(),
        pool.connect(),
        pool.connect(),
        pool.connect(),
      ]);
      try {
        await Promise.all(
          clients.map((c, idx) => acquireObjectSessionLock(c, `bench/distinct/key-${idx}.jpg`))
        );
      } finally {
        await Promise.all(
          clients.map((c, idx) => releaseObjectSessionLock(c, `bench/distinct/key-${idx}.jpg`))
        );
        clients.forEach((c) => c.release());
      }
    });

    // Test 4b: Contended lock acquisition on same key (serialized execution)
    const contendedLockStats = await measureFn(iters, async () => {
      const c1 = await pool.connect();
      const c2 = await pool.connect();
      try {
        await acquireObjectSessionLock(c1, 'bench/shared/contended-key.jpg');
        // c2 attempting the same lock will wait or serialize
        const c2AcquirePromise = acquireObjectSessionLock(c2, 'bench/shared/contended-key.jpg');
        // Release c1 after 5ms
        await new Promise((r) => setTimeout(r, 5));
        await releaseObjectSessionLock(c1, 'bench/shared/contended-key.jpg');
        await c2AcquirePromise;
        await releaseObjectSessionLock(c2, 'bench/shared/contended-key.jpg');
      } finally {
        c1.release();
        c2.release();
      }
    });

    // Benchmark 5: MongoDB Read Models
    const mongoSearchStats = await measureFn(iters, () =>
      readModelsQueryService.searchProductsFromMongo({ search: 'Assam Gold', limit: 25 })
    );
    const mongoCustomerStats = await measureFn(iters, () =>
      readModelsQueryService.listCustomersFromMongo({ search: 'Sharma', limit: 25 })
    );
    const mongoDashboardStats = await measureFn(iters, () =>
      readModelsQueryService.getDashboardOverviewFromMongo({})
    );

    const verbatimPlans =
      targetSize === maxTarget
        ? {
            outboxClaimPlan: await runExplainPgText(pool, claimBatchSql),
            limit1WakePlan: await runExplainPgText(pool, limit1WakeSql),
            cleanupClaimPlan: await runExplainPgText(pool, cleanupClaimSql),
          }
        : undefined;

    resultsBySize.push({
      datasetSize: targetSize,
      seedMs,
      outboxClaimBatch: {
        medianMs: claimBatchStats.medianMs,
        p95Ms: claimBatchStats.p95Ms,
        executionTimeMs: claimBatchExplain.executionTimeMs,
        planningTimeMs: claimBatchExplain.planningTimeMs,
        indexesUsed: claimBatchExplain.indexesUsed,
        sharedHitBlocks: claimBatchExplain.sharedHitBlocks,
        sharedReadBlocks: claimBatchExplain.sharedReadBlocks,
      },
      outboxBacklog: {
        legacyMedianMs: legacyStats.medianMs,
        legacyP95Ms: legacyStats.p95Ms,
        legacyExplain,
        limit1MedianMs: limit1Stats.medianMs,
        limit1P95Ms: limit1Stats.p95Ms,
        limit1Explain,
      },
      storageCleanupClaim: {
        medianMs: cleanupClaimStats.medianMs,
        p95Ms: cleanupClaimStats.p95Ms,
        executionTimeMs: cleanupClaimExplain.executionTimeMs,
        planningTimeMs: cleanupClaimExplain.planningTimeMs,
        indexesUsed: cleanupClaimExplain.indexesUsed,
        sharedHitBlocks: cleanupClaimExplain.sharedHitBlocks,
      },
      advisoryLocks: {
        distinctKeysParallelMedianMs: distinctLockStats.medianMs,
        distinctKeysParallelP95Ms: distinctLockStats.p95Ms,
        contendedSameKeyMedianMs: contendedLockStats.medianMs,
        contendedSameKeyP95Ms: contendedLockStats.p95Ms,
      },
      mongoReadModels: {
        productSearchMedianMs: mongoSearchStats.medianMs,
        productSearchP95Ms: mongoSearchStats.p95Ms,
        customerListMedianMs: mongoCustomerStats.medianMs,
        customerListP95Ms: mongoCustomerStats.p95Ms,
        dashboardOverviewMedianMs: mongoDashboardStats.medianMs,
        dashboardOverviewP95Ms: mongoDashboardStats.p95Ms,
      },
      verbatimPlans,
    });
  }

  const report = {
    release: '031',
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

  console.log('=== KHATA RELEASE 031 BENCHMARK SUMMARY ===');
  for (const row of resultsBySize) {
    console.log(
      `\n[Scale N=${row.datasetSize}] Outbox Claim Batch=${row.outboxClaimBatch.medianMs}ms (${row.outboxClaimBatch.sharedHitBlocks} blocks) | Limit 1 Wake=${row.outboxBacklog.limit1MedianMs}ms vs Legacy=${row.outboxBacklog.legacyMedianMs}ms | Cleanup Claim=${row.storageCleanupClaim.medianMs}ms | Advisory Distinct=${row.advisoryLocks.distinctKeysParallelMedianMs}ms, Contended=${row.advisoryLocks.contendedSameKeyMedianMs}ms | Mongo ProdSearch=${row.mongoReadModels.productSearchMedianMs}ms, CustList=${row.mongoReadModels.customerListMedianMs}ms, Dashboard=${row.mongoReadModels.dashboardOverviewMedianMs}ms`
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
