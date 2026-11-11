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
    ).toBe(true);
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
});
