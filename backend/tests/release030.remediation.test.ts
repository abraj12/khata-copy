import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  appPool,
  EXPECTED_CORE_TABLES,
  EXPECTED_MIGRATIONS,
  inspectSearchIndexCapabilities,
  OPTIONAL_SEARCH_TRGM_INDEXES,
} from '../src/config/database.js';
import * as mongoModule from '../src/config/mongodb.js';
import {
  computeOutboxBacklogWakeStatus,
  ReadModelOutboxWorker,
} from '../src/modules/readModels/readModelOutbox.worker.js';
import {
  buildProductCursorQueryContext,
  buildCustomerCursorQueryContext,
  decodeCustomerCursor,
  decodeProductCursor,
  encodeCursor,
  InvalidPaginationCursorError,
  readModelsQueryService,
} from '../src/modules/readModels/readModelsQuery.service.js';
import { readModelSyncService } from '../src/modules/readModels/readModelSync.service.js';
import {
  CustomerSummaryModel,
  DashboardSnapshotModel,
  ProductSearchModel,
} from '../src/modules/readModels/models.js';
import { productsService } from '../src/modules/products/products.service.js';
import { khataService } from '../src/modules/khata/khata.service.js';
import { offlineBillsService } from '../src/modules/offlineBills/offlineBills.service.js';
import { isNoSuchKeyError, StorageService, storageService } from '../src/services/storage.service.js';
import {
  sanitizeStorageErrorMessage,
  storageCleanupService,
} from '../src/services/storageCleanup.service.js';
import {
  computeStorageCleanupBackoffMs,
  StorageCleanupWorker,
} from '../src/services/storageCleanup.worker.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

function buildMockPoolClient(queryHandler: (sql: string, params?: unknown[]) => Promise<any>) {
  return {
    query: vi.fn(queryHandler),
    release: vi.fn(),
  } as any;
}

