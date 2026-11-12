import { storageService as globalStorageService } from '../src/services/storage.service.js';
import * as mongodbConfig from '../src/config/mongodb.js';
import { setForceMongoReadyInTests, resetForceMongoReadyInTests } from '../src/config/mongodb.js';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import { validateAndParseMongoEnv } from '../src/config/mongoEnv.js';
import { readModelsQueryService } from '../src/modules/readModels/readModelsQuery.service.js';
import {
  buildCustomerSearchTokens,
  bulkUpsertByNumericKey,
  readModelSyncService,
  upsertProjectionWithTimestampGuard,
} from '../src/modules/readModels/readModelSync.service.js';
import { ReadModelOutboxWorker } from '../src/modules/readModels/readModelOutbox.worker.js';
import { CustomerSummaryModel, ProductSearchModel, RecentActivityModel, DashboardSnapshotModel } from '../src/modules/readModels/models.js';
import { NotificationModel, SearchAnalyticsModel } from '../src/modules/appData/models.js';
import { appDataService } from '../src/modules/appData/appData.service.js';
import { StorageService } from '../src/services/storage.service.js';
import { offlineBillsService } from '../src/modules/offlineBills/offlineBills.service.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH = '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const app = createApp({ useMemoryStoreInTest: true });

describe('Khata Release #028 — Reliability, Consistency, Neon Optimization & Production Hardening Suite', () => {
  const prevMongoEnabled = env.MONGODB_ENABLED;
  const prevStaleMs = env.MONGODB_READ_STALE_THRESHOLD_MS;

  beforeEach(() => {
    vi.restoreAllMocks();
    env.MONGODB_ENABLED = true;
    setForceMongoReadyInTests(true);
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    readModelsQueryService.markOutboxBacklogPending(false);
    readModelsQueryService.setOutboxDeadLetterCount(0);
    readModelsQueryService.setLastWorkerError(null);
  });

  afterEach(() => {
    resetForceMongoReadyInTests();
    vi.useRealTimers();
    env.MONGODB_ENABLED = prevMongoEnabled;
    env.MONGODB_READ_STALE_THRESHOLD_MS = prevStaleMs;
    readModelsQueryService.markOutboxBacklogPending(false);
    readModelsQueryService.setOutboxDeadLetterCount(0);
    readModelsQueryService.setLastWorkerError(null);
  });

  describe('1. Sync Status Stale Thresholds, Separated Projection/Dashboard Timestamps & Dead-Letter Degradation', () => {
    it('reports isStale=true when projectionSyncedAt exceeds threshold EVEN when outbox backlog is empty', () => {
      env.MONGODB_READ_STALE_THRESHOLD_MS = 30_000;
      const staleTime = new Date(Date.now() - 120_000);

      const status = readModelsQueryService.buildSyncStatus(
        {
          lastSyncedAt: staleTime,
          lastProjectionSyncAt: staleTime,
          lastDashboardRefreshAt: staleTime,
        },
        'projection'
      );

      expect(status.isStale).toBe(true);
      expect(status.ageMs).toBeGreaterThanOrEqual(119_000);
      expect(status.projectionSyncedAt).toBe(staleTime.toISOString());
      expect(status.dashboardSyncedAt).toBe(staleTime.toISOString());
      expect(status.outboxDegraded).toBe(false);
    });

    it('separates projection freshness from delayed coalesced dashboard refresh without false stale alerts on searches', () => {
      env.MONGODB_READ_STALE_THRESHOLD_MS = 60_000;
      const freshProjection = new Date(Date.now() - 5_000);
      const delayedDashboard = new Date(Date.now() - 180_000);

      const projectionScope = readModelsQueryService.buildSyncStatus(
        {
          lastProjectionSyncAt: freshProjection,
          lastDashboardRefreshAt: delayedDashboard,
        },
        'projection'
      );
      expect(projectionScope.isStale).toBe(false);
      expect(projectionScope.projectionAgeMs).toBeLessThan(20_000);
      expect(projectionScope.dashboardAgeMs).toBeGreaterThanOrEqual(175_000);

      const dashboardScope = readModelsQueryService.buildSyncStatus(
        {
          lastProjectionSyncAt: freshProjection,
          lastDashboardRefreshAt: delayedDashboard,
        },
        'dashboard'
      );
      expect(dashboardScope.isStale).toBe(true);
    });

    it('reports outboxDegraded=true and isStale=true when dead-letter count > 0 or worker recorded an error', () => {
      const now = new Date();
      readModelsQueryService.setOutboxDeadLetterCount(2);
      readModelsQueryService.setLastWorkerError('Transient Neon timeout');

      const status = readModelsQueryService.buildSyncStatus(
        { lastProjectionSyncAt: now, lastDashboardRefreshAt: now },
        'projection'
      );
      expect(status.deadLetterCount).toBe(2);
      expect(status.outboxDegraded).toBe(true);
      expect(status.isStale).toBe(true);
    });
  });

  describe('2. Resilient Transactional Outbox Worker (Error Propagation, Dead-Letter, Lease Renewal & Coalescing)', () => {
    function bindWorkerPoolAndMongoMocks(
      queryImpl: (sql: any, params?: any) => Promise<any>
    ) {
      env.MONGODB_ENABLED = true;
      vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
      const querySpy = vi.spyOn(appPool, 'query').mockImplementation(queryImpl as any);
      vi.spyOn(appPool, 'connect').mockImplementation(async () => ({
        query: querySpy,
        release: vi.fn(),
      }) as any);
      return querySpy;
    }

    it('propagates failure-recording DB errors to handleDrainFailure, sets error state, and recovers cleanly', async () => {
      const worker = new ReadModelOutboxWorker({
        batchSize: 5,
        dashboardRefreshMinIntervalMs: 15_000,
      });

      const batch = [
        {
          id: 41,
          aggregate_type: 'product',
          aggregate_id: '10',
          event_type: 'product.updated',
          payload: {},
          attempt_count: 1,
          max_attempts: 5,
        },
      ];

      vi.spyOn(readModelSyncService, 'applyOutboxBatch').mockRejectedValueOnce(new Error('Mongo ECONNRESET'));
      const querySpy = bindWorkerPoolAndMongoMocks(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        if (text.includes('FOR UPDATE SKIP LOCKED')) {
          return { rows: batch, rowCount: 1 } as any;
        }
        if (text.includes("SET status = 'failed'") || text.includes('dead_letter_at')) {
          throw new Error('PG connection dropped while marking failed');
        }
        return { rows: [], rowCount: 0 } as any;
      });

      await worker.drainNow();

      const degradedStatus = worker.getStatus();
      expect(degradedStatus.consecutiveFailureCount).toBe(1);
      expect(degradedStatus.lastFailureMessage).toContain('PG connection dropped');
      expect(degradedStatus.retryTimerScheduled).toBe(true);
      expect(readModelsQueryService.getLastWorkerError()).toContain('PG connection dropped');

      // Recovery on next successful empty drain
      querySpy.mockImplementation(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        if (text.includes('FOR UPDATE SKIP LOCKED')) {
          return { rows: [], rowCount: 0 } as any;
        }
        if (text.includes('dead_letter')) {
          return { rows: [{ dead_letter_count: 0 }], rowCount: 1 } as any;
        }
        return { rows: [{ delay_ms: null, unresolved_count: 0 }], rowCount: 1 } as any;
      });

      await worker.drainNow();
      const recovered = worker.getStatus();
      expect(recovered.consecutiveFailureCount).toBe(0);
      expect(recovered.lastFailureMessage).toBeNull();
      expect(readModelsQueryService.getLastWorkerError()).toBeNull();

      await worker.stop();
    });

    it('transitions exhausted events to dead_letter with dead_letter_at and updates dead-letter indicator', async () => {
      const worker = new ReadModelOutboxWorker({ batchSize: 5 });
      const capturedSql: string[] = [];

      vi.spyOn(readModelSyncService, 'applyOutboxBatch').mockRejectedValueOnce(new Error('Validation error'));
      bindWorkerPoolAndMongoMocks(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        capturedSql.push(text);
        if (text.includes('FOR UPDATE SKIP LOCKED')) {
          return {
            rows: [
              {
                id: 99,
                aggregate_type: 'customer',
                aggregate_id: '5',
                event_type: 'customer.updated',
                payload: {},
                attempt_count: 5,
                max_attempts: 5,
              },
            ],
            rowCount: 1,
          } as any;
        }
        if (text.includes('dead_letter_count')) {
          return { rows: [{ dead_letter_count: 1 }], rowCount: 1 } as any;
        }
        if (text.includes('next_wake_at')) {
          return { rows: [{ next_wake_at: null, server_now: new Date().toISOString() }], rowCount: 1 } as any;
        }
        if (text.includes('dead_letter_at')) {
          return { rows: [], rowCount: 1 } as any;
        }
        return { rows: [{ delay_ms: null, unresolved_count: 0 }], rowCount: 1 } as any;
      });

      await worker.drainNow();

      const updateSql = capturedSql.find((s) => s.includes("SET status = 'dead_letter'"));
      expect(updateSql).toBeDefined();
      expect(updateSql).toContain('dead_letter_at');
      expect(worker.getStatus().deadLetterCount).toBe(1);
      expect(readModelsQueryService.getOutboxDeadLetterCount()).toBe(1);

      await worker.stop();
    });

    it('renews active processing leases via one-shot timer while draining long batches and leaves zero idle timers', async () => {
      vi.useFakeTimers();
      const worker = new ReadModelOutboxWorker({
        batchSize: 2,
        leaseDurationMs: 2_000,
        leaseHeartbeatIntervalMs: 500,
      });

      let leaseRenewCalls = 0;
      let finishApply!: () => void;
      const applyPromise = new Promise<number[]>((resolve) => {
        finishApply = () => resolve([55]);
      });

      vi.spyOn(readModelSyncService, 'applyOutboxBatch').mockReturnValueOnce(applyPromise as any);
      vi.spyOn(readModelSyncService, 'refreshGlobalDashboardSnapshotFromPool').mockResolvedValue(undefined);

      let claimCount = 0;
      bindWorkerPoolAndMongoMocks(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        if (text.includes('FOR UPDATE SKIP LOCKED')) {
          claimCount += 1;
          if (claimCount === 1) {
            return {
              rows: [
                {
                  id: 55,
                  aggregate_type: 'product',
                  aggregate_id: '7',
                  event_type: 'product.updated',
                  payload: {},
                  attempt_count: 1,
                  max_attempts: 5,
                },
              ],
              rowCount: 1,
            } as any;
          }
          return { rows: [], rowCount: 0 } as any;
        }
        if (text.includes("status = 'processing'") && text.includes('lease_expires_at = NOW()')) {
          leaseRenewCalls += 1;
          return { rows: [], rowCount: 1 } as any;
        }
        if (text.includes('next_wake_at')) {
          return { rows: [{ next_wake_at: null, server_now: new Date().toISOString() }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const drainPromise = worker.drainNow();
      await vi.advanceTimersByTimeAsync(1_200);
      expect(leaseRenewCalls).toBeGreaterThanOrEqual(2);

      finishApply();
      await drainPromise;
      await worker.stop();
      expect(worker.getStatus().retryTimerScheduled).toBe(false);
    });

    it('coalesces dashboard snapshot refreshes within READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS during burst drains', async () => {
      vi.useFakeTimers();
      const worker = new ReadModelOutboxWorker({
        batchSize: 10,
        dashboardRefreshMinIntervalMs: 15_000,
      });

      const applySpy = vi
        .spyOn(readModelSyncService, 'applyOutboxBatch')
        .mockResolvedValue([1]);
      const refreshSpy = vi
        .spyOn(readModelSyncService, 'refreshGlobalDashboardSnapshotFromPool')
        .mockResolvedValue(undefined);

      let eventId = 100;
      let drainStep = 0;
      bindWorkerPoolAndMongoMocks(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        if (text.includes('FOR UPDATE SKIP LOCKED')) {
          drainStep += 1;
          if (drainStep % 2 === 1) {
            return {
              rows: [
                {
                  id: ++eventId,
                  aggregate_type: 'khata_tx',
                  aggregate_id: '12',
                  event_type: 'udhar.created',
                  payload: {},
                  attempt_count: 1,
                  max_attempts: 5,
                },
              ],
              rowCount: 1,
            } as any;
          }
          return { rows: [], rowCount: 0 } as any;
        }
        if (text.includes('next_wake_at')) {
          return { rows: [{ next_wake_at: null, server_now: new Date().toISOString() }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      await worker.drainNow();
      expect(applySpy).toHaveBeenCalledWith(expect.any(Array), { skipDashboardSnapshot: true });
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      // Burst drain immediately after: deferred rather than hammering PG snapshot query
      await worker.drainNow();
      await worker.drainNow();
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(worker.getStatus().dashboardRefreshDirty).toBe(true);
      expect(worker.getStatus().dashboardRefreshTimerScheduled).toBe(true);

      await vi.advanceTimersByTimeAsync(15_050);
      expect(refreshSpy).toHaveBeenCalledTimes(2);
      expect(worker.getStatus().dashboardRefreshDirty).toBe(false);

      await worker.stop();
    });
  });

  describe('3. Out-of-Order Timestamp Guard, Token Generation, CreatedAt Preservation & Keyset Pagination', () => {
    it('prevents older sourceUpdatedAt projection from overwriting newer state and retries E11000 upsert race', async () => {
      const newerDate = new Date('2026-11-12T08:00:00Z');
      const olderDate = new Date('2026-11-12T07:55:00Z');
      const updateSpy = vi.fn().mockResolvedValue({ acknowledged: true });

      const mockModel = {
        findOne: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValueOnce({ sourceUpdatedAt: newerDate }),
          }),
        }),
        updateOne: updateSpy,
      };

      const staleResult = await upsertProjectionWithTimestampGuard(
        mockModel,
        { productId: 5 },
        { name: 'Stale Name', sourceUpdatedAt: olderDate, projectionUpdatedAt: new Date() }
      );
      expect(staleResult).toBe('skipped_stale');
      expect(updateSpy).not.toHaveBeenCalled();

      // Simulate concurrent insert hitting E11000 then succeeding on retry
      const raceModel = {
        findOne: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(null),
          }),
        }),
        updateOne: vi
          .fn()
          .mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }))
          .mockResolvedValueOnce({ acknowledged: true }),
      };

      const raceResult = await upsertProjectionWithTimestampGuard(
        raceModel,
        { productId: 6 },
        { name: 'Fresh Name', sourceUpdatedAt: newerDate, projectionUpdatedAt: new Date() }
      );
      expect(raceResult).toBe('upserted');
      expect(raceModel.updateOne).toHaveBeenCalledTimes(2);

      // Verify bulkUpsertByNumericKey skips older sourceUpdatedAt entries
      const bulkSpy = vi.fn().mockResolvedValue({ ok: 1 });
      const bulkModel = {
        find: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([{ productId: 10, sourceUpdatedAt: newerDate }]),
          }),
        }),
        bulkWrite: bulkSpy,
      };
      await bulkUpsertByNumericKey(bulkModel, 'productId', [
        { productId: 10, sourceUpdatedAt: olderDate, projectionUpdatedAt: new Date() },
      ]);
      expect(bulkSpy).not.toHaveBeenCalled();
    });

    it('builds customer phone prefix + suffix search tokens and preserves PG created_at in ProductSearch projections', async () => {
      const tokens = buildCustomerSearchTokens('Ramesh Kumar', '+91 98765-43210', '9876543210');
      expect(tokens).toContain('987');
      expect(tokens).toContain('987654');
      expect(tokens).toContain('3210'); // suffix lookup token
      expect(tokens).toContain('ramesh');
      expect(tokens).toContain('kumar');

      const pgCreated = new Date('2025-04-01T10:20:30Z');
      const pgUpdated = new Date('2026-11-11T11:00:00Z');
      let capturedDocs: any[] = [];

      vi.spyOn(ProductSearchModel, 'find').mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);
      vi.spyOn(ProductSearchModel, 'bulkWrite').mockImplementation(async (ops: any[]) => {
        capturedDocs = ops.map((op) => op.updateOne.update.$set || op.updateOne.update.$setOnInsert);
        return { ok: 1 } as any;
      });

      const fakePgClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 77,
              name: 'Portland Cement',
              buying_price: '320.00',
              hsn_code: '2523 29',
              barcode: '8901234567890',
              image_object_key: null,
              image_updated_at: null,
              archived_at: null,
              created_at: pgCreated,
              updated_at: pgUpdated,
            },
          ],
        }),
      } as any;

      await readModelSyncService.syncProductsByIds(fakePgClient, [77]);
      expect(fakePgClient.query.mock.calls[0][0]).toContain('created_at');
      expect(capturedDocs).toHaveLength(1);
      expect(capturedDocs[0].createdAtPg).toEqual(pgCreated);
      expect(capturedDocs[0].normalizedHsnCode).toBe('2523 29');
    });

    it('returns HTTP 400 INVALID_PAGINATION_CURSOR when invalid keyset cursor is passed to /products or /customers', async () => {
      env.MONGODB_ENABLED = true;
      vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);

      vi.spyOn(appPool, 'query').mockResolvedValue({
        rows: [
          { table_name: 'session' },
          { table_name: 'login_attempts' },
          { table_name: 'products' },
          { table_name: 'customers' },
        ],
        rowCount: 4,
      } as any);

      const loginRes = await request(app).post('/api/v1/auth/login').send({
        phone: TEST_PHONE,
        password: TEST_PASSWORD,
      });
      const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';

      const prodRes = await request(app)
        .get('/api/v1/products?cursor=not_valid_base64_json')
        .set('Cookie', cookie);
      expect(prodRes.status).toBe(400);
      expect(prodRes.body.code).toBe('INVALID_PAGINATION_CURSOR');

      const custRes = await request(app)
        .get('/api/v1/khata/customers?cursor=bad_cursor')
        .set('Cookie', cookie);
      expect(custRes.status).toBe(400);
      expect(custRes.body.code).toBe('INVALID_PAGINATION_CURSOR');
    });
  });

  describe('4. Notification Partial Index, ObjectId Route Status, RecentActivity TTL & Analytics PII Redaction', () => {
    it('defines partial unique filter on notifications.dedupeKey and 180d TTL on recent_activity', () => {
      const notifIdx = NotificationModel.schema.indexes();
      const partialUnique = notifIdx.find(
        ([fields, opts]) => fields.dedupeKey === 1 && opts?.unique === true
      );
      expect(partialUnique).toBeDefined();
      expect(partialUnique?.[1]?.sparse).toBeFalsy();
      expect(partialUnique?.[1]?.partialFilterExpression).toEqual({
        dedupeKey: { $type: 'string' },
      });

      const recentIdx = RecentActivityModel.schema.indexes();
      const ttlIdx = recentIdx.find(
        ([fields, opts]) => fields.occurredAt === 1 && typeof opts?.expireAfterSeconds === 'number'
      );
      expect(ttlIdx).toBeDefined();
      expect(ttlIdx?.[1]?.expireAfterSeconds).toBe(180 * 24 * 60 * 60);
    });

    it('omits dedupeKey when null/undefined, handles E11000 duplicates, and maps invalid ObjectId to HTTP 400', async () => {
      env.MONGODB_ENABLED = true;
      vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);

      const createSpy = vi.spyOn(NotificationModel, 'create').mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
      } as any);

      await appDataService.createNotification({
        category: 'system',
        severity: 'info',
        title: 'General alert',
        message: 'No dedupe key supplied',
        dedupeKey: null,
      });

      const insertedDoc = createSpy.mock.calls[0][0] as Record<string, unknown>;
      expect('dedupeKey' in insertedDoc).toBe(false);

      vi.spyOn(NotificationModel, 'updateOne').mockRejectedValueOnce(
        Object.assign(new Error('E11000'), { code: 11000 })
      );
      const dupResult = await appDataService.createNotification({
        category: 'system',
        severity: 'warning',
        title: 'Dup alert',
        message: 'Duplicate dedupeKey',
        dedupeKey: 'evt-1',
      });
      expect(dupResult).toEqual({ created: false, source: 'mongodb' });

      // Route HTTP 400 check (verifies err.status mapping instead of undefined err.statusCode)
      const loginRes = await request(app).post('/api/v1/auth/login').send({
        phone: TEST_PHONE,
        password: TEST_PASSWORD,
      });
      const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
      const csrfRes = await request(app).get('/api/v1/auth/csrf-token').set('Cookie', cookie);

      const badIdRes = await request(app)
        .post('/api/v1/notifications/not-an-object-id/read')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfRes.body.csrfToken);
      expect(badIdRes.status).toBe(400);
      expect(badIdRes.body.code).toBe('INVALID_NOTIFICATION_ID');
    });

    it('redacts customer phone and customer names before storing search analytics', async () => {
      env.MONGODB_ENABLED = true;
      vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
      const spy = vi.spyOn(SearchAnalyticsModel, 'create').mockResolvedValue({} as any);

      await appDataService.recordSearchAnalytics({
        module: 'customers',
        query: '+91 98765-43210',
        resultCount: 1,
        source: 'mongodb',
        durationMs: 4,
      });
      await appDataService.recordSearchAnalytics({
        module: 'customers',
        query: 'Ramesh Patel',
        resultCount: 1,
        source: 'mongodb',
        durationMs: 3,
      });

      expect((spy.mock.calls[0][0] as any).normalizedQuery).toBe('customer_phone_search');
      expect((spy.mock.calls[1][0] as any).normalizedQuery).toBe('customer_name_search');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('98765');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('Ramesh');
    });
  });

  describe('5. Outbox Sync Routes, Deployment Config, Scripts Separation & R2 Audit Hardening', () => {
    it('protects /api/v1/read-model-sync/* with owner session and retries dead-letter events', { timeout: 15000 }, async () => {
      const unauthStatus = await request(app).get('/api/v1/read-model-sync/status');
      expect(unauthStatus.status).toBe(401);

      const loginRes = await request(app).post('/api/v1/auth/login').send({
        phone: TEST_PHONE,
        password: TEST_PASSWORD,
      });
      const cookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
      const csrfRes = await request(app).get('/api/v1/auth/csrf-token').set('Cookie', cookie);

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        if (text.includes('pending_count')) {
          return {
            rows: [
              {
                pending_count: 1,
                processing_count: 0,
                failed_retryable_count: 0,
                dead_letter_count: 2,
                processed_count: 10,
                oldest_unresolved_age_ms: 4200,
              },
            ],
            rowCount: 1,
          } as any;
        }
        if (text.includes('ORDER BY') && text.includes('dead_letter_at')) {
          return { rows: [], rowCount: 0 } as any;
        }
        if (text.includes('UPDATE app_outbox_events')) {
          return {
            rows: [
              {
                id: 77,
                event_id: 'evt-77',
                aggregate_type: 'product',
                aggregate_id: '12',
                event_type: 'product.updated',
                status: 'pending',
                attempt_count: 0,
                max_attempts: 5,
              },
            ],
            rowCount: 1,
          } as any;
        }
        return { rows: [{ dead_letter_count: 1 }], rowCount: 1 } as any;
      });

      vi.spyOn(DashboardSnapshotModel, 'findOne').mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            lastOutboxEventId: 1,
            lastSyncedAt: new Date(),
            lastProjectionSyncAt: new Date(),
            lastDashboardRefreshAt: new Date(),
          }),
        }),
      } as any);

      const statusRes = await request(app)
        .get('/api/v1/read-model-sync/status')
        .set('Cookie', cookie);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data.outbox.deadLetterCount).toBe(2);

      const retryRes = await request(app)
        .post('/api/v1/read-model-sync/outbox/77/retry')
        .set('Cookie', cookie)
        .set('x-csrf-token', csrfRes.body.csrfToken);
      expect(retryRes.status).toBe(200);
      expect(retryRes.body.event.status).toBe('pending');
      expect(retryRes.body.event.attemptCount).toBe(0);
    });

    it('separates rebuild-read-models from DB migrations, enforces env override precedence, and configures render.yaml Mongo env', () => {
      const repoRoot = fs.existsSync(path.join(process.cwd(), 'render.yaml')) ? process.cwd() : path.resolve(process.cwd(), '..');
      const rebuildSrc = fs.readFileSync(path.join(repoRoot, 'backend/scripts/rebuild-read-models.ts'), 'utf8');
      const migrateSrc = fs.readFileSync(path.join(repoRoot, 'backend/scripts/migrate.ts'), 'utf8');
      const envSrc = fs.readFileSync(path.join(repoRoot, 'backend/src/config/env.ts'), 'utf8');
      const renderYaml = fs.readFileSync(path.join(repoRoot, 'render.yaml'), 'utf8');

      expect(rebuildSrc).not.toContain('runPendingMigrationsWithRetry');
      expect(rebuildSrc).toContain('override: false');
      expect(migrateSrc).toContain('override: false');
      expect(envSrc).toContain('override: false');

      expect(renderYaml).toContain('MONGODB_ENABLED');
      expect(renderYaml).toContain('MONGODB_URI');
      expect(renderYaml).toContain('MONGODB_DATABASE');
      expect(renderYaml).toContain('MONGODB_READ_STALE_THRESHOLD_MS');
      expect(renderYaml).toContain('READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS');

      const parsed = validateAndParseMongoEnv(
        {
          MONGODB_ENABLED: 'true',
          MONGODB_URI: 'mongodb://127.0.0.1:27017/khata_test',
          READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS: '15000',
        },
        'test'
      );
      expect(parsed.READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS).toBe(15000);
    });

    it('hardens R2 extension-vs-MIME validation, PDF signature error messages, and non-23505 offline bill cleanup', async () => {
      vi.spyOn(appPool, 'query').mockResolvedValue({ rows: [] } as any);
      vi.spyOn(appPool, 'connect').mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      } as any);
      env.R2_ACCOUNT_ID = 'acct';
      env.R2_ACCESS_KEY_ID = 'key';
      env.R2_SECRET_ACCESS_KEY = 'sec';
      env.R2_BUCKET_NAME = 'bucket';

      const storage = new StorageService();
      const deletedKeys: string[] = [];
      const mockS3 = {
        send: vi.fn(async (cmd: unknown) => {
          if (cmd instanceof DeleteObjectCommand) {
            deletedKeys.push(cmd.input.Key || '');
            return {};
          }
          if (cmd instanceof HeadObjectCommand) {
            return { ContentLength: 512, ContentType: 'application/pdf' };
          }
          if (cmd instanceof GetObjectCommand) {
            return { Body: { transformToByteArray: async () => new Uint8Array([0x00, 0x01, 0x02, 0x03]) } };
          }
          return {};
        }),
      };
      storage.setClient(mockS3 as any);
      globalStorageService.setClient(mockS3 as any);

      // Extension mismatch (.jpg key claiming application/pdf) must fail and clean R2
      await expect(
        storage.verifyObject('supplier-bills/10/spoofed.jpg', 'supplier-bills', 10)
      ).rejects.toMatchObject({ code: 'INVALID_CONTENT_TYPE', status: 400 });
      expect(deletedKeys).toContain('supplier-bills/10/spoofed.jpg');

      // Invalid PDF signature mentions PDF rather than image-only
      await expect(
        storage.verifyObject('supplier-bills/10/bad.pdf', 'supplier-bills', 10)
      ).rejects.toThrow(/JPEG, PNG, WebP, or PDF signature/);

      // OfflineBill presigned DB failure cleanup excludes 23505 duplicate key replay
      const verifySpy = vi
        .spyOn(offlineBillsService as any, 'attachPresignedUrls')
        .mockResolvedValue([]);
      const storageSvcMod = await import('../src/services/storage.service.js');
      vi.spyOn(storageSvcMod.storageService, 'verifyObject').mockResolvedValue({
        contentLength: 1024,
        contentType: 'image/jpeg',
      });
      const delSpy = vi.spyOn(storageSvcMod.storageService, 'deleteObject').mockResolvedValue(undefined);

      vi.spyOn(appPool, 'query').mockRejectedValueOnce(new Error('PG timeout'));
      await expect(
        offlineBillsService.createOfflineBill({
          customerName: 'Raju',
          customerPhone: '9876543210',
          imageObjectKey: 'offline-bills/temp/orphan.jpg',
        })
      ).rejects.toThrow('PG timeout');
      expect(delSpy).toHaveBeenCalledWith('offline-bills/temp/orphan.jpg');

      delSpy.mockClear();
      vi.spyOn(appPool, 'query').mockRejectedValueOnce(Object.assign(new Error('dup key'), { code: '23505' }));
      await expect(
        offlineBillsService.createOfflineBill({
          customerName: 'Raju',
          customerPhone: '9876543210',
          imageObjectKey: 'offline-bills/temp/existing.jpg',
        })
      ).rejects.toThrow('dup key');
      expect(delSpy).not.toHaveBeenCalled();

      verifySpy.mockRestore();
    });
  });
});
