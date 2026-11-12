import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appPool } from '../src/config/database.js';
import * as mongodbConfig from '../src/config/mongodb.js';
import { ReadModelOutboxWorker } from '../src/modules/readModels/readModelOutbox.worker.js';
import { readModelSyncService } from '../src/modules/readModels/readModelSync.service.js';

function buildMockPoolClient(queryHandler: (sql: string, params?: unknown[]) => Promise<any>) {
  return {
    query: vi.fn(queryHandler),
    release: vi.fn(),
  } as any;
}

describe('Khata Release #031 — Outbox Claiming, Lease Recovery & Concurrency Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('1. Outbox Event Claiming with FOR UPDATE SKIP LOCKED', () => {
    it('executes indexed claim query with ORDER BY id ASC LIMIT and FOR UPDATE SKIP LOCKED', async () => {
      vi.spyOn(mongodbConfig, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(true);
      vi.spyOn(readModelSyncService, 'applyOutboxBatch').mockResolvedValue([101]);
      vi.spyOn(readModelSyncService, 'refreshGlobalDashboardSnapshotFromPool').mockResolvedValue({} as any);

      const executedSql: { text: string; params?: unknown[] }[] = [];
      let queryCount = 0;

      const mockClient = buildMockPoolClient(async (sql, params) => {
        executedSql.push({ text: sql, params });
        if (sql.includes('WITH next_batch AS')) {
          queryCount++;
          if (queryCount === 1) {
            return {
              rows: [
                {
                  id: 101,
                  aggregate_type: 'product',
                  aggregate_id: 1,
                  event_type: 'product.created',
                  payload: {},
                  attempt_count: 1,
                  max_attempts: 5,
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('UPDATE app_outbox_events SET status = \'processed\'')) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient);
      vi.spyOn(appPool, 'query').mockImplementation(async (sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('FROM app_outbox_events')) {
          return { rows: [{ has_pending_due: false, has_future_pending: false, has_expired_lease: false }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const worker = new ReadModelOutboxWorker({ batchSize: 25, leaseDurationMs: 10000 });
      const result = await worker.drainNow('manual_test');

      expect(result.processedCount).toBe(1);

      const claimQuery = executedSql.find((q) => q.text.includes('WITH next_batch AS'));
      expect(claimQuery).toBeDefined();
      expect(claimQuery?.text).toContain('ORDER BY id ASC');
      expect(claimQuery?.text).toContain('LIMIT $1');
      expect(claimQuery?.text).toContain('FOR UPDATE SKIP LOCKED');
      expect(claimQuery?.params?.[0]).toBe(25);
    });
  });

  describe('2. Expired Lease Recovery', () => {
    it('reclaims expired leases before claiming next batch', async () => {
      vi.spyOn(mongodbConfig, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(true);

      const executedSql: { text: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executedSql.push({ text: sql, params });
        if (sql.includes('UPDATE app_outbox_events') && sql.includes('lease_expires_at < NOW()')) {
          return { rows: [], rowCount: 2 };
        }
        if (sql.includes('WITH next_batch AS')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      });

      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient);
      vi.spyOn(appPool, 'query').mockImplementation(async (sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT') && sql.includes('FROM app_outbox_events')) {
          return { rows: [{ has_pending_due: false, has_future_pending: false, has_expired_lease: false }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const worker = new ReadModelOutboxWorker({ batchSize: 10 });
      await worker.drainNow('lease_reclaim_test');

      const reclaimQuery = executedSql.find(
        (q) => (q.text.includes('status = \'pending\'') || q.text.includes('ELSE \'pending\' END')) && q.text.includes('lease_expires_at < NOW()')
      );
      expect(reclaimQuery).toBeDefined();
    });
  });

  describe('3. Zero Idle Polling & Failure Backoff Invariants', () => {
    it('runs with zero recurring timers when outbox is empty', async () => {
      vi.useFakeTimers();

      const worker = new ReadModelOutboxWorker({ batchSize: 10 });
      expect(worker.hasRetryTimerScheduled()).toBe(false);
      expect(worker.hasDashboardRefreshTimerScheduled()).toBe(false);

      vi.advanceTimersByTime(60000);

      // No timers were created during idle time
      expect(worker.hasRetryTimerScheduled()).toBe(false);
      expect(worker.hasDashboardRefreshTimerScheduled()).toBe(false);
    });

    it('schedules one-shot exponential backoff on drain failure', async () => {
      vi.useFakeTimers();

      const worker = new ReadModelOutboxWorker({ batchSize: 10, maxBackoffMs: 30000 });
      worker.handleDrainFailure(new Error('Transient Mongo timeout'), 'test');

      const status = worker.getStatus();
      expect(status.consecutiveFailureCount).toBe(1);
      expect(status.retryTimerScheduled).toBe(true);
      expect(status.lastFailureMessage).toContain('Transient Mongo timeout');
    });
  });
});
