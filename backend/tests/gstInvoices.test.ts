import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import { numberToIndianWords, formatDateToIndian, generateMannatInvoicePdf } from '../src/modules/gstInvoices/gstInvoices.pdf.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH = '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const app = createApp({ useMemoryStoreInTest: true });

describe('GST Billing Module (Mannat Hardware Store) Test Suite', () => {
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
          ],
          rowCount: 12,
        } as any;
      }
      if (sqlText.includes('FROM schema_migrations')) {
        return {
          rows: [
            { version: '001_auth_tables.sql' },
            { version: '010_product_hsn_code.sql' },
            {
            version: '011_gst_invoices.sql',
          },
          {
            version: '012_normal_bills.sql',
          },
          ],
          rowCount: 3,
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

  it('1. Formats Indian numbering system currency to words and dates strictly as DD-MM-YYYY', () => {
    expect(numberToIndianWords(9581.60)).toBe('Rupees Nine Thousand Five Hundred Eighty One and Sixty Paise Only');
    expect(numberToIndianWords(100000)).toBe('Rupees One Lakh Only');
    expect(numberToIndianWords(10500000.50)).toBe('Rupees One Crore Five Lakh and Fifty Paise Only');
    expect(numberToIndianWords(0)).toBe('Rupees Zero Only');

    // Date formatting tests: never timezone, always DD-MM-YYYY
    expect(formatDateToIndian('2026-11-02')).toBe('02-11-2026');
    expect(formatDateToIndian('2026-11-02T00:00:00.000Z')).toBe('02-11-2026');
    expect(formatDateToIndian(new Date(2026, 10, 2))).toBe('02-11-2026');
    expect(formatDateToIndian('Mon Nov 02 2026 05:30:00 GMT+0530 (India Standard Time)')).toBe('02-11-2026');
    expect(formatDateToIndian(null)).toBe('');
  });

  it('2. Suggests the next sequential invoice number via /api/v1/gst-invoices/next-number', async () => {
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('MAX(') || sqlText.includes('max_num')) {
        return { rows: [{ max_num: '3' }], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .get('/api/v1/gst-invoices/next-number')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nextInvoiceNumber).toBe('004');
  });

  it('2a. Suggests 001 and self-heals sequence when invoice table is empty (e.g. bills were deleted)', async () => {
    const executedQueries: string[] = [];
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      executedQueries.push(sqlText);
      if (sqlText.includes('MAX(') || sqlText.includes('max_num')) {
        return { rows: [{ max_num: '0', next_num: 3 }], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .get('/api/v1/gst-invoices/next-number')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nextInvoiceNumber).toBe('001');
    expect(executedQueries.some(q => q.includes("setval('gst_invoice_number_seq', 1, false)"))).toBe(true);
  });

  it('3. Creates an Intra-State GST Invoice (UP to UP) with CGST and SGST correctly calculated', async () => {
    const mockCreatedInvoice = {
      id: 1,
      invoice_number: '001',
      invoice_date: '2026-11-02',
      state: 'Uttar Pradesh',
      state_code: '09',
      transportation_mode: 'Road',
      vehicle_number: 'UP-22-AB-1234',
      date_of_supply: '2026-11-02',
      place_of_supply: 'Uttar Pradesh',
      customer_id: null,
      customer_name: 'Sharma Construction Co.',
      customer_address: 'Station Road, Bilaspur, Rampur',
      customer_gstin: '09AABCS1429B1ZB',
      customer_state: 'Uttar Pradesh',
      customer_state_code: '09',
      taxable_amount: '8120.00',
      cgst_rate: '9.00',
      cgst_amount: '730.80',
      sgst_rate: '9.00',
      sgst_amount: '730.80',
      igst_rate: '0.00',
      igst_amount: '0.00',
      tax_amount: '1461.60',
      grand_total: '9581.60',
      amount_in_words: 'Rupees Nine Thousand Five Hundred Eighty One and Sixty Paise Only',
      pdf_status: 'local_only',
      r2_object_key: null,
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const mockItem = {
      id: 10,
      invoice_id: 1,
      product_id: 101,
      item_index: 1,
      description: 'HDF BOARD 12mm HDF (OSB) 2.44 x 1.22',
      hsn_code: '44119219',
      quantity: '14.00',
      unit: 'pcs',
      rate: '580.00',
      rate_unit: 'sqm',
      amount: '8120.00',
      created_at: new Date().toISOString(),
    };

    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT 1 FROM gst_invoices WHERE invoice_number')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO gst_invoices')) {
          return { rows: [mockCreatedInvoice], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO gst_invoice_items')) {
          return { rows: [mockItem], rowCount: 1 };
        }
        if (sql.includes('UPDATE gst_invoices SET')) {
          return { rows: [mockCreatedInvoice], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const res = await request(app)
      .post('/api/v1/gst-invoices')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        invoiceNumber: '001',
        invoiceDate: '2026-11-02',
        state: 'Uttar Pradesh',
        stateCode: '09',
        customerName: 'Sharma Construction Co.',
        customerAddress: 'Station Road, Bilaspur, Rampur',
        customerGstin: '09AABCS1429B1ZB',
        customerState: 'Uttar Pradesh',
        customerStateCode: '09',
        gstRate: 18,
        items: [
          {
            productId: 101,
            description: 'HDF BOARD 12mm HDF (OSB) 2.44 x 1.22',
            hsnCode: '44119219',
            quantity: 14,
            unit: 'pcs',
            rate: 580,
            rateUnit: 'sqm',
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.taxable_amount).toBe('8120.00');
    expect(res.body.data.cgst_amount).toBe('730.80');
    expect(res.body.data.sgst_amount).toBe('730.80');
    expect(res.body.data.grand_total).toBe('9581.60');
    expect(res.body.data.items).toHaveLength(1);
  });

  it('4. Creates an Inter-State GST Invoice (UP to Delhi/07) with IGST and zero CGST/SGST', async () => {
    const mockCreatedInvoice = {
      id: 2,
      invoice_number: '002',
      invoice_date: '2026-11-02',
      state: 'Uttar Pradesh',
      state_code: '09',
      customer_name: 'Delhi Traders LLP',
      customer_state: 'Delhi',
      customer_state_code: '07',
      taxable_amount: '1000.00',
      cgst_rate: '0.00',
      cgst_amount: '0.00',
      sgst_rate: '0.00',
      sgst_amount: '0.00',
      igst_rate: '18.00',
      igst_amount: '180.00',
      tax_amount: '180.00',
      grand_total: '1180.00',
      amount_in_words: 'Rupees One Thousand One Hundred Eighty Only',
      pdf_status: 'local_only',
      r2_object_key: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const mockItem = {
      id: 11,
      invoice_id: 2,
      product_id: null,
      item_index: 1,
      description: 'Brass Fitting 1 inch',
      hsn_code: '8481',
      quantity: '10.00',
      rate: '100.00',
      amount: '1000.00',
      created_at: new Date().toISOString(),
    };

    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT 1 FROM gst_invoices WHERE invoice_number')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO gst_invoices')) {
          return { rows: [mockCreatedInvoice], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO gst_invoice_items')) {
          return { rows: [mockItem], rowCount: 1 };
        }
        if (sql.includes('UPDATE gst_invoices SET')) {
          return { rows: [mockCreatedInvoice], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const res = await request(app)
      .post('/api/v1/gst-invoices')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        invoiceNumber: '002',
        customerName: 'Delhi Traders LLP',
        customerState: 'Delhi',
        customerStateCode: '07',
        gstRate: 18,
        items: [
          {
            description: 'Brass Fitting 1 inch',
            hsnCode: '8481',
            quantity: 10,
            rate: 100,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.igst_amount).toBe('180.00');
    expect(res.body.data.cgst_amount).toBe('0.00');
    expect(res.body.data.sgst_amount).toBe('0.00');
    expect(res.body.data.grand_total).toBe('1180.00');
  });

  it('5. Rejects invoice creation with empty items list', async () => {
    const res = await request(app)
      .post('/api/v1/gst-invoices')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        customerName: 'Test Customer',
        gstRate: 18,
        items: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toContain('At least one item is required');
  });

  it('6. Rejects invoice creation with negative or zero quantity', async () => {
    const res = await request(app)
      .post('/api/v1/gst-invoices')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        customerName: 'Test Customer',
        gstRate: 18,
        items: [
          {
            description: 'Item 1',
            quantity: 0,
            rate: 100,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('7. Rejects duplicate invoice numbers with 409 Conflict', async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT 1 FROM gst_invoices WHERE invoice_number')) {
          return { rows: [{ '?column?': 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const res = await request(app)
      .post('/api/v1/gst-invoices')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        invoiceNumber: '001',
        customerName: 'Duplicate Test',
        gstRate: 18,
        items: [{ description: 'Item A', quantity: 1, rate: 50 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_INVOICE_NUMBER');
  });

  it('8. Generates valid PDF buffer matching the Mannat invoice layout', async () => {
    const sample = {
      invoiceNumber: '004',
      invoiceDate: '2026-11-02',
      customer: {
        name: 'Sharma Construction Co.',
        address: 'Bilaspur',
        state: 'Uttar Pradesh',
        stateCode: '09',
      },
      items: [
        {
          name: 'HDF BOARD 12mm HDF (OSB) 2.44 x 1.22',
          hsn: '44119219',
          quantity: 14,
          unit: 'pcs',
          rate: 580,
          amount: 8120,
        },
      ],
      totals: {
        taxableAmount: 8120,
        cgstRate: 9,
        cgstAmount: 730.80,
        sgstRate: 9,
        sgstAmount: 730.80,
        taxAmount: 1461.60,
        grandTotal: 9581.60,
      },
    };

    const pdfBuffer = await generateMannatInvoicePdf(sample);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    // Standard PDF header signature
    expect(pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    // Verifies that the authorized signature image is embedded in the PDF
    expect(pdfBuffer.toString('latin1')).toContain('/Image');
  });

  it('9. Lists invoices with pagination and search', async () => {
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('COUNT(*)')) {
        return { rows: [{ total: 1 }], rowCount: 1 } as any;
      }
      if (sqlText.includes('FROM gst_invoices') && !sqlText.includes('COUNT(*)')) {
        return {
          rows: [
            {
              id: 1,
              invoice_number: '001',
              invoice_date: '2026-11-02',
              customer_name: 'Sharma Construction',
              grand_total: '9581.60',
              pdf_status: 'local_only',
              items: [
                {
                  id: 1,
                  invoice_id: 1,
                  description: 'HDF BOARD 12mm',
                  hsn_code: '44119219',
                  quantity: '14.00',
                  rate: '580.00',
                  amount: '8120.00',
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
      .get('/api/v1/gst-invoices?search=Sharma')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].items).toHaveLength(1);
    expect(res.body.invoices[0].items[0].description).toBe('HDF BOARD 12mm');
    expect(res.body.pagination.total).toBe(1);
  });

  it('10. Streams invoice PDF via GET /api/v1/gst-invoices/:id/pdf', async () => {
    const mockInvoice = {
      id: 1,
      invoice_number: '001',
      invoice_date: '2026-11-02',
      state: 'Uttar Pradesh',
      state_code: '09',
      customer_name: 'Sharma Construction Co.',
      customer_address: 'Bilaspur',
      taxable_amount: '8120.00',
      cgst_rate: '9.00',
      cgst_amount: '730.80',
      sgst_rate: '9.00',
      sgst_amount: '730.80',
      igst_rate: '0.00',
      igst_amount: '0.00',
      tax_amount: '1461.60',
      grand_total: '9581.60',
      amount_in_words: 'Rupees Nine Thousand Five Hundred Eighty One and Sixty Paise Only',
      r2_object_key: null,
      pdf_status: 'local_only',
    };

    const mockItems = [
      {
        id: 10,
        invoice_id: 1,
        description: 'HDF BOARD 12mm',
        hsn_code: '44119219',
        quantity: '14.00',
        unit: 'pcs',
        rate: '580.00',
        amount: '8120.00',
      },
    ];

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('FROM gst_invoices WHERE id = $1')) {
        return { rows: [mockInvoice], rowCount: 1 } as any;
      }
      if (sqlText.includes('FROM gst_invoice_items WHERE invoice_id = $1')) {
        return { rows: mockItems, rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .get('/api/v1/gst-invoices/1/pdf')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('Invoice_001.pdf');
    expect(res.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('11. Generates and streams on-the-fly draft PDF via POST /api/v1/gst-invoices/preview-pdf without saving', async () => {
    const res = await request(app)
      .post('/api/v1/gst-invoices/preview-pdf')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        invoiceNumber: 'DRAFT-099',
        customerName: 'Mobile User Preview',
        gstRate: 18,
        items: [
          {
            description: 'Sample Fitting Screws',
            hsnCode: '7318',
            quantity: 2,
            rate: 150,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('Invoice_DRAFT-099.pdf');
    expect(res.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('12. Renders multi-line long item descriptions and 20 items cleanly in PDF without overlap or error', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      name: `Premium Heavy Duty Stainless Steel Flange Pipe Fitting Joint # ${i + 1}`,
      hsn: '7307',
      quantity: 1,
      unit: 'pcs',
      rate: 150,
      amount: 150,
    }));

    const pdfBuffer = await generateMannatInvoicePdf({
      invoiceNumber: '020',
      invoiceDate: '2026-11-02',
      customer: {
        name: 'Mannat Customer With Long Multi-line Address',
        address: 'Plot No. 45, Industrial Area Phase II, Near Subhash Chowk, Bilaspur, Rampur, UP',
        gstin: '09ABCDE1234F1Z5',
        state: 'Uttar Pradesh',
        stateCode: '09',
      },
      items,
      totals: {
        taxableAmount: 3000,
        cgstRate: 9,
        cgstAmount: 270,
        sgstRate: 9,
        sgstAmount: 270,
        taxAmount: 540,
        grandTotal: 3540,
      },
    });

    expect(pdfBuffer).toBeDefined();
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    expect(pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('13. Rejects invalid calendar dates (e.g. 2026-02-31) with HTTP 400 Bad Request', async () => {
    const res = await request(app)
      .post('/api/v1/gst-invoices')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        customerName: 'Invalid Date Customer',
        invoiceDate: '2026-02-31',
        gstRate: 18,
        items: [
          {
            description: 'Item A',
            quantity: 1,
            rate: 100,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('14. Safely accepts string-typed productId and customerId from pickers and coerces to numbers', async () => {
    const res = await request(app)
      .post('/api/v1/gst-invoices/preview-pdf')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        customerId: '42',
        customerName: 'Picker Customer',
        gstRate: 18,
        items: [
          {
            productId: '99',
            description: 'Item with string Product ID',
            quantity: 2,
            rate: 150,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});
