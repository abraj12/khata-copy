import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH = '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const app = createApp({ useMemoryStoreInTest: true });

describe('Product HSN Code Feature Test Suite', () => {
  let authCookie: string;
  let csrfToken: string;

  beforeEach(async () => {
    vi.restoreAllMocks();

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
          rows: [{ version: '001_auth_tables.sql' }, { version: '010_product_hsn_code.sql' }],
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

  it('1. Creates a product with an optional HSN code', async () => {
    const mockCreated = {
      id: 101,
      name: 'Brass Ball Valve 1/2 inch',
      buying_price: '240.00',
      hsn_code: '8481.80.30',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
      image_object_key: null,
      image_content_type: null,
      image_size_bytes: null,
      image_updated_at: null,
    };

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('INSERT INTO products')) {
        return { rows: [mockCreated], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .post('/api/v1/products')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        name: 'Brass Ball Valve 1/2 inch',
        buying_price: '240.00',
        hsn_code: '8481.80.30',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hsn_code).toBe('8481.80.30');
  });

  it('2. Creates a product without HSN code (optional field defaults to null)', async () => {
    const mockCreated = {
      id: 102,
      name: 'PVC Elbow 25mm',
      buying_price: '18.00',
      hsn_code: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
      image_object_key: null,
      image_content_type: null,
      image_size_bytes: null,
      image_updated_at: null,
    };

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('INSERT INTO products')) {
        return { rows: [mockCreated], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .post('/api/v1/products')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        name: 'PVC Elbow 25mm',
        buying_price: '18.00',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hsn_code).toBeNull();
  });

  it('3. Rejects HSN code longer than 20 characters', async () => {
    const res = await request(app)
      .post('/api/v1/products')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        name: 'Test Product',
        buying_price: '50.00',
        hsn_code: '123456789012345678901', // 21 chars
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toContain('HSN code cannot exceed 20 characters');
  });

  it('4. Updates an existing product with an HSN code', async () => {
    const existing = {
      id: 101,
      name: 'Brass Ball Valve 1/2 inch',
      buying_price: '240.00',
      hsn_code: null,
      archived_at: null,
    };

    const updated = {
      ...existing,
      hsn_code: '8481',
      updated_at: new Date().toISOString(),
    };

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
        return { rows: [existing], rowCount: 1 } as any;
      }
      if (sqlText.includes('UPDATE products')) {
        return { rows: [updated], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .patch('/api/v1/products/101')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        hsn_code: '8481',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hsn_code).toBe('8481');
  });
});
