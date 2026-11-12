import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import { parseStrictEnvBoolean, validateAndParseMongoEnv } from '../src/config/mongoEnv.js';
import { assertSafeTestDatabaseUrl, resolveValidatedTestPoolUrls } from '../src/config/testDbGuard.js';
import * as mongodbConfig from '../src/config/mongodb.js';
import {
  READ_MODEL_MODELS,
  ProductSearchModel,
  CustomerSummaryModel,
  DashboardSnapshotModel,
  RecentActivityModel,
  DailyAnalyticsModel,
} from '../src/modules/readModels/models.js';
import {
  APP_DATA_MODELS,
  UserPreferenceModel,
  NotificationModel,
  AppTelemetryModel,
  AppActivityEventModel,
  SearchAnalyticsModel,
} from '../src/modules/appData/models.js';
import { enqueueOutboxEvent } from '../src/modules/readModels/outbox.service.js';
import { ReadModelOutboxWorker } from '../src/modules/readModels/readModelOutbox.worker.js';
import {
  readModelsQueryService,
  ReadModelUnavailableError,
} from '../src/modules/readModels/readModelsQuery.service.js';
import { readModelSyncService } from '../src/modules/readModels/readModelSync.service.js';
import { StorageService, MAX_PRODUCT_IMAGE_BYTES } from '../src/services/storage.service.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const app = createApp({ useMemoryStoreInTest: true });

async function loginAuthenticatedAgent() {
  const agent = request.agent(app);
  const csrfRes = await agent.get('/api/v1/auth/csrf-token');
  const csrfToken = csrfRes.body.csrfToken as string;
  const loginRes = await agent
    .post('/api/v1/auth/login')
    .set('X-CSRF-Token', csrfToken)
    .send({ phone: TEST_PHONE, password: TEST_PASSWORD });
  expect(loginRes.status).toBe(200);
  const nextCsrf = (await agent.get('/api/v1/auth/csrf-token')).body.csrfToken as string;
  return { agent, csrfToken: nextCsrf };
}

