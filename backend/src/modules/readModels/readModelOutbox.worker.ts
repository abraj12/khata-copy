import type { PoolClient } from 'pg';
import { appPool } from '../../config/database.js';
import { env } from '../../config/env.js';
import { isMongoEnabled, isMongoReady } from '../../config/mongodb.js';
import { DashboardSnapshotModel } from './models.js';
import { onOutboxCommitted } from './outbox.service.js';
import { readModelsQueryService } from './readModelsQuery.service.js';
import { readModelSyncService, type OutboxBatchEventRow } from './readModelSync.service.js';

export interface OutboxWorkerOptions {
  workerId?: string;
  batchSize?: number;
  leaseDurationMs?: number;
  leaseHeartbeatIntervalMs?: number;
  maxBackoffMs?: number;
  dashboardRefreshMinIntervalMs?: number;
}

export interface OutboxBacklogStatus {
  hasBacklog: boolean;
  nextDelayMs: number | null;
  deadLetterCount?: number;
}

export function clampOutboxWakeDelayMs(
  rawDelayMs: number,
  options: { minDelayMs?: number; maxBackoffMs: number }
): number {
  const minDelayMs = options.minDelayMs ?? 500;
  if (!Number.isFinite(rawDelayMs)) {
    return Math.min(options.maxBackoffMs, minDelayMs);
  }
  return Math.min(options.maxBackoffMs, Math.max(minDelayMs, Math.ceil(rawDelayMs)));
}

export function computeOutboxBacklogWakeStatus(
  nextWakeAt: Date | string | null | undefined,
  referenceNow: Date | string | number,
  options: { minDelayMs?: number; maxBackoffMs: number }
): OutboxBacklogStatus {
  if (nextWakeAt === null || nextWakeAt === undefined) {
    return { hasBacklog: false, nextDelayMs: null };
  }

  const wakeMs =
    nextWakeAt instanceof Date ? nextWakeAt.getTime() : Date.parse(String(nextWakeAt));
  const nowMs =
    typeof referenceNow === 'number'
      ? referenceNow
      : referenceNow instanceof Date
      ? referenceNow.getTime()
      : Date.parse(String(referenceNow));

  if (!Number.isFinite(wakeMs) || !Number.isFinite(nowMs)) {
    return {
      hasBacklog: true,
      nextDelayMs: clampOutboxWakeDelayMs(options.minDelayMs ?? 500, options),
    };
  }

  const diffMs = Math.max(0, wakeMs - nowMs);
  return {
    hasBacklog: true,
    nextDelayMs: clampOutboxWakeDelayMs(diffMs, options),
  };
}

