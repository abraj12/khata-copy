import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  storageUploadIntentService,
  StorageUploadIntentRecord,
} from '../src/services/storageUploadIntent.service.js';
import { AppError } from '../src/utils/errors.js';

describe('Khata Release #032 — Storage Upload Intent Lifecycle Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Registration and Query Verification', () => {
    it('registers presigned upload intent in database with status issued', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 'intent-uuid-1',
              object_key: 'products/prod_1_123.jpg',
              object_kind: 'product_image',
              reference_type: 'product',
              reference_id: '1',
              status: 'issued',
              expires_at: new Date(Date.now() + 300_000),
            },
          ],
          rowCount: 1,
        }),
      } as any;

      const record = await storageUploadIntentService.registerIntent(
        {
          objectKey: 'products/prod_1_123.jpg',
          objectKind: 'product_image',
          referenceType: 'product',
          referenceId: 1,
          expectedContentType: 'image/jpeg',
          expectedSizeBytes: 10240,
        },
        mockDb
      );

      expect(record.status).toBe('issued');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO storage_upload_intents'),
        expect.arrayContaining(['products/prod_1_123.jpg', 'product_image', 'product', '1'])
      );
    });
  });

  describe('2. Intent Validation and Locking', () => {
    it('locks intent FOR UPDATE and returns intent when valid and unexpired', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 'intent-uuid-1',
              object_key: 'products/prod_1_123.jpg',
              reference_type: 'product',
              reference_id: '1',
              status: 'issued',
              expires_at: new Date(Date.now() + 60_000),
            },
          ],
          rowCount: 1,
        }),
      } as any;

      const intent = await storageUploadIntentService.lockAndValidateIntent(mockClient, {
        objectKey: 'products/prod_1_123.jpg',
        expectedReferenceType: 'product',
        expectedReferenceId: 1,
      });

      expect(intent).not.toBeNull();
      expect(intent?.status).toBe('issued');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE'),
        ['products/prod_1_123.jpg']
      );
    });

    it('rejects expired intent, transitions status to expired in database, and throws 400', async () => {
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('FOR UPDATE')) {
            return {
              rows: [
                {
                  id: 'intent-expired-1',
                  object_key: 'products/expired.jpg',
                  reference_type: 'product',
                  reference_id: '1',
                  status: 'issued',
                  // Expired 10 seconds ago
                  expires_at: new Date(Date.now() - 10_000),
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        }),
      } as any;

      await expect(
        storageUploadIntentService.lockAndValidateIntent(mockClient, {
          objectKey: 'products/expired.jpg',
        })
      ).rejects.toThrowError(AppError);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'expired'"),
        ['intent-expired-1']
      );
    });

    it('throws UPLOAD_INTENT_MISMATCH when reference type or ID does not match', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 'intent-uuid-2',
              object_key: 'products/prod_2.jpg',
              reference_type: 'product',
              reference_id: '2',
              status: 'issued',
              expires_at: new Date(Date.now() + 60_000),
            },
          ],
          rowCount: 1,
        }),
      } as any;

      await expect(
        storageUploadIntentService.lockAndValidateIntent(mockClient, {
          objectKey: 'products/prod_2.jpg',
          expectedReferenceType: 'product',
          expectedReferenceId: 999, // Mismatched ID
        })
      ).rejects.toThrowError(/reference ID mismatch/);
    });

    it('returns null if intent does not exist in database', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      } as any;

      const result = await storageUploadIntentService.lockAndValidateIntent(mockClient, {
        objectKey: 'non-existent.jpg',
      });

      expect(result).toBeNull();
    });
  });

  describe('3. Transactional Completion', () => {
    it('atomically marks status completed in database transaction', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rowCount: 1 }),
      } as any;

      const completed = await storageUploadIntentService.completeIntentInTransaction(
        mockClient,
        'products/prod_1_123.jpg'
      );

      expect(completed).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'completed'"),
        ['products/prod_1_123.jpg']
      );
    });
  });
});
