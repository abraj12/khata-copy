import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: () => Promise.resolve('https://fake-r2.cloudflarestorage.com/presigned-url'),
}));

import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import { storageService } from '../src/services/storage.service.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH = '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;
env.R2_ACCOUNT_ID = 'dummy-account-id';
env.R2_ACCESS_KEY_ID = 'dummy-access-key';
env.R2_SECRET_ACCESS_KEY = 'dummy-secret-key';
env.R2_BUCKET_NAME = 'khata-test-bucket';

const app = createApp({ useMemoryStoreInTest: true });

describe('Product Images API Test Suite', () => {
  let authCookie: string;
  let csrfToken: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    storageService.setClient({ send: vi.fn().mockResolvedValue({}) } as any);

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('information_schema.tables')) {
        return {
          rows: [
            { table_name: 'session' },
            { table_name: 'login_attempts' },
            { table_name: 'products' },
            { table_name: 'customers' },
            { table_name: 'udhar_transactions' },
            { table_name: 'udhar_items' },
            { table_name: 'payments' },
            { table_name: 'payment_allocations' },
            { table_name: 'idempotency_keys' },
            { table_name: 'offline_bill_records' },
          ],
          rowCount: 10,
        } as any;
      }
      if (sqlText.includes('FROM schema_migrations')) {
        return {
          rows: [{ version: '001_auth_tables.sql' }, { version: '009_product_images_and_offline_bills.sql' }],
          rowCount: 2,
        } as any;
      }
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as any;
    });

    vi.spyOn(appPool, 'connect').mockImplementation(async () => ({
      query: (sql: any, params?: any) => (appPool.query as any)(sql, params),
      release: () => {},
    }) as any);

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      phone: TEST_PHONE,
      password: TEST_PASSWORD,
    });

    authCookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';

    const csrfRes = await request(app).get('/api/v1/auth/csrf-token').set('Cookie', authCookie);
    csrfToken = csrfRes.body.csrfToken;
  });

  describe('1. Product Image Upload Intent', () => {
    it('returns 404 if product does not exist or is archived', async () => {
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return {
            rows: [{ table_name: 'products' }, { table_name: 'session' }],
            rowCount: 2,
          } as any;
        }
        if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
          return { rows: [], rowCount: 0 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .post('/api/v1/products/999/image/upload-intent')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken)
        .send({
          contentType: 'image/jpeg',
          sizeBytes: 10240,
        });

      expect(res.status).toBe(404);
      expect(res.body.message).toContain('Product not found or archived');
    });

    it('returns presigned PUT intent for existing active product', async () => {
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return {
            rows: [{ table_name: 'products' }, { table_name: 'session' }],
            rowCount: 2,
          } as any;
        }
        if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
          return {
            rows: [
              {
                id: 10,
                name: 'Tata Tea Gold',
                buying_price: '180.00',
                archived_at: null,
                image_object_key: null,
              },
            ],
            rowCount: 1,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      vi.spyOn(storageService, 'getUploadIntent').mockResolvedValueOnce({
        uploadUrl: 'https://fake-r2.cloudflarestorage.com/products/10/upload?sig=abc',
        objectKey: 'products/10/uuid.jpg',
        expiresIn: 300,
        headers: { 'Content-Type': 'image/jpeg' },
      });

      const res = await request(app)
        .post('/api/v1/products/10/image/upload-intent')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken)
        .send({
          contentType: 'image/jpeg',
          sizeBytes: 50000,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.uploadUrl).toContain('https://fake-r2.cloudflarestorage.com');
      expect(res.body.data.objectKey).toBe('products/10/uuid.jpg');
    });
  });

  describe('2. Complete & Attach Image', () => {
    it('verifies uploaded object and updates product table', async () => {
      vi.spyOn(storageService, 'verifyObject').mockResolvedValueOnce({
        contentLength: 45000,
        contentType: 'image/jpeg',
      });

      const updatedProduct = {
        id: 10,
        name: 'Tata Tea Gold',
        buying_price: '180.00',
        image_object_key: 'products/10/uuid.jpg',
        image_content_type: 'image/jpeg',
        image_size_bytes: '45000',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return {
            rows: [{ table_name: 'products' }, { table_name: 'session' }],
            rowCount: 2,
          } as any;
        }
        if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
          return {
            rows: [
              {
                id: 10,
                name: 'Tata Tea Gold',
                buying_price: '180.00',
                archived_at: null,
                image_object_key: null,
              },
            ],
            rowCount: 1,
          } as any;
        }
        if (sqlText.includes('UPDATE products')) {
          return { rows: [updatedProduct], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .post('/api/v1/products/10/image/complete')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken)
        .send({
          objectKey: 'products/10/uuid.jpg',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(10);
      expect(res.body.data.image_object_key).toBe('products/10/uuid.jpg');
    });
  });

  describe('3. Remove Image Without Deleting Product', () => {
    it('clears product image references from DB and removes R2 object while keeping product intact', async () => {
      let deletedKey = '';
      const { storageCleanupService } = await import('../src/services/storageCleanup.service.js');
      vi.spyOn(storageCleanupService, 'enqueueCleanupJobInTransaction').mockImplementation(async (_client: any, input: any) => {
        deletedKey = input.objectKey;
      });
      vi.spyOn(storageService, 'deleteObject').mockImplementation(async (key: string) => {
        deletedKey = key;
      });

      const clearedProduct = {
        id: 10,
        name: 'Tata Tea Gold',
        buying_price: '180.00',
        image_object_key: null,
        image_content_type: null,
        image_size_bytes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return {
            rows: [{ table_name: 'products' }, { table_name: 'session' }],
            rowCount: 2,
          } as any;
        }
        if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
          return {
            rows: [
              {
                id: 10,
                name: 'Tata Tea Gold',
                buying_price: '180.00',
                archived_at: null,
                image_object_key: 'products/10/old.jpg',
              },
            ],
            rowCount: 1,
          } as any;
        }
        if (sqlText.includes('UPDATE products')) {
          return { rows: [clearedProduct], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .delete('/api/v1/products/10/image')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(deletedKey).toBe('products/10/old.jpg');
      expect(res.body.data.image_object_key).toBeNull();
      expect(res.body.data.id).toBe(10);
    });
  });
  describe('4. Server-Side Proxy Upload (POST /api/v1/products/:id/image/upload)', () => {
    it('rejects unauthenticated multipart upload with 401', async () => {
      const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x31, 0x32]);
      const res = await request(app)
        .post('/api/v1/products/10/image/upload')
        .attach('image', validJpeg, 'test.jpg');

      expect(res.status).toBe(401);
    });

    it('rejects multipart upload without image file', async () => {
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'products' }, { table_name: 'session' }], rowCount: 2 } as any;
        }
        if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
          return {
            rows: [{ id: 10, name: 'Tata Tea Gold', buying_price: '180.00', archived_at: null, image_object_key: null }],
            rowCount: 1,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .post('/api/v1/products/10/image/upload')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('No image file provided');
    });

    it('successfully uploads valid JPEG buffer and attaches to product', async () => {
      const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x31, 0x32]);

      vi.spyOn(storageService, 'uploadBufferToR2').mockResolvedValue(undefined as any);
      vi.spyOn(storageService, 'verifyObject').mockResolvedValue({
        contentLength: validJpeg.length,
        contentType: 'image/jpeg',
      });

      const updatedProduct = {
        id: 10,
        name: 'Tata Tea Gold',
        buying_price: '180.00',
        image_object_key: 'products/10/uploaded.jpg',
        image_content_type: 'image/jpeg',
        image_size_bytes: String(validJpeg.length),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'products' }, { table_name: 'session' }], rowCount: 2 } as any;
        }
        if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
          return {
            rows: [{ id: 10, name: 'Tata Tea Gold', buying_price: '180.00', archived_at: null, image_object_key: null }],
            rowCount: 1,
          } as any;
        }
        if (sqlText.includes('UPDATE products')) {
          return { rows: [updatedProduct], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .post('/api/v1/products/10/image/upload')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken)
        .attach('image', validJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(10);
    });
  });
  describe('5. Product Image Streaming (GET /api/v1/products/:id/image)', () => {
    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v1/products/10/image');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 404 when product has no image attached', async () => {
      const { readModelsQueryService } = await import('../src/modules/readModels/readModelsQuery.service.js');
      vi.spyOn(readModelsQueryService, 'getProductImageMetaFromMongo').mockResolvedValueOnce(null);
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'products' }, { table_name: 'session' }], rowCount: 2 } as any;
        }
        if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
          return {
            rows: [{ id: 10, name: 'Tata Tea Gold', buying_price: '180.00', archived_at: null, image_object_key: null }],
            rowCount: 1,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .get('/api/v1/products/10/image')
        .set('Cookie', authCookie);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('streams image with private Cache-Control and Cross-Origin-Resource-Policy', async () => {
      const { readModelsQueryService } = await import('../src/modules/readModels/readModelsQuery.service.js');
      vi.spyOn(readModelsQueryService, 'getProductImageMetaFromMongo').mockResolvedValueOnce({
        id: 10,
        imageObjectKey: 'products/10/pic.jpg',
        isArchived: false,
      } as any);
      const { Readable } = require('stream');
      const fakeStream = new Readable();
      fakeStream.push(Buffer.from([0xff, 0xd8, 0xff]));
      fakeStream.push(null);

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'products' }, { table_name: 'session' }], rowCount: 2 } as any;
        }
        if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
          return {
            rows: [{
              id: 10,
              name: 'Tata Tea Gold',
              buying_price: '180.00',
              archived_at: null,
              image_object_key: 'products/10/pic.jpg',
              image_content_type: 'image/jpeg',
            }],
            rowCount: 1,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      vi.spyOn(storageService, 'getObjectStream').mockResolvedValue({
        stream: fakeStream,
        contentType: 'image/jpeg',
        contentLength: 3,
      });

      const res = await request(app)
        .get('/api/v1/products/10/image')
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['cache-control']).toContain('private');
    });
  });
});
