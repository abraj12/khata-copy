import type { PoolClient } from 'pg';
import { appPool } from '../config/database.js';
import { storageService } from './storage.service.js';
import { acquireObjectSessionLock, releaseObjectSessionLock } from './storageObjectLock.js';
import {
  redactObjectKeyForLog,
  registerStorageCleanupListener,
  sanitizeStorageErrorMessage,
  storageCleanupService,
} from './storageCleanup.service.js';

export interface StorageCleanupWorkerOptions {
  batchSize?: number;
  leaseDurationMs?: number;
  leaseHeartbeatIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  registerGlobalListener?: boolean;
  workerId?: string;
}

export interface ClaimedCleanupJob {
  id: number;
  object_key: string;
  object_kind: string;
  reason: string;
  attempt_count: number;
  max_attempts: number;
  claim_token?: string | null;
  claim_generation?: string | number;
  claim_version?: string | number;
  claimed_at?: string | Date | null;
  claimed_by?: string | null;
}

export interface StorageBacklogStatus {
  hasBacklog: boolean;
  nextDelayMs: number | null;
}

export function computeStorageCleanupBackoffMs(
  attemptCount: number,
  baseBackoffMs = 2000,
  maxBackoffMs = 300_000
): number {
  const normalizedAttempt = Math.max(1, Math.floor(attemptCount));
  const rawDelay = baseBackoffMs * Math.pow(2, normalizedAttempt - 1);
  return Math.max(100, Math.min(maxBackoffMs, Math.floor(rawDelay)));
}

export function computeStorageBacklogWakeStatus(
  nextWakeAtInput: string | Date | null | undefined,
  serverNowInput: string | Date | number,
  opts?: { maxBackoffMs?: number; minDelayMs?: number }
): StorageBacklogStatus {
  if (!nextWakeAtInput) {
    return { hasBacklog: false, nextDelayMs: null };
  }

  const nextWakeMs =
    nextWakeAtInput instanceof Date
      ? nextWakeAtInput.getTime()
      : new Date(nextWakeAtInput).getTime();
  const serverNowMs =
    serverNowInput instanceof Date
      ? serverNowInput.getTime()
      : typeof serverNowInput === 'number'
        ? serverNowInput
        : new Date(serverNowInput).getTime();

  if (!Number.isFinite(nextWakeMs) || !Number.isFinite(serverNowMs)) {
    return {
      hasBacklog: true,
      nextDelayMs: opts?.minDelayMs ?? 250,
    };
  }

  const minDelay = opts?.minDelayMs ?? 100;
  const maxDelay = opts?.maxBackoffMs ?? 300_000;
  const rawDelayMs = Math.max(minDelay, nextWakeMs - serverNowMs + 25);
  return {
    hasBacklog: true,
    nextDelayMs: Math.min(maxDelay, rawDelayMs),
  };
}

/**
 * Shared claim SQL definition ensuring the benchmark and worker execute identical logic.
 */
export const STORAGE_CLEANUP_CLAIM_SQL = `
  WITH next_batch AS (
    SELECT id
    FROM storage_cleanup_jobs
    WHERE (
      status = 'pending'
      OR (status = 'failed' AND attempt_count < max_attempts)
    )
      AND next_attempt_at <= NOW()
    ORDER BY next_attempt_at ASC, id ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE storage_cleanup_jobs j
    SET status = 'processing',
        lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
        attempt_count = j.attempt_count + 1,
        claim_generation = j.claim_generation + 1,
        claim_token = gen_random_uuid(),
        claimed_at = NOW(),
        claimed_by = $3,
        updated_at = NOW()
    FROM next_batch nb
    WHERE j.id = nb.id
    RETURNING
      j.id,
      j.object_key,
      j.object_kind,
      j.reason,
      j.attempt_count,
      j.max_attempts,
      j.claim_token,
      j.claim_generation,
      j.claim_generation AS claim_version,
      j.claimed_at,
      j.claimed_by
  )
  SELECT * FROM claimed ORDER BY id ASC
`;

/**
 * Bounded event-driven worker for durable Cloudflare R2 cleanup retries.
 * Uses PostgreSQL LISTEN/NOTIFY for distributed multi-instance event delivery,
 * FOR UPDATE SKIP LOCKED, claim-token fencing, lease recovery, exponential backoff,
 * cross-table live-reference verification, and one-shot wakeup timers (zero idle DB polling).
 */
