import { describe, it, expect } from 'vitest';
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
  formatAbsRupees,
} from '../src/features/suppliers/suppliersApi.js';

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
});
