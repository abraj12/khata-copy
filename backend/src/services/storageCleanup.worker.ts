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
}

export interface ClaimedCleanupJob {
  id: number;
  object_key: string;
  object_kind: string;
  reason: string;
  attempt_count: number;
  max_attempts: number;
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
 * Bounded event-driven worker for durable Cloudflare R2 cleanup retries.
 * Uses FOR UPDATE SKIP LOCKED, lease expiry recovery, exponential backoff,
 * cross-table live-reference verification, and one-shot wakeup timers (zero idle DB polling).
 */
export class StorageCleanupWorker {
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

  constructor(options: StorageCleanupWorkerOptions = {}) {
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
    void this.triggerDrain();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.clearRetryTimer();

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

  private triggerDrain(): Promise<{ processedCount: number }> {
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
          const claimedIds = claimed.map((j) => j.id);

          const scheduleHeartbeat = () => {
            if (!batchActive || this.stopped) return;
            heartbeatTimer = setTimeout(() => {
              heartbeatTimer = null;
              if (!batchActive || this.stopped) return;
              inFlightRenewal = this.renewBatchLease(claimedIds)
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
                const unstartedIds = claimed.slice(i).map((j) => j.id);
                if (unstartedIds.length > 0) {
                  await this.releaseUnprocessedLeases(unstartedIds).catch(() => {});
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
      const refs = await storageCleanupService.findLiveObjectReferences(job.object_key, client);
      if (refs.length > 0) {
        await client.query('COMMIT');
        await this.markJobCompleted(
          job.id,
          `Skipped deletion: object remains referenced in ${refs.join(', ')}`
        );
        return true;
      }
      await client.query('COMMIT');

      // Advisory session lock remains held across R2 delete.
      // PG transaction is closed during external network request.
      await storageService.deleteObject(job.object_key);

      await this.markJobCompleted(job.id, null);
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

  private async claimNextBatch(): Promise<ClaimedCleanupJob[]> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // Reclaim expired or missing processing leases first
      await client.query(
        `UPDATE storage_cleanup_jobs
         SET status = 'pending',
             lease_expires_at = NULL,
             updated_at = NOW()
         WHERE status = 'processing'
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`
      );

      const res = await client.query(
        `WITH next_batch AS (
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
               updated_at = NOW()
           FROM next_batch nb
           WHERE j.id = nb.id
           RETURNING j.id, j.object_key, j.object_kind, j.reason, j.attempt_count, j.max_attempts
         )
         SELECT * FROM claimed ORDER BY id ASC`,
        [this.batchSize, this.leaseDurationMs]
      );

      await client.query('COMMIT');
      return res.rows as ClaimedCleanupJob[];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async renewBatchLease(ids: number[]): Promise<void> {
    if (ids.length === 0 || this.stopped) return;
    await appPool.query(
      `UPDATE storage_cleanup_jobs
       SET lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = ANY($1::bigint[])
         AND status = 'processing'`,
      [ids, this.leaseDurationMs]
    );
  }

  private async releaseUnprocessedLeases(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await appPool.query(
      `UPDATE storage_cleanup_jobs
       SET status = 'pending',
           lease_expires_at = NULL,
           attempt_count = GREATEST(attempt_count - 1, 0),
           updated_at = NOW()
       WHERE id = ANY($1::bigint[])
         AND status = 'processing'`,
      [ids]
    );
  }

  private async markJobCompleted(id: number, note: string | null): Promise<void> {
    await appPool.query(
      `UPDATE storage_cleanup_jobs
       SET status = 'completed',
           lease_expires_at = NULL,
           last_error = $2,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [id, note]
    );
  }

  private async markJobFailedOrDeadLetter(job: ClaimedCleanupJob, errorMessage: string): Promise<void> {
    const isExhausted = job.attempt_count >= job.max_attempts;
    if (isExhausted) {
      await appPool.query(
        `UPDATE storage_cleanup_jobs
         SET status = 'dead_letter',
             lease_expires_at = NULL,
             dead_letter_at = COALESCE(dead_letter_at, NOW()),
             last_error = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, errorMessage]
      );
      console.error('[STORAGE CLEANUP WORKER] Cleanup job transitioned to dead_letter after max_attempts.', {
        jobId: job.id,
        object: redactObjectKeyForLog(job.object_key),
        objectKind: job.object_kind,
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
        message: errorMessage,
      });
      return;
    }

    const delayMs = computeStorageCleanupBackoffMs(
      job.attempt_count,
      this.baseBackoffMs,
      this.maxBackoffMs
    );
    await appPool.query(
      `UPDATE storage_cleanup_jobs
       SET status = 'failed',
           lease_expires_at = NULL,
           next_attempt_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
           last_error = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, delayMs, errorMessage]
    );
  }

  private async inspectBacklogWakeDelay(): Promise<StorageBacklogStatus> {
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
