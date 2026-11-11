import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import { quotationsService } from '../src/modules/quotations/quotations.service.js';
import { generateQuotationPdf } from '../src/modules/quotations/quotations.pdf.js';
import { normalBillsService } from '../src/modules/normalBills/normalBills.service.js';
import { gstInvoicesService } from '../src/modules/gstInvoices/gstInvoices.service.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH = '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const app = createApp({ useMemoryStoreInTest: true });

describe('Professional Quotations Module Test Suite', () => {
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
          rows: [
            { version: '001_auth_tables.sql' },
            { version: '015_product_barcode.sql' },
            { version: '016_quotations.sql' },
            { version: '017_quotation_conversion_financial_fields.sql' },
            { version: '018_numbering_and_legacy_data_integrity.sql' },
          ],
          rowCount: 5,
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
              bank_name: 'State Bank of India',
              bank_account_number: '123456789012',
              bank_ifsc: 'SBIN0001234',
              bank_branch: 'Gopalganj Main',
              standard_validity_days: 30,
              standard_payment_terms: '100% advance',
              standard_delivery_terms: '2 weeks',
              standard_warranty_terms: '1 year warranty',
              standard_declaration: 'Computer generated quotation.',
              signatory_title: 'Director',
              updated_at: new Date().toISOString(),
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

  it('1. Suggests next sequential quotation number via /api/v1/quotations/next-number', async () => {
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('MAX(') || sqlText.includes('max_num')) {
        return { rows: [{ seq_last: 4, seq_called: true, max_num: '4' }], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const res = await request(app)
      .get('/api/v1/quotations/next-number')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.nextNumber).toBe('QT-005');
  });

  it('2. Pure Decimal.js financial calculation: Subtotal, Fixed Discount, Intra-State GST (CGST/SGST)', () => {
    const calc = quotationsService.calculateQuotationTotals(
      [
        { description: 'Item 1', quantity: 2, rate: '100.00' }, // 200.00
        { description: 'Item 2', quantity: '3.50', rate: '200.00' }, // 700.00
      ],
      'fixed',
      '100.00', // Discount 100 -> Taxable = 800.00
      true,     // GST enabled
      18,       // 18% GST -> 9% CGST (72.00) + 9% SGST (72.00)
      '10',     // Supplier: Bihar (10)
      '10'      // Customer: Bihar (10)
    );

    expect(calc.subtotal).toBe('900.00');
    expect(calc.discountAmount).toBe('100.00');
    expect(calc.taxableAmount).toBe('800.00');
    expect(calc.cgstAmount).toBe('72.00');
    expect(calc.sgstAmount).toBe('72.00');
    expect(calc.igstAmount).toBe('0.00');
    expect(calc.grandTotal).toBe('944.00');
    expect(calc.amountInWords).toContain('Nine Hundred Forty Four');
  });

  it('3. Pure Decimal.js financial calculation: Percentage Discount and Inter-State GST (IGST)', () => {
    const calc = quotationsService.calculateQuotationTotals(
      [
        { description: 'High Performance Server', quantity: 1, rate: '50000.00' },
      ],
      'percentage',
      10,   // 10% discount on 50,000 -> 5,000 -> Taxable = 45,000.00
      true, // GST enabled
      18,   // 18% IGST -> 8,100.00
      '10', // Supplier: Bihar (10)
      '07'  // Customer: Delhi (07)
    );

    expect(calc.subtotal).toBe('50000.00');
    expect(calc.discountAmount).toBe('5000.00');
    expect(calc.taxableAmount).toBe('45000.00');
    expect(calc.cgstAmount).toBe('0.00');
    expect(calc.sgstAmount).toBe('0.00');
    expect(calc.igstAmount).toBe('8100.00');
    expect(calc.taxAmount).toBe('8100.00');
    expect(calc.grandTotal).toBe('53100.00');
    expect(calc.amountInWords).toContain('Fifty Three Thousand One Hundred');
  });

  it('4. Financial calculation with GST disabled: Tax amount is 0 and Grand Total equals Taxable Amount', () => {
    const calc = quotationsService.calculateQuotationTotals(
      [
        { description: 'Commercial Software Consultation', quantity: 10, rate: '1500.00' }, // 15,000.00
      ],
      null,
      0,
      false, // GST disabled
      0,
      '10',
      '10'
    );

    expect(calc.subtotal).toBe('15000.00');
    expect(calc.discountAmount).toBe('0.00');
    expect(calc.taxableAmount).toBe('15000.00');
    expect(calc.taxAmount).toBe('0.00');
    expect(calc.grandTotal).toBe('15000.00');
  });

  it('5. Generates a valid multi-page professional PDF buffer with dynamic branding', async () => {
    const pdfBuffer = await generateQuotationPdf({
      quotationNumber: 'QT-001',
      quotationDate: '2026-11-10',
      validUntil: '2026-12-10',
      company: {
        companyName: 'ALGIONS AI LABS PRIVATE LIMITED',
        cin: 'U62011BR2026PTC088473',
        gstin: '10ABGCA8624E1Z3',
        address: 'House No. 145A, Haziyapur, Ward 26, Gopalganj, Bihar – 841428',
        phone: '94938 40000',
        email: 'contact@algions.in',
        website: 'algions.in',
        bankName: 'State Bank of India',
        bankAccountNumber: '123456789012',
        bankIfsc: 'SBIN0001234',
        signatoryTitle: 'Managing Director',
      },
      customer: {
        name: 'Tech Enterprises Pvt Ltd',
        address: 'Sector 62, Noida, Uttar Pradesh',
        phone: '9876543210',
        gstin: '09AAACT1234A1ZZ',
      },
      projectTitle: 'AI Infrastructure Implementation',
      subject: 'Supply of Edge AI Hardware and Model Deployment',
      items: Array.from({ length: 25 }, (_, i) => ({
        itemIndex: i,
        description: `Industrial AI Compute Node Model-${i + 1}`,
        hsnCode: '8471.50.00',
        barcode: `89012345678${i % 10}`,
        quantity: 2,
        unit: 'units',
        rate: '75000.00',
        amount: '150000.00',
      })),
      totals: {
        subtotal: '3750000.00',
        discountType: 'percentage',
        discountValue: '5.00',
        discountAmount: '187500.00',
        taxableAmount: '3562500.00',
        gstEnabled: true,
        gstRate: '18.00',
        igstAmount: '641250.00',
        taxAmount: '641250.00',
        grandTotal: '4203750.00',
      },
      amountInWords: 'Rupees Forty Two Lakh Three Thousand Seven Hundred Fifty Only',
      termsAndConditions: 'Payment: 50% advance, 50% on milestone.\nDelivery: 3 weeks.\nWarranty: 3 years comprehensive.',
    });

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    // PDF Magic Header %PDF-
    expect(pdfBuffer.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('6. POST /api/v1/quotations/preview-pdf streams PDF buffer without saving to database', async () => {
    const res = await request(app)
      .post('/api/v1/quotations/preview-pdf')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        customerName: 'Preview Customer Ltd',
        items: [
          {
            description: 'Preview Line Item 1',
            quantity: 5,
            rate: '120.00',
          },
        ],
        gstEnabled: false,
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body).toBeDefined();
  });

  it('7. Rejects quotation creation with empty items array with 400', async () => {
    const res = await request(app)
      .post('/api/v1/quotations')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        customerName: 'No Items Customer',
        items: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('8. Rejects conversion of quotation when status is draft without force=true', async () => {
    const mockQuotation = {
      id: 501,
      quotation_number: 'QT-501',
      status: 'draft',
      customer_name: 'Pending Customer',
      valid_until: '2099-12-31',
      converted_normal_bill_id: null,
      converted_gst_invoice_id: null,
    };

    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM quotation_settings')) {
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
        if (sql.includes('SELECT * FROM quotations WHERE id = $1 FOR UPDATE')) {
          return { rows: [mockQuotation], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const res = await request(app)
      .post('/api/v1/quotations/501/convert-to-bill')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ billType: 'normal', force: false });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('QUOTATION_NOT_ACCEPTED');
  });

  it('9. Rejects double conversion with 409 when already converted', async () => {
    const mockQuotation = {
      id: 502,
      quotation_number: 'QT-502',
      status: 'converted',
      converted_normal_bill_id: 12,
      converted_gst_invoice_id: null,
    };

    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM quotation_settings')) {
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
        if (sql.includes('SELECT * FROM quotations WHERE id = $1 FOR UPDATE')) {
          return { rows: [mockQuotation], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const res = await request(app)
      .post('/api/v1/quotations/502/convert-to-bill')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ billType: 'normal' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_CONVERTED');
  });

  it('10. Rejects unauthenticated request to /api/v1/quotations with 401', async () => {
    const res = await request(app).get('/api/v1/quotations');
    expect(res.status).toBe(401);
  });

  it('11. Rejects conversion of expired quotation without force=true', async () => {
    const mockQuotation = {
      id: 503,
      quotation_number: 'QT-503',
      status: 'accepted',
      valid_until: '2020-01-01', // Expired
      customer_name: 'Expired Quote Customer',
      converted_normal_bill_id: null,
      converted_gst_invoice_id: null,
    };

    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM quotation_settings')) {
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
        if (sql.includes('SELECT * FROM quotations WHERE id = $1 FOR UPDATE')) {
          return { rows: [mockQuotation], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const res = await request(app)
      .post('/api/v1/quotations/503/convert-to-bill')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ billType: 'normal', force: false });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXPIRED_QUOTATION');
  });

  it('12. Rejects conversion of non-GST quotation to GST invoice without explicit gstRateOverride', async () => {
    const mockQuotation = {
      id: 504,
      quotation_number: 'QT-504',
      status: 'accepted',
      valid_until: '2099-12-31',
      gst_enabled: false,
      customer_name: 'Non GST Customer',
      converted_normal_bill_id: null,
      converted_gst_invoice_id: null,
    };

    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM quotation_settings')) {
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
        if (sql.includes('SELECT * FROM quotations WHERE id = $1 FOR UPDATE')) {
          return { rows: [mockQuotation], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM quotation_items')) {
          return { rows: [{ id: 1, quotation_id: 504, description: 'Service', quantity: '1', rate: '100.00', amount: '100.00' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const res = await request(app)
      .post('/api/v1/quotations/504/convert-to-bill')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ billType: 'gst' }); // No gstRateOverride

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GST_RATE_REQUIRED');
  });

  it('13. Atomic updateQuotationStatus prevents altering status of an already converted quotation', async () => {
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any[]) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('UPDATE quotations') && sqlText.includes("status <> 'converted'")) {
        return { rows: [], rowCount: 0 } as any; // No rows updated because already converted
      }
      if (sqlText.includes('SELECT * FROM quotations WHERE id = $1')) {
        return {
          rows: [{ id: 505, status: 'converted', quotation_number: 'QT-505' }],
          rowCount: 1,
        } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    vi.spyOn(appPool, 'connect').mockImplementation(async () => ({
      query: (sql: any, params?: any) => (appPool.query as any)(sql, params),
      release: () => {},
    }) as any);

    await expect(quotationsService.updateQuotationStatus(505, 'accepted')).rejects.toThrow(
      'Cannot alter the status of an already converted quotation.'
    );
  });

  it('14. Converted normal bill preserves exact discounts and passes single transaction client', async () => {
    const mockQuotation = {
      id: 506,
      quotation_number: 'QT-506',
      status: 'accepted',
      valid_until: '2099-12-31',
      customer_name: 'Discount Client',
      customer_address: 'Patna, Bihar',
      customer_phone: '9876543210',
      customer_state: 'Bihar',
      customer_state_code: '10',
      subtotal: '1000.00',
      discount_type: 'percentage',
      discount_value: '10.00',
      discount_amount: '100.00',
      grand_total: '900.00',
      converted_normal_bill_id: null,
      converted_gst_invoice_id: null,
    };

    const mockItems = [
      {
        id: 1,
        quotation_id: 506,
        description: 'Design Package',
        quantity: '1.00',
        unit: 'set',
        rate: '1000.00',
        rate_unit: 'set',
        amount: '1000.00',
      },
    ];

    let queryCalls: string[] = [];
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
        queryCalls.push(sql);
        if (sql.includes('FROM quotation_settings')) {
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
        if (sql.includes('SELECT * FROM quotations WHERE id = $1 FOR UPDATE')) {
          return { rows: [mockQuotation], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM quotation_items')) {
          return { rows: mockItems, rowCount: 1 };
        }
        if (sql.includes('UPDATE quotations') && sql.includes('converted_normal_bill_id')) {
          return { rows: [{ ...mockQuotation, status: 'converted', converted_normal_bill_id: 888 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);
    const createBillSpy = vi.spyOn(normalBillsService, 'createBillInTransaction').mockResolvedValue({
      id: 888,
      bill_number: '088',
      total_amount: '900.00',
      subtotal_amount: '1000.00',
      discount_type: 'percentage',
      discount_value: '10.00',
      discount_amount: '100.00',
    } as any);

    const result = await quotationsService.convertToBill(506, { billType: 'normal' });

    expect(result.billId).toBe(888);
    expect(result.billNumber).toBe('088');
    expect(createBillSpy).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({
        subtotalAmount: '1000.00',
        discountType: 'percentage',
        discountValue: '10.00',
        discountAmount: '100.00',
      })
    );
    expect(queryCalls).toContain('BEGIN');
    expect(queryCalls).toContain('COMMIT');
  });
});
