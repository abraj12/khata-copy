// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SupplierStatement } from '../src/features/suppliers/SupplierStatement.js';
import * as suppliersApi from '../src/features/suppliers/suppliersApi.js';

vi.mock('../src/features/suppliers/suppliersApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/suppliers/suppliersApi.js')>(
    '../src/features/suppliers/suppliersApi.js'
  );
  return {
    ...actual,
    listAllSuppliersApi: vi.fn(),
    fetchSupplierStatementApi: vi.fn(),
    downloadSupplierStatementCsvApi: vi.fn(),
  };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import {
  applyCatalogProductToDraftLine,
  DraftLineBase,
  ProductCatalogReference,
  upsertScannedProductLine,
  validateSellingRateInput,
} from '../src/utils/lineItemDraft.js';
import {
  computeAutoFifoBillAllocations,
  computeDraftPurchaseBillTotals,
  createSupplierIdempotencyKey,
  fetchAllPages,
  formatAbsRupees,
  getSupplierPaymentReferenceFieldMeta,
  isValidIdempotencyKeyFormat,
  validateSupplierPaymentFormInput,
} from '../src/features/suppliers/suppliersApi.js';
import { resolveDashboardDateRange } from '../src/features/suppliers/SupplierDashboard.js';
import { DEFAULT_SUPPLIER_SECTION_TAB } from '../src/features/suppliers/SuppliersModuleView.js';
import type { SupplierStatementData } from '../src/features/suppliers/suppliers.types.js';

interface TestBillingLine extends DraftLineBase {
  localId: string;
}

const createEmptyLine = (): TestBillingLine => ({
  localId: 'line-new',
  productId: null,
  description: '',
  hsnCode: '',
  barcode: '',
  quantity: '1',
  rate: '',
  buyingPriceReference: null,
});