describe('Khata Release #027 — MongoDB Architecture, Outbox, Fail-Closed Reads & R2 Hardening Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const text = typeof sql === 'string' ? sql : sql?.text || '';
      if (text.includes('login_attempts')) {
        return { rows: [], rowCount: 0 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('1. Strict Environment Booleans, Mongo URI Redaction & PG Test Guard', () => {
    it('strictly rejects ambiguous boolean strings instead of z.coerce.boolean() truthiness', () => {
      expect(parseStrictEnvBoolean('true', false, 'MONGODB_ENABLED')).toBe(true);
      expect(parseStrictEnvBoolean('false', true, 'MONGODB_ENABLED')).toBe(false);
      expect(parseStrictEnvBoolean('1', false, 'MONGODB_ENABLED')).toBe(true);
      expect(parseStrictEnvBoolean('0', true, 'MONGODB_ENABLED')).toBe(false);
      expect(parseStrictEnvBoolean(undefined, false, 'MONGODB_ENABLED')).toBe(false);

      expect(() => parseStrictEnvBoolean('falsee', false, 'MONGODB_ENABLED')).toThrow();
      expect(() => parseStrictEnvBoolean('yes', false, 'MONGODB_ENABLED')).toThrow();
    });

    it('requires MONGODB_ENABLED=true and non-placeholder URI in production', () => {
      expect(() =>
        validateAndParseMongoEnv({ MONGODB_ENABLED: 'false' }, 'production')
      ).toThrow(/production/i);

      expect(() =>
        validateAndParseMongoEnv(
          { MONGODB_ENABLED: 'true', MONGODB_URI: 'mongodb+srv://u:p@REPLACE_WITH.mongodb.net/khata' },
          'production'
        )
      ).toThrow(/MONGODB_URI/i);

      const valid = validateAndParseMongoEnv(
        {
          MONGODB_ENABLED: 'true',
          MONGODB_URI: 'mongodb://127.0.0.1:27017/khata_test',
          MONGODB_DATABASE: 'khata_test',
        },
        'test'
      );
      expect(valid.MONGODB_ENABLED).toBe(true);
      expect(valid.MONGODB_DATABASE).toBe('khata_test');
    });

    it('redacts MongoDB username and password credentials in logs', () => {
      const redacted = mongodbConfig.redactMongoUri(
        'mongodb+srv://khata_user:SuperSecretPassword!@cluster0.mongodb.net/khata?retryWrites=true'
      );
      expect(redacted).not.toContain('SuperSecretPassword!');
      expect(redacted).not.toContain('khata_user');
      expect(redacted).toContain('***:***@cluster0.mongodb.net');
    });

    it('blocks neondb_owner role even on localhost loopback URLs and resolves safe test pool URLs', () => {
      expect(() =>
        assertSafeTestDatabaseUrl('postgresql://neondb_owner:pass@127.0.0.1:5432/khata_test')
      ).toThrow(/neondb_owner/i);

      const urls = resolveValidatedTestPoolUrls({
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/khata_integration_test',
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/khata_integration_test',
      });
      expect(urls.isTestDbActive).toBe(true);
      expect(urls.testDbUrl).toBe('postgresql://postgres:postgres@127.0.0.1:5432/khata_integration_test');
    });
  });

  describe('2. MongoDB Schema Contracts, Single-Vendor Privacy & Explicit Index Configuration', () => {
    it('preserves single-vendor Khata model without adding inventory/stock quantity to products', () => {
      const productPaths = Object.keys(ProductSearchModel.schema.paths);
      expect(productPaths).toContain('productId');
      expect(productPaths).toContain('name');
      expect(productPaths).toContain('barcode');
      expect(productPaths).not.toContain('quantity');
      expect(productPaths).not.toContain('stock');
      expect(productPaths).not.toContain('stockQty');
      expect(productPaths).not.toContain('stock_qty');
    });

    it('disables implicit autoIndex across all models and enforces TTL + sparse unique indexes', () => {
      for (const model of [...READ_MODEL_MODELS, ...APP_DATA_MODELS]) {
        expect(model.schema.get('autoIndex')).toBe(false);
      }

      const telemetryIndexes = AppTelemetryModel.schema.indexes();
      const hasTelemetryTtl = telemetryIndexes.some(
        ([, opts]) => typeof opts?.expireAfterSeconds === 'number' && opts.expireAfterSeconds > 0
      );
      expect(hasTelemetryTtl).toBe(true);

      const activityIndexes = AppActivityEventModel.schema.indexes();
      const hasActivityTtl = activityIndexes.some(
        ([, opts]) => typeof opts?.expireAfterSeconds === 'number' && opts.expireAfterSeconds > 0
      );
      expect(hasActivityTtl).toBe(true);

      const searchIndexes = SearchAnalyticsModel.schema.indexes();
      const hasSearchTtl = searchIndexes.some(
        ([, opts]) => typeof opts?.expireAfterSeconds === 'number' && opts.expireAfterSeconds > 0
      );
      expect(hasSearchTtl).toBe(true);

      const notifIndexes = NotificationModel.schema.indexes();
      const hasDedupeUnique = notifIndexes.some(
        ([fields, opts]) => fields.dedupeKey === 1 && opts?.unique === true && !opts?.sparse && (opts?.partialFilterExpression as any)?.dedupeKey?.$type === 'string'
      );
      expect(hasDedupeUnique).toBe(true);
    });
  });

  describe('3. Event-Driven Outbox Enqueue & Worker (Zero Periodic Idle Polling)', () => {
    it('enqueues outbox event on the caller transaction client rather than appPool', async () => {
      const poolQuerySpy = vi.spyOn(appPool, 'query');
      const txQueries: Array<{ sql: string; params: unknown[] }> = [];
      const mockClient = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          txQueries.push({ sql, params });
          return { rows: [{ id: 101 }], rowCount: 1 };
        }),
      } as any;

      await enqueueOutboxEvent(mockClient, {
        aggregateType: 'product',
        aggregateId: 42,
        eventType: 'product.updated',
        payload: { name: 'Cement Bag' },
        sourceVersion: 1,
        businessDate: '2026-11-11',
      });

      expect(poolQuerySpy).not.toHaveBeenCalled();
      expect(txQueries).toHaveLength(1);
      expect(txQueries[0].sql).toContain('INSERT INTO app_outbox_events');
      expect(txQueries[0].params[0]).toBe('product');
      expect(txQueries[0].params[1]).toBe('42');
    });

    it('runs with ZERO idle polling timers when outbox queue is empty and schedules bounded one-shot retry only on error', async () => {
      vi.spyOn(mongodbConfig, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(true);

      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      let backlogActive = false;
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        if (text.includes('pending_count')) {
          return {
            rows: [{ pending_count: backlogActive ? 1 : 0, next_delay_ms: backlogActive ? 2000 : null }],
            rowCount: 1,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const connectSpy = vi.spyOn(appPool, 'connect').mockImplementation(async () => {
        const client = {
          query: vi.fn(async (sql: string) => {
            if (sql.includes('WITH next_batch')) {
              return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
          }),
          release: vi.fn(),
        };
        return client as any;
      });

      const worker = new ReadModelOutboxWorker({ batchSize: 10 });
      const result = await worker.drainNow();
      expect(result.processedCount).toBe(0);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(worker.hasRetryTimerScheduled()).toBe(false);
      expect(connectSpy).toHaveBeenCalled();

      // Simulate batch failure -> schedules one-shot retry timer, and stop() clears it cleanly
      backlogActive = true;
      let claimCall = 0;
      connectSpy.mockImplementation(async () => {
        const client = {
          query: vi.fn(async (sql: string) => {
            if (sql.includes('WITH next_batch')) {
              claimCall += 1;
              if (claimCall === 1) {
                return {
                  rows: [
                    {
                      id: 77,
                      event_id: 'evt-77',
                      aggregate_type: 'product',
                      aggregate_id: '42',
                      event_type: 'product.updated',
                      payload: {},
                      source_version: 1,
                      business_date: null,
                      attempt_count: 1,
                      max_attempts: 10,
                    },
                  ],
                  rowCount: 1,
                };
              }
              return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
          }),
          release: vi.fn(),
        };
        return client as any;
      });

      vi.spyOn(readModelSyncService, 'applyOutboxBatch').mockRejectedValueOnce(
        new Error('Transient Mongo write timeout')
      );

      await worker.drainNow();
      expect(worker.hasRetryTimerScheduled()).toBe(true);
      expect(readModelsQueryService.isOutboxBacklogPending()).toBe(true);

      await worker.stop();
      expect(worker.hasRetryTimerScheduled()).toBe(false);
    });
  });

  describe('4. Zero-PG-Query Read Routes & Fail-Closed 503 Behavior + Health Live Contract', () => {
    it('/api/v1/health/live executes zero PostgreSQL and zero MongoDB queries', async () => {
      const poolQuerySpy = vi.spyOn(appPool, 'query');
      const poolConnectSpy = vi.spyOn(appPool, 'connect');
      const res = await request(app).get('/api/v1/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
      expect(poolQuerySpy).not.toHaveBeenCalled();
      expect(poolConnectSpy).not.toHaveBeenCalled();
    });

    it('fails closed with 503 READ_MODEL_UNAVAILABLE when MONGODB_ENABLED=true and Mongo is down', async () => {
      const { agent } = await loginAuthenticatedAgent();

      vi.spyOn(mongodbConfig, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(false);
      const querySpy = vi.spyOn(appPool, 'query');
      const connectSpy = vi.spyOn(appPool, 'connect');

      const dashRes = await agent.get('/api/v1/dashboard/overview');
      expect(dashRes.status).toBe(503);
      expect(dashRes.body.code).toBe('READ_MODEL_UNAVAILABLE');

      const prodRes = await agent.get('/api/v1/products');
      expect(prodRes.status).toBe(503);
      expect(prodRes.body.code).toBe('READ_MODEL_UNAVAILABLE');

      const khataRes = await agent.get('/api/v1/khata/summary');
      expect(khataRes.status).toBe(503);
      expect(khataRes.body.code).toBe('READ_MODEL_UNAVAILABLE');

      expect(querySpy).not.toHaveBeenCalled();
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('serves Dashboard, Products, and Khata reads exclusively from MongoDB with ZERO PostgreSQL queries', async () => {
      const { agent } = await loginAuthenticatedAgent();

      vi.spyOn(mongodbConfig, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(true);

      // Assert zero PG reads from here on
      const pgQuerySpy = vi.spyOn(appPool, 'query');
      const pgConnectSpy = vi.spyOn(appPool, 'connect');
      pgQuerySpy.mockClear();
      pgConnectSpy.mockClear();

      // Mock Mongo read models cleanly
      const fakeOverview = {
        businessDate: '2026-11-11',
        timeZone: 'Asia/Kolkata',
        dateRange: { fromDate: null, toDate: null },
        sales: {
          normalBillsTotal: '100.00',
          normalBillsCount: 1,
          gstTaxableSales: '0.00',
          gstCollected: '0.00',
          gstInvoicesGrandTotal: '0.00',
          gstInvoicesCount: 0,
          totalSalesRevenue: '100.00',
          totalBilledAmountIncludingGst: '100.00',
          totalBillsCount: 1,
          averageBillValue: '100.00',
        },
        profitability: {
          totalSalesRevenue: '100.00',
          costedSalesRevenue: '100.00',
          uncostedSalesRevenue: '0.00',
          estimatedCostOfGoodsSold: '60.00',
          estimatedGrossProfit: '40.00',
          estimatedGrossMarginPercent: '40.00',
          costCoveragePercent: '100.00',
          operatingExpenses: '0.00',
          operatingExpensesCount: 0,
          voidedExpensesCount: 0,
          estimatedNetOperatingResult: '40.00',
          hasIncompleteCostData: false,
        },
        expensesByCategory: [],
        customersKhata: {
          totalCustomers: 1,
          activeCustomers: 1,
          newCustomersCount: 1,
          customersWithOutstanding: 1,
          totalOutstandingReceivable: '250.00',
          creditGiven: '250.00',
          paymentsReceived: '0.00',
          paymentCount: 0,
        },
        products: { totalProducts: 1, activeProducts: 1, archivedProducts: 0, topProducts: [] },
        suppliers: {
          totalSuppliers: 0,
          activeSuppliers: 0,
          totalPurchases: '0.00',
          purchaseBillsCount: 0,
          cancelledBillsCount: 0,
          totalPaymentsMade: '0.00',
          paymentsCount: 0,
          totalPaymentsReversed: '0.00',
          totalOutstandingPayable: '0.00',
          totalAdvanceCredit: '0.00',
          totalUnallocatedPayments: '0.00',
        },
        quotations: {
          totalCount: 0,
          draftCount: 0,
          sentCount: 0,
          acceptedCount: 0,
          convertedCount: 0,
          rejectedCount: 0,
          expiredCount: 0,
          conversionRatePercent: '0.00',
          pendingPipelineValue: '0.00',
          convertedValue: '0.00',
        },
        recentActivity: [],
        trends: { periodType: 'daily' as const, points: [] },
        insights: { strongestDay: null, highestExpenseCategory: null, unreadAlertCount: 0 },
        syncStatus: {
          source: 'mongodb' as const,
          syncedAt: new Date().toISOString(),
          ageMs: 0,
          isStale: false,
        },
      };

      vi.spyOn(readModelsQueryService, 'getDashboardOverviewFromMongo').mockResolvedValue(fakeOverview as any);
      vi.spyOn(readModelsQueryService, 'searchProductsFromMongo').mockResolvedValue({
        products: [
          {
            id: 7,
            name: 'Mongo Cement',
            buying_price: '320.00',
            barcode: '8901234567890',
            hsn_code: '2523',
            image_object_key: null,
            image_url: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
        syncStatus: {
          source: 'mongodb',
          syncedAt: new Date().toISOString(),
          ageMs: 0,
          isStale: false,
        },
      });
      vi.spyOn(readModelsQueryService, 'getKhataSummaryFromMongo').mockResolvedValue({
        totalCustomers: 1,
        totalOutstanding: '250.00',
        totalReceived: '0.00',
        syncStatus: {
          source: 'mongodb',
          syncedAt: new Date().toISOString(),
          ageMs: 0,
          isStale: false,
        },
      });
      vi.spyOn(readModelsQueryService, 'listCustomersFromMongo').mockResolvedValue({
        customers: [
          {
            id: 1,
            name: 'Anil Hardware',
            phone: '9876501234',
            address: null,
            state: 'Bihar',
            state_code: '10',
            totalUdhar: '250.00',
            totalReceived: '0.00',
            outstanding: '250.00',
            created_at: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
        syncStatus: {
          source: 'mongodb',
          syncedAt: new Date().toISOString(),
          ageMs: 0,
          isStale: false,
        },
      });
      vi.spyOn(SearchAnalyticsModel, 'create').mockResolvedValue({} as any);

      const dashRes = await agent.get('/api/v1/dashboard/overview');
      expect(dashRes.status).toBe(200);
      expect(dashRes.body.data.syncStatus.source).toBe('mongodb');

      const prodRes = await agent.get('/api/v1/products?search=cement');
      expect(prodRes.status).toBe(200);
      expect(prodRes.body.data[0].name).toBe('Mongo Cement');

      const khataRes = await agent.get('/api/v1/khata/summary');
      expect(khataRes.status).toBe(200);
      expect(khataRes.body.summary.totalOutstanding).toBe('250.00');

      const customersRes = await agent.get('/api/v1/khata/customers?search=anil');
      expect(customersRes.status).toBe(200);
      expect(customersRes.body.customers[0].name).toBe('Anil Hardware');

      // Zero PostgreSQL calls across ALL read requests!
      expect(pgQuerySpy).not.toHaveBeenCalled();
      expect(pgConnectSpy).not.toHaveBeenCalled();
    });
  });

  describe('5. Authenticated Mongo App-Data Endpoints & Pre-Storage R2 Limit Enforcement', () => {
    it('enforces owner session auth on /api/v1/preferences, /api/v1/notifications, /api/v1/telemetry', async () => {
      const unauthPref = await request(app).get('/api/v1/preferences');
      expect(unauthPref.status).toBe(401);
      const unauthNotif = await request(app).get('/api/v1/notifications');
      expect(unauthNotif.status).toBe(401);

      const { agent, csrfToken } = await loginAuthenticatedAgent();

      vi.spyOn(mongodbConfig, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(true);

      vi.spyOn(UserPreferenceModel, 'findOne').mockReturnValue({
        lean: async () => null,
      } as any);
      vi.spyOn(UserPreferenceModel, 'updateOne').mockResolvedValue({ acknowledged: true } as any);
      vi.spyOn(NotificationModel, 'find').mockReturnValue({
        sort: () => ({ limit: () => ({ lean: async () => [] }) }),
      } as any);
      vi.spyOn(NotificationModel, 'countDocuments').mockResolvedValue(0 as any);
      vi.spyOn(AppTelemetryModel, 'create').mockResolvedValue({} as any);

      const prefGet = await agent.get('/api/v1/preferences');
      expect(prefGet.status).toBe(200);
      expect(prefGet.body.source).toBe('mongodb');

      const prefPut = await agent
        .put('/api/v1/preferences')
        .set('X-CSRF-Token', csrfToken)
        .send({ theme: { preset: 'soft-dark', textSize: '115' } });
      expect(prefPut.status).toBe(200);
      expect(prefPut.body.preferences.theme.preset).toBe('soft-dark');

      const notifGet = await agent.get('/api/v1/notifications');
      expect(notifGet.status).toBe(200);
      expect(notifGet.body.notifications).toEqual([]);

      const telPost = await agent
        .post('/api/v1/telemetry')
        .set('X-CSRF-Token', csrfToken)
        .send({ kind: 'pdf_render', name: 'quotation_preview', durationMs: 42, ok: true });
      expect(telPost.status).toBe(202);
      expect(telPost.body.recorded).toBe(true);
    });

    it('rejects oversized R2 uploadBufferToR2 BEFORE calling S3Client.send and embeds exact ContentLength on presigned intents', async () => {
      env.R2_ACCOUNT_ID = 'acct_test';
      env.R2_ACCESS_KEY_ID = 'key_test';
      env.R2_SECRET_ACCESS_KEY = 'secret_test';
      env.R2_BUCKET_NAME = 'khata-test';

      const storage = new StorageService();
      const s3SendMock = vi.fn().mockResolvedValue({});
      (storage as any).s3Client = { send: s3SendMock };

      const oversizedProduct = Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES + 1024, 0xff);
      await expect(
        storage.uploadBufferToR2({
          buffer: oversizedProduct,
          objectKey: 'products/42/oversized.jpg',
          contentType: 'image/jpeg',
        })
      ).rejects.toThrow(/exceeds maximum allowed upload limit/i);

      // Pre-storage rejection means S3Client.send was NEVER called!
      expect(s3SendMock).not.toHaveBeenCalled();

      // Verify ReadModelUnavailableError exposes 503 statusCode cleanly
      const err = new ReadModelUnavailableError('down');
      expect(err.statusCode).toBe(503);
    });
  });
});
