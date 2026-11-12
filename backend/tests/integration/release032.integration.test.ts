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
    expect(cleanupCols.includes('claim_version') || cleanupCols.includes('claim_generation')).toBe(true);

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
        const res = await c.query(STORAGE_CLEANUP_CLAIM_SQL, [4, 60000, 'test_worker_' + Math.random().toString(36).slice(2, 6)]);
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
        expect(Number(job.claim_generation || job.claim_version)).toBeGreaterThanOrEqual(1);
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
      'SELECT status, attached_at FROM storage_upload_intents WHERE object_key = $1',
      [testKey]
    );
    expect(finalRes.rows[0].status).toBe('attached');
    expect(finalRes.rows[0].attached_at).not.toBeNull();

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
  it('5. Real PostgreSQL Transactional pg_notify and LISTEN on app_outbox_events', async () => {
    const listenClient = await pool.connect();
    const notifyClient = await pool.connect();

    try {
      const receivedNotifications: string[] = [];
      listenClient.on('notification', (msg) => {
        if (msg.channel === 'app_outbox_events') {
          receivedNotifications.push(msg.payload || '');
        }
      });

      await listenClient.query('LISTEN app_outbox_events');

      // Test 1: ROLLBACK does NOT emit notification
      await notifyClient.query('BEGIN');
      await notifyClient.query("SELECT pg_notify('app_outbox_events', $1)", ['rolled_back_event']);
      await notifyClient.query('ROLLBACK');

      // Small delay to ensure no notification delivered
      await new Promise((r) => setTimeout(r, 100));
      expect(receivedNotifications).not.toContain('rolled_back_event');

      // Test 2: COMMIT DOES emit notification
      await notifyClient.query('BEGIN');
      await notifyClient.query("SELECT pg_notify('app_outbox_events', $1)", ['committed_event_123']);
      await notifyClient.query('COMMIT');

      // Wait for async delivery
      await new Promise((r) => setTimeout(r, 200));
      expect(receivedNotifications).toContain('committed_event_123');

      await listenClient.query('UNLISTEN app_outbox_events');
    } finally {
      listenClient.release();
      notifyClient.release();
    }
  });

  it('6. Worker Claim Fencing: stale worker completion is rejected (0 rows updated)', async () => {
    const client = await pool.connect();
    const testKey = 'products/fencing_test_' + Date.now() + '.png';

    try {
      // Seed a processing job
      const insertRes = await client.query(
        `INSERT INTO storage_cleanup_jobs (
           object_key, object_kind, reason, status, attempt_count, max_attempts,
           claim_token, claim_generation, lease_expires_at, next_attempt_at, created_at, updated_at
         )
         VALUES ($1, 'product_image', 'test_fencing', 'processing', 1, 5,
                 gen_random_uuid(), 1, NOW() + INTERVAL '1 minute', NOW(), NOW(), NOW())
         RETURNING id, claim_token`,
        [testKey]
      );
      const jobId = insertRes.rows[0].id;
      const initialToken = insertRes.rows[0].claim_token;

      // Simulate lease recovery / second worker reclaiming the job
      const newTokenRes = await client.query(
        `UPDATE storage_cleanup_jobs
         SET claim_token = gen_random_uuid(),
             claim_generation = 2,
             lease_expires_at = NOW() + INTERVAL '1 minute',
             updated_at = NOW()
         WHERE id = $1
         RETURNING claim_token`,
        [jobId]
      );
      const newToken = newTokenRes.rows[0].claim_token;
      expect(newToken).not.toBe(initialToken);

      // Original worker with stale initialToken tries to complete the job
      const staleCompleteRes = await client.query(
        `UPDATE storage_cleanup_jobs
         SET status = 'completed',
             lease_expires_at = NULL,
             claim_token = NULL,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND status = 'processing'
           AND claim_token = $2`,
        [jobId, initialToken]
      );

      // Stale update MUST affect 0 rows (fenced out)
      expect(staleCompleteRes.rowCount).toBe(0);

      // Winner worker with newToken successfully completes the job
      const winnerCompleteRes = await client.query(
        `UPDATE storage_cleanup_jobs
         SET status = 'completed',
             lease_expires_at = NULL,
             claim_token = NULL,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND status = 'processing'
           AND claim_token = $2`,
        [jobId, newToken]
      );
      expect(winnerCompleteRes.rowCount).toBe(1);

      // Cleanup
      await client.query('DELETE FROM storage_cleanup_jobs WHERE id = $1', [jobId]);
    } finally {
      client.release();
    }
  });

  it('7. Expired Lease Recovery: transitions exhausted jobs to dead_letter', async () => {
    const client = await pool.connect();
    const testKey = 'products/dead_letter_recovery_' + Date.now() + '.png';

    try {
      // Seed an expired processing job that reached max_attempts
      const insertRes = await client.query(
        `INSERT INTO storage_cleanup_jobs (
           object_key, object_kind, reason, status, attempt_count, max_attempts,
           claim_token, claim_generation, lease_expires_at, next_attempt_at, created_at, updated_at
         )
         VALUES ($1, 'product_image', 'test_exhausted', 'processing', 5, 5,
                 gen_random_uuid(), 1, NOW() - INTERVAL '10 seconds', NOW(), NOW(), NOW())
         RETURNING id`,
        [testKey]
      );
      const jobId = insertRes.rows[0].id;

      // Run expired lease recovery query
      await client.query(
        `UPDATE storage_cleanup_jobs
         SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
             lease_expires_at = NULL,
             claim_token = NULL,
             claimed_at = NULL,
             claimed_by = NULL,
             dead_letter_at = CASE WHEN attempt_count >= max_attempts THEN COALESCE(dead_letter_at, NOW()) ELSE dead_letter_at END,
             updated_at = NOW()
         WHERE status = 'processing'
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`
      );

      // Verify status transitioned to dead_letter
      const checkRes = await client.query(
        'SELECT status, dead_letter_at, claim_token FROM storage_cleanup_jobs WHERE id = $1',
        [jobId]
      );
      expect(checkRes.rows[0].status).toBe('dead_letter');
      expect(checkRes.rows[0].dead_letter_at).not.toBeNull();
      expect(checkRes.rows[0].claim_token).toBeNull();

      // Cleanup
      await client.query('DELETE FROM storage_cleanup_jobs WHERE id = $1', [jobId]);
    } finally {
      client.release();
    }
  });
});
