import { appPool } from '../../config/database.js';
import { env } from '../../config/env.js';
import { isMongoEnabled, isMongoReady } from '../../config/mongodb.js';
import { DashboardSnapshotModel } from './models.js';
import { onOutboxCommitted } from './outbox.service.js';
import { readModelsQueryService } from './readModelsQuery.service.js';
import { readModelSyncService, type OutboxBatchEventRow } from './readModelSync.service.js';

export interface OutboxWorkerOptions {
  batchSize?: number;
  leaseDurationMs?: number;
  leaseHeartbeatIntervalMs?: number;
  maxBackoffMs?: number;
  dashboardRefreshMinIntervalMs?: number;
}

export class ReadModelOutboxWorker {
  private readonly batchSize: number;
  private readonly leaseDurationMs: number;
  private readonly leaseHeartbeatIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly dashboardRefreshMinIntervalMs: number;

  private started = false;
  private stopped = false;
  private draining = false;
  private drainRequestedWhileBusy = false;
  private unsubscribeOutbox: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dashboardRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDrainPromise: Promise<{ processedCount: number }> | null = null;
  private activeDashboardRefreshPromise: Promise<void> | null = null;
  private dashboardRefreshDirty = false;
  private lastDashboardRefreshAt = 0;
  private consecutiveFailureCount = 0;
  private lastFailureMessage: string | null = null;

  constructor(options: OutboxWorkerOptions = {}) {
    this.batchSize = Math.min(Math.max(1, options.batchSize ?? 25), 100);
    this.leaseDurationMs = Math.max(500, options.leaseDurationMs ?? 30_000);
    this.leaseHeartbeatIntervalMs = Math.max(
      50,
      options.leaseHeartbeatIntervalMs ?? Math.floor(this.leaseDurationMs / 3)
    );
    this.maxBackoffMs = Math.max(5_000, options.maxBackoffMs ?? 60_000);
    this.dashboardRefreshMinIntervalMs = Math.max(
      25,
      options.dashboardRefreshMinIntervalMs ?? env.READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS ?? 15_000
    );
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

  public hasDashboardRefreshTimerScheduled(): boolean {
    return this.dashboardRefreshTimer !== null;
  }

  public getStatus(): {
    started: boolean;
    stopped: boolean;
    draining: boolean;
    retryTimerScheduled: boolean;
    dashboardRefreshTimerScheduled: boolean;
    dashboardRefreshDirty: boolean;
    consecutiveFailureCount: number;
    lastFailureMessage: string | null;
    dashboardRefreshMinIntervalMs: number;
    deadLetterCount: number;
    outboxBacklogPending: boolean;
  } {
    return {
      started: this.started,
      stopped: this.stopped,
      draining: this.draining,
      retryTimerScheduled: this.hasRetryTimerScheduled(),
      dashboardRefreshTimerScheduled: this.hasDashboardRefreshTimerScheduled(),
      dashboardRefreshDirty: this.dashboardRefreshDirty,
      consecutiveFailureCount: this.consecutiveFailureCount,
      lastFailureMessage: this.lastFailureMessage,
      dashboardRefreshMinIntervalMs: this.dashboardRefreshMinIntervalMs,
      deadLetterCount: readModelsQueryService.getOutboxDeadLetterCount(),
      outboxBacklogPending: readModelsQueryService.isOutboxBacklogPending(),
    };
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
      this.triggerDrain().catch((err) => {
        this.handleDrainFailure(err, 'outbox:committed');
      });
    });

