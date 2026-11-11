import { appPool } from '../../config/database.js';
import { isMongoEnabled, isMongoReady } from '../../config/mongodb.js';
import { DashboardSnapshotModel } from './models.js';
import { onOutboxCommitted } from './outbox.service.js';
import { readModelsQueryService } from './readModelsQuery.service.js';
import { readModelSyncService, type OutboxBatchEventRow } from './readModelSync.service.js';

export interface OutboxWorkerOptions {
  batchSize?: number;
  leaseDurationMs?: number;
  maxBackoffMs?: number;
}

export class ReadModelOutboxWorker {
  private readonly batchSize: number;
  private readonly leaseDurationMs: number;
  private readonly maxBackoffMs: number;

  private started = false;
  private stopped = false;
  private draining = false;
  private drainRequestedWhileBusy = false;
  private unsubscribeOutbox: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDrainPromise: Promise<{ processedCount: number }> | null = null;

  constructor(options: OutboxWorkerOptions = {}) {
    this.batchSize = Math.min(Math.max(1, options.batchSize ?? 25), 100);
    this.leaseDurationMs = Math.max(5_000, options.leaseDurationMs ?? 30_000);
    this.maxBackoffMs = Math.max(5_000, options.maxBackoffMs ?? 60_000);
  }

  public isRunning(): boolean {
    return this.started && !this.stopped;
  }

  public isDraining(): boolean {
    return this.draining;
  }

  public hasRetryTimerScheduled(): boolean {
    return this.retryTimer !== null;
  }

  /**
   * Starts the outbox worker in event-driven mode:
   * - Listens for in-process COMMIT notifications (0 periodic idle polling)
   * - Runs a single startup catch-up drain and initial seed if snapshot is missing
   */
  public start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;

    this.unsubscribeOutbox = onOutboxCommitted(() => {
      void this.triggerDrain();
    });

