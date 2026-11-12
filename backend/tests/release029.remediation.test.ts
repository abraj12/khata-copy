import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  appPool,
  EXPECTED_MIGRATIONS,
  resolveDatabasePoolTargets,
  TestDatabaseUnavailableError,
} from '../src/config/database.js';
import { assertSafeTestDatabaseUrl } from '../src/config/testDbGuard.js';
import * as mongoModule from '../src/config/mongodb.js';
import {
  buildCustomerSearchTokens,
  buildProductSearchTokens,
  readModelSyncService,
  tokenizeSearchText,
} from '../src/modules/readModels/readModelSync.service.js';
import {
  InvalidPaginationCursorError,
  readModelsQueryService,
} from '../src/modules/readModels/readModelsQuery.service.js';
import { ReadModelOutboxWorker } from '../src/modules/readModels/readModelOutbox.worker.js';
import {
  CustomerSummaryModel,
  DashboardSnapshotModel,
  ProductSearchModel,
  RecentActivityModel,
} from '../src/modules/readModels/models.js';
import { productsService } from '../src/modules/products/products.service.js';
import { gstInvoicesService } from '../src/modules/gstInvoices/gstInvoices.service.js';
import { normalBillsService } from '../src/modules/normalBills/normalBills.service.js';
import { offlineBillsService } from '../src/modules/offlineBills/offlineBills.service.js';
import { storageService } from '../src/services/storage.service.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

function buildMockPoolClient(queryImpl: (sql: any, params?: any[]) => Promise<any>) {
  return {
    query: vi.fn().mockImplementation(queryImpl),
    release: vi.fn(),
  } as any;
}