describe('Supplier Management & Billing Barcode Frontend Unit Tests', () => {
  it('1. Scanned product fills blank placeholder row, preserves leading zeros, and never leaks buying_price into rate', () => {
    const product: ProductCatalogReference = {
      id: 42,
      name: 'LED Panel 18W',
      buying_price: '215.00',
      hsn_code: '9405',
      barcode: '0089012345001',
    };

    const result = upsertScannedProductLine([createEmptyLine()], product, createEmptyLine);

    expect(result.error).toBeNull();
    expect(result.action).toBe('filled_empty');
    expect(result.targetIndex).toBe(0);
    expect(result.nextLines).toHaveLength(1);
    expect(result.nextLines[0].productId).toBe(42);
    expect(result.nextLines[0].barcode).toBe('0089012345001');
    expect(result.nextLines[0].quantity).toBe('1');
    expect(result.nextLines[0].rate).toBe('');
    expect(result.nextLines[0].buyingPriceReference).toBe('215.00');
    expect(validateSellingRateInput(result.nextLines[0].rate, 'Selling rate')).toBeTruthy();
  });

  it('2. Repeated barcode scan increments existing line quantity by +1 without overwriting seller custom rate', () => {
    const product: ProductCatalogReference = {
      id: 42,
      name: 'LED Panel 18W',
      buying_price: '215.00',
      barcode: '0089012345001',
    };

    const existingLines: TestBillingLine[] = [
      {
        localId: 'line-1',
        productId: 42,
        description: 'LED Panel 18W',
        hsnCode: '9405',
        barcode: '0089012345001',
        quantity: '2',
        rate: '390.00',
        buyingPriceReference: '215.00',
      },
    ];

    const result = upsertScannedProductLine(existingLines, product, createEmptyLine);

    expect(result.error).toBeNull();
    expect(result.action).toBe('incremented');
    expect(result.targetIndex).toBe(0);
    expect(result.nextLines[0].quantity).toBe('3');
    expect(result.nextLines[0].rate).toBe('390.00');
  });

  it('3. Appends a new line when draft already holds other items and blocks incrementing above 1,000,000', () => {
    const productA: ProductCatalogReference = {
      id: 1,
      name: 'Switch Socket',
      buying_price: '45.00',
      barcode: '890111',
    };
    const productB: ProductCatalogReference = {
      id: 2,
      name: 'MCB 16A',
      buying_price: '120.00',
      barcode: '890222',
    };

    const initial: TestBillingLine[] = [
      { ...applyCatalogProductToDraftLine(createEmptyLine(), productA), rate: '90.00' },
    ];

    const appended = upsertScannedProductLine(initial, productB, createEmptyLine);
    expect(appended.action).toBe('added');
    expect(appended.nextLines).toHaveLength(2);
    expect(appended.nextLines[1].productId).toBe(2);
    expect(appended.nextLines[1].rate).toBe('');

    const maxed = upsertScannedProductLine(
      [{ ...initial[0], quantity: '1000000' }],
      productA,
      createEmptyLine
    );
    expect(maxed.error).toContain('cannot exceed 1,000,000');
    expect(maxed.nextLines[0].quantity).toBe('1000000');
  });

  it('4. Computes draft purchase bill totals identically to backend Decimal.js calculations', () => {
    const draft = computeDraftPurchaseBillTotals(
      [
        { quantity: '2.50', purchaseRate: '300.00' },
        { quantity: '3', purchaseRate: '100.25' },
      ],
      '50.75',
      '18'
    );

    expect(draft).toEqual({
      lineTotals: ['750.00', '300.75'],
      subtotalAmount: '1050.75',
      discountAmount: '50.75',
      taxableAmount: '1000.00',
      gstAmount: '180.00',
      grandTotal: '1180.00',
    });
  });

  it('5. Auto-allocates supplier payment chronologically (FIFO by oldest invoice date, then bill ID)', () => {
    const allocations = computeAutoFifoBillAllocations('1500.00', [
      { id: 30, invoiceDate: '2026-04-12', remainingAmount: '900.00' },
      { id: 10, invoiceDate: '2026-04-02', remainingAmount: '700.00' },
      { id: 20, invoiceDate: '2026-04-02', remainingAmount: '1000.00' },
    ]);

    expect(allocations).toEqual({
      10: '700.00',
      20: '800.00',
    });
  });

  it('6. Formats absolute rupee values safely without minus-sign comma corruption', () => {
    expect(formatAbsRupees('-1250')).toBe('₹1,250.00');
    expect(formatAbsRupees('0')).toBe('₹0.00');
    expect(formatAbsRupees('254321.5')).toBe('₹2,54,321.50');
  });

  it('7. Generates compliant Idempotency-Key tokens and rejects malformed keys', () => {
    const k1 = createSupplierIdempotencyKey('sup-pay');
    const k2 = createSupplierIdempotencyKey('sup-pay');
    expect(k1).not.toBe(k2);
    expect(k1.startsWith('sup-pay_')).toBe(true);
    expect(isValidIdempotencyKeyFormat(k1)).toBe(true);

    expect(isValidIdempotencyKeyFormat('abc')).toBe(false);
    expect(isValidIdempotencyKeyFormat('bad key with spaces')).toBe(false);
    expect(isValidIdempotencyKeyFormat('a'.repeat(129))).toBe(false);
    expect(isValidIdempotencyKeyFormat('sup_rev:2026-04-10.1')).toBe(true);
  });

  it('8. Fetches all pages via fetchAllPages across >200 records without truncation', async () => {
    const totalRecords = Array.from({ length: 450 }, (_, idx) => ({ id: idx + 1 }));
    const loadPage = vi.fn(async (offset: number, limit: number) => {
      const items = totalRecords.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      const hasMore = nextOffset < totalRecords.length;
      return {
        items,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
      };
    });

    const collected = await fetchAllPages(loadPage, 200);

    expect(loadPage).toHaveBeenCalledTimes(3);
    expect(loadPage).toHaveBeenNthCalledWith(1, 0, 200);
    expect(loadPage).toHaveBeenNthCalledWith(2, 200, 200);
    expect(loadPage).toHaveBeenNthCalledWith(3, 400, 200);
    expect(collected).toHaveLength(450);
    expect(collected[0]).toEqual({ id: 1 });
    expect(collected[449]).toEqual({ id: 450 });
  });

  it('9. Enforces required labels & inline validation for UPI, Bank Transfer & Cheque references while leaving Cash/Other optional', () => {
    expect(getSupplierPaymentReferenceFieldMeta('upi')).toMatchObject({
      required: true,
      label: 'UPI Transaction ID',
    });
    expect(getSupplierPaymentReferenceFieldMeta('bank_transfer')).toMatchObject({
      required: true,
      label: 'UTR / Bank Reference',
    });
    expect(getSupplierPaymentReferenceFieldMeta('cheque')).toMatchObject({
      required: true,
      label: 'Cheque Number',
    });
    expect(getSupplierPaymentReferenceFieldMeta('cash').required).toBe(false);
    expect(getSupplierPaymentReferenceFieldMeta('other').required).toBe(false);

    for (const method of ['upi', 'bank_transfer', 'cheque'] as const) {
      const missing = validateSupplierPaymentFormInput({
        supplierArchivedAt: null,
        amount: '500.00',
        paymentMethod: method,
        transactionReference: '  ',
        allocatedAmountTotal: '0.00',
        allocationCount: 0,
      });
      expect(missing.referenceError).not.toBeNull();
    }

    const validCash = validateSupplierPaymentFormInput({
      supplierArchivedAt: null,
      amount: '500.00',
      paymentMethod: 'cash',
      transactionReference: '',
      allocatedAmountTotal: '0.00',
      allocationCount: 0,
    });
    expect(validCash.referenceError).toBeNull();
    expect(validCash.allocationError).toBeNull();
  });

  it('10. Restricts archived suppliers to full historical bill settlement without creating advances', () => {
    const emptyAlloc = validateSupplierPaymentFormInput({
      supplierArchivedAt: '2026-04-15T10:00:00.000Z',
      amount: '600.00',
      paymentMethod: 'cash',
      allocatedAmountTotal: '0.00',
      allocationCount: 0,
    });
    expect(emptyAlloc.allocationError).toContain('unallocated advances');

    const partialAlloc = validateSupplierPaymentFormInput({
      supplierArchivedAt: '2026-04-15T10:00:00.000Z',
      amount: '600.00',
      paymentMethod: 'cash',
      allocatedAmountTotal: '400.00',
      allocationCount: 1,
    });
    expect(partialAlloc.allocationError).toContain('exact full amount');

    const exactSettlement = validateSupplierPaymentFormInput({
      supplierArchivedAt: '2026-04-15T10:00:00.000Z',
      amount: '600.00',
      paymentMethod: 'upi',
      transactionReference: 'UPI-ARC-99',
      allocatedAmountTotal: '600.00',
      allocationCount: 2,
    });
    expect(exactSettlement.referenceError).toBeNull();
    expect(exactSettlement.allocationError).toBeNull();
  });

  it('11. Defaults supplier module tab to All Suppliers, resolves dashboard date presets, and models bill cancellations in statements', () => {
    expect(DEFAULT_SUPPLIER_SECTION_TAB).toBe('all-suppliers');

    expect(resolveDashboardDateRange('all_time', '', '', '2026-04-18')).toEqual({});
    expect(resolveDashboardDateRange('today', '', '', '2026-04-18')).toEqual({
      fromDate: '2026-04-18',
      toDate: '2026-04-18',
    });
    expect(resolveDashboardDateRange('this_month', '', '', '2026-04-18')).toEqual({
      fromDate: '2026-04-01',
      toDate: '2026-04-18',
    });
    expect(
      resolveDashboardDateRange('custom', ' 2026-04-05 ', ' 2026-04-12 ', '2026-04-18')
    ).toEqual({
      fromDate: '2026-04-05',
      toDate: '2026-04-12',
    });

    const sampleStatement: Pick<SupplierStatementData, 'periodCancellations' | 'entries'> = {
      periodCancellations: '1200.00',
      entries: [
        {
          entryType: 'purchase_bill_cancellation',
          entryDate: '2026-04-18',
          sortOrder: 3,
          id: 9,
          referenceNumber: 'INV-009',
          description: 'Bill Cancellation (INV-009)',
          amount: '1200.00',
          debitAmount: '0.00',
          creditAmount: '1200.00',
          runningBalance: '0.00',
        },
      ],
    };
    expect(sampleStatement.entries[0].entryType).toBe('purchase_bill_cancellation');
    expect(sampleStatement.periodCancellations).toBe('1200.00');
  });
});

