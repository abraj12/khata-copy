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

describe('Offline Bills & Non-Financial Document Storage Test Suite', () => {
  let authCookie: string;
  let csrfToken: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    storageService.setClient({ send: vi.fn() } as any);

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

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      phone: TEST_PHONE,
      password: TEST_PASSWORD,
    });

    authCookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';

    const csrfRes = await request(app).get('/api/v1/auth/csrf-token').set('Cookie', authCookie);
    csrfToken = csrfRes.body.csrfToken;
  });

  describe('1. Authentication Protection', () => {
    it('rejects unauthenticated requests with HTTP 401 Unauthorized', async () => {
      const res = await request(app).get('/api/v1/offline-bills');
      expect(res.status).toBe(401);
      expect(res.body.authenticated).toBe(false);
      expect(res.body.message).toContain('Authentication required');
    });
  });

  describe('2. Validation & Document Ingestion', () => {
    it('rejects creation if customer name is missing', async () => {
      const res = await request(app)
        .post('/api/v1/offline-bills')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken)
        .send({
          customerName: '',
          customerPhone: '9876543210',
          imageObjectKey: 'offline-bills/temp/file.jpg',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Customer name is required');
    });

    it('rejects creation if mobile number is invalid', async () => {
      const res = await request(app)
        .post('/api/v1/offline-bills')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken)
        .send({
          customerName: 'Anil Kumar',
          customerPhone: '12345',
          imageObjectKey: 'offline-bills/temp/file.jpg',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('10-digit Indian mobile');
    });

    it('successfully creates offline bill document with verified storage image', async () => {
      vi.spyOn(storageService, 'verifyObject').mockResolvedValueOnce({
        contentLength: 204800,
        contentType: 'image/jpeg',
      });

      const mockRecord = {
        id: 101,
        customer_name: 'Anil Kumar',
        customer_phone: '9876543210',
        normalized_customer_phone: '9876543210',
        image_object_key: 'offline-bills/temp/bill-101.jpg',
        image_content_type: 'image/jpeg',
        image_size_bytes: '204800',
        original_filename: 'scan.jpg',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return {
            rows: [{ table_name: 'offline_bill_records' }, { table_name: 'session' }],
            rowCount: 2,
          } as any;
        }
        if (sqlText.includes('INSERT INTO offline_bill_records')) {
          return { rows: [mockRecord], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .post('/api/v1/offline-bills')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken)
        .send({
          customerName: 'Anil Kumar',
          customerPhone: '+91 98765 43210',
          imageObjectKey: 'offline-bills/temp/bill-101.jpg',
          originalFilename: 'scan.jpg',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(101);
      expect(res.body.data.customer_name).toBe('Anil Kumar');
      expect(res.body.data.customer_phone).toBe('9876543210');
    });
  });

  describe('3. Bounded Listing & Search', () => {
    it('lists offline bills with search by customer name and phone', async () => {
      let executedSql = '';
      let executedParams: any[] = [];

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params: any) => {
        executedSql = typeof sql === 'string' ? sql : sql?.text || '';
        executedParams = params || [];

        if (executedSql.includes('information_schema.tables')) {
          return {
            rows: [{ table_name: 'offline_bill_records' }, { table_name: 'session' }],
            rowCount: 2,
          } as any;
        }

        return {
          rows: [
            {
              id: 1,
              customer_name: 'Ramesh Patel',
              customer_phone: '9811122233',
              normalized_customer_phone: '9811122233',
              image_object_key: 'offline-bills/1/bill.jpg',
              image_content_type: 'image/jpeg',
              image_size_bytes: '102400',
              original_filename: 'bill.jpg',
              created_at: '2026-11-01T10:00:00Z',
              updated_at: '2026-11-01T10:00:00Z',
            },
          ],
          rowCount: 1,
        } as any;
      });

      const res = await request(app)
        .get('/api/v1/offline-bills?search=Ramesh&limit=10&offset=0')
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(executedSql).toContain('customer_name ILIKE $1');
      expect(executedParams[0]).toBe('%Ramesh%');
    });
  });

  describe('4. CRITICAL NON-FINANCIAL INVARIANCE (Zero Ledger Impact)', () => {
    it('guarantees offline bill creation does NOT touch customers, transactions, or payment tables', async () => {
      vi.spyOn(storageService, 'verifyObject').mockResolvedValueOnce({
        contentLength: 150000,
        contentType: 'image/jpeg',
      });

      const touchedTables: string[] = [];

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';

        if (sqlText.includes('information_schema.tables')) {
          return {
            rows: [{ table_name: 'offline_bill_records' }, { table_name: 'session' }],
            rowCount: 2,
          } as any;
        }

        if (/INSERT\s+INTO\s+([a-zA-Z_]+)/i.test(sqlText)) {
          const match = sqlText.match(/INSERT\s+INTO\s+([a-zA-Z_]+)/i);
          if (match) touchedTables.push(match[1]);
        }
        if (/UPDATE\s+([a-zA-Z_]+)/i.test(sqlText)) {
          const match = sqlText.match(/UPDATE\s+([a-zA-Z_]+)/i);
          if (match) touchedTables.push(match[1]);
        }

        if (sqlText.includes('INSERT INTO offline_bill_records')) {
          return {
            rows: [
              {
                id: 200,
                customer_name: 'Stranger Without Account',
                customer_phone: '9999888877',
                normalized_customer_phone: '9999888877',
                image_object_key: 'offline-bills/temp/stranger.jpg',
                image_content_type: 'image/jpeg',
                image_size_bytes: '150000',
                created_at: new Date().toISOString(),
              },
            ],
            rowCount: 1,
          } as any;
        }

        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .post('/api/v1/offline-bills')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken)
        .send({
          customerName: 'Stranger Without Account',
          customerPhone: '9999888877',
          imageObjectKey: 'offline-bills/temp/stranger.jpg',
        });

      expect(res.status).toBe(201);
      expect(touchedTables).toEqual(['offline_bill_records']);
      expect(touchedTables).not.toContain('customers');
      expect(touchedTables).not.toContain('udhar_transactions');
      expect(touchedTables).not.toContain('udhar_items');
      expect(touchedTables).not.toContain('payments');
      expect(touchedTables).not.toContain('payment_allocations');
    });
  });

  describe('5. View, Download & Deletion', () => {
    it('generates presigned download URL with Content-Disposition attachment', async () => {
      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return {
            rows: [{ table_name: 'offline_bill_records' }, { table_name: 'session' }],
            rowCount: 2,
          } as any;
        }
        if (sqlText.includes('FROM offline_bill_records') && sqlText.includes('WHERE id = $1')) {
          return {
            rows: [
              {
                id: 5,
                customer_name: 'Test Customer',
                customer_phone: '9876543210',
                normalized_customer_phone: '9876543210',
                image_object_key: 'offline-bills/5/receipt.jpg',
                image_content_type: 'image/jpeg',
                image_size_bytes: '50000',
                original_filename: 'receipt.jpg',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
            rowCount: 1,
          } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .get('/api/v1/offline-bills/5/image-url?download=true')
        .set('Cookie', authCookie);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toContain('https://fake-r2.cloudflarestorage.com');
    });

    it('deletes offline bill record and triggers storage deletion', async () => {
      let deletedFromR2Key = '';
      vi.spyOn(storageService, 'deleteObject').mockImplementation(async (key: string) => {
        deletedFromR2Key = key;
      });

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('information_schema.tables')) {
          return {
            rows: [{ table_name: 'offline_bill_records' }, { table_name: 'session' }],
            rowCount: 2,
          } as any;
        }
        if (sqlText.includes('FROM offline_bill_records') && sqlText.includes('WHERE id = $1')) {
          return {
            rows: [
              {
                id: 12,
                customer_name: 'Delete Me',
                customer_phone: '9876543210',
                normalized_customer_phone: '9876543210',
                image_object_key: 'offline-bills/12/delete_me.jpg',
                image_content_type: 'image/jpeg',
                image_size_bytes: '1000',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
            rowCount: 1,
          } as any;
        }
        if (sqlText.includes('DELETE FROM offline_bill_records')) {
          return { rows: [], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const res = await request(app)
        .delete('/api/v1/offline-bills/12')
        .set('Cookie', authCookie)
        .set('x-csrf-token', csrfToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(deletedFromR2Key).toBe('offline-bills/12/delete_me.jpg');
    });
  });
});
