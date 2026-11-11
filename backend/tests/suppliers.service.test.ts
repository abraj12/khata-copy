import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import {
  aggregateSupplierDashboardKPIs,
  buildSupplierStatementLedger,
  computePurchaseBillTotals,
  computeSupplierAccountSummary,
} from '../src/modules/suppliers/suppliers.accounting.js';
import {
  allocateAdvanceSchema,
  createPurchaseBillSchema,
  createSupplierPaymentSchema,
  createSupplierSchema,
  normalizeOptionalEmail,
  normalizeSupplierInvoiceNumber,
  normalizeSupplierName,
  normalizeSupplierPhone,
  extractAndValidateIdempotencyKey,
  normalizeTransactionReference,
  listSupplierPaymentsQuerySchema,
  reversePaymentAllocationSchema,
  reversePaymentSchema,
  supplierDashboardQuerySchema,
  supplierStatementQuerySchema,
} from '../src/modules/suppliers/suppliers.validation.js';
import { suppliersService, SupplierStatementResponse } from '../src/modules/suppliers/suppliers.service.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const app = createApp({ useMemoryStoreInTest: true });

describe('Suppliers Accounting, Validation, Security & API Test Suite', () => {
  let authCookie = '';
  let csrfToken = '';

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('information_schema.tables')) {
        return { rows: [], rowCount: 0 } as any;
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

  it('1. Computes purchase bill line totals, discount, taxable amount, GST, and grand total with exact HALF_UP precision', () => {
    const res = computePurchaseBillTotals(
      [
        { quantity: '2.50', purchaseRate: '300.00' }, // 750.00
        { quantity: '3', purchaseRate: '100.25' }, // 300.75
      ],
      '50.75',
      '18'
    );

    expect(res.items[0].lineTotal).toBe('750.00');
    expect(res.items[1].lineTotal).toBe('300.75');
    expect(res.subtotalAmount).toBe('1050.75');
    expect(res.discountAmount).toBe('50.75');
    expect(res.taxableAmount).toBe('1000.00');
    expect(res.gstRate).toBe('18.00');
    expect(res.gstAmount).toBe('180.00');
    expect(res.grandTotal).toBe('1180.00');
  });

  it('2. Computes unified supplier payable, advance credit, and unallocated payment balances accurately', () => {
    const payableCase = computeSupplierAccountSummary({
      totalPurchases: '2500.50',
      totalPayments: '1000.00',
      allocatedPayments: '800.00',
    });
    expect(payableCase).toEqual({
      totalPurchases: '2500.50',
      totalPayments: '1000.00',
      allocatedPayments: '800.00',
      unallocatedPayments: '200.00',
      outstandingPayable: '1500.50',
      advanceBalance: '0.00',
      netBalance: '1500.50',
    });

    const advanceCase = computeSupplierAccountSummary({
      totalPurchases: '1200.00',
      totalPayments: '1500.00',
      allocatedPayments: '1200.00',
    });
    expect(advanceCase).toEqual({
      totalPurchases: '1200.00',
      totalPayments: '1500.00',
      allocatedPayments: '1200.00',
      unallocatedPayments: '300.00',
      outstandingPayable: '0.00',
      advanceBalance: '300.00',
      netBalance: '-300.00',
    });
  });

  it('3. Builds statement ledger with 0.00 opening balance when no prior transactions exist and sorts chronologically', () => {
    const noPrior = buildSupplierStatementLedger(0, 0, [
      {
        entryType: 'payment',
        entryDate: '2026-04-05',
        sortOrder: 1,
        id: 2,
        referenceNumber: 'SUP-PAY-001',
        description: 'Payment',
        amount: '400.00',
      },
      {
        entryType: 'purchase_bill',
        entryDate: '2026-04-05',
        sortOrder: 0,
        id: 1,
        referenceNumber: 'INV-01',
        description: 'Purchase Bill',
        amount: '1000.00',
      },
    ]);

    expect(noPrior.openingBalance).toBe('0.00');
    expect(noPrior.entries[0].entryType).toBe('purchase_bill');
    expect(noPrior.entries[0].debitAmount).toBe('1000.00');
    expect(noPrior.entries[0].runningBalance).toBe('1000.00');
    expect(noPrior.entries[1].entryType).toBe('payment');
    expect(noPrior.entries[1].creditAmount).toBe('400.00');
    expect(noPrior.entries[1].runningBalance).toBe('600.00');
    expect(noPrior.closingBalance).toBe('600.00');

    const withPrior = buildSupplierStatementLedger('1500.00', '500.00', []);
    expect(withPrior.openingBalance).toBe('1000.00');
    expect(withPrior.closingBalance).toBe('1000.00');
  });

  it('4. Aggregates Supplier Dashboard KPIs identically to individual supplier summaries', () => {
    const s1 = {
      archivedAt: null,
      ...computeSupplierAccountSummary({
        totalPurchases: '5000.00',
        totalPayments: '3200.00',
        allocatedPayments: '3000.00',
      }),
    };
    const s2 = {
      archivedAt: '2026-03-01T00:00:00.000Z',
      ...computeSupplierAccountSummary({
        totalPurchases: '1000.00',
        totalPayments: '1250.00',
        allocatedPayments: '1000.00',
      }),
    };

    const kpis = aggregateSupplierDashboardKPIs([s1, s2]);
    expect(kpis).toEqual({
      totalSuppliers: 2,
      activeSuppliers: 1,
      totalPurchases: '6000.00',
      totalPaymentsMade: '4450.00',
      totalOutstandingPayable: '1800.00',
      suppliersWithBalanceCount: 1,
      totalAdvanceCredit: '250.00',
      totalUnallocatedPayments: '450.00',
    });
  });

  it('5. Enforces Zod validation defaults (updateProductBuyingPrice defaults false) and normalizers', () => {
    expect(normalizeSupplierName('  Shree   Traders  Co. ')).toBe('shree traders co.');
    expect(normalizeSupplierInvoiceNumber('  inv-001/a ')).toBe('INV-001/A');
    expect(normalizeSupplierPhone('09876543210')).toBe('+919876543210');
    expect(normalizeSupplierPhone('+91 98765-43210')).toBe('+919876543210');
    expect(normalizeSupplierPhone(null)).toBeNull();
    expect(() => normalizeSupplierPhone('12345')).toThrow();
    expect(normalizeOptionalEmail('  Orders@Supplier.IN ')).toBe('orders@supplier.in');

    const validBill = createPurchaseBillSchema.parse({
      supplierId: '11111111-1111-4111-8111-111111111111',
      invoiceNumber: 'PUR-100',
      invoiceDate: '2026-04-10',
      dueDate: '2026-04-25',
      items: [
        {
          productId: 12,
          description: 'Copper Cable',
          quantity: '2.25',
          purchaseRate: '450.00',
        },
      ],
    });
    expect(validBill.items[0].updateProductBuyingPrice).toBe(false);

    const invalidDateBill = createPurchaseBillSchema.safeParse({
      supplierId: '11111111-1111-4111-8111-111111111111',
      invoiceNumber: 'PUR-100',
      invoiceDate: '2026-04-10',
      dueDate: '2026-04-01',
      items: [{ description: 'Item', quantity: '1', purchaseRate: '100' }],
    });
    expect(invalidDateBill.success).toBe(false);

    const invalidPrecisionQty = createPurchaseBillSchema.safeParse({
      supplierId: '11111111-1111-4111-8111-111111111111',
      invoiceNumber: 'PUR-101',
      items: [{ description: 'Item', quantity: '1.234', purchaseRate: '100' }],
    });
    expect(invalidPrecisionQty.success).toBe(false);

    expect(createSupplierSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(allocateAdvanceSchema.safeParse({ allocations: [] }).success).toBe(false);
    expect(
      createSupplierPaymentSchema.safeParse({
        supplierId: '11111111-1111-4111-8111-111111111111',
        amount: '500.00',
        paymentMethod: 'upi',
      }).success
    ).toBe(false);
    expect(
      supplierStatementQuerySchema.safeParse({
        fromDate: '2026-05-01',
        toDate: '2026-04-01',
      }).success
    ).toBe(false);
  });

  it('6. Neutralizes CSV formula cells and prints Opening Balance only when date filter starts mid-history', () => {
    const mockStatement: SupplierStatementResponse = {
      supplier: {
        id: '11111111-1111-4111-8111-111111111111',
        name: '=CMD("evil")',
        contactPerson: null,
        phone: null,
        email: null,
        address: null,
        state: null,
        stateCode: null,
        gstin: null,
        notes: null,
        archivedAt: null,
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
        lastActivity: null,
        purchaseBillCount: 1,
        paymentCount: 0,
        totalPurchases: '500.00',
        totalPayments: '0.00',
        allocatedPayments: '0.00',
        unallocatedPayments: '0.00',
        outstandingPayable: '500.00',
        advanceBalance: '0.00',
        netBalance: '500.00',
      },
      filters: { fromDate: '2026-04-01', toDate: '2026-04-30' },
      openingBalance: '0.00',
      periodPurchases: '500.00',
      periodPayments: '0.00',
      periodReversals: '0.00',
      periodCancellations: '0.00',
      closingBalance: '500.00',
      entries: [
        {
          entryType: 'purchase_bill',
          entryDate: '2026-04-02',
          sortOrder: 0,
          id: 10,
          referenceNumber: '+BILL-1',
          description: '@Purchase',
          amount: '500.00',
          billStatus: 'unpaid',
          debitAmount: '500.00',
          creditAmount: '0.00',
          runningBalance: '500.00',
        },
      ],
    };

    const csv = suppliersService.formatStatementCsv(mockStatement);
    expect(csv).toContain('"\'=CMD(""evil"")"');
    expect(csv).toContain('"\'+BILL-1"');
    expect(csv).toContain('"\'@Purchase"');
    expect(csv).toContain('"Opening Balance"');
    expect(csv).toContain('"0.00","0.00","0.00"');
  });

  it('7. Requires authenticated owner session on all supplier API endpoints (HTTP 401)', async () => {
    const paths: Array<{ method: 'get' | 'post'; url: string }> = [
      { method: 'get', url: '/api/v1/suppliers/dashboard' },
      { method: 'get', url: '/api/v1/suppliers' },
      { method: 'post', url: '/api/v1/suppliers' },
      { method: 'post', url: '/api/v1/suppliers/purchase-bills' },
      { method: 'post', url: '/api/v1/suppliers/payments' },
      { method: 'get', url: '/api/v1/suppliers/11111111-1111-4111-8111-111111111111/statement' },
    ];

    for (const entry of paths) {
      const res = await request(app)[entry.method](entry.url);
      expect(res.status).toBe(401);
    }
  });

  it('8. Rejects invalid UUIDs, invalid supplier phone/GSTIN-state mismatches, and blocks deletion when history exists', async () => {
    const badIdRes = await request(app)
      .get('/api/v1/suppliers/not-a-uuid')
      .set('Cookie', authCookie);
    expect(badIdRes.status).toBe(400);
    expect(badIdRes.body.code).toBe('VALIDATION_ERROR');

    const badPhoneRes = await request(app)
      .post('/api/v1/suppliers')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Test Supplier', phone: '123' });
    expect(badPhoneRes.status).toBe(400);

    const badGstinStateRes = await request(app)
      .post('/api/v1/suppliers')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        name: 'Bihar Traders',
        state: 'Bihar',
        gstin: '27ABCDE1234F1Z5',
      });
    expect(badGstinStateRes.status).toBe(400);

    const mockClient = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT id FROM suppliers')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 };
        }
        if (sql.includes('FROM supplier_purchase_bills')) {
          return { rows: [{ bills: '2', payments: '0' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValueOnce(mockClient as any);

    const deleteRes = await request(app)
      .delete('/api/v1/suppliers/11111111-1111-4111-8111-111111111111')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken);

    expect(deleteRes.status).toBe(409);
    expect(deleteRes.body.code).toBe('SUPPLIER_HAS_FINANCIAL_HISTORY');
  });

  it('9. Builds statement ledger with payment reversals & priorReversals and formats CSV reversal rows cleanly', () => {
    const ledger = buildSupplierStatementLedger(
      '1500.00',
      '1000.00',
      [
        {
          entryType: 'purchase_bill',
          entryDate: '2026-04-02',
          sortOrder: 0,
          id: 1,
          referenceNumber: 'BILL-01',
          description: 'Purchase Bill BILL-01',
          amount: '500.00',
          billStatus: 'unpaid',
        },
        {
          entryType: 'payment',
          entryDate: '2026-04-05',
          sortOrder: 1,
          id: 2,
          referenceNumber: 'SUP-PAY-0002',
          description: 'UPI Payment',
          amount: '300.00',
          paymentMethod: 'upi',
          paymentStatus: 'reversed',
        },
        {
          entryType: 'payment_reversal',
          entryDate: '2026-04-05',
          sortOrder: 2,
          id: 2,
          referenceNumber: 'REV-SUP-PAY-0002',
          description: 'Payment Reversal of SUP-PAY-0002',
          amount: '300.00',
          paymentMethod: 'upi',
          paymentStatus: 'reversed',
          reversalReason: 'UPI bounced',
          originalPaymentReceipt: 'SUP-PAY-0002',
        },
      ],
      '400.00'
    );

    // Opening = 1500 - 1000 + 400 = 900.00
    expect(ledger.openingBalance).toBe('900.00');
    expect(ledger.periodPurchases).toBe('500.00');
    expect(ledger.periodPayments).toBe('300.00');
    expect(ledger.periodReversals).toBe('300.00');
    expect(ledger.closingBalance).toBe('1400.00');
    expect(ledger.entries.map((e) => e.entryType)).toEqual([
      'purchase_bill',
      'payment',
      'payment_reversal',
    ]);
    expect(ledger.entries[2].debitAmount).toBe('300.00');
    expect(ledger.entries[2].creditAmount).toBe('0.00');
    expect(ledger.entries[2].runningBalance).toBe('1400.00');

    const csv = suppliersService.formatStatementCsv({
      supplier: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Shree Traders',
        contactPerson: null,
        phone: null,
        email: null,
        address: null,
        state: null,
        stateCode: null,
        gstin: null,
        notes: null,
        archivedAt: null,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        billCount: 1,
        paymentCount: 0,
        totalPurchases: '2000.00',
        totalPayments: '600.00',
        allocatedPayments: '0.00',
        unallocatedPayments: '600.00',
        outstandingPayable: '1400.00',
        advanceBalance: '0.00',
        netBalance: '1400.00',
      },
      filters: { fromDate: '2026-04-01', toDate: '2026-04-30' },
      ...ledger,
    });
    expect(csv).toContain('"Payment Reversal"');
    expect(csv).toContain('"REV-SUP-PAY-0002"');
  });

  it('10. Validates reversal schemas, transaction reference normalizer, and Idempotency-Key extraction', () => {
    expect(reversePaymentSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(reversePaymentSchema.safeParse({ reason: 'Bounced cheque' }).success).toBe(true);
    expect(reversePaymentAllocationSchema.safeParse({ amount: '0', reason: 'Fix' }).success).toBe(false);
    expect(reversePaymentAllocationSchema.safeParse({ amount: '250.50', reason: 'Split' }).success).toBe(true);

    expect(normalizeTransactionReference('  UTR-12345  ')).toBe('UTR-12345');
    expect(normalizeTransactionReference('   ')).toBeNull();
    expect(normalizeTransactionReference(null)).toBeNull();

    expect(() => extractAndValidateIdempotencyKey(undefined, true)).toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED', status: 400 })
    );
    expect(() => extractAndValidateIdempotencyKey('bad key!', true)).toThrowError(
      expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY', status: 400 })
    );
    expect(() => extractAndValidateIdempotencyKey(['k1', 'k2'], true)).toThrowError(
      expect.objectContaining({ code: 'INVALID_IDEMPOTENCY_KEY', status: 400 })
    );
    expect(extractAndValidateIdempotencyKey('  sup_pay:2026-04-10.1  ', true)).toBe('sup_pay:2026-04-10.1');
  });

  it('11. Enforces auth (401), Idempotency-Key (400), and validation rules across payment & reversal endpoints', async () => {
    const unauthRoutes = [
      '/api/v1/suppliers/payments/1/allocate',
      '/api/v1/suppliers/payments/1/reverse',
      '/api/v1/suppliers/payments/1/allocations/2/reverse',
    ];
    for (const url of unauthRoutes) {
      const res = await request(app).post(url).send({});
      expect(res.status).toBe(401);
    }

    const missingKeyPay = await request(app)
      .post('/api/v1/suppliers/payments')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({
        supplierId: '11111111-1111-4111-8111-111111111111',
        amount: '100.00',
        paymentMethod: 'cash',
      });
    expect(missingKeyPay.status).toBe(400);
    expect(missingKeyPay.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const badKeyAlloc = await request(app)
      .post('/api/v1/suppliers/payments/1/allocate')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', 'short')
      .send({ allocations: [{ purchaseBillId: 1, amount: '50.00' }] });
    expect(badKeyAlloc.status).toBe(400);
    expect(badKeyAlloc.body.code).toBe('INVALID_IDEMPOTENCY_KEY');

    const missingKeyReverse = await request(app)
      .post('/api/v1/suppliers/payments/1/reverse')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .send({ reason: 'Wrong amount' });
    expect(missingKeyReverse.status).toBe(400);
    expect(missingKeyReverse.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const badBodyReverse = await request(app)
      .post('/api/v1/suppliers/payments/1/reverse')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', 'valid-key-rev-0001')
      .send({ reason: '   ' });
    expect(badBodyReverse.status).toBe(400);
    expect(badBodyReverse.body.code).toBe('VALIDATION_ERROR');

    const badBodyAllocRev = await request(app)
      .post('/api/v1/suppliers/payments/1/allocations/2/reverse')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', 'valid-key-arev-0001')
      .send({ amount: '0', reason: 'Fix' });
    expect(badBodyAllocRev.status).toBe(400);
    expect(badBodyAllocRev.body.code).toBe('VALIDATION_ERROR');
  });

  it('12. Returns 409 SUPPLIER_PAYMENT_REFERENCE_DUPLICATE and PAYMENT_ALREADY_REVERSED on conflicted requests', async () => {
    const dupRefClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM suppliers WHERE id = $1')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111', archived_at: null }], rowCount: 1 };
        }
        if (sql.includes('FROM supplier_payments') && sql.includes('LOWER(BTRIM(transaction_reference))')) {
          return { rows: [{ id: 55, receipt_number: 'SUP-PAY-0005' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValueOnce(dupRefClient as any);

    const dupRes = await request(app)
      .post('/api/v1/suppliers/payments')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', 'dup-ref-check-0001')
      .send({
        supplierId: '11111111-1111-4111-8111-111111111111',
        amount: '500.00',
        paymentMethod: 'upi',
        transactionReference: 'UTR-999111',
      });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.code).toBe('SUPPLIER_PAYMENT_REFERENCE_DUPLICATE');

    const alreadyReversedClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM supplier_payments') && sql.includes('FOR UPDATE')) {
          return {
            rows: [
              {
                id: 55,
                receipt_number: 'SUP-PAY-0005',
                supplier_id: '11111111-1111-4111-8111-111111111111',
                amount: '500.00',
                status: 'reversed',
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValueOnce(alreadyReversedClient as any);

    const revRes = await request(app)
      .post('/api/v1/suppliers/payments/55/reverse')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', 'rev-twice-check-0001')
      .send({ reason: 'Duplicate check' });
    expect(revRes.status).toBe(409);
    expect(revRes.body.code).toBe('PAYMENT_ALREADY_REVERSED');
  });

  it('13. Enforces mandatory digital/cheque references while keeping cash & other optional', async () => {
    for (const method of ['upi', 'bank_transfer', 'cheque'] as const) {
      const missingRes = createSupplierPaymentSchema.safeParse({
        supplierId: '11111111-1111-4111-8111-111111111111',
        amount: '250.00',
        paymentMethod: method,
        transactionReference: '   ',
      });
      expect(missingRes.success).toBe(false);
      if (!missingRes.success) {
        expect(missingRes.error.issues.some((i) => i.path.includes('transactionReference'))).toBe(true);
      }

      const validRes = createSupplierPaymentSchema.safeParse({
        supplierId: '11111111-1111-4111-8111-111111111111',
        amount: '250.00',
        paymentMethod: method,
        transactionReference: 'REF-1001',
      });
      expect(validRes.success).toBe(true);
    }

    for (const method of ['cash', 'other'] as const) {
      expect(
        createSupplierPaymentSchema.safeParse({
          supplierId: '11111111-1111-4111-8111-111111111111',
          amount: '250.00',
          paymentMethod: method,
        }).success
      ).toBe(true);
    }

    // Service-layer enforcement (defense-in-depth)
    const missingRefClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM suppliers WHERE id = $1')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111', archived_at: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValueOnce(missingRefClient as any);
    await expect(
      suppliersService.createSupplierPayment({
        supplierId: '11111111-1111-4111-8111-111111111111',
        amount: '250.00',
        paymentMethod: 'bank_transfer',
        transactionReference: '   ',
      })
    ).rejects.toMatchObject({ status: 400, code: 'TRANSACTION_REFERENCE_REQUIRED' });

    // HTTP endpoint validation rejection
    const httpMissingRef = await request(app)
      .post('/api/v1/suppliers/payments')
      .set('Cookie', authCookie)
      .set('x-csrf-token', csrfToken)
      .set('Idempotency-Key', 'ref-req-http-check-01')
      .send({
        supplierId: '11111111-1111-4111-8111-111111111111',
        amount: '250.00',
        paymentMethod: 'cheque',
      });
    expect(httpMissingRef.status).toBe(400);
    expect(httpMissingRef.body.code).toBe('VALIDATION_ERROR');
  });

  it('14. Enforces archived supplier rules on edit, payment advances, partial allocation & post-archival bills', async () => {
    const editArchivedClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM supplier_purchase_bills spb')) {
          return {
            rows: [
              {
                id: 90,
                supplier_id: '11111111-1111-4111-8111-111111111111',
                status: 'finalized',
                supplier_archived_at: '2026-04-15T10:00:00.000Z',
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValueOnce(editArchivedClient as any);
    await expect(
      suppliersService.updatePurchaseBill(90, {
        invoiceNumber: 'INV-90',
        invoiceDate: '2026-04-10',
        items: [{ description: 'Item', quantity: '1', purchaseRate: '100.00' }],
      })
    ).rejects.toMatchObject({ status: 409, code: 'SUPPLIER_ARCHIVED' });

    const archivedAdvClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM suppliers WHERE id = $1')) {
          return {
            rows: [{ id: '11111111-1111-4111-8111-111111111111', archived_at: '2026-04-15T10:00:00.000Z' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValueOnce(archivedAdvClient as any);
    await expect(
      suppliersService.createSupplierPayment({
        supplierId: '11111111-1111-4111-8111-111111111111',
        amount: '500.00',
        paymentMethod: 'cash',
        allocations: [],
      })
    ).rejects.toMatchObject({ status: 409, code: 'ARCHIVED_SUPPLIER_ADVANCE_BLOCKED' });

    const archivedPartialClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM suppliers WHERE id = $1')) {
          return {
            rows: [{ id: '11111111-1111-4111-8111-111111111111', archived_at: '2026-04-15T10:00:00.000Z' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValueOnce(archivedPartialClient as any);
    await expect(
      suppliersService.createSupplierPayment({
        supplierId: '11111111-1111-4111-8111-111111111111',
        amount: '500.00',
        paymentMethod: 'cash',
        allocations: [{ purchaseBillId: 90, amount: '300.00' }],
      })
    ).rejects.toMatchObject({ status: 409, code: 'ARCHIVED_SUPPLIER_PARTIAL_ALLOCATION' });

    const billAfterArchiveClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM supplier_payments sp')) {
          return {
            rows: [
              {
                id: 55,
                receipt_number: 'SUP-PAY-0055',
                supplier_id: '11111111-1111-4111-8111-111111111111',
                amount: '500.00',
                status: 'active',
                supplier_archived_at: '2026-04-15T10:00:00.000Z',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('AS allocated_amount') && sql.includes('FROM supplier_payment_allocations')) {
          return { rows: [{ allocated_amount: '0.00' }], rowCount: 1 };
        }
        if (sql.includes('FROM supplier_purchase_bills spb') && sql.includes('FOR UPDATE OF spb, s')) {
          return {
            rows: [
              {
                id: 91,
                supplier_id: '11111111-1111-4111-8111-111111111111',
                invoice_number: 'POST-ARC-91',
                grand_total: '500.00',
                status: 'finalized',
                bill_created_at: '2026-04-16T09:00:00.000Z',
                supplier_archived_at: '2026-04-15T10:00:00.000Z',
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValueOnce(billAfterArchiveClient as any);
    await expect(
      suppliersService.allocateAdvancePayment(55, [{ purchaseBillId: 91, amount: '500.00' }])
    ).rejects.toMatchObject({ status: 409, code: 'ARCHIVED_SUPPLIER_BILL_AFTER_ARCHIVE' });
  });

  it('15. Accounts for purchase_bill_cancellation in statement ledger, ordering & CSV export', () => {
    const stmt = buildSupplierStatementLedger(
      '1000.00', // priorPurchases
      '300.00',  // priorPayments
      [
        {
          entryType: 'purchase_bill_cancellation',
          entryDate: '2026-04-10',
          sortOrder: 3,
          id: 4,
          referenceNumber: 'INV-10',
          description: 'Bill Cancellation (INV-10) — Wrong invoice',
          amount: '200.00',
          cancellationReason: 'Wrong invoice',
          originalBillInvoiceNumber: 'INV-10',
        },
        {
          entryType: 'payment_reversal',
          entryDate: '2026-04-10',
          sortOrder: 2,
          id: 3,
          referenceNumber: 'REV-SUP-PAY-0001',
          description: 'Reversal of SUP-PAY-0001',
          amount: '150.00',
        },
        {
          entryType: 'purchase_bill',
          entryDate: '2026-04-10',
          sortOrder: 0,
          id: 1,
          referenceNumber: 'INV-10',
          description: 'Purchase Bill INV-10 [Cancelled later]',
          amount: '200.00',
          billStatus: 'cancelled',
        },
        {
          entryType: 'payment',
          entryDate: '2026-04-10',
          sortOrder: 1,
          id: 2,
          referenceNumber: 'SUP-PAY-0002',
          description: 'Payment SUP-PAY-0002 (CASH)',
          amount: '400.00',
          paymentMethod: 'cash',
          paymentStatus: 'active',
        },
      ],
      '50.00',  // priorReversals
      '250.00'  // priorCancellations -> opening = 1000 - 300 + 50 - 250 = 500.00
    );

    expect(stmt.openingBalance).toBe('500.00');
    expect(stmt.entries.map((e) => e.entryType)).toEqual([
      'purchase_bill',
      'payment',
      'payment_reversal',
      'purchase_bill_cancellation',
    ]);
    expect(stmt.entries.map((e) => e.runningBalance)).toEqual([
      '700.00', // 500 + 200
      '300.00', // 700 - 400
      '450.00', // 300 + 150
      '250.00', // 450 - 200
    ]);
    expect(stmt.periodPurchases).toBe('200.00');
    expect(stmt.periodPayments).toBe('400.00');
    expect(stmt.periodReversals).toBe('150.00');
    expect(stmt.periodCancellations).toBe('200.00');
    expect(stmt.closingBalance).toBe('250.00');

    const csv = suppliersService.formatStatementCsv({
      supplier: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Shree Traders',
        contactPerson: null,
        phone: null,
        email: null,
        address: null,
        state: null,
        stateCode: null,
        gstin: null,
        notes: null,
        archivedAt: null,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        lastActivity: '2026-04-10',
        purchaseBillCount: 1,
        paymentCount: 1,
        totalPurchases: '1000.00',
        totalPayments: '750.00',
        allocatedPayments: '0.00',
        unallocatedPayments: '750.00',
        outstandingPayable: '250.00',
        advanceBalance: '0.00',
        netBalance: '250.00',
      },
      filters: { fromDate: '2026-04-10', toDate: '2026-04-30' },
      ...stmt,
    });
    expect(csv).toContain('"Purchase Bill Cancellation"');
    expect(csv).toContain('"350.00","600.00","250.00"');
  });

  it('16. Validates dashboard date range & payment search queries over HTTP API', async () => {
    expect(
      supplierDashboardQuerySchema.safeParse({ fromDate: '2026-05-01', toDate: '2026-04-01' }).success
    ).toBe(false);
    expect(
      supplierDashboardQuerySchema.safeParse({ fromDate: '2026-04-01', toDate: '2026-04-30' }).success
    ).toBe(true);
    const parsedSearch = listSupplierPaymentsQuerySchema.safeParse({ search: '  UTR-42  ' });
    expect(parsedSearch.success).toBe(true);
    if (parsedSearch.success) {
      expect(parsedSearch.data.search).toBe('UTR-42');
    }

    const dashSpy = vi.spyOn(suppliersService, 'getDashboard').mockResolvedValueOnce({
      summary: {
        totalSuppliers: 3,
        activeSuppliers: 2,
        totalPurchases: '5000.00',
        totalPaymentsMade: '2000.00',
        totalPaymentsReversed: '0.00',
        totalOutstandingPayable: '3000.00',
        totalAdvanceCredit: '0.00',
        totalUnallocatedPayments: '500.00',
        paymentMethodTotals: [
          { paymentMethod: 'cash', amount: '500.00', count: 1 },
          { paymentMethod: 'upi', amount: '1500.00', count: 1 },
          { paymentMethod: 'bank_transfer', amount: '0.00', count: 0 },
          { paymentMethod: 'cheque', amount: '0.00', count: 0 },
          { paymentMethod: 'other', amount: '0.00', count: 0 },
        ],
      },
      recentPayments: [],
      recentPaymentsTotal: 0,
    });

    const dashHttp = await request(app)
      .get('/api/v1/suppliers/dashboard?fromDate=2026-04-01&toDate=2026-04-30')
      .set('Cookie', authCookie);
    expect(dashHttp.status).toBe(200);
    expect(dashSpy).toHaveBeenCalledWith({ fromDate: '2026-04-01', toDate: '2026-04-30' });
    expect(dashHttp.body.data.summary.totalPurchases).toBe('5000.00');

    const paySpy = vi.spyOn(suppliersService, 'listSupplierPayments').mockResolvedValueOnce({
      payments: [],
      total: 0,
      pagination: { limit: 50, offset: 0, hasMore: false, nextOffset: null },
    });
    const payHttp = await request(app)
      .get('/api/v1/suppliers/payments?search=UTR-42')
      .set('Cookie', authCookie);
    expect(payHttp.status).toBe(200);
    expect(paySpy).toHaveBeenCalledWith(expect.objectContaining({ search: 'UTR-42' }));
  });
});
