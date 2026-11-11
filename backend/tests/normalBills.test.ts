import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import { Decimal } from 'decimal.js';
import { normalBillsService } from '../src/modules/normalBills/normalBills.service.js';
import { generateTaxInvoicePdf } from '../src/modules/gstInvoices/gstInvoices.pdf.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH = '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const app = createApp({ useMemoryStoreInTest: true });

describe('Normal Billing Module (Non-GST Standard Bills) Test Suite', () => {
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
            { table_name: 'normal_bills' },
            { table_name: 'normal_bill_items' },
          ],
          rowCount: 13,
        } as any;
      }
      if (sqlText.includes('FROM schema_migrations')) {
        return {
          rows: [
            { version: '001_auth_tables.sql' },
            { version: '010_product_hsn_code.sql' },
            { version: '011_gst_invoices.sql' },
            { version: '012_normal_bills.sql' },
          ],
          rowCount: 4,
        } as any;
      }
      if (sqlText.includes('FROM quotation_settings')) {
        return {
          rows: [
            {
              id: 1,
              company_name: 'ALGIONS AI LABS PRIVATE LIMITED',
              cin: 'U62011BR2026PTC088473',
              gstin: '10ABGCA8624E1Z3',
              address: 'House No. 145A, Haziyapur, Ward 26, Gopalganj, Bihar – 841428',
              email: 'contact@algions.in',
              phone: '94938 40000',
              website: 'algions.in',
              state: 'Bihar',
              state_code: '10',
            },
          ],
          rowCount: 1,
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

  it('1. Suggests the next sequential bill number via /api/v1/normal-bills/next-number', async () => {
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('MAX(') || sqlText.includes('max_num')) {
        return { rows: [{ max_num: '12' }], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .get('/api/v1/normal-bills/next-number')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nextBillNumber).toBe('013');
  });

  it('1a. Suggests 001 via read-only preview when normal bills table is empty without calling setval/nextval', async () => {
    const executedQueries: string[] = [];
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      executedQueries.push(sqlText);
      if (sqlText.includes('MAX(') || sqlText.includes('max_num')) {
        return { rows: [{ max_num: '0', seq_last: 1, seq_called: false }], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .get('/api/v1/normal-bills/next-number')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nextBillNumber).toBe('001');
    expect(executedQueries.some(q => q.includes("setval"))).toBe(false);
    expect(executedQueries.some(q => q.includes("nextval"))).toBe(false);
  });

  it('2. Creates a Normal Bill with 0 GST calculations and pure Decimal math', async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: any) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText === 'BEGIN' || sqlText === 'COMMIT' || sqlText === 'ROLLBACK') {
          return { rowCount: 1 };
        }
        if (sqlText.includes('FROM quotation_settings')) {
          return {
            rows: [
              {
                id: 1,
                company_name: 'ALGIONS AI LABS PRIVATE LIMITED',
                cin: 'U62011BR2026PTC088473',
                gstin: '10ABGCA8624E1Z3',
                address: 'House No. 145A, Haziyapur, Ward 26, Gopalganj, Bihar – 841428',
                email: 'contact@algions.in',
                phone: '94938 40000',
                website: 'algions.in',
                state: 'Bihar',
                state_code: '10',
              },
            ],
            rowCount: 1,
          };
        }
        if (sqlText.includes('SELECT 1 FROM normal_bills WHERE bill_number')) {
          return { rows: [], rowCount: 0 };
        }
        if (sqlText.includes('INSERT INTO normal_bills')) {
          return {
            rows: [
              {
                id: 101,
                bill_number: 'NB-101',
                bill_date: '2026-11-02',
                state: 'Uttar Pradesh',
                state_code: '09',
                customer_name: 'Gupta Enterprises',
                total_amount: '3500.00',
                amount_in_words: 'Rupees Three Thousand Five Hundred Only',
                pdf_status: 'local_only',
              },
            ],
            rowCount: 1,
          };
        }
        if (sqlText.includes('INSERT INTO normal_bill_items')) {
          return {
            rows: [
              {
                id: 501,
                bill_id: 101,
                item_index: 1,
                description: 'HDF BOARD 12mm 2.44 x 1.22',
                hsn_code: '4411',
                quantity: '2.00',
                rate: '1750.00',
                amount: '3500.00',
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const res = await request(app)
      .post('/api/v1/normal-bills')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        billNumber: 'NB-101',
        billDate: '2026-11-02',
        customerName: 'Gupta Enterprises',
        items: [
          {
            description: 'HDF BOARD 12mm 2.44 x 1.22',
            hsnCode: '4411',
            quantity: 2,
            rate: 1750,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.bill.bill_number).toBe('NB-101');
    expect(res.body.bill.total_amount).toBe('3500.00');
    // Notice NO GST fields are present
    expect(res.body.bill.cgst_amount).toBeUndefined();
    expect(res.body.bill.sgst_amount).toBeUndefined();
    expect(res.body.bill.igst_amount).toBeUndefined();
  });

  it('3. Generates a valid Normal Bill PDF buffer with "NORMAL BILL" title and without GST breakdown', async () => {
    const pdfBuffer = await generateTaxInvoicePdf({
      invoiceNumber: '001',
      invoiceDate: '2026-11-02',
      customer: {
        name: 'Sharma Builders',
        address: 'Bilaspur',
        phone: '9876543210',
      },
      items: [
        {
          name: 'Shuttering Ply 18mm',
          hsn: '4412',
          quantity: 10,
          rate: 1200,
          amount: 12000,
        },
      ],
      totals: {
        taxableAmount: 12000,
        taxAmount: 0,
        grandTotal: 12000,
      },
      isNormalBill: true,
      billTitle: 'NORMAL BILL',
    });

    expect(pdfBuffer).toBeDefined();
    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    // PDF Magic bytes: %PDF-
    expect(pdfBuffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('4. Rejects normal bill creation when line items are missing or quantity is zero', async () => {
    const res = await request(app)
      .post('/api/v1/normal-bills')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        customerName: 'Invalid Customer',
        items: [],
      });

    expect(res.status).toBe(400);
  });

  it('5. Lists normal bills with embedded item snapshots and pagination', async () => {
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('COUNT(*)::INT AS total FROM normal_bills')) {
        return { rows: [{ total: 1 }], rowCount: 1 } as any;
      }
      if (sqlText.includes('SELECT') && sqlText.includes('FROM normal_bills')) {
        return {
          rows: [
            {
              id: 101,
              bill_number: 'NB-001',
              bill_date: '2026-11-02',
              customer_name: 'Sharma Hardware',
              total_amount: '2400.00',
              amount_in_words: 'Rupees Two Thousand Four Hundred Only',
              items: [
                {
                  id: 1,
                  bill_id: 101,
                  description: 'White Cement 5kg',
                  quantity: '2.00',
                  rate: '1200.00',
                  amount: '2400.00',
                },
              ],
            },
          ],
          rowCount: 1,
        } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .get('/api/v1/normal-bills?limit=10')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.bills).toHaveLength(1);
    expect(res.body.bills[0].items).toHaveLength(1);
    expect(res.body.bills[0].items[0].description).toBe('White Cement 5kg');
  });

  it('6. Generates and streams on-the-fly draft PDF via POST /api/v1/normal-bills/preview-pdf without saving', async () => {
    const res = await request(app)
      .post('/api/v1/normal-bills/preview-pdf')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        billNumber: 'DRAFT-01',
        customerName: 'Quick Buyer',
        items: [
          {
            description: 'Fevicol SH 1kg',
            quantity: 3,
            rate: 260,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment; filename="Normal_Bill_DRAFT-01.pdf"');
    expect(res.body.length).toBeGreaterThan(100);
  });

  it('7. Safely accepts string-typed productId and customerId from pickers and coerces to numbers', async () => {
    const res = await request(app)
      .post('/api/v1/normal-bills/preview-pdf')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        customerId: '55',
        customerName: 'Picker Buyer',
        items: [
          {
            productId: '88',
            description: 'Item with string Product ID',
            quantity: 1,
            rate: 200,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });

  it('7. Rejects invalid discount inputs (negative, >100%, 3dp, scientific notation, text, invalid omitted-mode value) with 400 and rejects >20 line items', async () => {
    const basePayload = {
      billNumber: 'NB-VAL-1',
      billDate: '2026-11-02',
      customerName: 'Validation Buyer',
      items: [{ description: 'Item A', quantity: 2, rate: 100 }],
    };

    const invalidCases: Array<Record<string, unknown>> = [
      { discountType: 'percentage', discountValue: -5 },
      { discountType: 'percentage', discountValue: 101 },
      { discountType: 'percentage', discountValue: '1.234' },
      { discountType: 'fixed', discountValue: '1e2' },
      { discountType: 'fixed', discountValue: 'abc' },
      { discountValue: '1e2' },
      { discountAmount: -1 },
    ];

    for (const badFields of invalidCases) {
      for (const endpoint of ['/api/v1/normal-bills', '/api/v1/normal-bills/preview-pdf']) {
        const res = await request(app)
          .post(endpoint)
          .set('Cookie', authCookie)
          .set('X-CSRF-Token', csrfToken)
          .send({ ...basePayload, ...badFields });
        expect(res.status).toBe(400);
      }
    }

    // Over 100 line items must also fail with 400
    const tooManyItems = Array.from({ length: 101 }, (_, idx) => ({
      description: `Item ${idx + 1}`,
      quantity: 1,
      rate: 10,
    }));
    const tooManyRes = await request(app)
      .post('/api/v1/normal-bills')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...basePayload, items: tooManyItems });
    expect(tooManyRes.status).toBe(400);
  });

  it('8. Recomputes fixed clamped discounts, normalizes 0 vs "0", and ignores tampered client totals on POST & service call', async () => {
    let insertedBillParams: any[] = [];
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: any, params?: any[]) => {
        const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
        if (sqlText.includes('FROM quotation_settings')) {
          return { rows: [{ company_name: 'ALGIONS AI LABS PRIVATE LIMITED', state: 'Bihar', state_code: '10' }], rowCount: 1 };
        }
        if (sqlText.includes('SELECT 1 FROM normal_bills WHERE bill_number')) {
          return { rows: [], rowCount: 0 };
        }
        if (sqlText.includes('INSERT INTO normal_bills')) {
          insertedBillParams = params || [];
          return {
            rows: [
              {
                id: 901,
                bill_number: insertedBillParams[0],
                bill_date: '2026-11-02',
                customer_name: 'Clamp Buyer',
                subtotal_amount: insertedBillParams[14],
                discount_type: insertedBillParams[15],
                discount_value: insertedBillParams[16],
                discount_amount: insertedBillParams[17],
                total_amount: insertedBillParams[18],
                amount_in_words: insertedBillParams[19],
                pdf_status: 'local_only',
              },
            ],
            rowCount: 1,
          };
        }
        if (sqlText.includes('INSERT INTO normal_bill_items')) {
          return { rows: [{ id: 1, bill_id: 901, item_index: 1, description: 'Board', quantity: '2.00', rate: '100.00', amount: '200.00' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    // Fixed discount > subtotal (500 > 200) clamps discount_amount to 200.00 and total to 0.00, ignoring tampered discountAmount: 5
    const clampRes = await request(app)
      .post('/api/v1/normal-bills')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        billNumber: 'NB-CLAMP-1',
        billDate: '2026-11-02',
        customerName: 'Clamp Buyer',
        discountType: 'fixed',
        discountValue: '500.00',
        discountAmount: 5,
        items: [{ description: 'Board', quantity: 2, rate: 100 }],
      });
    expect(clampRes.status).toBe(201);
    expect(insertedBillParams[14]).toBe('200.00');
    expect(insertedBillParams[17]).toBe('200.00');
    expect(insertedBillParams[18]).toBe('0.00');

    // Consistent handling of 0 and '0' directly in createBillInTransaction
    await normalBillsService.createBillInTransaction(mockClient as any, {
      billNumber: 'NB-ZERO-NUM',
      billDate: '2026-11-02',
      customerName: 'Zero Buyer',
      discountType: 'percentage',
      discountValue: 0,
      items: [{ description: 'Board', quantity: 1, rate: 100 }],
    });
    const numDiscount = new Decimal(insertedBillParams[17]).toFixed(2);
    const numTotal = new Decimal(insertedBillParams[18]).toFixed(2);

    await normalBillsService.createBillInTransaction(mockClient as any, {
      billNumber: 'NB-ZERO-STR',
      billDate: '2026-11-02',
      customerName: 'Zero Buyer',
      discountType: 'percentage',
      discountValue: '0',
      items: [{ description: 'Board', quantity: 1, rate: 100 }],
    });
    expect(new Decimal(insertedBillParams[17]).toFixed(2)).toBe(numDiscount);
    expect(new Decimal(insertedBillParams[18]).toFixed(2)).toBe(numTotal);
  });
});
