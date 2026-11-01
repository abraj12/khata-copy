import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: () => Promise.resolve('https://fake-r2.cloudflarestorage.com/presigned-url'),
}));

import {
  StorageService,
  validateImageMagicBytes,
  MAX_PRODUCT_IMAGE_BYTES,
  MAX_OFFLINE_BILL_BYTES,
} from '../src/services/storage.service.js';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { AppError } from '../src/utils/errors.js';
import { env } from '../src/config/env.js';

describe('Cloudflare R2 Storage Service & Image Validation Suite', () => {
  let storageService: StorageService;
  let mockS3Client: any;

  beforeEach(() => {
    vi.restoreAllMocks();

    env.R2_ACCOUNT_ID = 'dummy-account-id';
    env.R2_ACCESS_KEY_ID = 'dummy-access-key';
    env.R2_SECRET_ACCESS_KEY = 'dummy-secret-key';
    env.R2_BUCKET_NAME = 'khata-test-bucket';

    storageService = new StorageService();

    mockS3Client = {
      send: vi.fn(),
    };
    storageService.setClient(mockS3Client as unknown as S3Client);
  });

  describe('1. Image Magic Bytes & Content-Type Spoofing Protection', () => {
    it('accepts valid JPEG magic bytes (FF D8 FF)', () => {
      const validJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      expect(validateImageMagicBytes(validJpeg, 'image/jpeg')).toBe(true);
    });

    it('accepts valid PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)', () => {
      const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      expect(validateImageMagicBytes(validPng, 'image/png')).toBe(true);
    });

    it('accepts valid WebP magic bytes (RIFF...WEBP)', () => {
      const validWebp = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      expect(validateImageMagicBytes(validWebp, 'image/webp')).toBe(true);
    });

    it('rejects executable / ELF files masquerading as JPEG', () => {
      const elfHeader = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      expect(validateImageMagicBytes(elfHeader, 'image/jpeg')).toBe(false);
      expect(validateImageMagicBytes(elfHeader, 'image/png')).toBe(false);
      expect(validateImageMagicBytes(elfHeader, 'image/webp')).toBe(false);
    });

    it('rejects Windows PE executable masquerading as PNG', () => {
      const mzHeader = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      expect(validateImageMagicBytes(mzHeader, 'image/png')).toBe(false);
    });

    it('rejects text / SVG / HTML masquerading as image/jpeg', () => {
      const svgHeader = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">');
      expect(validateImageMagicBytes(svgHeader, 'image/jpeg')).toBe(false);
      expect(validateImageMagicBytes(svgHeader, 'image/png')).toBe(false);
      expect(validateImageMagicBytes(svgHeader, 'image/webp')).toBe(false);
    });

    it('rejects short or empty buffers', () => {
      expect(validateImageMagicBytes(new Uint8Array([]), 'image/jpeg')).toBe(false);
      expect(validateImageMagicBytes(new Uint8Array([0xff, 0xd8]), 'image/jpeg')).toBe(false);
    });
  });

  describe('2. Upload Intent Constraints & Server-Controlled Object Keys', () => {
    it('rejects disallowed content types with AppError 400', async () => {
      await expect(
        storageService.getUploadIntent({
          folder: 'products',
          referenceId: 10,
          contentType: 'image/svg+xml',
          sizeBytes: 1024,
        })
      ).rejects.toThrow('Unsupported image type');
    });

    it('rejects product images exceeding 5 MB limit', async () => {
      await expect(
        storageService.getUploadIntent({
          folder: 'products',
          referenceId: 10,
          contentType: 'image/jpeg',
          sizeBytes: MAX_PRODUCT_IMAGE_BYTES + 1,
        })
      ).rejects.toThrow('Image size exceeds maximum allowed limit');
    });

    it('rejects offline bills exceeding 10 MB limit', async () => {
      await expect(
        storageService.getUploadIntent({
          folder: 'offline-bills',
          referenceId: 'ref-123',
          contentType: 'image/png',
          sizeBytes: MAX_OFFLINE_BILL_BYTES + 1,
        })
      ).rejects.toThrow('Image size exceeds maximum allowed limit');
    });

    it('generates server-controlled object key containing folder and UUID extension', async () => {
      const result = await storageService.getUploadIntent({
        folder: 'products',
        referenceId: 42,
        contentType: 'image/jpeg',
        sizeBytes: 100 * 1024,
      });

      expect(result.objectKey).toMatch(/^products\/42\/[a-f0-9-]+\.jpg$/);
      expect(result.expiresIn).toBe(300);
      expect(result.uploadUrl).toBeDefined();
    });

    it('generates server-controlled object key for offline bills', async () => {
      const result = await storageService.getUploadIntent({
        folder: 'offline-bills',
        referenceId: 'temp',
        contentType: 'image/png',
        sizeBytes: 500 * 1024,
      });

      expect(result.objectKey).toMatch(/^offline-bills\/temp\/[a-f0-9-]+\.png$/);
      expect(result.uploadUrl).toBeDefined();
    });
  });

  describe('3. Object Verification & Spoofed Header Protection', () => {
    it('successfully verifies genuine uploaded JPEG object', async () => {
      const validJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

      mockS3Client.send.mockImplementation(async (command: any) => {
        if (command instanceof HeadObjectCommand) {
          return {
            ContentLength: 10240,
            ContentType: 'image/jpeg',
          };
        }
        if (command instanceof GetObjectCommand) {
          return {
            Body: {
              transformToByteArray: async () => validJpegBytes,
            },
          };
        }
        return {};
      });

      const verified = await storageService.verifyObject('products/1/test.jpg', 'products', 1);
      expect(verified.contentLength).toBe(10240);
      expect(verified.contentType).toBe('image/jpeg');
    });

    it('detects spoofed content-type, deletes object from R2 and throws AppError 400', async () => {
      const fakeJpegBytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // ELF executable
      let deleteCalledWithKey = '';

      mockS3Client.send.mockImplementation(async (command: any) => {
        if (command instanceof HeadObjectCommand) {
          return {
            ContentLength: 5000,
            ContentType: 'image/jpeg',
          };
        }
        if (command instanceof GetObjectCommand) {
          return {
            Body: {
              transformToByteArray: async () => fakeJpegBytes,
            },
          };
        }
        if (command instanceof DeleteObjectCommand) {
          deleteCalledWithKey = command.input.Key;
          return {};
        }
        return {};
      });

      await expect(
        storageService.verifyObject('products/1/malicious.jpg', 'products', 1)
      ).rejects.toThrow('Uploaded file contents do not match a valid');

      expect(deleteCalledWithKey).toBe('products/1/malicious.jpg');
    });
  });

  describe('4. Safe Deletion & Presigned Retrieval URLs', () => {
    it('deletes object from R2 bucket safely', async () => {
      let deletedKey = '';
      mockS3Client.send.mockImplementation(async (command: any) => {
        if (command instanceof DeleteObjectCommand) {
          deletedKey = command.input.Key;
          return {};
        }
        return {};
      });

      await storageService.deleteObject('products/5/old.jpg');
      expect(deletedKey).toBe('products/5/old.jpg');
    });

    it('generates presigned view and download URLs', async () => {
      const viewUrl = await storageService.getPresignedViewUrl('products/5/pic.jpg', 600);
      expect(viewUrl).toContain('https://');

      const downloadUrl = await storageService.getPresignedDownloadUrl('offline-bills/bill.png', 'my_bill.png', 600);
      expect(downloadUrl).toContain('https://');
    });

    it('throws 503 STORAGE_NOT_CONFIGURED if S3 client is null', () => {
      storageService.setClient(null);
      expect(() => storageService.assertConfigured()).toThrow(AppError);
    });
  });
});
