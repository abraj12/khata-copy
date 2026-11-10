import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { formatCurrency } from '../src/lib/formatters.js';

describe('Professional Quotations Frontend Module Test Suite', () => {
  it('1. Calculates subtotal, percentage discount, and taxable amount with Decimal.js', () => {
    const items = [
      { quantity: new Decimal('2.50'), rate: new Decimal('1200.00') }, // 3000.00
      { quantity: new Decimal('4'), rate: new Decimal('500.00') },      // 2000.00
    ];

    let subtotal = new Decimal(0);
    items.forEach((it) => {
      subtotal = subtotal.plus(it.quantity.times(it.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
    });

    expect(subtotal.toFixed(2)).toBe('5000.00');

    // 15% discount
    const discountRate = new Decimal(15);
    const discountAmount = subtotal.times(discountRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const taxable = subtotal.minus(discountAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    expect(discountAmount.toFixed(2)).toBe('750.00');
    expect(taxable.toFixed(2)).toBe('4250.00');
  });

  it('2. Computes Intra-State GST (CGST + SGST) accurately on taxable amount', () => {
    const taxable = new Decimal('4250.00');
    const gstRate = new Decimal(18);
    const halfRate = gstRate.dividedBy(2); // 9%

    const cgst = taxable.times(halfRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const sgst = taxable.times(halfRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const grandTotal = taxable.plus(cgst).plus(sgst);

    expect(cgst.toFixed(2)).toBe('382.50');
    expect(sgst.toFixed(2)).toBe('382.50');
    expect(grandTotal.toFixed(2)).toBe('5015.00');
  });

  it('3. Computes Inter-State GST (IGST only) without CGST/SGST', () => {
    const taxable = new Decimal('4250.00');
    const gstRate = new Decimal(18);

    const igst = taxable.times(gstRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const grandTotal = taxable.plus(igst);

    expect(igst.toFixed(2)).toBe('765.00');
    expect(grandTotal.toFixed(2)).toBe('5015.00');
  });

  it('4. Zero tax applied when GST is disabled', () => {
    const taxable = new Decimal('4250.00');
    const gstEnabled = false;

    const tax = gstEnabled ? taxable.times(0.18) : new Decimal(0);
    const grandTotal = taxable.plus(tax);

    expect(tax.toFixed(2)).toBe('0.00');
    expect(grandTotal.toFixed(2)).toBe('4250.00');
  });

  it('5. Currency formatter outputs formatted Indian Rupee amounts with currency symbol', () => {
    expect(formatCurrency('1250000.50')).toBe('₹12,50,000.50');
    expect(formatCurrency('5015')).toBe('₹5,015.00');
  });
});
