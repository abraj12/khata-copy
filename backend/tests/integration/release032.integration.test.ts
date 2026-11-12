import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertSafeTestDatabaseUrl } from '../../src/config/testDbGuard.js';
import { EXPECTED_CORE_TABLES, EXPECTED_MIGRATIONS } from '../../src/config/database.js';
import { STORAGE_CLEANUP_CLAIM_SQL } from '../../src/services/storageCleanup.worker.js';
import { StorageUploadIntentService } from '../../src/services/storageUploadIntent.service.js';
import {
  acquireObjectSessionLock,
  releaseObjectSessionLock,
} from '../../src/services/storageObjectLock.js';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
const requireTestDb = process.env.REQUIRE_TEST_DATABASE_URL === 'true';

if (requireTestDb && !testDbUrl) {
  throw new Error(
    '[TEST DB GUARD] REQUIRE_TEST_DATABASE_URL=true requires TEST_DATABASE_URL to run PostgreSQL integration tests; refusing silent skip.'
  );
}
if (requireTestDb && testDbUrl) {
  assertSafeTestDatabaseUrl(testDbUrl);
}

const describeIntegration = testDbUrl || requireTestDb ? describe : describe.skip;

describeIntegration('Khata Release #032 — PostgreSQL 18+ Integration Test Suite', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDbUrl!);
    pool = new Pool({ connectionString: testDbUrl, ssl: false });

    // Cleanly prepare database schema
    const client = await pool.connect();
    try {
      // Apply real migrations
      const migrationsDir = path.resolve(__dirname, '../../migrations');
      await client.query(`
        CREATE TABLE IF NOT EXISTS "schema_migrations" (
          "version" VARCHAR(255) PRIMARY KEY,
          "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      for (const file of EXPECTED_MIGRATIONS) {
        const checkRes = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
        if (checkRes.rows.length === 0) {
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

  it('1. Schema Verification: all 33 migrations applied, storage_upload_intents exists, claim fencing columns present', async () => {
    const migRes = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
    const appliedVersions = migRes.rows.map((r) => r.version);

    for (const exp of EXPECTED_MIGRATIONS) {
      expect(appliedVersions).toContain(exp);
    }

    // Verify storage_upload_intents table columns
    const colsRes = await pool.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'storage_upload_intents'`
    );
    const colNames = colsRes.rows.map((r) => r.column_name);
    expect(colNames).toContain('object_key');
    expect(colNames).toContain('object_kind');
    expect(colNames).toContain('status');
    expect(colNames).toContain('expires_at');

    // Verify claim_token and claim_version in storage_cleanup_jobs
    const cleanupColsRes = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'storage_cleanup_jobs'`
    );
    const cleanupCols = cleanupColsRes.rows.map((r) => r.column_name);
    expect(cleanupCols).toContain('claim_token');
    expect(cleanupCols).toContain('claim_version');

    // Verify index idx_storage_cleanup_processing_claim
    const idxRes = await pool.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'storage_cleanup_jobs'`
    );
    const indexNames = idxRes.rows.map((r) => r.indexname);
    expect(indexNames).toContain('idx_storage_cleanup_processing_claim');
  });

  it('2. Concurrent Worker Claim Simulation with SKIP LOCKED guarantees 0 duplicate claims', async () => {
    // Insert 20 test pending cleanup jobs
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM storage_cleanup_jobs WHERE object_key LIKE $1', ['test/bench-concurrent-%']);
      for (let i = 0; i < 20; i++) {
        await client.query(
          `INSERT INTO storage_cleanup_jobs (
             object_key,
             object_kind,
             reason,
             status,
             attempt_count,
             max_attempts,
             next_attempt_at,
             created_at,
             updated_at
           )
           VALUES ($1, 'product_image', 'test_claim', 'pending', 0, 10, NOW() - INTERVAL '1 second', NOW(), NOW())`,
          [`test/bench-concurrent-${i}.png`]
        );
      }
    } finally {
      client.release();
    }

    // 5 concurrent workers claim simultaneously
    const workerPromises = Array.from({ length: 5 }, async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const res = await c.query(STORAGE_CLEANUP_CLAIM_SQL, [4, 60000]);
        await c.query('COMMIT');
        return res.rows;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    });

    const results = await Promise.all(workerPromises);
    const allClaimedIds = results.flatMap((batch) => batch.map((job) => job.id));

    // Verify 0 duplicate claims across all workers
    const uniqueIds = new Set(allClaimedIds);
    expect(uniqueIds.size).toBe(allClaimedIds.length);
    expect(allClaimedIds.length).toBe(20);

    // Verify every job received a non-null claim_token
    for (const batch of results) {
      for (const job of batch) {
        expect(job.claim_token).toBeDefined();
        expect(job.claim_token).not.toBeNull();
        expect(job.claim_version).toBeGreaterThanOrEqual(1);
      }
    }

    // Clean up
    await pool.query('DELETE FROM storage_cleanup_jobs WHERE object_key LIKE $1', ['test/bench-concurrent-%']);
  });

  it('3. Real Storage Upload Intent Lifecycle: register -> lock & validate -> complete', async () => {
    const intentService = new StorageUploadIntentService();
    const testKey = 'test/integration-upload-intent.jpg';

    // 1. Register intent
    const intent = await intentService.registerIntent(
      {
        objectKey: testKey,
        objectKind: 'product_image',
        referenceType: 'product',
        referenceId: '101',
        expectedContentType: 'image/jpeg',
        expectedSizeBytes: 2048,
        expiresInSeconds: 300,
      },
      pool
    );

    expect(intent.id).toBeDefined();
    expect(intent.status).toBe('issued');

    // 2. Lock & validate intent inside transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const validated = await intentService.lockAndValidateIntent(client, {
        objectKey: testKey,
        expectedReferenceType: 'product',
        expectedReferenceId: '101',
      });

      expect(validated).not.toBeNull();
      expect(validated?.status).toBe('issued');

      // 3. Complete intent
      const completed = await intentService.completeIntentInTransaction(client, testKey);
      expect(completed).toBe(true);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Verify completed in database
    const finalRes = await pool.query(
      'SELECT status, completed_at FROM storage_upload_intents WHERE object_key = $1',
      [testKey]
    );
    expect(finalRes.rows[0].status).toBe('completed');
    expect(finalRes.rows[0].completed_at).not.toBeNull();

    // Clean up
    await pool.query('DELETE FROM storage_upload_intents WHERE object_key = $1', [testKey]);
  });

  it('4. Real PostgreSQL Session Advisory Locking: mutual exclusion on same key', async () => {
    const client1 = await pool.connect();
    const client2 = await pool.connect();
    const testKey = 'products/advisory-test-mutex.png';

    try {
      // client1 acquires session lock
      const locked1 = await acquireObjectSessionLock(client1, testKey);
      expect(locked1).toBe(true);

      // client2 tries to acquire lock on the SAME key without blocking (pg_try_advisory_lock)
      const tryRes = await client2.query(
        `SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired`,
        [testKey]
      );
      // Must be false because client1 holds it
      expect(tryRes.rows[0].acquired).toBe(false);

      // client1 releases lock
      const unlocked1 = await releaseObjectSessionLock(client1, testKey);
      expect(unlocked1).toBe(true);

      // Now client2 can acquire the lock
      const tryRes2 = await client2.query(
        `SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired`,
        [testKey]
      );
      expect(tryRes2.rows[0].acquired).toBe(true);

      // client2 releases lock
      await releaseObjectSessionLock(client2, testKey);
    } finally {
      client1.release();
      client2.release();
    }
  });
});