    void this.catchUpOnStartup();
  }

  /**
   * Stops the worker gracefully, clearing pending retry timers and waiting briefly
   * for any in-flight drain pass to finish.
   */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.unsubscribeOutbox) {
      this.unsubscribeOutbox();
      this.unsubscribeOutbox = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.activeDrainPromise) {
      try {
        await this.activeDrainPromise;
      } catch {
        // Ignore shutdown errors from in-flight sync
      }
    }
    this.started = false;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleOneShotRetry(delayMs: number): void {
    if (this.stopped) return;
    this.clearRetryTimer();
    const boundedDelay = Math.min(Math.max(500, delayMs), this.maxBackoffMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) {
        void this.triggerDrain();
      }
    }, boundedDelay);
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref();
    }
  }

  /**
   * Startup catch-up: seeds an initial MongoDB snapshot if absent, then drains any
   * uncommitted/missed outbox events left behind before restart.
   */
  public async catchUpOnStartup(): Promise<void> {
    if (this.stopped || !isMongoEnabled() || !isMongoReady()) {
      return;
    }

    try {
      const existingSnapshot = await DashboardSnapshotModel.findOne({ snapshotKey: '__global__' })
        .select({ _id: 1 })
        .lean();
      if (!existingSnapshot) {
        await readModelSyncService.rebuildAllReadModels({ confirm: true, batchSize: 100 });
      }
      await this.drainNow();
    } catch (err) {
      console.error('[OUTBOX WORKER] Startup catch-up failed; scheduling bounded retry:', {
        message: (err as Error)?.message,
      });
      readModelsQueryService.markOutboxBacklogPending(true);
      this.scheduleOneShotRetry(5_000);
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

  /**
   * Drains all currently due outbox events in bounded batches using FOR UPDATE SKIP LOCKED.
   * When the queue is empty, goes completely idle without leaving any interval timer running.
   */
  public async drainNow(): Promise<{ processedCount: number }> {
    if (this.stopped || !isMongoEnabled() || !isMongoReady()) {
      return { processedCount: 0 };
    }

    if (this.activeDrainPromise) {
      this.drainRequestedWhileBusy = true;
      return this.activeDrainPromise;
    }

    this.draining = true;
    const runPromise = (async (): Promise<{ processedCount: number }> => {
      let processedCount = 0;

      try {
        while (!this.stopped && isMongoReady()) {
          this.drainRequestedWhileBusy = false;
          const claimed = await this.claimOutboxBatch();
          if (claimed.length === 0) {
            break;
          }

          try {
            const processedIds = await readModelSyncService.applyOutboxBatch(claimed);
            if (processedIds.length > 0) {
              await this.markEventsProcessed(processedIds);
              processedCount += processedIds.length;
            }
          } catch (err) {
            console.error('[OUTBOX WORKER] Failed applying outbox batch to MongoDB:', {
              batchSize: claimed.length,
              message: (err as Error)?.message,
            });
            readModelsQueryService.markOutboxBacklogPending(true);
            const retryDelay = await this.markEventsFailedWithBackoff(claimed, err as Error);
            if (retryDelay !== null) {
              this.scheduleOneShotRetry(retryDelay);
            }
            break;
          }

          if (claimed.length < this.batchSize && !this.drainRequestedWhileBusy) {
            break;
          }
        }

        if (!this.stopped) {
          const retryStatus = await this.inspectRetryableBacklogDelay();
          if (retryStatus.hasBacklog) {
            readModelsQueryService.markOutboxBacklogPending(true);
            if (retryStatus.nextDelayMs !== null && !this.hasRetryTimerScheduled()) {
              this.scheduleOneShotRetry(retryStatus.nextDelayMs);
            }
          } else {
            this.clearRetryTimer();
            readModelsQueryService.markOutboxBacklogPending(false);
          }
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

  private async claimOutboxBatch(): Promise<OutboxBatchEventRow[]> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // Reclaim leases held by crashed workers first
      await client.query(
        `UPDATE app_outbox_events
         SET status = 'pending',
             lease_expires_at = NULL,
             updated_at = NOW()
         WHERE status = 'processing'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < NOW()`
      );

      const res = await client.query(
        `WITH next_batch AS (
           SELECT id
           FROM app_outbox_events
           WHERE (
             status = 'pending'
             OR (status = 'failed' AND attempt_count < max_attempts)
           )
             AND next_attempt_at <= NOW()
           ORDER BY id ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         ),
         claimed AS (
           UPDATE app_outbox_events o
           SET status = 'processing',
               lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
               attempt_count = o.attempt_count + 1,
               updated_at = NOW()
           FROM next_batch nb
           WHERE o.id = nb.id
           RETURNING
             o.id,
             o.event_id,
             o.aggregate_type,
             o.aggregate_id,
             o.event_type,
             o.payload,
             o.source_version,
             o.business_date,
             o.attempt_count,
             o.max_attempts
         )
         SELECT * FROM claimed ORDER BY id ASC`,
        [this.batchSize, this.leaseDurationMs]
      );

      await client.query('COMMIT');
      return res.rows as OutboxBatchEventRow[];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async markEventsProcessed(ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE app_outbox_events
         SET status = 'processed',
             processed_at = NOW(),
             lease_expires_at = NULL,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = ANY($1::bigint[])`,
        [ids]
      );
      // Bounded cleanup of processed events older than 7 days piggybacked on active work
      await client.query(
        `DELETE FROM app_outbox_events
         WHERE id IN (
           SELECT id FROM app_outbox_events
           WHERE status = 'processed'
             AND processed_at < NOW() - INTERVAL '7 days'
           LIMIT 200
         )`
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async markEventsFailedWithBackoff(
    claimed: OutboxBatchEventRow[],
    err: Error
  ): Promise<number | null> {
    const errorMessage = String(err?.message || 'Unknown projection error').slice(0, 500);
    let minDelayMs: number | null = null;

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      for (const row of claimed) {
        const attemptCount = Math.max(1, Number((row as any).attempt_count || 1));
        const maxAttempts = Math.max(1, Number((row as any).max_attempts || 8));
        const backoffMs = Math.min(this.maxBackoffMs, 1000 * Math.pow(2, attemptCount - 1));
        if (attemptCount < maxAttempts) {
          minDelayMs = minDelayMs === null ? backoffMs : Math.min(minDelayMs, backoffMs);
        }

        await client.query(
          `UPDATE app_outbox_events
           SET status = 'failed',
               lease_expires_at = NULL,
               last_error = $2,
               next_attempt_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
               updated_at = NOW()
           WHERE id = $1`,
          [row.id, errorMessage, backoffMs]
        );
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[OUTBOX WORKER] Failed updating failed outbox rows:', {
        message: (txErr as Error)?.message,
      });
    } finally {
      client.release();
    }

    return minDelayMs;
  }

  private async inspectRetryableBacklogDelay(): Promise<{
    hasBacklog: boolean;
    nextDelayMs: number | null;
  }> {
    try {
      const res = await appPool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE status IN ('pending', 'processing')
                OR (status = 'failed' AND attempt_count < max_attempts)
           )::int AS pending_count,
           MIN(
             GREATEST(0, EXTRACT(EPOCH FROM (next_attempt_at - NOW())) * 1000)
           ) FILTER (
             WHERE status = 'pending'
                OR (status = 'failed' AND attempt_count < max_attempts)
           ) AS next_delay_ms
         FROM app_outbox_events`
      );
      const row = res.rows[0] || {};
      const pendingCount = Number(row.pending_count || 0);
      if (pendingCount <= 0) {
        return { hasBacklog: false, nextDelayMs: null };
      }
      const rawDelay = row.next_delay_ms !== null && row.next_delay_ms !== undefined
        ? Math.ceil(Number(row.next_delay_ms))
        : 1000;
      return {
        hasBacklog: true,
        nextDelayMs: Math.min(this.maxBackoffMs, Math.max(500, rawDelay)),
      };
    } catch {
      return { hasBacklog: false, nextDelayMs: null };
    }
  }
}

export const readModelOutboxWorker = new ReadModelOutboxWorker();