describe('Release #023: SupplierStatement Race Safety & Export Guards (React DOM)', () => {
  let container: HTMLDivElement;
  let root: Root;

  const makeSupplier = (id: string, name: string) => ({
    id,
    name,
    contactPerson: null,
    phone: '9876543210',
    email: null,
    address: null,
    state: 'Bihar',
    stateCode: '10',
    gstin: null,
    notes: null,
    archivedAt: null,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    totalPurchases: '1000.00',
    totalPayments: '200.00',
    allocatedPayments: '200.00',
    unallocatedPayments: '0.00',
    outstandingPayable: '800.00',
    advanceBalance: '0.00',
    netBalance: '800.00',
    purchaseBillCount: 1,
    paymentCount: 1,
    lastPurchaseDate: '2026-04-02',
  });

  const makeStatement = (id: string, name: string, fromDate: string | null = null, toDate: string | null = null): SupplierStatementData => ({
    supplier: makeSupplier(id, name),
    filters: { fromDate, toDate },
    openingBalance: '0.00',
    periodPurchases: '1000.00',
    periodPayments: '200.00',
    periodReversals: '0.00',
    periodCancellations: '0.00',
    closingBalance: '800.00',
    entries: [
      {
        entryType: 'purchase_bill',
        entryDate: '2026-04-02',
        id: 1,
        referenceNumber: `BILL-${id}`,
        description: `Purchase for ${name}`,
        debitAmount: '1000.00',
        creditAmount: '0.00',
        runningBalance: '1000.00',
      },
    ],
  });

  const setInputValue = (el: HTMLInputElement | HTMLSelectElement, val: string) => {
    const proto =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, val);
    if (el instanceof HTMLSelectElement) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    (suppliersApi.listAllSuppliersApi as any).mockResolvedValue([
      makeSupplier('sup-a', 'Alpha Hardware'),
      makeSupplier('sup-b', 'Beta Plywood'),
    ]);
    (suppliersApi.downloadSupplierStatementCsvApi as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('clears old statement on supplier switch and discards slow overlapping responses', async () => {
    let resolveSupA!: (v: SupplierStatementData) => void;
    let resolveSupB!: (v: SupplierStatementData) => void;

    (suppliersApi.fetchSupplierStatementApi as any).mockImplementation((supplierId: string) => {
      if (supplierId === 'sup-a') {
        return new Promise<SupplierStatementData>((r) => {
          resolveSupA = r;
        });
      }
      return new Promise<SupplierStatementData>((r) => {
        resolveSupB = r;
      });
    });

    await act(async () => {
      root.render(React.createElement(SupplierStatement));
    });

    const select = container.querySelector('select')!;
    // Select Supplier A (request A stays pending)
    await act(async () => {
      setInputValue(select, 'sup-a');
    });
    expect(container.textContent).toContain('Generating statement...');

    // Switch immediately to Supplier B before A resolves -> old statement stays cleared
    await act(async () => {
      setInputValue(select, 'sup-b');
    });

    // Resolve Supplier B first (fast response)
    await act(async () => {
      resolveSupB(makeStatement('sup-b', 'Beta Plywood'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Beta Plywood');
    expect(container.textContent).toContain('BILL-sup-b');

    // Slow Supplier A resolves late -> MUST NOT overwrite Beta Plywood
    await act(async () => {
      resolveSupA(makeStatement('sup-a', 'Alpha Hardware'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Beta Plywood');
    expect(container.textContent).toContain('BILL-sup-b');
    expect(container.textContent).not.toContain('BILL-sup-a');
  });

  it('disables Print & Export CSV when filter dates change until Apply is clicked, and exports applied dates only', async () => {
    (suppliersApi.fetchSupplierStatementApi as any).mockImplementation(
      async (supplierId: string, opts?: { fromDate?: string; toDate?: string }) =>
        makeStatement(supplierId, 'Alpha Hardware', opts?.fromDate || null, opts?.toDate || null)
    );

    await act(async () => {
      root.render(React.createElement(SupplierStatement, { initialSupplierId: 'sup-a' }));
    });

    const findBtn = (label: string) =>
      Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(label)
      )!;

    expect(findBtn('Print Statement').disabled).toBe(false);
    expect(findBtn('Export CSV').disabled).toBe(false);

    // Edit Start Date without clicking Apply -> dirty notice + disabled export/print buttons
    const dateInputs = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    await act(async () => {
      setInputValue(dateInputs[0], '2026-04-01');
    });

    expect(container.textContent).toContain('Filter dates changed — click Apply to refresh this statement');
    expect(findBtn('Print Statement').disabled).toBe(true);
    expect(findBtn('Export CSV').disabled).toBe(true);

    // Click Apply -> statement loads with 2026-04-01 filter -> Export CSV uses applied dates
    await act(async () => {
      findBtn('Apply').click();
    });
    expect(findBtn('Export CSV').disabled).toBe(false);

    await act(async () => {
      findBtn('Export CSV').click();
    });
    expect(suppliersApi.downloadSupplierStatementCsvApi).toHaveBeenCalledWith(
      'sup-a',
      'Alpha Hardware',
      {
        fromDate: '2026-04-01',
        toDate: undefined,
      }
    );
  });
});