describe('Khata Release #030 — Performance, Fallback Search, Outbox, Cursor Binding & R2 Cleanup Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('1. Outbox Worker Index-Friendly Wakeup, Lease Scheduling & Freshness Separation', () => {
    it('replaces full-table aggregate backlog scans with three LIMIT 1 index probes and maintains zero idle polling', async () => {
      vi.useFakeTimers();

      const worker = new ReadModelOutboxWorker({
        batchSize: 10,
        leaseDurationMs: 5000,
        baseBackoffMs: 250,
        maxBackoffMs: 30_000,
      });

      vi.spyOn(mongoModule, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);
      vi.spyOn(readModelSyncService, 'refreshGlobalDashboardSnapshotFromPool').mockResolvedValue(undefined);
      vi.spyOn(readModelSyncService, 'applyOutboxBatch').mockResolvedValue([]);

      const executedSql: string[] = [];
      const nowMs = Date.now();
      let mode: 'future_retry' | 'empty' = 'future_retry';

      vi.spyOn(appPool, 'connect').mockResolvedValue(
        buildMockPoolClient(async (sql: string) => {
          const text = String(sql);
          if (text.includes('WITH next_batch AS')) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        })
      );

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = String(typeof sql === 'string' ? sql : sql?.text || '');
        executedSql.push(text);
        if (text.includes('next_wake_at')) {
          return {
            rows: [
              {
                next_wake_at: mode === 'future_retry' ? new Date(nowMs + 12_000).toISOString() : null,
                server_now: new Date(nowMs).toISOString(),
              },
            ],
            rowCount: 1,
          } as any;
        }
        if (text.includes('dead_letter_count')) {
          return { rows: [{ dead_letter_count: 3 }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      // Drain with future scheduled event -> index probe uses LIMIT 1 probes, NO COUNT(*) scan on processed history
      await worker.drainNow();

      const wakeSql = executedSql.find((s) => s.includes('next_wake_at'));
      expect(wakeSql).toBeTruthy();
      expect(wakeSql).toContain("WHERE status = 'pending'");
      expect(wakeSql).toContain("WHERE status = 'failed' AND attempt_count < max_attempts");
      expect(wakeSql).toContain("WHERE status = 'processing'");
      expect(wakeSql).toContain('NULLS FIRST');
      expect(wakeSql).toContain('LIMIT 1');
      expect(wakeSql).not.toContain('COUNT(*) FILTER');
      expect(wakeSql).not.toContain('GROUP BY status');

      expect(worker.hasRetryTimerScheduled()).toBe(true);
      expect(readModelsQueryService.isOutboxBacklogPending()).toBe(true);

      // Drain again once queue is empty -> clears timer completely (zero idle Neon polling)
      mode = 'empty';
      await worker.drainNow();
      expect(worker.hasRetryTimerScheduled()).toBe(false);
      expect(readModelsQueryService.isOutboxBacklogPending()).toBe(false);

      await worker.stop();
    });

    it('computeOutboxBacklogWakeStatus handles null, expired, null-lease, and future wakeup times accurately', () => {
      const serverNow = new Date('2026-11-12T10:00:00.000Z');
      expect(
        computeOutboxBacklogWakeStatus(null, serverNow, { maxBackoffMs: 60_000, minDelayMs: 500 })
      ).toEqual({
        hasBacklog: false,
        nextDelayMs: null,
      });

      const dueNow = computeOutboxBacklogWakeStatus('2026-11-12T09:59:59.000Z', serverNow, {
        maxBackoffMs: 60_000,
        minDelayMs: 500,
      });
      expect(dueNow.hasBacklog).toBe(true);
      expect(dueNow.nextDelayMs).toBe(500);

      const future = computeOutboxBacklogWakeStatus('2026-11-12T10:00:25.000Z', serverNow, {
        maxBackoffMs: 60_000,
        minDelayMs: 500,
      });
      expect(future.hasBacklog).toBe(true);
      expect(future.nextDelayMs).toBeGreaterThanOrEqual(25_000);
      expect(future.nextDelayMs).toBeLessThanOrEqual(25_200);
    });

    it('updates dead-letter indicator via dedicated query on startup/exhaustion without full drain table scans', async () => {
      const worker = new ReadModelOutboxWorker({ baseBackoffMs: 100, maxBackoffMs: 1000 });
      vi.spyOn(mongoModule, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);
      vi.spyOn(readModelSyncService, 'refreshGlobalDashboardSnapshotFromPool').mockResolvedValue(undefined);
      vi.spyOn(DashboardSnapshotModel, 'updateOne').mockResolvedValue({ acknowledged: true } as any);
      vi.spyOn(DashboardSnapshotModel, 'findOne').mockReturnValue({
        select: () => ({ lean: vi.fn().mockResolvedValue({ _id: 'snap' }) }),
      } as any);

      vi.spyOn(appPool, 'connect').mockResolvedValue(
        buildMockPoolClient(async (sql: string) => {
          if (String(sql).includes('UPDATE app_outbox_events')) {
            return { rows: [{ id: 1, status: 'dead_letter', next_attempt_at: null }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        })
      );

      let dlqValue = 2;
      const seenQueries: string[] = [];
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = String(typeof sql === 'string' ? sql : sql?.text || '');
        seenQueries.push(text);
        if (text.includes('dead_letter_count')) {
          return { rows: [{ dead_letter_count: dlqValue }], rowCount: 1 } as any;
        }
        if (text.includes('next_wake_at')) {
          return { rows: [{ next_wake_at: null, server_now: new Date().toISOString() }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      await worker.catchUpOnStartup();
      expect(readModelsQueryService.getOutboxDeadLetterCount()).toBe(2);

      // Routine empty drainNow does NOT re-run dead_letter COUNT query needlessly
      const countBefore = seenQueries.filter((q) => q.includes('dead_letter_count')).length;
      await worker.drainNow();
      expect(seenQueries.filter((q) => q.includes('dead_letter_count')).length).toBe(countBefore);

      // Dead-letter exhaustion refreshes indicator immediately
      dlqValue = 5;
      vi.spyOn(readModelSyncService, 'applyOutboxBatch').mockRejectedValueOnce(new Error('Permanent schema error'));
      vi.spyOn(appPool, 'connect')
        .mockResolvedValueOnce(
          buildMockPoolClient(async (sql: string) => {
            if (String(sql).includes('WITH next_batch AS')) {
              return {
                rows: [
                  {
                    id: 99,
                    event_id: 'evt-99',
                    aggregate_type: 'product',
                    aggregate_id: '10',
                    event_type: 'product.updated',
                    payload: {},
                    source_version: 1,
                    business_date: null,
                    attempt_count: 8,
                    max_attempts: 8,
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          })
        )
        .mockResolvedValueOnce(
          buildMockPoolClient(async (sql: string) => {
            if (String(sql).includes('UPDATE app_outbox_events')) {
              return { rows: [{ id: 99, status: 'dead_letter', next_attempt_at: null }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          })
        )
        .mockResolvedValueOnce(buildMockPoolClient(async () => ({ rows: [], rowCount: 0 })));

      await worker.drainNow();
      expect(readModelsQueryService.getOutboxDeadLetterCount()).toBe(5);

      await worker.stop();
    });
  });

  describe('2. PostgreSQL Fallback Search Completeness, Capability Telemetry & Customer Sort Parity', () => {
    it('inspectSearchIndexCapabilities detects missing or complete trigram indexes accurately without log spam by default', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = String(sql);
        if (text.includes('pg_extension')) {
          return { rows: [{ pg_trgm_installed: true }], rowCount: 1 } as any;
        }
        return {
          rows: OPTIONAL_SEARCH_TRGM_INDEXES.map((indexname) => ({ indexname })),
          rowCount: OPTIONAL_SEARCH_TRGM_INDEXES.length,
        } as any;
      });

      const fullReport = await inspectSearchIndexCapabilities();
      expect(fullReport.pgTrgmInstalled).toBe(true);
      expect(fullReport.missingOptionalIndexes).toEqual([]);
      expect(fullReport.fallbackSearchMode).toBe('pg_trgm_gin');
      expect(warnSpy).not.toHaveBeenCalled();

      // Missing subset stays silent when warnOnMissing=false, warns when warnOnMissing=true
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = String(sql);
        if (text.includes('pg_extension')) {
          return { rows: [{ pg_trgm_installed: false }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const degradedSilent = await inspectSearchIndexCapabilities();
      expect(degradedSilent.fallbackSearchMode).toBe('sequential_fallback');
      expect(degradedSilent.missingOptionalIndexes).toHaveLength(OPTIONAL_SEARCH_TRGM_INDEXES.length);
      expect(warnSpy).not.toHaveBeenCalled();

      await inspectSearchIndexCapabilities({ warnOnMissing: true });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('PG fallback product search matches name, HSN, exact/partial barcode, short tokens, Indic script, and escaped LIKE chars', async () => {
      const capturedSql: string[] = [];
      const capturedParams: unknown[][] = [];

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any[]) => {
        capturedSql.push(String(sql));
        capturedParams.push(params || []);
        return {
          rows: [
            {
              id: 42,
              name: 'आटा 50%_Special',
              buying_price: '240.00',
              hsn_code: '1101',
              barcode: '000890123',
              created_at: '2026-11-01T00:00:00.000Z',
              updated_at: '2026-11-01T00:00:00.000Z',
              archived_at: null,
            },
          ],
          rowCount: 1,
        } as any;
      });

      // General search binds escaped LIKE AND exact raw token across name, hsn_code, barcode
      const res = await productsService.listActiveProducts({
        search: '50%_\\000',
        limit: 25,
        offset: 0,
      });
      expect(res.products).toHaveLength(1);
      expect(capturedSql[0]).toContain("name ILIKE $1 ESCAPE '\\'");
      expect(capturedSql[0]).toContain("hsn_code ILIKE $1 ESCAPE '\\'");
      expect(capturedSql[0]).toContain('barcode = $2 OR barcode ILIKE $1');
      expect(capturedParams[0][0]).toBe('%50\\%\\_\\\\000%');
      expect(capturedParams[0][1]).toBe('50%_\\000');

      // Exact barcode filter path
      await productsService.listActiveProducts({ exactBarcode: ' 000890123 ', limit: 25, offset: 0 });
      expect(capturedSql[1]).toContain('AND barcode = $1');
      expect(capturedParams[1][0]).toBe('000890123');

      // 1-character search term still queries DB properly (never truncated/ignored)
      await productsService.listActiveProducts({ search: 'अ', limit: 25, offset: 0 });
      expect(capturedParams[2][0]).toBe('%अ%');
    });

    it('PG fallback customer search prefilters matched_customers before aggregation, handles +91/0 partial phone, and enforces canonical sorting', async () => {
      const capturedSql: string[] = [];
      const capturedParams: unknown[][] = [];

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any[]) => {
        capturedSql.push(String(sql));
        capturedParams.push(params || []);
        return {
          rows: [
            {
              id: 7,
              name: 'ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ',
              phone: '9876500112',
              address: null,
              state: 'Punjab',
              state_code: '03',
              total_udhar: '1000.00',
              total_received: '250.00',
              outstanding: '750.00',
              last_activity: '2026-11-11T10:00:00.000Z',
            },
          ],
          rowCount: 1,
        } as any;
      });

      const list = await khataService.listCustomers({ search: '+91 9876', limit: 25, offset: 0 });
      expect(list.customers).toHaveLength(1);
      expect(capturedSql[0]).toContain('WITH matched_customers AS MATERIALIZED');
      expect(capturedSql[0]).toContain('WHERE t.customer_id IN (SELECT id FROM matched_customers)');
      expect(capturedSql[0]).toContain('WHERE p.customer_id IN (SELECT id FROM matched_customers)');
      expect(capturedSql[0]).toContain(
        'ROUND(GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0), 2) DESC'
      );
      expect(capturedSql[0]).toContain('GREATEST(tx.last_activity, pay.last_payment) DESC NULLS LAST');
      expect(capturedSql[0]).toContain('c.id ASC');
      // Normalized phone partial search stripped +91 cleanly
      expect(capturedParams[0]).toEqual(['%+91 9876%', '%9876%', 26, 0]);

      // Leading 0 domestic partial phone search
      await khataService.listCustomers({ search: '098765', limit: 25, offset: 0 });
      expect(capturedParams[1]).toEqual(['%098765%', '%98765%', 26, 0]);

      // 2-character short search and LIKE escaping
      await khataService.listCustomers({ search: 'a_', limit: 25, offset: 0 });
      expect(capturedParams[2][0]).toBe('%a\\_%');
    });
  });

  describe('3. Product & Customer Keyset Cursor Binding, Tampering & Cross-Endpoint Replay', () => {
    it('binds product cursors to exact search semantics (0012 != 12, tea != sugar) and rejects cross-endpoint/tampered cursors', () => {
      const prodCtx0012 = buildProductCursorQueryContext('0012');
      const prodCtx12 = buildProductCursorQueryContext('12');
      expect(prodCtx0012).not.toBe(prodCtx12);

      const prodCursor = encodeCursor({ t: 'p', n: 'atta', id: 42 }, prodCtx0012);

      // Valid same context decodes cleanly
      expect(decodeProductCursor(prodCursor, prodCtx0012)).toEqual({
        n: 'atta',
        id: 42,
      });

      // Replaying '0012' cursor against '12' must reject
      expect(() => decodeProductCursor(prodCursor, prodCtx12)).toThrow(
        InvalidPaginationCursorError
      );

      // Cross-endpoint replay: product cursor passed to customer decoder must reject
      expect(() => decodeCustomerCursor(prodCursor, prodCtx0012)).toThrow(
        InvalidPaginationCursorError
      );

      // Customer cursor passed to product decoder must reject
      const custCtxRam = buildCustomerCursorQueryContext('ram');
      const custCursor = encodeCursor(
        { t: 'c', o: 500, l: new Date('2026-11-11T10:00:00.000Z').getTime(), id: 7 },
        custCtxRam
      );
      expect(() => decodeProductCursor(custCursor, custCtxRam)).toThrow(
        InvalidPaginationCursorError
      );

      // Tampered payload rejected
      const tampered = custCursor.slice(0, -4) + 'AAAA';
      expect(() => decodeCustomerCursor(tampered, custCtxRam)).toThrow(
        InvalidPaginationCursorError
      );
    });

    it('rejects HTTP requests with replayed or mismatched cursors via /api/v1/products and /api/v1/khata/customers with HTTP 400', async () => {
      const app = createApp({ useMemoryStoreInTest: true });
      vi.spyOn(mongoModule, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);
      vi.spyOn(appPool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);

      const loginRes = await request(app).post('/api/v1/auth/login').send({
        phone: TEST_PHONE,
        password: TEST_PASSWORD,
      });
      const cookie = loginRes.headers['set-cookie'];

      const productCursorForZeroZeroTwelve = encodeCursor(
        { t: 'p', n: 'item', id: 5 },
        buildProductCursorQueryContext('0012')
      );

      const mismatchProdRes = await request(app)
        .get(`/api/v1/products?search=12&cursor=${encodeURIComponent(productCursorForZeroZeroTwelve)}`)
        .set('Cookie', cookie);
      expect(mismatchProdRes.status).toBe(400);
      expect(mismatchProdRes.body.code).toBe('INVALID_PAGINATION_CURSOR');

      const replayToCustRes = await request(app)
        .get(`/api/v1/khata/customers?search=0012&cursor=${encodeURIComponent(productCursorForZeroZeroTwelve)}`)
        .set('Cookie', cookie);
      expect(replayToCustRes.status).toBe(400);
      expect(replayToCustRes.body.code).toBe('INVALID_PAGINATION_CURSOR');
    });

    it('MongoDB search continues finding exact barcodes, tokens, and Indic terms cleanly', async () => {
      vi.spyOn(mongoModule, 'isMongoReady').mockReturnValue(true);
      vi.spyOn(DashboardSnapshotModel, 'findOne').mockReturnValue({
        select: () => ({ lean: vi.fn().mockResolvedValue({ lastProjectionSyncAt: new Date() }) }),
      } as any);
      const leanMock = vi.fn().mockResolvedValue([
        {
          productId: 101,
          name: 'बासमती चावल',
          normalizedName: 'बासमती चावल',
          buyingPrice: '90.00',
          hsnCode: '1006',
          barcode: '000123456',
          imageObjectKey: null,
          imageContentType: null,
          imageSizeBytes: null,
          sourceUpdatedAt: new Date('2026-11-11T00:00:00.000Z'),
          createdAtPg: new Date('2026-11-10T00:00:00.000Z'),
        },
      ]);
      const findChain = {
        skip: vi.fn(),
        limit: vi.fn(),
        lean: leanMock,
      };
      findChain.skip.mockReturnValue(findChain);
      findChain.limit.mockReturnValue(findChain);
      vi.spyOn(ProductSearchModel, 'find').mockReturnValue({
        sort: () => findChain,
      } as any);

      const page = await readModelsQueryService.searchProductsFromMongo({
        search: 'बासमती',
        limit: 25,
        offset: 0,
      });
      expect(page.products).toHaveLength(1);
      expect(page.products[0].name).toBe('बासमती चावल');
    });
  });

  describe('4. Durable Cloudflare R2 Cleanup Service, Reference Safety & Bounded Worker Lifecycle', () => {
    it('treats NoSuchKey/404 as clean deletion while propagating transport errors and redacting secrets from error strings', async () => {
      env.R2_ACCOUNT_ID = 'acct';
      env.R2_ACCESS_KEY_ID = 'key';
      env.R2_SECRET_ACCESS_KEY = 'sec';
      env.R2_BUCKET_NAME = 'bucket';

      const storage = new StorageService();
      const s3Send = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 }, message: 'Not Found' })
        .mockRejectedValueOnce(new Error('ETIMEDOUT https://bucket.r2.dev/secret.png?X-Amz-Signature=deadbeef123'));

      storage.setClient({ send: s3Send } as any);

      await expect(storage.deleteObject('products/1/missing1.jpg')).resolves.toBeUndefined();
      await expect(storage.deleteObject('products/1/missing2.jpg')).resolves.toBeUndefined();
      await expect(storage.deleteObject('products/1/timeout.jpg')).rejects.toThrow('ETIMEDOUT');

      expect(isNoSuchKeyError({ Code: 'NoSuchKey' })).toBe(true);
      const redacted = sanitizeStorageErrorMessage(
        'Request failed for https://r2.example.com/a/b.png?X-Amz-Signature=supersecret&X-Amz-Credential=abc Bearer token123'
      );
      expect(redacted).not.toContain('supersecret');
      expect(redacted).not.toContain('token123');
      expect(redacted).toContain('[redacted-signed-url]');
    });

    it('skips R2 deletion if any live DB table references the object key, and enqueues retry job on R2 failure', async () => {
      const deleteSpy = vi.spyOn(storageService, 'deleteObject').mockResolvedValue(undefined);
      const executedSql: string[] = [];

      // Case A: key still referenced by gst_invoices -> must NEVER call storageService.deleteObject
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = String(sql);
        executedSql.push(text);
        if (text.includes('EXISTS (SELECT 1 FROM gst_invoices')) {
          return {
            rows: [
              {
                in_products: false,
                in_offline_bills: false,
                in_supplier_bills: false,
                in_gst_invoices: true,
                in_normal_bills: false,
                in_quotation_settings: false,
              },
            ],
            rowCount: 1,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const refSkip = await storageCleanupService.attemptDeleteOrEnqueue({
        objectKey: 'shared/invoice-logo.png',
        objectKind: 'product_image',
        reason: 'product_image_replace',
      });
      expect(refSkip.outcome).toBe('skipped_referenced');
      expect(refSkip.referencedIn).toEqual(['gst_invoices']);
      expect(deleteSpy).not.toHaveBeenCalled();

      // Case B: R2 network failure -> enqueues idempotent upsert in storage_cleanup_jobs
      deleteSpy.mockRejectedValueOnce(new Error('R2 network ECONNRESET'));
      let enqueueSql = '';
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const text = String(sql);
        if (text.includes('EXISTS (SELECT 1 FROM gst_invoices')) {
          return { rows: [{}], rowCount: 1 } as any;
        }
        if (text.includes('INSERT INTO storage_cleanup_jobs')) {
          enqueueSql = text;
          return { rows: [{ id: 88 }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const queued = await storageCleanupService.attemptDeleteOrEnqueue({
        objectKey: 'products/55/orphan.jpg',
        objectKind: 'product_image',
        reason: 'product_image_replace',
      });
      expect(queued).toEqual({ outcome: 'queued', jobId: 88 });
      expect(enqueueSql).toContain("WHERE status IN ('pending', 'processing', 'failed')");

      // Case C: Rollback where R2 fails AND DB enqueue also fails -> preserves original caller error without throwing
      vi.spyOn(storageService, 'verifyObject').mockResolvedValue({
        contentLength: 1024,
        contentType: 'image/jpeg',
      } as any);
      deleteSpy.mockRejectedValueOnce(new Error('R2 unavailable'));
      vi.spyOn(appPool, 'query').mockRejectedValue(new Error('PG connection closed'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        offlineBillsService.createOfflineBill({
          customerName: 'Test',
          customerPhone: '9876543210',
          imageObjectKey: 'offline-bills/tmp/rollback.jpg',
        })
      ).rejects.toThrow('PG connection closed');
      expect(errSpy).toHaveBeenCalled();
    });

    it('StorageCleanupWorker handles exponential backoff, dead-letter exhaustion, and graceful stop with active work', async () => {
      expect(computeStorageCleanupBackoffMs(1, 2000, 300_000)).toBe(2000);
      expect(computeStorageCleanupBackoffMs(3, 2000, 300_000)).toBe(8000);
      expect(computeStorageCleanupBackoffMs(20, 2000, 300_000)).toBe(300_000);

      // Test active-work graceful shutdown + releasing remaining batch leases
      let releaseSecondDelete!: () => void;
      const activeDeleteBarrier = new Promise<void>((resolve) => {
        releaseSecondDelete = resolve;
      });
      let releaseFirstEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        releaseFirstEntered = resolve;
      });

      const worker = new StorageCleanupWorker({
        batchSize: 5,
        leaseDurationMs: 5000,
        baseBackoffMs: 100,
        maxBackoffMs: 1000,
        registerGlobalListener: false,
      });

      const completedIds: number[] = [];
      const releasedLeases: number[][] = [];
      const deadLetteredIds: number[] = [];

      vi.spyOn(storageService, 'deleteObject').mockImplementation(async (key: string) => {
        if (key === 'products/1/slow.jpg') {
          releaseFirstEntered();
          await activeDeleteBarrier;
          return;
        }
        throw new Error('R2 timeout');
      });

      let batchCalls = 0;
      vi.spyOn(appPool, 'connect').mockImplementation(async () =>
        buildMockPoolClient(async (sql: string) => {
          const text = String(sql);
          if (text.includes('WITH next_batch AS')) {
            batchCalls += 1;
            if (batchCalls === 1) {
              return {
                rows: [
                  {
                    id: 10,
                    object_key: 'products/1/slow.jpg',
                    object_kind: 'product_image',
                    reason: 'test',
                    attempt_count: 1,
                    max_attempts: 3,
                  },
                  {
                    id: 11,
                    object_key: 'products/2/unstarted.jpg',
                    object_kind: 'product_image',
                    reason: 'test',
                    attempt_count: 1,
                    max_attempts: 3,
                  },
                ],
                rowCount: 2,
              };
            }
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        })
      );

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any[]) => {
        const text = String(sql);
        if (text.includes('EXISTS (SELECT 1 FROM gst_invoices')) {
          return { rows: [{}], rowCount: 1 } as any;
        }
        if (text.includes("SET status = 'completed'")) {
          completedIds.push(Number(params?.[0]));
          return { rows: [], rowCount: 1 } as any;
        }
        if (text.includes("SET status = 'pending'") && text.includes('attempt_count = GREATEST')) {
          releasedLeases.push(params?.[0] || []);
          return { rows: [], rowCount: 1 } as any;
        }
        if (text.includes("SET status = 'dead_letter'")) {
          deadLetteredIds.push(Number(params?.[0]));
          return { rows: [], rowCount: 1 } as any;
        }
        if (text.includes('next_wake_at')) {
          return { rows: [{ next_wake_at: null, server_now: new Date().toISOString() }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const drainPromise = worker.drainNow();
      await firstEntered;

      // Stop while job 10 is mid-R2-call and job 11 is still unstarted in batch
      const stopPromise = worker.stop();
      releaseSecondDelete();
      await stopPromise;
      await drainPromise;

      expect(completedIds).toContain(10);
      expect(releasedLeases[0]).toEqual([11]);

      // Verify max_attempts transition to dead_letter
      const worker2 = new StorageCleanupWorker({ batchSize: 5, registerGlobalListener: false });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      batchCalls = 0;
      vi.spyOn(appPool, 'connect').mockImplementation(async () =>
        buildMockPoolClient(async (sql: string) => {
          if (String(sql).includes('WITH next_batch AS')) {
            batchCalls += 1;
            if (batchCalls === 1) {
              return {
                rows: [
                  {
                    id: 22,
                    object_key: 'products/3/exhausted.jpg',
                    object_kind: 'product_image',
                    reason: 'test',
                    attempt_count: 10,
                    max_attempts: 10,
                  },
                ],
                rowCount: 1,
              };
            }
          }
          return { rows: [], rowCount: 0 };
        })
      );

      await worker2.drainNow();
      expect(deadLetteredIds).toContain(22);
      await worker2.dispose();
    });
  });

  describe('5. Migration Tracking, Session/CSRF Security & Existing Financial Safeguards', () => {
    it('tracks migrations 030 & 031, registers storage_cleanup_jobs core table, and leaves 001-029 untouched', () => {
      expect(EXPECTED_MIGRATIONS).toContain('030_storage_cleanup_jobs.sql');
      expect(EXPECTED_MIGRATIONS).toContain('031_outbox_worker_search_indexes.sql');
      expect(EXPECTED_CORE_TABLES).toContain('storage_cleanup_jobs');

      const repoRoot = path.resolve(process.cwd(), '..');
      const m030 = fs.readFileSync(
        path.join(repoRoot, 'backend/migrations/030_storage_cleanup_jobs.sql'),
        'utf-8'
      );
      const m031 = fs.readFileSync(
        path.join(repoRoot, 'backend/migrations/031_outbox_worker_search_indexes.sql'),
        'utf-8'
      );
      expect(m030).toContain('CREATE TABLE IF NOT EXISTS storage_cleanup_jobs');
      expect(m030).toContain('idx_storage_cleanup_active_object');
      expect(m031).toContain('idx_app_outbox_pending_wake');
      expect(m031).toContain('idx_app_outbox_failed_retryable');
      expect(m031).toContain('idx_app_outbox_processing_wake');
      expect(m031).toContain('idx_products_active_barcode_trgm');
      expect(m031).toContain('idx_customers_active_normalized_phone_trgm');
    });

    it('rejects authenticated POST mutations missing CSRF token and requires owner session on /read-model-sync/status', async () => {
      const app = createApp({ useMemoryStoreInTest: true });
      vi.spyOn(appPool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);

      const unauthStatus = await request(app).get('/api/v1/read-model-sync/status');
      expect(unauthStatus.status).toBe(401);

      const loginRes = await request(app).post('/api/v1/auth/login').send({
        phone: TEST_PHONE,
        password: TEST_PASSWORD,
      });
      const cookie = loginRes.headers['set-cookie'];

      const csrfBlocked = await request(app)
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .set('Origin', 'https://erp.algions.in')
        .send({ name: 'Unprotected CSRF Check', buyingPrice: '10.00' });
      expect(csrfBlocked.status).toBe(403);
    });
  });
});