describe('Khata Release #029 — Reliability, DSA Search, Keyset Pagination & Hardening Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    readModelsQueryService.markOutboxBacklogPending(false);
    readModelsQueryService.setOutboxDeadLetterCount(0);
    readModelsQueryService.setLastWorkerError(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    env.MONGODB_ENABLED = false;
  });

  describe('1. Projection vs Dashboard Timestamp Freshness Separation', () => {
    it('syncDashboardSnapshot preserves lastProjectionSyncAt when updating dashboard snapshot and advances lastDashboardRefreshAt', async () => {
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);

      const mockClient = buildMockPoolClient(async (sql: any) => {
        const text = String(sql);
        if (text.includes('total_customers')) {
          return {
            rows: [{ total_customers: 5, total_udhar: '5000.00', total_paid: '2500.00', total_outstanding_due: '2500.00' }],
            rowCount: 1,
          };
        }
        if (text.includes('total_products')) {
          return {
            rows: [{ total_products: 10, active_products: 9, archived_products: 1 }],
            rowCount: 1,
          };
        }
        if (text.includes('total_suppliers')) {
          return {
            rows: [{ total_suppliers: 2, supplier_payable_total: '500.00' }],
            rowCount: 1,
          };
        }
        if (text.includes('MAX(id)::bigint AS max_id')) {
          return { rows: [{ max_id: 95 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      vi.spyOn(readModelsQueryService, 'buildOverviewFromAnalytics').mockResolvedValue({
        period: { preset: 'all_time', fromDate: '2026-01-01', toDate: '2026-11-12', label: 'All Time' },
        kpis: {} as any,
        charts: {} as any,
      } as any);

      vi.spyOn(DashboardSnapshotModel, 'findOne').mockReturnValue({
        select: () => ({
          lean: vi.fn().mockResolvedValue({ lastOutboxEventId: 90 }),
        }),
      } as any);

      const updateOneSpy = vi
        .spyOn(DashboardSnapshotModel, 'updateOne')
        .mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1 } as any);

      await readModelSyncService.syncDashboardSnapshot(mockClient, null, {
        updateProjectionSyncAt: false,
      });
      expect(updateOneSpy).toHaveBeenCalledTimes(1);

      const firstDoc = updateOneSpy.mock.calls[0]?.[1] as any;
      expect(firstDoc.$set.lastDashboardRefreshAt).toBeInstanceOf(Date);
      expect(firstDoc.$max).toBeUndefined();

      const explicitProj = new Date('2026-11-12T04:20:00.000Z');
      await readModelSyncService.syncDashboardSnapshot(mockClient, 96, {
        updateProjectionSyncAt: explicitProj,
      });
      const secondDoc = updateOneSpy.mock.calls[1]?.[1] as any;
      expect(secondDoc.$max.lastProjectionSyncAt).toEqual(explicitProj);
    });

    it('applyOutboxBatch advances projection sync timestamp via $max without touching lastDashboardRefreshAt', async () => {
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);

      const mockClient = buildMockPoolClient(async (sql: any) => {
        const text = String(sql);
        if (text.includes('FROM products')) {
          return {
            rows: [
              {
                id: 11,
                name: 'Basmati Rice',
                buying_price: '80.00',
                hsn_code: '1006',
                barcode: '0001122',
                image_object_key: null,
                image_updated_at: null,
                archived_at: null,
                created_at: new Date('2026-11-01T00:00:00.000Z'),
                updated_at: new Date('2026-11-12T05:00:00.000Z'),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient);

      vi.spyOn(ProductSearchModel, 'find').mockReturnValue({
        select: () => ({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);
      vi.spyOn(ProductSearchModel, 'bulkWrite').mockResolvedValue({ ok: 1 } as any);
      vi.spyOn(RecentActivityModel, 'updateOne').mockResolvedValue({ ok: 1 } as any);
      const dashUpdateSpy = vi
        .spyOn(DashboardSnapshotModel, 'updateOne')
        .mockResolvedValue({ ok: 1, matchedCount: 1, modifiedCount: 1 } as any);

      const ids = await readModelSyncService.applyOutboxBatch(
        [
          {
            id: 501,
            event_id: 'evt-501',
            aggregate_type: 'product',
            aggregate_id: '11',
            event_type: 'product.updated',
            payload: {},
            created_at: new Date('2026-11-12T05:00:00.000Z'),
          },
        ],
        { skipDashboardSnapshot: true }
      );

      expect(ids).toEqual([501]);
      expect(dashUpdateSpy).toHaveBeenCalledTimes(1);
      const updateArg = dashUpdateSpy.mock.calls[0]?.[1] as any;
      expect(updateArg.$max.lastProjectionSyncAt).toBeInstanceOf(Date);
      expect(updateArg.$max.lastOutboxEventId).toBe(501);
      expect(updateArg.$set).toBeUndefined();
    });

    it('buildSyncStatus evaluates projection vs dashboard timestamps separately and flags worker errors as stale', () => {
      const staleTs = new Date(Date.now() - 10 * 60_000);
      const freshTs = new Date();

      const projStatus = readModelsQueryService.buildSyncStatus(
        {
          lastProjectionSyncAt: freshTs,
          lastDashboardRefreshAt: staleTs,
          lastSyncedAt: staleTs,
        },
        'projection'
      );
      expect(projStatus.isStale).toBe(false);
      expect(projStatus.projectionSyncedAt).toBe(freshTs.toISOString());
      expect(projStatus.dashboardSyncedAt).toBe(staleTs.toISOString());

      const dashStatus = readModelsQueryService.buildSyncStatus(
        {
          lastProjectionSyncAt: freshTs,
          lastDashboardRefreshAt: staleTs,
          lastSyncedAt: staleTs,
        },
        'dashboard'
      );
      expect(dashStatus.isStale).toBe(true);

      readModelsQueryService.setLastWorkerError('Simulated Mongo write failure');
      const errStatus = readModelsQueryService.buildSyncStatus(
        {
          lastProjectionSyncAt: freshTs,
          lastDashboardRefreshAt: freshTs,
          lastSyncedAt: freshTs,
        },
        'projection'
      );
      expect(errStatus.isStale).toBe(true);
      expect(errStatus.outboxDegraded).toBe(true);
      expect(readModelsQueryService.getLastWorkerError()).toBe('Simulated Mongo write failure');
    });
  });

  describe('2. Dashboard Refresh Concurrency & Trailing Execution', () => {
    it('coalesces concurrent flushDashboardRefresh calls and schedules a trailing refresh when dirtied mid-flight', async () => {
      vi.useFakeTimers();
      vi.spyOn(mongoModule, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);

      let resolveFirst!: () => void;
      const refreshSpy = vi
        .spyOn(readModelSyncService, 'refreshGlobalDashboardSnapshotFromPool')
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockResolvedValue(undefined);

      const worker = new ReadModelOutboxWorker({ dashboardRefreshMinIntervalMs: 100 });

      const firstPromise = worker.flushDashboardRefresh();
      const secondPromise = worker.flushDashboardRefresh();
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      resolveFirst();
      await Promise.all([firstPromise, secondPromise]);

      expect(worker.hasDashboardRefreshTimerScheduled()).toBe(true);
      expect(worker.getStatus().dashboardRefreshDirty).toBe(true);

      await vi.advanceTimersByTimeAsync(150);
      expect(refreshSpy).toHaveBeenCalledTimes(2);
      expect(worker.getStatus().dashboardRefreshDirty).toBe(false);

      await worker.stop();
    });
  });

  describe('3. Legacy Dead-Letter Migration, Status Listing & Retry + Lease Scheduling', () => {
    it('includes migration 029 backfilling exhausted failed rows and creating unresolved outbox + pg_trgm indexes', () => {
      expect(EXPECTED_MIGRATIONS).toContain('029_outbox_legacy_dead_letter_and_perf_indexes.sql');
      const repoRoot = path.resolve(process.cwd(), '..');
      const sql = fs.readFileSync(
        path.join(repoRoot, 'backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql'),
        'utf8'
      );
      expect(sql).toContain("SET status = 'dead_letter'");
      expect(sql).toContain("WHERE status = 'failed'");
      expect(sql).toContain('attempt_count >= max_attempts');
      expect(sql).toContain('idx_app_outbox_unresolved_created');
      expect(sql).toContain('gin_trgm_ops');
    });

    it('lists both dead_letter and legacy exhausted failed events, handles nullable timestamps safely, and allows retry', async () => {
      env.MONGODB_ENABLED = false;
      const app = createApp({ useMemoryStoreInTest: true });

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        if (text.includes('pending_count')) {
          return {
            rows: [
              {
                pending_count: 0,
                processing_count: 0,
                failed_retryable_count: 1,
                dead_letter_count: 2,
                processed_count: 50,
                oldest_unresolved_age_ms: 9000,
              },
            ],
            rowCount: 1,
          } as any;
        }
        if (text.includes('FROM app_outbox_events') && text.includes('ORDER BY')) {
          return {
            rows: [
              {
                id: 901,
                event_id: 'evt-901',
                aggregate_type: 'product',
                aggregate_id: '15',
                event_type: 'product.updated',
                attempt_count: 5,
                max_attempts: 5,
                last_error: 'Legacy failed row',
                dead_letter_at: null,
                created_at: '2026-11-10T10:00:00.000Z',
                updated_at: null,
              },
            ],
            rowCount: 1,
          } as any;
        }
        if (text.includes('UPDATE app_outbox_events')) {
          return {
            rows: [
              {
                id: 901,
                event_id: 'evt-901',
                aggregate_type: 'product',
                aggregate_id: '15',
                event_type: 'product.updated',
                status: 'pending',
                attempt_count: 0,
                max_attempts: 5,
              },
            ],
            rowCount: 1,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const loginRes = await request(app).post('/api/v1/auth/login').send({
        phone: TEST_PHONE,
        password: TEST_PASSWORD,
      });
      const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
      const csrfRes = await request(app).get('/api/v1/auth/csrf-token').set('Cookie', cookie);

      const statusRes = await request(app).get('/api/v1/read-model-sync/status').set('Cookie', cookie);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data.outbox.deadLetterCount).toBe(2);
      expect(statusRes.body.data.outbox.recentDeadLetters).toHaveLength(1);
      expect(statusRes.body.data.outbox.recentDeadLetters[0].deadLetterAt).toBeNull();
      expect(statusRes.body.data.outbox.recentDeadLetters[0].updatedAt).toBeNull();

      const retryRes = await request(app)
        .post('/api/v1/read-model-sync/outbox/901/retry')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfRes.body.csrfToken);
      expect(retryRes.status).toBe(200);
      expect(retryRes.body.event.status).toBe('pending');
      expect(retryRes.body.event.attemptCount).toBe(0);
    });

    it('schedules wake delay from processing lease expiry instead of 1-second polling and reclaims NULL leases in SQL', async () => {
      vi.useFakeTimers();
      vi.spyOn(mongoModule, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);

      const capturedSqls: string[] = [];
      vi.spyOn(appPool, 'connect').mockResolvedValue(
        buildMockPoolClient(async (sql: any) => {
          capturedSqls.push(String(sql));
          return { rows: [], rowCount: 0 };
        })
      );

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = String(sql);
        if (text.includes('next_wake_at')) {
          const nowMs = Date.now();
          return {
            rows: [
              {
                next_wake_at: new Date(nowMs + 28_000).toISOString(),
                server_now: new Date(nowMs).toISOString(),
              },
            ],
            rowCount: 1,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const worker = new ReadModelOutboxWorker();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      await worker.drainNow();

      const reclaimSql = capturedSqls.find((s) => s.includes("SET status = 'pending'") || s.includes("ELSE 'pending' END"));
      expect(reclaimSql).toBeTruthy();
      expect(reclaimSql).toContain('lease_expires_at IS NULL');
      expect(reclaimSql).toContain('lease_expires_at < NOW()');
      expect(worker.hasRetryTimerScheduled()).toBe(true);

      const retryDelays = setTimeoutSpy.mock.calls.map((c) => Number(c[1]));
      expect(retryDelays.some((ms) => ms >= 28_000)).toBe(true);
      expect(retryDelays).not.toContain(1000);

      await worker.stop();
    });

    it('propagates DB backlog inspection failures to handleDrainFailure rather than swallowing errors', async () => {
      vi.spyOn(mongoModule, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);

      vi.spyOn(appPool, 'connect').mockResolvedValue(
        buildMockPoolClient(async () => ({ rows: [], rowCount: 0 }))
      );
      vi.spyOn(appPool, 'query').mockRejectedValueOnce(new Error('PG inspect connection lost'));

      const worker = new ReadModelOutboxWorker();
      await worker.drainNow();

      const status = worker.getStatus();
      expect(status.consecutiveFailureCount).toBe(1);
      expect(status.lastFailureMessage).toContain('PG inspect connection lost');
      expect(status.retryTimerScheduled).toBe(true);

      await worker.stop();
    });
  });

  describe('4. Indic Unicode Search Tokenization, Prioritization & High-Performance Query Paths', () => {
    it('preserves Devanagari (Hindi) and Gurmukhi (Punjabi) combining matras without corruption', () => {
      const hindiTokens = tokenizeSearchText('बासमती चावल 1किग्रा प्रीमियम');
      expect(hindiTokens).toContain('बासमती');
      expect(hindiTokens).toContain('चावल');
      expect(hindiTokens).toContain('1किग्रा');

      const punjabiTokens = tokenizeSearchText('ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ ਆਟਾ ਦਾਲ');
      expect(punjabiTokens).toContain('ਗੁਰਪ੍ਰੀਤ');
      expect(punjabiTokens).toContain('ਸਿੰਘ');
      expect(punjabiTokens).toContain('ਆਟਾ');
      expect(punjabiTokens).toContain('ਦਾਲ');

      const prodTokens = buildProductSearchTokens({
        name: 'आशीर्वाद शुद्ध आटा 5किग्रा',
        hsnCode: '11010000',
        barcode: '0089017251234',
      });
      expect(prodTokens).toContain('आश');
      expect(prodTokens).toContain('आट');
      expect(prodTokens).toContain('11010000');
      expect(prodTokens).toContain('0089017251234');
      expect(prodTokens.length).toBeLessThanOrEqual(96);
    });

    it('prioritizes product name prefixes ahead of HSN/barcode noise and respects maxTokens cap', () => {
      const veryLongName = Array.from({ length: 18 }, (_, i) => `alphabetaword${i}`).join(' ');
      const boundedTokens = buildProductSearchTokens(
        {
          name: veryLongName,
          hsnCode: '10063020',
          barcode: '8901234567890',
        },
        24
      );

      expect(boundedTokens.length).toBeLessThanOrEqual(24);
      expect(boundedTokens.some((t) => t.startsWith('alpha'))).toBe(true);

      const defaultTokens = buildProductSearchTokens({
        name: 'Basmati Rice 1kg',
        hsnCode: '10063020',
        barcode: '8901234567890',
      });
      expect(defaultTokens.length).toBeLessThanOrEqual(96);
      expect(defaultTokens).toContain('10063020');
      expect(defaultTokens).toContain('8901234567890');
    });

    it('builds Indian phone search variants (+91 / 0 / 10-digit) and Indic name tokens in buildCustomerSearchTokens', () => {
      const custTokens = buildCustomerSearchTokens('राधेश्याम शर्मा', '+91-98112 23344', '9811223344');
      expect(custTokens).toContain('9811223344');
      expect(custTokens).toContain('919811223344');
      expect(custTokens).toContain('राध');
      expect(custTokens.length).toBeLessThanOrEqual(96);
    });

    it('uses lexicographic $gte/$lt prefix bounds without $regex and skips countDocuments on multi-page product search', async () => {
      env.MONGODB_ENABLED = true;
      vi.spyOn(mongoModule, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);

      vi.spyOn(DashboardSnapshotModel, 'findOne').mockReturnValue({
        select: () => ({
          lean: vi.fn().mockResolvedValue({
            lastProjectionSyncAt: new Date(),
            lastDashboardRefreshAt: new Date(),
            lastSyncedAt: new Date(),
          }),
        }),
      } as any);

      let capturedFilter: Record<string, unknown> | null = null;
      const threeDocs = Array.from({ length: 3 }, (_, idx) => ({
        productId: idx + 1,
        name: `Rice ${idx + 1}`,
        normalizedName: `rice ${idx + 1}`,
        buyingPrice: '90.00',
        hsnCode: '1006',
        barcode: `89000${idx + 1}`,
        imageObjectKey: null,
        imageUpdatedAt: null,
        isArchived: false,
        sourceCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
        sourceUpdatedAt: new Date('2026-01-02T00:00:00.000Z'),
      }));

      vi.spyOn(ProductSearchModel, 'find').mockImplementation((filter: any) => {
        capturedFilter = filter;
        const chain: any = {
          sort: () => chain,
          skip: () => chain,
          limit: () => chain,
          select: () => chain,
          lean: vi.fn().mockResolvedValue(threeDocs),
        };
        return chain;
      });
      const countSpy = vi.spyOn(ProductSearchModel, 'countDocuments').mockResolvedValue(999);

      const res = await readModelsQueryService.searchProductsFromMongo({
        search: 'rice',
        limit: 2,
      });

      expect(res.products).toHaveLength(2);
      expect(res.hasMore).toBe(true);
      expect(res.nextCursor).toBeTruthy();
      expect(res.total).toBeNull();
      expect(res.totalIsExact).toBe(false);
      expect(countSpy).not.toHaveBeenCalled();

      const serializedFilter = JSON.stringify(capturedFilter);
      expect(serializedFilter).toContain('$gte');
      expect(serializedFilter).toContain('$lt');
      expect(serializedFilter).not.toContain('$regex');
    });

    it('rejects pagination cursors replayed across different search queries or tampered HMAC signatures', async () => {
      env.MONGODB_ENABLED = true;
      vi.spyOn(mongoModule, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);

      vi.spyOn(DashboardSnapshotModel, 'findOne').mockReturnValue({
        select: () => ({
          lean: vi.fn().mockResolvedValue({
            lastProjectionSyncAt: new Date(),
            lastDashboardRefreshAt: new Date(),
            lastSyncedAt: new Date(),
          }),
        }),
      } as any);

      vi.spyOn(CustomerSummaryModel, 'find').mockImplementation(() => {
        const chain: any = {
          sort: () => chain,
          skip: () => chain,
          limit: () => chain,
          select: () => chain,
          lean: vi.fn().mockResolvedValue([
            {
              customerId: 1,
              name: 'Alpha Customer',
              phone: '9811111111',
              totalUdhar: 1000,
              totalPaid: 200,
              outstandingBalance: 800,
              lastActivityAt: null,
              lastTransactionDate: null,
              sourceCreatedAt: new Date(),
              sourceUpdatedAt: new Date(),
            },
            {
              customerId: 2,
              name: 'Beta Customer',
              phone: '9822222222',
              totalUdhar: 1000,
              totalPaid: 200,
              outstandingBalance: 800,
              lastActivityAt: null,
              lastTransactionDate: null,
              sourceCreatedAt: new Date(),
              sourceUpdatedAt: new Date(),
            },
          ]),
        };
        return chain;
      });

      const page1 = await readModelsQueryService.listCustomersFromMongo({
        search: 'alpha',
        limit: 1,
      });
      expect(page1.nextCursor).toBeTruthy();

      await expect(
        readModelsQueryService.listCustomersFromMongo({
          search: 'beta',
          limit: 1,
          cursor: page1.nextCursor!,
        })
      ).rejects.toThrow(InvalidPaginationCursorError);

      const [payloadPart, sigPart] = String(page1.nextCursor).split('.');
      const tampered = `${payloadPart.slice(0, -1)}${payloadPart.endsWith('a') ? 'b' : 'a'}.${sigPart}`;
      await expect(
        readModelsQueryService.listCustomersFromMongo({
          search: 'alpha',
          limit: 1,
          cursor: tampered,
        })
      ).rejects.toThrow(InvalidPaginationCursorError);
    });
  });

  describe('5. Database Guard, SQL LIKE Escaping, R2 Image Failure Safety & Auth Session Revocation', () => {
    it('enforces TestDatabaseUnavailableError guard for DB-free unit tests while preserving integration safety checks', async () => {
      const guard = resolveDatabasePoolTargets(
        {
          NODE_ENV: 'test',
          TEST_DATABASE_URL: undefined,
          REQUIRE_TEST_DATABASE_URL: 'false',
        },
        {
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://user:pass@localhost:5432/khata_dev',
          DATABASE_URL_POOLED: 'postgresql://user:pass@localhost:5432/khata_dev',
        }
      );
      expect(guard.isUnitTestUnavailable).toBe(true);

      await expect(appPool.query('SELECT 1')).rejects.toThrow(TestDatabaseUnavailableError);
      expect(() =>
        assertSafeTestDatabaseUrl('postgresql://neondb_owner:secret@ep-cool.neon.tech/neondb?sslmode=require')
      ).toThrow();
      expect(() =>
        assertSafeTestDatabaseUrl('postgres://postgres:postgres@127.0.0.1:55432/khata_test')
      ).not.toThrow();
    });

    it('escapes LIKE metacharacters (% and _) with ESCAPE backslash in GST invoices, normal bills, and offline bills', async () => {
      const capturedSql: Array<{ text: string; params: any[] }> = [];
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any[]) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        capturedSql.push({ text, params: params || [] });
        return { rows: [], rowCount: 0 } as any;
      });

      await gstInvoicesService.listInvoices({ search: '50%_discount\\test', limit: 10, offset: 0 });
      await normalBillsService.listBills({ search: '50%_discount\\test', limit: 10, offset: 0 });
      await offlineBillsService.listOfflineBills({ search: '50%_discount\\test', limit: 10, offset: 0 });

      expect(capturedSql.length).toBeGreaterThanOrEqual(3);
      for (const entry of capturedSql) {
        expect(entry.text).toContain("ESCAPE '\\'");
        expect(entry.params.some((p) => typeof p === 'string' && p.includes('50\\%\\_discount\\\\test'))).toBe(true);
      }
    });

    it('preserves existing product image in R2 on DB rollback, deletes orphan on attach failure, and keeps original DB error if cleanup fails', async () => {
      vi.spyOn(productsService, 'getProductById').mockResolvedValue({
        id: 21,
        name: 'Spices',
        buying_price: '50.00',
        image_object_key: 'products/21/existing-old.jpg',
        archived_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any);

      vi.spyOn(storageService, 'verifyObject').mockResolvedValue({
        contentType: 'image/png',
        contentLength: 2048,
      } as any);

      const deleteSpy = vi
        .spyOn(storageService, 'deleteObject')
        .mockRejectedValue(new Error('R2 temporary delete failure'));

      vi.spyOn(appPool, 'connect').mockResolvedValue(
        buildMockPoolClient(async (sql: any) => {
          const text = String(sql);
          if (text.includes('FOR UPDATE')) {
            return {
              rows: [{ id: 21, archived_at: null, image_object_key: 'products/21/existing-old.jpg' }],
              rowCount: 1,
            };
          }
          if (text.includes('UPDATE products')) {
            throw new Error('PG disk full');
          }
          return { rows: [], rowCount: 0 };
        })
      );

      await expect(productsService.attachProductImage(21, 'products/21/new-candidate.png')).rejects.toThrow(
        'PG disk full'
      );

      expect(deleteSpy).toHaveBeenCalledWith('products/21/new-candidate.png');
      expect(deleteSpy).not.toHaveBeenCalledWith('products/21/existing-old.jpg');
    });

    it('revokes server-side session on logout under concurrent session checks so replayed cookie is rejected with 401', async () => {
      const app = createApp({ useMemoryStoreInTest: true });
      vi.spyOn(appPool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);

      const loginRes = await request(app).post('/api/v1/auth/login').send({
        phone: TEST_PHONE,
        password: TEST_PASSWORD,
      });
      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
      const csrfRes = await request(app).get('/api/v1/auth/csrf-token').set('Cookie', cookie);

      await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfRes.body.csrfToken)
        .expect(200);

      const meAfterLogout = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
      expect(meAfterLogout.status).toBe(401);
    });
  });
});
