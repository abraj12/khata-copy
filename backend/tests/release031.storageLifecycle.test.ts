import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appPool } from '../src/config/database.js';
import { storageService, isNoSuchKeyError } from '../src/services/storage.service.js';
import { storageCleanupService } from '../src/services/storageCleanup.service.js';
import { productsService } from '../src/modules/products/products.service.js';
import { suppliersService } from '../src/modules/suppliers/suppliers.service.js';
import { offlineBillsService } from '../src/modules/offlineBills/offlineBills.service.js';
import { env } from '../src/config/env.js';

function buildMockPoolClient(queryHandler: (sql: string, params?: unknown[]) => Promise<any>) {
  return {
    query: vi.fn(queryHandler),
    release: vi.fn(),
  } as any;
}

describe('Khata Release #031 — Storage Lifecycle & Transactional Cleanup Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('1. deleteObject Idempotency & Failure Propagation', () => {
    it('treats NoSuchKey error from R2 as idempotent success', () => {
      const err = new Error('The specified key does not exist.');
      (err as any).name = 'NoSuchKey';
      (err as any).$metadata = { httpStatusCode: 404 };

      expect(isNoSuchKeyError(err)).toBe(true);
    });

    it('treats NotFound / 404 error from R2 as idempotent success', () => {
      const err = new Error('Object not found');
      (err as any).name = 'NotFound';
      (err as any).$metadata = { httpStatusCode: 404 };

      expect(isNoSuchKeyError(err)).toBe(true);
    });

    it('does NOT treat network errors or 500 server errors as success', () => {
      const netErr = new Error('ECONNRESET');
      (netErr as any).code = 'ECONNRESET';
      expect(isNoSuchKeyError(netErr)).toBe(false);

      const serverErr = new Error('Internal S3 Error');
      (serverErr as any).$metadata = { httpStatusCode: 500 };
      expect(isNoSuchKeyError(serverErr)).toBe(false);

      const authErr = new Error('Access Denied');
      (authErr as any).name = 'AccessDenied';
      (authErr as any).$metadata = { httpStatusCode: 403 };
      expect(isNoSuchKeyError(authErr)).toBe(false);
    });

    it('rejects empty or whitespace-only object keys', async () => {
      await expect(storageService.deleteObject('')).rejects.toThrowError(/Storage object key is required/);
      await expect(storageService.deleteObject('   ')).rejects.toThrowError(/Storage object key is required/);
    });
  });

  describe('2. Transactional Cleanup Job Insertion in same PostgreSQL Transaction', () => {
    it('inserts cleanup job into storage_cleanup_jobs using existing client transaction', async () => {
      const executedSql: { text: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executedSql.push({ text: sql, params });
        if (sql.includes('INSERT INTO storage_cleanup_jobs')) {
          return { rows: [{ id: 42 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const jobId = await storageCleanupService.enqueueCleanupJobInTransaction(mockClient, {
        objectKey: 'products/123/old-photo.jpg',
        objectKind: 'product_image',
        reason: 'product_image_replace',
      });

      expect(jobId).toBe(42);
      expect(mockClient.query).toHaveBeenCalled();
      const insertQuery = executedSql.find((q) => q.text.includes('INSERT INTO storage_cleanup_jobs'));
      expect(insertQuery).toBeDefined();
      expect(insertQuery?.params).toContain('products/123/old-photo.jpg');
      expect(insertQuery?.params).toContain('product_image');
      expect(insertQuery?.params).toContain('product_image_replace');
    });
  });

  describe('3. Product Image Replacement & Removal Storage Lifecycle', () => {
    it('enqueues cleanup job in transaction when product image is replaced', async () => {
      vi.spyOn(storageService, 'verifyObject').mockResolvedValue({
        contentType: 'image/jpeg',
        contentLength: 102400,
      });
      vi.spyOn(storageService, 'getPresignedViewUrl').mockResolvedValue('https://r2.khata.internal/view');

      const executedSql: { text: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executedSql.push({ text: sql, params });
        if (sql.includes('SELECT id, archived_at, image_object_key') && sql.includes('FOR UPDATE')) {
          return {
            rows: [{ id: 1, archived_at: null, image_object_key: 'products/1/old-image.jpg' }],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT pg_advisory_xact_lock')) {
          return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
        }
        if (sql.includes('UPDATE products')) {
          return {
            rows: [
              {
                id: 1,
                name: 'Cement Ultra',
                buying_price: '350.00',
                hsn_code: '2523',
                barcode: null,
                image_object_key: 'products/1/new-image.jpg',
                image_content_type: 'image/jpeg',
                image_size_bytes: 102400,
                image_updated_at: new Date().toISOString(),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO storage_cleanup_jobs')) {
          return { rows: [{ id: 99 }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO outbox_events')) {
          return { rows: [{ id: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient);

      await productsService.attachProductImage(1, 'products/1/new-image.jpg');

      const cleanupSql = executedSql.find((q) => q.text.includes('INSERT INTO storage_cleanup_jobs'));
      expect(cleanupSql).toBeDefined();
      expect(cleanupSql?.params).toContain('products/1/old-image.jpg');
      expect(cleanupSql?.params).toContain('product_image_replace');

      const commitSql = executedSql.find((q) => q.text === 'COMMIT');
      expect(commitSql).toBeDefined();
    });

    it('enqueues cleanup job in transaction when product image is removed', async () => {
      vi.spyOn(storageService, 'getPresignedViewUrl').mockResolvedValue('https://r2.khata.internal/view');

      const executedSql: { text: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executedSql.push({ text: sql, params });
        if (sql.includes('SELECT id, archived_at, image_object_key') && sql.includes('FOR UPDATE')) {
          return {
            rows: [{ id: 2, archived_at: null, image_object_key: 'products/2/to-remove.jpg' }],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT pg_advisory_xact_lock')) {
          return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
        }
        if (sql.includes('UPDATE products')) {
          return {
            rows: [
              {
                id: 2,
                name: 'Steel Rods',
                buying_price: '500.00',
                hsn_code: null,
                barcode: null,
                image_object_key: null,
                image_content_type: null,
                image_size_bytes: null,
                image_updated_at: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO storage_cleanup_jobs')) {
          return { rows: [{ id: 101 }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO outbox_events')) {
          return { rows: [{ id: 2 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient);

      await productsService.removeProductImage(2);

      const cleanupSql = executedSql.find((q) => q.text.includes('INSERT INTO storage_cleanup_jobs'));
      expect(cleanupSql).toBeDefined();
      expect(cleanupSql?.params).toContain('products/2/to-remove.jpg');
      expect(cleanupSql?.params).toContain('product_image_remove');
    });
  });

  describe('4. Supplier Purchase Bill & Offline Bill Cleanup', () => {
    it('enqueues cleanup job in transaction when supplier bill attachment is removed', async () => {
      vi.spyOn(suppliersService, 'getPurchaseBillById').mockResolvedValue({
        id: 5,
        supplierId: 1,
        billNumber: 'BILL-001',
        billDate: '2026-03-01',
        totalAmount: '1500.00',
        paymentStatus: 'UNPAID',
        paidAmount: '0.00',
        remainingBalance: '1500.00',
        attachment: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lineItems: [],
        payments: [],
      } as any);

      const executedSql: { text: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executedSql.push({ text: sql, params });
        if (sql.includes('SELECT attachment_object_key FROM supplier_purchase_bills') && sql.includes('FOR UPDATE')) {
          return {
            rows: [{ attachment_object_key: 'supplier-bills/5/bill.pdf' }],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT pg_advisory_xact_lock')) {
          return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
        }
        if (sql.includes('UPDATE supplier_purchase_bills')) {
          return {
            rows: [
              {
                id: 5,
                supplier_id: 1,
                bill_number: 'BILL-001',
                bill_date: '2026-03-01',
                total_amount: '1500.00',
                attachment_object_key: null,
                attachment_content_type: null,
                attachment_size_bytes: null,
                attachment_updated_at: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO storage_cleanup_jobs')) {
          return { rows: [{ id: 105 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient);

      await suppliersService.removePurchaseBillAttachment(5);

      const cleanupSql = executedSql.find((q) => q.text.includes('INSERT INTO storage_cleanup_jobs'));
      expect(cleanupSql).toBeDefined();
      expect(cleanupSql?.params).toContain('supplier-bills/5/bill.pdf');
      expect(cleanupSql?.params).toContain('supplier_attachment_remove');
    });

    it('enqueues cleanup job in transaction when offline bill is deleted', async () => {
      const executedSql: { text: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executedSql.push({ text: sql, params });
        if (sql.includes('SELECT id, image_object_key FROM offline_bill_records') && sql.includes('FOR UPDATE')) {
          return {
            rows: [{ id: 8, image_object_key: 'offline-bills/8/bill.jpg' }],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT pg_advisory_xact_lock')) {
          return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
        }
        if (sql.includes('DELETE FROM offline_bill_records')) {
          return { rows: [{ id: 8 }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO storage_cleanup_jobs')) {
          return { rows: [{ id: 108 }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO outbox_events')) {
          return { rows: [{ id: 3 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient);

      await offlineBillsService.deleteOfflineBill(8);

      const cleanupSql = executedSql.find((q) => q.text.includes('INSERT INTO storage_cleanup_jobs'));
      expect(cleanupSql).toBeDefined();
      expect(cleanupSql?.params).toContain('offline-bills/8/bill.jpg');
      expect(cleanupSql?.params).toContain('offline_bill_delete');
    });
  });
});