export class StorageCleanupWorker {
  public readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseDurationMs: number;
  private readonly leaseHeartbeatIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  private started = false;
  private stopped = false;
  private draining = false;
  private drainRequestedWhileBusy = false;
  private activeDrainPromise: Promise<{ processedCount: number }> | null = null;
  private activeJobPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unregisterListener: (() => void) | null = null;

  private listenClient: PoolClient | null = null;
  private listenReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listenConnecting = false;

  constructor(options: StorageCleanupWorkerOptions = {}) {
    this.workerId = options.workerId ?? `storage_cleanup_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    this.batchSize = Math.max(1, Math.min(100, options.batchSize ?? 20));
    this.leaseDurationMs = Math.max(500, options.leaseDurationMs ?? 60_000);
    this.leaseHeartbeatIntervalMs = Math.max(200, options.leaseHeartbeatIntervalMs ?? 20_000);
    this.baseBackoffMs = Math.max(10, options.baseBackoffMs ?? 2_000);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, options.maxBackoffMs ?? 300_000);

    if (options.registerGlobalListener !== false) {
      this.unregisterListener = registerStorageCleanupListener((delayMs = 0) => {
        if (!this.started || this.stopped) return;
        if (delayMs > 0) {
          this.scheduleOneShotRetry(delayMs);
        } else {
          void this.triggerDrain();
        }
      });
    }
  }

  public start(): void {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    void this.setupListenConnection();
    void this.triggerDrain();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.clearRetryTimer();
    this.cleanupListenConnection(false);

    if (this.activeDrainPromise) {
      await this.activeDrainPromise.catch(() => {});
    }
    if (this.activeJobPromise) {
      await this.activeJobPromise.catch(() => {});
    }
  }

  public async dispose(): Promise<void> {
    await this.stop();
    if (this.unregisterListener) {
      this.unregisterListener();
      this.unregisterListener = null;
    }
  }

  public hasRetryTimerScheduled(): boolean {
    return this.retryTimer !== null;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleOneShotRetry(delayMs: number): void {
    if (this.stopped || !this.started) return;
    const bounded = Math.max(25, Math.min(this.maxBackoffMs, delayMs));
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped && this.started) {
        void this.triggerDrain();
      }
    }, bounded);
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref();
    }
  }

  private async setupListenConnection(): Promise<void> {
    if (this.stopped || this.listenClient || this.listenConnecting) return;
    this.listenConnecting = true;

    try {
      const client = await appPool.connect();
      if (this.stopped) {
        client.release();
        return;
      }

      client.on('notification', (msg) => {
        if (msg.channel === 'storage_cleanup_jobs') {
          void this.triggerDrain();
        }
      });

      client.on('error', (err) => {
        console.warn('[STORAGE CLEANUP WORKER] LISTEN client error:', err.message);
        this.cleanupListenConnection(true);
      });

      client.on('end', () => {
        this.cleanupListenConnection(true);
      });

      await client.query('LISTEN storage_cleanup_jobs');
      this.listenClient = client;
      console.log('[STORAGE CLEANUP WORKER] Subscribed to PostgreSQL LISTEN storage_cleanup_jobs.');

      // Perform bounded catch-up after establishing subscription
      void this.triggerDrain();
    } catch (err) {
      console.warn('[STORAGE CLEANUP WORKER] Failed establishing LISTEN subscription:', (err as Error).message);
      this.cleanupListenConnection(true);
    } finally {
      this.listenConnecting = false;
    }
  }

  private cleanupListenConnection(scheduleReconnect = false): void {
    if (this.listenReconnectTimer) {
      clearTimeout(this.listenReconnectTimer);
      this.listenReconnectTimer = null;
    }

    if (this.listenClient) {
      const client = this.listenClient;
      this.listenClient = null;
      client.query('UNLISTEN storage_cleanup_jobs').catch(() => {}).finally(() => {
        client.release();
      });
    }

    if (scheduleReconnect && !this.stopped && this.started) {
      this.listenReconnectTimer = setTimeout(() => {
        this.listenReconnectTimer = null;
        if (!this.stopped && this.started) {
          void this.setupListenConnection();
        }
      }, 5000);
      if (typeof this.listenReconnectTimer.unref === 'function') {
        this.listenReconnectTimer.unref();
      }
    }
  }

  public triggerDrain(): Promise<{ processedCount: number }> {
    if (this.stopped) {
      return Promise.resolve({ processedCount: 0 });
    }
    if (this.activeDrainPromise) {
      this.drainRequestedWhileBusy = true;
      return this.activeDrainPromise;
    }
    return this.drainNow();
  }

  public async drainNow(): Promise<{ processedCount: number }> {
    if (this.stopped) {
      return { processedCount: 0 };
    }
    if (this.draining && this.activeDrainPromise) {
      this.drainRequestedWhileBusy = true;
      return this.activeDrainPromise;
    }

    this.draining = true;
    this.clearRetryTimer();

    const runPromise = (async (): Promise<{ processedCount: number }> => {
      let processedCount = 0;

      try {
        while (!this.stopped) {
          this.drainRequestedWhileBusy = false;
          const claimed = await this.claimNextBatch();
          if (claimed.length === 0) {
            break;
          }

          let batchActive = true;
          let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
          let inFlightRenewal: Promise<void> | null = null;

          const scheduleHeartbeat = () => {
            if (!batchActive || this.stopped) return;
            heartbeatTimer = setTimeout(() => {
              heartbeatTimer = null;
              if (!batchActive || this.stopped) return;
              inFlightRenewal = this.renewBatchLease(claimed)
                .catch((renewErr) => {
                  console.warn('[STORAGE CLEANUP WORKER] Lease renewal warning:', {
                    message: sanitizeStorageErrorMessage(renewErr),
                  });
                })
                .finally(() => {
                  inFlightRenewal = null;
                  if (batchActive && !this.stopped) {
                    scheduleHeartbeat();
                  }
                });
            }, this.leaseHeartbeatIntervalMs);
            if (typeof heartbeatTimer.unref === 'function') {
              heartbeatTimer.unref();
            }
          };

          scheduleHeartbeat();

          try {
            for (let i = 0; i < claimed.length; i += 1) {
              if (this.stopped) {
                const unstartedJobs = claimed.slice(i);
                if (unstartedJobs.length > 0) {
                  await this.releaseUnprocessedLeases(unstartedJobs).catch(() => {});
                }
                break;
              }

              const job = claimed[i];
              const jobPromise = this.processSingleJob(job).then((handled) => {
                if (handled) {
                  processedCount += 1;
                }
              });
              this.activeJobPromise = jobPromise;
              await jobPromise;
              this.activeJobPromise = null;
            }
          } finally {
            batchActive = false;
            this.activeJobPromise = null;
            if (heartbeatTimer) {
              clearTimeout(heartbeatTimer);
              heartbeatTimer = null;
            }
            if (inFlightRenewal) {
              await inFlightRenewal;
            }
          }

          if (claimed.length < this.batchSize && !this.drainRequestedWhileBusy) {
            break;
          }
        }

        if (!this.stopped) {
          const wakeStatus = await this.inspectBacklogWakeDelay();
          if (wakeStatus.hasBacklog && wakeStatus.nextDelayMs !== null && !this.hasRetryTimerScheduled()) {
            this.scheduleOneShotRetry(wakeStatus.nextDelayMs);
          } else if (!wakeStatus.hasBacklog) {
            this.clearRetryTimer();
          }
        }
      } catch (err) {
        console.warn('[STORAGE CLEANUP WORKER] Drain cycle warning:', {
          message: sanitizeStorageErrorMessage(err),
        });
        if (!this.stopped) {
          this.scheduleOneShotRetry(this.baseBackoffMs);
        }
      } finally {
        this.draining = false;
        this.activeDrainPromise = null;
      }

      if (this.drainRequestedWhileBusy && !this.stopped) {
        const extra = await this.drainNow();
        return { processedCount: processedCount + extra.processedCount };
      }

      return { processedCount };
    })();

    this.activeDrainPromise = runPromise;
    return runPromise;
  }

  private async processSingleJob(job: ClaimedCleanupJob): Promise<boolean> {
    const client = await appPool.connect();
    let lockAcquired = false;

    try {
      lockAcquired = await acquireObjectSessionLock(client, job.object_key);

      await client.query('BEGIN');

      // If claim token is present, confirm claim ownership remains active
      if (job.claim_token) {
        const claimCheck = await client.query(
          `SELECT id FROM storage_cleanup_jobs
           WHERE id = $1
             AND status = 'processing'
             AND claim_token = $2
           FOR UPDATE`,
          [job.id, job.claim_token]
        );

        if (claimCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          console.warn('[STORAGE CLEANUP WORKER] Skipping job: claim ownership lost or lease expired.', {
            jobId: job.id,
            objectKey: redactObjectKeyForLog(job.object_key),
          });
          return false;
        }
      }

      const refs = await storageCleanupService.findLiveObjectReferences(job.object_key, client);
      if (refs.length > 0) {
        await client.query('COMMIT');
        await this.markJobCompleted(
          job.id,
          job.claim_token,
          `Skipped deletion: object remains referenced in ${refs.join(', ')}`
        );
        return true;
      }
      await client.query('COMMIT');

      // Advisory session lock remains held across external R2 delete.
      // Database transaction is closed during external network request.
      await storageService.deleteObject(job.object_key);

      await this.markJobCompleted(job.id, job.claim_token, null);
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const safeError = sanitizeStorageErrorMessage(err);
      await this.markJobFailedOrDeadLetter(job, safeError).catch(() => {});
      return false;
    } finally {
      if (lockAcquired) {
        await releaseObjectSessionLock(client, job.object_key).catch(() => {});
      }
      client.release();
    }
  }

  public async claimNextBatch(): Promise<ClaimedCleanupJob[]> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // Reclaim expired processing leases; transition to dead_letter if attempts exhausted
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

      const res = await client.query(STORAGE_CLEANUP_CLAIM_SQL, [
        this.batchSize,
        this.leaseDurationMs,
        this.workerId,
      ]);

      await client.query('COMMIT');
      return res.rows as ClaimedCleanupJob[];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async renewBatchLease(jobs: ClaimedCleanupJob[]): Promise<void> {
    if (jobs.length === 0 || this.stopped) return;
    const ids = jobs.map((j) => j.id);
    const tokens = jobs.map((j) => j.claim_token).filter((t): t is string => Boolean(t));

    if (tokens.length === jobs.length) {
      await appPool.query(
        `UPDATE storage_cleanup_jobs j
         SET lease_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
             updated_at = NOW()
         FROM (
           SELECT UNNEST($1::bigint[]) AS id, UNNEST($2::uuid[]) AS claim_token
         ) batch
         WHERE j.id = batch.id
           AND j.status = 'processing'
           AND j.claim_token = batch.claim_token`,
        [ids, tokens, this.leaseDurationMs]
      );
    } else {
      await appPool.query(
        `UPDATE storage_cleanup_jobs
         SET lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
             updated_at = NOW()
         WHERE id = ANY($1::bigint[])
           AND status = 'processing'`,
        [ids, this.leaseDurationMs]
      );
    }
  }

  private async releaseUnprocessedLeases(jobs: ClaimedCleanupJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const ids = jobs.map((j) => j.id);
    const tokens = jobs.map((j) => j.claim_token).filter((t): t is string => Boolean(t));

    if (tokens.length === jobs.length) {
      await appPool.query(
        `UPDATE storage_cleanup_jobs j
         SET status = 'pending',
             lease_expires_at = NULL,
             claim_token = NULL,
             claimed_at = NULL,
             claimed_by = NULL,
             attempt_count = GREATEST(j.attempt_count - 1, 0),
             updated_at = NOW()
         FROM (
           SELECT UNNEST($1::bigint[]) AS id, UNNEST($2::uuid[]) AS claim_token
         ) batch
         WHERE j.id = batch.id
           AND j.status = 'processing'
           AND j.claim_token = batch.claim_token`,
        [ids, tokens]
      );
    } else {
      await appPool.query(
        `UPDATE storage_cleanup_jobs
         SET status = 'pending',
             lease_expires_at = NULL,
             claim_token = NULL,
             claimed_at = NULL,
             claimed_by = NULL,
             attempt_count = GREATEST(attempt_count - 1, 0),
             updated_at = NOW()
         WHERE id = ANY($1::bigint[])
           AND status = 'processing'`,
        [ids]
      );
    }
  }

  public async markJobCompleted(id: number, claimToken?: string | null, note?: string | null): Promise<boolean> {
    const hasToken = Boolean(claimToken);
    const sql = hasToken
      ? `UPDATE storage_cleanup_jobs
         SET status = 'completed',
             lease_expires_at = NULL,
             claim_token = NULL,
             claimed_at = NULL,
             claimed_by = NULL,
             last_error = $3,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
           AND status = 'processing'
           AND claim_token = $2
         RETURNING id`
      : `UPDATE storage_cleanup_jobs
         SET status = 'completed',
             lease_expires_at = NULL,
             claim_token = NULL,
             claimed_at = NULL,
             claimed_by = NULL,
             last_error = $2,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING id`;

    const params = hasToken ? [id, claimToken, note || null] : [id, note || null];
    const res = await appPool.query(sql, params);

    if ((res.rowCount ?? 0) === 0) {
      console.warn('[STORAGE CLEANUP WORKER] Failed to mark completed: claim token mismatch or expired.', { id });
      return false;
    }
    return true;
  }

  public async markJobFailedOrDeadLetter(job: ClaimedCleanupJob, errorMessage: string): Promise<boolean> {
    const isExhausted = job.attempt_count >= job.max_attempts;
    const hasToken = Boolean(job.claim_token);

    if (isExhausted) {
      const sql = hasToken
        ? `UPDATE storage_cleanup_jobs
           SET status = 'dead_letter',
               lease_expires_at = NULL,
               claim_token = NULL,
               claimed_at = NULL,
               claimed_by = NULL,
               dead_letter_at = COALESCE(dead_letter_at, NOW()),
               last_error = $3,
               updated_at = NOW()
           WHERE id = $1
             AND status = 'processing'
             AND claim_token = $2
           RETURNING id`
        : `UPDATE storage_cleanup_jobs
           SET status = 'dead_letter',
               lease_expires_at = NULL,
               claim_token = NULL,
               claimed_at = NULL,
               claimed_by = NULL,
               dead_letter_at = COALESCE(dead_letter_at, NOW()),
               last_error = $2,
               updated_at = NOW()
           WHERE id = $1
           RETURNING id`;

      const params = hasToken ? [job.id, job.claim_token, errorMessage] : [job.id, errorMessage];
      const res = await appPool.query(sql, params);

      if ((res.rowCount ?? 0) === 0) {
        console.warn('[STORAGE CLEANUP WORKER] Failed to transition to dead_letter: claim token mismatch.', { id: job.id });
        return false;
      }

      console.error('[STORAGE CLEANUP WORKER] Cleanup job transitioned to dead_letter after max_attempts.', {
        jobId: job.id,
        object: redactObjectKeyForLog(job.object_key),
        objectKind: job.object_kind,
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
        message: errorMessage,
      });
      return true;
    }

    const delayMs = computeStorageCleanupBackoffMs(
      job.attempt_count,
      this.baseBackoffMs,
      this.maxBackoffMs
    );

    const sql = hasToken
      ? `UPDATE storage_cleanup_jobs
         SET status = 'failed',
             lease_expires_at = NULL,
             claim_token = NULL,
             claimed_at = NULL,
             claimed_by = NULL,
             next_attempt_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
             last_error = $4,
             updated_at = NOW()
         WHERE id = $1
           AND status = 'processing'
           AND claim_token = $2
         RETURNING id`
      : `UPDATE storage_cleanup_jobs
         SET status = 'failed',
             lease_expires_at = NULL,
             claim_token = NULL,
             claimed_at = NULL,
             claimed_by = NULL,
             next_attempt_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
             last_error = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id`;

    const params = hasToken ? [job.id, job.claim_token, delayMs, errorMessage] : [job.id, delayMs, errorMessage];
    const res = await appPool.query(sql, params);

    if ((res.rowCount ?? 0) === 0) {
      console.warn('[STORAGE CLEANUP WORKER] Failed to record retry state: claim token mismatch.', { id: job.id });
      return false;
    }
    return true;
  }

  public async inspectBacklogWakeDelay(): Promise<StorageBacklogStatus> {
    const res = await appPool.query(
      `WITH next_jobs AS (
         (
           SELECT next_attempt_at AS wake_at
           FROM storage_cleanup_jobs
           WHERE status = 'pending'
           ORDER BY next_attempt_at ASC, id ASC
           LIMIT 1
         )
         UNION ALL
         (
           SELECT next_attempt_at AS wake_at
           FROM storage_cleanup_jobs
           WHERE status = 'failed' AND attempt_count < max_attempts
           ORDER BY next_attempt_at ASC, id ASC
           LIMIT 1
         )
         UNION ALL
         (
           SELECT COALESCE(lease_expires_at, NOW() - INTERVAL '1 millisecond') AS wake_at
           FROM storage_cleanup_jobs
           WHERE status = 'processing'
           ORDER BY lease_expires_at ASC NULLS FIRST, id ASC
           LIMIT 1
         )
       )
       SELECT
         MIN(wake_at) AS next_wake_at,
         NOW() AS server_now
       FROM next_jobs`
    );
    const row = res.rows?.[0] || {};
    return computeStorageBacklogWakeStatus(
      row.next_wake_at ?? null,
      row.server_now ?? Date.now(),
      { maxBackoffMs: this.maxBackoffMs, minDelayMs: 100 }
    );
  }
}

export const storageCleanupWorker = new StorageCleanupWorker();