    this.catchUpOnStartup().catch((err) => {
      this.handleDrainFailure(err, 'startup_catchup');
    });
  }

  /**
   * Stops the worker gracefully, clearing pending timers and awaiting any in-flight passes.
   */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.unsubscribeOutbox) {
      this.unsubscribeOutbox();
      this.unsubscribeOutbox = null;
    }
    this.clearRetryTimer();
    this.clearDashboardRefreshTimer();
    if (this.activeDrainPromise) {
      try {
        await this.activeDrainPromise;
      } catch {
        // Ignore shutdown errors from in-flight sync
      }
    }
    if (this.activeDashboardRefreshPromise) {
      try {
        await this.activeDashboardRefreshPromise;
      } catch {
        // Ignore shutdown errors from in-flight dashboard refresh
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

  private clearDashboardRefreshTimer(): void {
    if (this.dashboardRefreshTimer) {
      clearTimeout(this.dashboardRefreshTimer);
      this.dashboardRefreshTimer = null;
    }
  }

  private scheduleOneShotRetry(delayMs: number): void {
    if (this.stopped) return;
    this.clearRetryTimer();
    const boundedDelay = Math.min(Math.max(500, delayMs), this.maxBackoffMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) {
        this.triggerDrain().catch((err) => {
          this.handleDrainFailure(err, 'retry_timer');
        });
      }
    }, boundedDelay);
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref();
    }
  }

  public handleDrainFailure(err: unknown, source: string): void {
    this.consecutiveFailureCount += 1;
    const message = String((err as Error)?.message || err || 'Unknown outbox worker failure').slice(0, 500);
    this.lastFailureMessage = message;
    readModelsQueryService.markOutboxBacklogPending(true);
    readModelsQueryService.setLastWorkerError(message);

    console.error(`[OUTBOX WORKER] Failure in ${source}:`, {
      consecutiveFailureCount: this.consecutiveFailureCount,
      message,
    });

    if (!this.stopped) {
      const expBackoff = Math.min(
        this.maxBackoffMs,
        1000 * Math.pow(2, Math.min(6, this.consecutiveFailureCount - 1))
      );
      this.scheduleOneShotRetry(expBackoff);
    }
  }

  private scheduleCoalescedDashboardRefreshTimer(delayMs: number): void {
    if (this.stopped || this.dashboardRefreshTimer) return;
    const boundedDelay = Math.max(25, delayMs);
    this.dashboardRefreshTimer = setTimeout(() => {
      this.dashboardRefreshTimer = null;
      if (!this.stopped && this.dashboardRefreshDirty) {
        this.flushDashboardRefresh().catch((err) => {
          this.handleDrainFailure(err, 'coalesced_dashboard_refresh');
        });
      }
    }, boundedDelay);
    if (typeof this.dashboardRefreshTimer.unref === 'function') {
      this.dashboardRefreshTimer.unref();
    }
  }

  /**
   * Forces a coalesced global dashboard snapshot refresh (single-flight) and updates freshness state.
   */
  public async flushDashboardRefresh(): Promise<void> {
    if (this.stopped || !isMongoEnabled() || !isMongoReady()) return;
    if (this.activeDashboardRefreshPromise) {
      this.dashboardRefreshDirty = true;
      await this.activeDashboardRefreshPromise;
      return;
    }

    this.clearDashboardRefreshTimer();
    const run = (async () => {
      this.dashboardRefreshDirty = false;
      try {
        await readModelSyncService.refreshGlobalDashboardSnapshotFromPool();
        this.lastDashboardRefreshAt = Date.now();
      } catch (err) {
        this.dashboardRefreshDirty = true;
        throw err;
      } finally {
        this.activeDashboardRefreshPromise = null;
        if (!this.stopped && this.dashboardRefreshDirty && !this.dashboardRefreshTimer) {
          const elapsed = Date.now() - this.lastDashboardRefreshAt;
          const remainingMs = Math.max(25, this.dashboardRefreshMinIntervalMs - elapsed);
          this.scheduleCoalescedDashboardRefreshTimer(remainingMs);
        }
      }
    })();

    this.activeDashboardRefreshPromise = run;
    await run;
  }

  private async triggerOrScheduleDashboardRefresh(): Promise<void> {
    if (this.stopped || !isMongoEnabled() || !isMongoReady()) return;
    this.dashboardRefreshDirty = true;

    const elapsed = Date.now() - this.lastDashboardRefreshAt;
    if (
      this.lastDashboardRefreshAt === 0 ||
      elapsed >= this.dashboardRefreshMinIntervalMs
    ) {
      if (!this.dashboardRefreshTimer) {
        await this.flushDashboardRefresh();
        return;
      }
    }

    const remainingMs = Math.max(25, this.dashboardRefreshMinIntervalMs - elapsed);
    this.scheduleCoalescedDashboardRefreshTimer(remainingMs);
  }

  /**
   * Refreshes the in-memory dead-letter metric without enabling any idle polling loop.
   */
  public async refreshDeadLetterIndicator(): Promise<number> {
    const status = await this.inspectRetryableBacklogDelay();
    readModelsQueryService.setOutboxDeadLetterCount(status.deadLetterCount);
    return status.deadLetterCount;
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
        this.lastDashboardRefreshAt = Date.now();
        this.dashboardRefreshDirty = false;
      }
      await this.drainNow();
    } catch (err) {
      this.handleDrainFailure(err, 'catchUpOnStartup');
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
   * Renews active batch leases while work executes and runs zero idle timers when empty.
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

          let batchActive = true;
          let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
          let inFlightRenewal: Promise<void> | null = null;
          const claimedIds = claimed.map((e) => Number(e.id));

          const scheduleHeartbeat = () => {
            if (!batchActive || this.stopped) return;
            heartbeatTimer = setTimeout(() => {
              heartbeatTimer = null;
              if (!batchActive || this.stopped) return;
              inFlightRenewal = this.renewBatchLease(claimedIds)
                .catch((renewErr) => {
                  console.warn('[OUTBOX WORKER] Lease renewal warning:', {
                    message: (renewErr as Error)?.message,
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
            const processedIds = await readModelSyncService.applyOutboxBatch(claimed, {
              skipDashboardSnapshot: true,
            });
            batchActive = false;
            if (heartbeatTimer) {
              clearTimeout(heartbeatTimer);
              heartbeatTimer = null;
            }
            if (inFlightRenewal) {
              await inFlightRenewal;
            }

            if (processedIds.length > 0) {
              await this.markEventsProcessed(processedIds);
              processedCount += processedIds.length;
            }
          } catch (err) {
            batchActive = false;
            if (heartbeatTimer) {
              clearTimeout(heartbeatTimer);
              heartbeatTimer = null;
            }
            if (inFlightRenewal) {
              await inFlightRenewal;
            }

            console.error('[OUTBOX WORKER] Failed applying outbox batch to MongoDB:', {
              batchSize: claimed.length,
              message: (err as Error)?.message,
            });
            readModelsQueryService.markOutboxBacklogPending(true);
            readModelsQueryService.setLastWorkerError(
              String((err as Error)?.message || 'Outbox batch failed').slice(0, 500)
            );
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

        if (processedCount > 0 && !this.stopped) {
          await this.triggerOrScheduleDashboardRefresh();
        }

        if (!this.stopped) {
          const retryStatus = await this.inspectRetryableBacklogDelay();
          readModelsQueryService.setOutboxDeadLetterCount(retryStatus.deadLetterCount);

          if (retryStatus.hasBacklog) {
            readModelsQueryService.markOutboxBacklogPending(true);
            if (retryStatus.nextDelayMs !== null && !this.hasRetryTimerScheduled()) {
              this.scheduleOneShotRetry(retryStatus.nextDelayMs);
            }
          } else {
            this.clearRetryTimer();
            this.consecutiveFailureCount = 0;
            this.lastFailureMessage = null;
            readModelsQueryService.markOutboxBacklogPending(false);
            readModelsQueryService.setLastWorkerError(null);
          }
        }
      } catch (err) {
        this.handleDrainFailure(err, 'drainNow');
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

  private async renewBatchLease(ids: number[]): Promise<void> {
    if (ids.length === 0 || this.stopped) return;
    await appPool.query(
      `UPDATE app_outbox_events
       SET lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = ANY($1::bigint[])
         AND status = 'processing'`,
      [ids, this.leaseDurationMs]
    );
  }

  private async claimOutboxBatch(): Promise<OutboxBatchEventRow[]> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // Reclaim expired or missing leases held by crashed workers first
      await client.query(
        `UPDATE app_outbox_events
         SET status = 'pending',
             lease_expires_at = NULL,
             updated_at = NOW()
         WHERE status = 'processing'
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`
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
      // Bounded cleanup of only processed events older than 7 days piggybacked on active work
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
    let deadLetterOccurred = false;

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      for (const row of claimed) {
        const attemptCount = Math.max(1, Number((row as any).attempt_count || 1));
        const maxAttempts = Math.max(1, Number((row as any).max_attempts || 8));
        if (attemptCount >= maxAttempts) {
          deadLetterOccurred = true;
          await client.query(
            `UPDATE app_outbox_events
             SET status = 'dead_letter',
                 dead_letter_at = NOW(),
                 lease_expires_at = NULL,
                 last_error = $2,
                 updated_at = NOW()
             WHERE id = $1`,
            [row.id, errorMessage]
          );
        } else {
          const backoffMs = Math.min(this.maxBackoffMs, 1000 * Math.pow(2, attemptCount - 1));
          minDelayMs = minDelayMs === null ? backoffMs : Math.min(minDelayMs, backoffMs);
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
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    if (deadLetterOccurred) {
      console.error('[OUTBOX WORKER] Outbox event(s) transitioned to dead_letter after max_attempts.', {
        errorMessage,
      });
    }

    return minDelayMs;
  }

  private async inspectRetryableBacklogDelay(): Promise<{
    hasBacklog: boolean;
    nextDelayMs: number | null;
    deadLetterCount: number;
  }> {
    const res = await appPool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE status IN ('pending', 'processing')
              OR (status = 'failed' AND attempt_count < max_attempts)
         )::int AS pending_count,
         COUNT(*) FILTER (
           WHERE status = 'dead_letter'
              OR (status = 'failed' AND attempt_count >= max_attempts)
         )::int AS dead_letter_count,
         MIN(
           GREATEST(
             0,
             EXTRACT(
               EPOCH FROM (
                 (
                   CASE
                     WHEN status = 'processing'
                       THEN COALESCE(lease_expires_at, NOW() - INTERVAL '1 millisecond')
                     ELSE next_attempt_at
                   END
                 ) - NOW()
               )
             ) * 1000
           )
         ) FILTER (
           WHERE status IN ('pending', 'processing')
              OR (status = 'failed' AND attempt_count < max_attempts)
         ) AS next_delay_ms
       FROM app_outbox_events`
    );
    const row = res.rows[0] || {};
    const pendingCount = Number(row.pending_count || 0);
    const deadLetterCount = Number(row.dead_letter_count || 0);
    if (pendingCount <= 0) {
      return { hasBacklog: false, nextDelayMs: null, deadLetterCount };
    }
    const rawDelay =
      row.next_delay_ms !== null && row.next_delay_ms !== undefined
        ? Math.ceil(Number(row.next_delay_ms))
        : this.leaseDurationMs;
    return {
      hasBacklog: true,
      nextDelayMs: Math.min(this.maxBackoffMs, Math.max(500, rawDelay)),
      deadLetterCount,
    };
  }
}

export const readModelOutboxWorker = new ReadModelOutboxWorker();
