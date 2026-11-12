import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appPool } from '../src/config/database.js';
import { storageCleanupService } from '../src/services/storageCleanup.service.js';
import { StorageCleanupWorker, storageCleanupWorker } from '../src/services/storageCleanup.worker.js';
import { storageService } from '../src/services/storage.service.js';
import * as storageObjectLock from '../src/services/storageObjectLock.js';

describe('Khata Release #032 — Storage Cleanup Service & Notification Lifecycle Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await storageCleanupWorker.stop().catch(() => {});
    vi.restoreAllMocks();
  });

  describe('1. Reference Safety Checks (Storage Upload Intents & External Logos)', () => {
    it('protects objects referenced in active storage_upload_intents from cleanup', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              in_products: false,
              in_offline_bills: false,
              in_supplier_bills: false,
              in_gst_invoices: false,
              in_normal_bills: false,
              in_quotation_settings: false,
              in_upload_intents: true,
            },
          ],
          rowCount: 1,
        }),
      } as any;

      const refs = await storageCleanupService.findLiveObjectReferences(
        'products/new-active-upload.png',
        mockClient
      );

      expect(refs).toContain('storage_upload_intents');
    });

    it('identifies external company logo URLs as external and does not match internal R2 keys', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              in_products: false,
              in_offline_bills: false,
              in_supplier_bills: false,
              in_gst_invoices: false,
              in_normal_bills: false,
              in_quotation_settings: false,
              in_upload_intents: false,
            },
          ],
          rowCount: 1,
        }),
      } as any;

      const refs = await storageCleanupService.findLiveObjectReferences(
        'quotations/my-local-logo.png',
        mockClient
      );

      expect(refs).not.toContain('quotation_settings');
    });

    it('matches quotation company_logo_url when it references the exact R2 key or path', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              in_products: false,
              in_offline_bills: false,
              in_supplier_bills: false,
              in_gst_invoices: false,
              in_normal_bills: false,
              in_quotation_settings: true,
              in_upload_intents: false,
            },
          ],
          rowCount: 1,
        }),
      } as any;

      const refs = await storageCleanupService.findLiveObjectReferences(
        'quotations/store-logo.png',
        mockClient
      );

      expect(refs).toContain('quotation_settings');
    });
  });

  describe('2. Transactional PG_NOTIFY on Cleanup Job Enqueue', () => {
    it('notifies storage_cleanup_jobs channel inside the enclosing transaction query', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({
          rows: [{ id: '11111111-1111-1111-1111-111111111111' }],
          rowCount: 1,
        }),
      } as any;

      await storageCleanupService.enqueueCleanupJob(
        {
          objectKey: 'products/orphan-test.png',
          objectKind: 'product_image',
          reason: 'product_image_replace',
        },
        mockClient
      );

      // Verify atomic CTE executed with pg_notify
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("pg_notify('storage_cleanup_jobs', id::text)"),
        expect.any(Array)
      );
    });
  });

  describe('3. Lock Protection in Immediate Deletion (attemptDeleteOrEnqueue)', () => {
    it('acquires session advisory lock, verifies references, and releases lock on deletion', async () => {
      const acquireLockSpy = vi.spyOn(storageObjectLock, 'acquireObjectSessionLock').mockResolvedValue(true);
      const releaseLockSpy = vi.spyOn(storageObjectLock, 'releaseObjectSessionLock').mockResolvedValue(true);
      const deleteObjectSpy = vi.spyOn(storageService, 'deleteObject').mockResolvedValue({} as any);

      vi.spyOn(storageCleanupService, 'findLiveObjectReferences').mockResolvedValue([]);

      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: vi.fn(),
      };
      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

      const result = await storageCleanupService.attemptDeleteOrEnqueue({
        objectKey: 'products/safe-to-delete.png',
        objectKind: 'product_image',
        reason: 'product_image_delete',
      });

      expect(acquireLockSpy).toHaveBeenCalledWith(mockClient, 'products/safe-to-delete.png');
      expect(deleteObjectSpy).toHaveBeenCalledWith('products/safe-to-delete.png');
      expect(releaseLockSpy).toHaveBeenCalledWith(mockClient, 'products/safe-to-delete.png');
      expect(result.outcome).toBe('deleted');
    });

    it('skips deletion and releases lock if live reference is discovered under lock', async () => {
      vi.spyOn(storageObjectLock, 'acquireObjectSessionLock').mockResolvedValue(true);
      const releaseLockSpy = vi.spyOn(storageObjectLock, 'releaseObjectSessionLock').mockResolvedValue(true);
      const deleteObjectSpy = vi.spyOn(storageService, 'deleteObject');

      vi.spyOn(storageCleanupService, 'findLiveObjectReferences').mockResolvedValue(['products']);

      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: vi.fn(),
      };
      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

      const result = await storageCleanupService.attemptDeleteOrEnqueue({
        objectKey: 'products/still-referenced.png',
        objectKind: 'product_image',
        reason: 'product_image_delete',
      });

      expect(deleteObjectSpy).not.toHaveBeenCalled();
      expect(releaseLockSpy).toHaveBeenCalled();
      expect(result.outcome).toBe('skipped_referenced');
    });
  });

  describe('4. Worker PostgreSQL LISTEN Subscription Lifecycle', () => {
    it('sets up LISTEN client and triggers drain when notification is received', async () => {
      const eventHandlers: Record<string, Function> = {};
      const mockListenClient = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        on: vi.fn().mockImplementation((event: string, handler: Function) => {
          eventHandlers[event] = handler;
          return mockListenClient;
        }),
        release: vi.fn(),
      };

      vi.spyOn(appPool, 'connect').mockResolvedValue(mockListenClient as any);

      const worker = new StorageCleanupWorker({ registerGlobalListener: false });
      const drainSpy = vi.spyOn(worker, 'triggerDrain').mockResolvedValue({ processedCount: 0 });

      worker.start();

      // Wait a tick for setupListenConnection promise
      await new Promise((r) => setImmediate(r));

      expect(mockListenClient.query).toHaveBeenCalledWith('LISTEN storage_cleanup_jobs');
      expect(eventHandlers['notification']).toBeDefined();

      // Simulate incoming notification
      eventHandlers['notification']({
        channel: 'storage_cleanup_jobs',
        payload: '11111111-1111-1111-1111-111111111111',
      });

      expect(drainSpy).toHaveBeenCalled();

      // Teardown
      await worker.stop();
      await new Promise((r) => setImmediate(r));
      expect(mockListenClient.release).toHaveBeenCalled();
    });
  });
});