export class ReadModelOutboxWorker {
  public readonly workerId: string;
  private listenClient: PoolClient | null = null;
  private listenReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listenConnecting = false;
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
    this.workerId = options.workerId ?? `outbox_worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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
        if (msg.channel === 'app_outbox_events') {
          void this.triggerDrain();
        }
      });

      client.on('error', (err) => {
        console.warn('[OUTBOX WORKER] LISTEN client error:', err.message);
        this.cleanupListenConnection(true);
      });

      client.on('end', () => {
        this.cleanupListenConnection(true);
      });

      await client.query('LISTEN app_outbox_events');
      this.listenClient = client;
      console.log('[OUTBOX WORKER] Subscribed to PostgreSQL LISTEN app_outbox_events.');

      void this.triggerDrain();
    } catch (err) {
      console.warn('[OUTBOX WORKER] Failed establishing LISTEN subscription:', (err as Error).message);
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
      client.query('UNLISTEN app_outbox_events').catch(() => {}).finally(() => {
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
   * Refreshes the in-memory dead-letter metric using targeted dead-letter / exhausted counts
   * without recalculating on every routine drain iteration or enabling idle polling.
   */
  public async refreshDeadLetterIndicator(): Promise<number> {
    const res = await appPool.query(
      `SELECT
         (
           (SELECT COUNT(*)::int FROM app_outbox_events WHERE status = 'dead_letter')
           + (SELECT COUNT(*)::int FROM app_outbox_events WHERE status = 'failed' AND attempt_count >= max_attempts)
         ) AS dead_letter_count`
    );
    const deadLetterCount = Number(res.rows[0]?.dead_letter_count || 0);
    readModelsQueryService.setOutboxDeadLetterCount(deadLetterCount);
    return deadLetterCount;
  }

  /**
   * Startup catch-up: refreshes dead-letter metrics, seeds an initial MongoDB snapshot if absent,
   * then drains any uncommitted/missed outbox events left behind before restart.
   */
  public async catchUpOnStartup(): Promise<void> {
    if (this.stopped || !isMongoEnabled() || !isMongoReady()) {
      return;
    }

    try {
      await this.refreshDeadLetterIndicator();
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
              inFlightRenewal = this.renewBatchLease(claimed)
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
              await this.markEventsProcessed(claimed, processedIds);
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
          if (typeof retryStatus.deadLetterCount === 'number') {
            readModelsQueryService.setOutboxDeadLetterCount(retryStatus.deadLetterCount);
          }

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

  private async renewBatchLease(claimed: OutboxBatchEventRow[]): Promise<void> {
    if (claimed.length === 0 || this.stopped) return;
    const ids = claimed.map((c) => c.id);
    const tokens = claimed.map((c) => c.claim_token).filter((t): t is string => Boolean(t));

    if (tokens.length === claimed.length) {
      await appPool.query(
        `UPDATE app_outbox_events o
         SET lease_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
             updated_at = NOW()
         FROM (
           SELECT UNNEST($1::bigint[]) AS id, UNNEST($2::uuid[]) AS claim_token
         ) batch
         WHERE o.id = batch.id
           AND o.status = 'processing'
           AND o.claim_token = batch.claim_token`,
        [ids, tokens, this.leaseDurationMs]
      );
    } else {
      await appPool.query(
        `UPDATE app_outbox_events
         SET lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
             updated_at = NOW()
         WHERE id = ANY($1::bigint[])
           AND status = 'processing'`,
        [ids, this.leaseDurationMs]
      );
    }
  }

  private async claimOutboxBatch(): Promise<OutboxBatchEventRow[]> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // Reclaim expired processing leases; transition to dead_letter if attempts exhausted
      await client.query(
        `UPDATE app_outbox_events
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
               claim_generation = o.claim_generation + 1,
               claim_token = gen_random_uuid(),
               claimed_at = NOW(),
               claimed_by = $3,
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
             o.max_attempts,
             o.claim_token,
             o.claim_generation,
             o.claimed_at,
             o.claimed_by
         )
         SELECT * FROM claimed ORDER BY id ASC`,
        [this.batchSize, this.leaseDurationMs, this.workerId]
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

  private async markEventsProcessed(
    claimed: OutboxBatchEventRow[],
    processedIds?: number[]
  ): Promise<void> {
    const toMark = processedIds
      ? claimed.filter((c) => processedIds.includes(c.id))
      : claimed;
    if (toMark.length === 0) return;

    const ids = toMark.map((c) => c.id);
    const tokens = toMark.map((c) => c.claim_token).filter((t): t is string => Boolean(t));

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      if (tokens.length === toMark.length) {
        await client.query(
          `UPDATE app_outbox_events o
           SET status = 'processed',
               processed_at = NOW(),
               lease_expires_at = NULL,
               claim_token = NULL,
               claimed_at = NULL,
               claimed_by = NULL,
               last_error = NULL,
               updated_at = NOW()
           FROM (
             SELECT UNNEST($1::bigint[]) AS id, UNNEST($2::uuid[]) AS claim_token
           ) batch
           WHERE o.id = batch.id
             AND o.status = 'processing'
             AND o.claim_token = batch.claim_token`,
          [ids, tokens]
        );
      } else {
        await client.query(
          `UPDATE app_outbox_events
           SET status = 'processed',
               processed_at = NOW(),
               lease_expires_at = NULL,
               claim_token = NULL,
               claimed_at = NULL,
               claimed_by = NULL,
               last_error = NULL,
               updated_at = NOW()
           WHERE id = ANY($1::bigint[])`,
          [ids]
        );
      }

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
        const hasToken = Boolean(row.claim_token);

        if (attemptCount >= maxAttempts) {
          deadLetterOccurred = true;
          const sql = hasToken
            ? `UPDATE app_outbox_events
               SET status = 'dead_letter',
                   dead_letter_at = COALESCE(dead_letter_at, NOW()),
                   lease_expires_at = NULL,
                   claim_token = NULL,
                   claimed_at = NULL,
                   claimed_by = NULL,
                   last_error = $2,
                   updated_at = NOW()
               WHERE id = $1
                 AND status = 'processing'
                 AND claim_token = $3`
            : `UPDATE app_outbox_events
               SET status = 'dead_letter',
                   dead_letter_at = COALESCE(dead_letter_at, NOW()),
                   lease_expires_at = NULL,
                   claim_token = NULL,
                   claimed_at = NULL,
                   claimed_by = NULL,
                   last_error = $2,
                   updated_at = NOW()
               WHERE id = $1`;
          const params = hasToken ? [row.id, errorMessage, row.claim_token] : [row.id, errorMessage];
          await client.query(sql, params);
        } else {
          const backoffMs = Math.min(this.maxBackoffMs, 1000 * Math.pow(2, attemptCount - 1));
          minDelayMs = minDelayMs === null ? backoffMs : Math.min(minDelayMs, backoffMs);
          const sql = hasToken
            ? `UPDATE app_outbox_events
               SET status = 'failed',
                   lease_expires_at = NULL,
                   claim_token = NULL,
                   claimed_at = NULL,
                   claimed_by = NULL,
                   last_error = $2,
                   next_attempt_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
                   updated_at = NOW()
               WHERE id = $1
                 AND status = 'processing'
                 AND claim_token = $4`
            : `UPDATE app_outbox_events
               SET status = 'failed',
                   lease_expires_at = NULL,
                   claim_token = NULL,
                   claimed_at = NULL,
                   claimed_by = NULL,
                   last_error = $2,
                   next_attempt_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
                   updated_at = NOW()
               WHERE id = $1`;
          const params = hasToken
            ? [row.id, errorMessage, backoffMs, row.claim_token]
            : [row.id, errorMessage, backoffMs];
          await client.query(sql, params);
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
      await this.refreshDeadLetterIndicator().catch((refreshErr) => {
        console.warn('[OUTBOX WORKER] Dead-letter count refresh warning:', {
          message: (refreshErr as Error)?.message,
        });
      });
    }

    return minDelayMs;
  }

  private async inspectRetryableBacklogDelay(): Promise<OutboxBacklogStatus> {
    const res = await appPool.query(
      `WITH next_events AS (
         (
           SELECT next_attempt_at AS wake_at
           FROM app_outbox_events
           WHERE status = 'pending'
           ORDER BY next_attempt_at ASC, id ASC
           LIMIT 1
         )
         UNION ALL
         (
           SELECT next_attempt_at AS wake_at
           FROM app_outbox_events
           WHERE status = 'failed' AND attempt_count < max_attempts
           ORDER BY next_attempt_at ASC, id ASC
           LIMIT 1
         )
         UNION ALL
         (
           SELECT COALESCE(lease_expires_at, NOW() - INTERVAL '1 millisecond') AS wake_at
           FROM app_outbox_events
           WHERE status = 'processing'
           ORDER BY lease_expires_at ASC NULLS FIRST, id ASC
           LIMIT 1
         )
       )
       SELECT
         MIN(wake_at) AS next_wake_at,
         NOW() AS server_now
       FROM next_events`
    );
    const row = res.rows[0] || {};
    return computeOutboxBacklogWakeStatus(
      row.next_wake_at ?? null,
      row.server_now ?? Date.now(),
      { maxBackoffMs: this.maxBackoffMs, minDelayMs: 500 }
    );
  }
}

export const readModelOutboxWorker = new ReadModelOutboxWorker();
