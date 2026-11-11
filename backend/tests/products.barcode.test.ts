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

describe('Product Barcode Feature Test Suite', () => {
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
            { table_name: 'gst_invoices' },
            { table_name: 'gst_invoice_items' },
            { table_name: 'normal_bills' },
            { table_name: 'normal_bill_items' },
            { table_name: 'quotations' },
            { table_name: 'quotation_items' },
            { table_name: 'quotation_settings' },
          ],
          rowCount: 17,
        } as any;
      }
      if (sqlText.includes('FROM schema_migrations')) {
        return {
          rows: [{ version: '001_auth_tables.sql' }, { version: '015_product_barcode.sql' }],
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

  it('1. Creates a product with an optional barcode', async () => {
    const mockCreated = {
      id: 201,
      name: 'Wireless Barcode Scanner Handheld',
      buying_price: '1850.00',
      hsn_code: '8471.90.00',
      barcode: '8901234567890',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
      image_object_key: null,
      image_content_type: null,
      image_size_bytes: null,
      image_updated_at: null,
    };

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('INSERT INTO products')) {
        expect(params?.[3]).toBe('8901234567890');
        return { rows: [mockCreated], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .post('/api/v1/products')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        name: 'Wireless Barcode Scanner Handheld',
        buying_price: '1850.00',
        hsn_code: '8471.90.00',
        barcode: '8901234567890',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.barcode).toBe('8901234567890');
  });

  it('2. Preserves leading zeroes in barcode during creation', async () => {
    const leadingZeroBarcode = '0012345678905';
    const mockCreated = {
      id: 202,
      name: 'Item with Leading Zero Barcode',
      buying_price: '100.00',
      hsn_code: null,
      barcode: leadingZeroBarcode,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    };

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('INSERT INTO products')) {
        expect(params?.[3]).toBe(leadingZeroBarcode);
        return { rows: [mockCreated], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .post('/api/v1/products')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        name: 'Item with Leading Zero Barcode',
        buying_price: '100.00',
        barcode: leadingZeroBarcode,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.barcode).toBe(leadingZeroBarcode);
  });

  it('3. Rejects product creation when barcode exceeds 64 characters', async () => {
    const tooLongBarcode = '1'.repeat(65);

    const res = await request(app)
      .post('/api/v1/products')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        name: 'Product with Oversized Barcode',
        buying_price: '50.00',
        barcode: tooLongBarcode,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('4. Rejects duplicate active barcode with HTTP 409', async () => {
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('INSERT INTO products')) {
        const err: any = new Error('duplicate key value violates unique constraint "idx_products_barcode_active"');
        err.code = '23505';
        err.constraint = 'idx_products_barcode_active';
        throw err;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .post('/api/v1/products')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        name: 'Duplicate Barcode Item',
        buying_price: '75.00',
        barcode: '8901234567890',
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('DUPLICATE_BARCODE');
    expect(res.body.message).toContain('8901234567890');
  });

  it('5. Lookups active product by barcode via GET /api/v1/products/barcode/:barcode', async () => {
    const mockProduct = {
      id: 205,
      name: 'Cat6 Ethernet Cable 10m',
      buying_price: '320.00',
      hsn_code: '8544.49.99',
      barcode: '8909876543210',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
      image_object_key: null,
    };

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('FROM products') && sqlText.includes('barcode = $1')) {
        expect(params?.[0]).toBe('8909876543210');
        return { rows: [mockProduct], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .get('/api/v1/products/barcode/8909876543210')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(205);
    expect(res.body.data.name).toBe('Cat6 Ethernet Cable 10m');
    expect(res.body.data.barcode).toBe('8909876543210');
  });

  it('6. Returns 404 when barcode does not match any active product', async () => {
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('FROM products') && sqlText.includes('barcode = $1')) {
        return { rows: [], rowCount: 0 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .get('/api/v1/products/barcode/9999999999999')
      .set('Cookie', authCookie);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('7. Updates a product barcode specifically via PATCH /api/v1/products/:id/barcode', async () => {
    const mockUpdated = {
      id: 207,
      name: 'Power Extension Cord 5M',
      buying_price: '450.00',
      hsn_code: null,
      barcode: '8901112223334',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    };

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('UPDATE products') && sqlText.includes('SET barcode = $1')) {
        expect(params?.[0]).toBe('8901112223334');
        expect(params?.[1]).toBe(207);
        return { rows: [mockUpdated], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .patch('/api/v1/products/207/barcode')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ barcode: '8901112223334' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.barcode).toBe('8901112223334');
  });

  it('8. Removes barcode association when passing null or empty string to PATCH /api/v1/products/:id/barcode', async () => {
    const mockCleared = {
      id: 208,
      name: 'Item With Removed Barcode',
      buying_price: '200.00',
      hsn_code: null,
      barcode: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    };

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('UPDATE products') && sqlText.includes('SET barcode = $1')) {
        expect(params?.[0]).toBeNull();
        return { rows: [mockCleared], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .patch('/api/v1/products/208/barcode')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ barcode: null });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.barcode).toBeNull();
  });

  it('9. Rejects unauthenticated barcode lookup with HTTP 401', async () => {
    const res = await request(app).get('/api/v1/products/barcode/8901234567890');
    expect(res.status).toBe(401);
  });

  it('10. Rejects silent overwrite of existing product barcode without confirmReplaceBarcode (409)', async () => {
    const existingProduct = {
      id: 209,
      name: 'Existing Barcoded Cable',
      buying_price: '120.00',
      hsn_code: '8544',
      barcode: '8900000000111',
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
      if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
        return { rows: [existingProduct], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const resBarcode = await request(app)
      .patch('/api/v1/products/209/barcode')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ barcode: '8900000000222' });

    expect(resBarcode.status).toBe(409);
    expect(resBarcode.body.code).toBe('BARCODE_REPLACE_CONFIRMATION_REQUIRED');

    const resUpdate = await request(app)
      .patch('/api/v1/products/209')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ barcode: '8900000000222' });

    expect(resUpdate.status).toBe(409);
    expect(resUpdate.body.code).toBe('BARCODE_REPLACE_CONFIRMATION_REQUIRED');
  });

  it('11. Replaces existing product barcode when confirmReplaceBarcode is true', async () => {
    const existingProduct = {
      id: 210,
      name: 'Replaceable Barcoded Cable',
      buying_price: '150.00',
      hsn_code: '8544',
      barcode: '8900000000111',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
      image_object_key: null,
      image_content_type: null,
      image_size_bytes: null,
      image_updated_at: null,
    };

    const updatedProduct = {
      ...existingProduct,
      barcode: '8900000000222',
    };

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('FROM products') && sqlText.includes('WHERE id = $1')) {
        return { rows: [existingProduct], rowCount: 1 } as any;
      }
      if (sqlText.includes('UPDATE products') && sqlText.includes('SET barcode = $1')) {
        expect(params?.[0]).toBe('8900000000222');
        expect(params?.[1]).toBe(210);
        return { rows: [updatedProduct], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .patch('/api/v1/products/210/barcode')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ barcode: '8900000000222', confirmReplaceBarcode: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.barcode).toBe('8900000000222');
  });
});
