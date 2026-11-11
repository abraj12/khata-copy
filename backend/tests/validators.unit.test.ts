import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  validateDecimalQuantityInput,
  validateQuantityInput,
  validateMoneyInput,
  escapeLike,
  FinancialValidationError,
  validatePercentageInput,
  validateGstRateInput,
  resolveValidatedDiscount,
  calculateGstBreakdown,
} from '../src/utils/validation.js';
import { khataService } from '../src/modules/khata/khata.service.js';

describe('Unit Test Suite: Validators & Normalizers (Phase 12.1)', () => {
  describe('validateDecimalQuantityInput', () => {
    it('accepts valid quantities up to 2 decimal places and returns Decimal', () => {
      const q1 = validateDecimalQuantityInput('1');
      expect(q1).toBeInstanceOf(Decimal);
      expect(q1.toString()).toBe('1');

      const q2 = validateDecimalQuantityInput(1.5);
      expect(q2.toString()).toBe('1.5');

      const q3 = validateDecimalQuantityInput('1.25');
      expect(q3.toString()).toBe('1.25');

      const q4 = validateDecimalQuantityInput('0.01');
      expect(q4.toString()).toBe('0.01');

      const q5 = validateDecimalQuantityInput('0.25');
      expect(q5.toString()).toBe('0.25');

      const q6 = validateDecimalQuantityInput('1000000');
      expect(q6.toString()).toBe('1000000');

      const q7 = validateDecimalQuantityInput('1000000.00');
      expect(q7.toString()).toBe('1000000');
    });

    it('rejects zero, negative numbers, excess decimals, non-numeric input, and exponents', () => {
      // Zero
      expect(() => validateDecimalQuantityInput('0')).toThrow(FinancialValidationError);
      expect(() => validateDecimalQuantityInput(0)).toThrow(FinancialValidationError);

      // Negative
      expect(() => validateDecimalQuantityInput('-1')).toThrow(FinancialValidationError);
      expect(() => validateDecimalQuantityInput('-0.01')).toThrow(FinancialValidationError);

      // Excess decimal places (> 2)
      expect(() => validateDecimalQuantityInput('1.234')).toThrow(/up to 2 decimal places/);
      expect(() => validateDecimalQuantityInput('0.001')).toThrow(/up to 2 decimal places/);
      expect(() => validateDecimalQuantityInput('1.2300')).toThrow(/up to 2 decimal places/);

      // Non-numeric text
      expect(() => validateDecimalQuantityInput('1.2abc')).toThrow(FinancialValidationError);
      expect(() => validateDecimalQuantityInput('abc')).toThrow(FinancialValidationError);

      // Exponent notation
      expect(() => validateDecimalQuantityInput('1e3')).toThrow(FinancialValidationError);
      expect(() => validateDecimalQuantityInput('2e-1')).toThrow(FinancialValidationError);

      // Null, undefined, empty
      expect(() => validateDecimalQuantityInput('')).toThrow(/required/);
      expect(() => validateDecimalQuantityInput('   ')).toThrow(/required/);
      expect(() => validateDecimalQuantityInput(null)).toThrow(/required/);
      expect(() => validateDecimalQuantityInput(undefined)).toThrow(/required/);

      // Exceeding ceiling (1,000,000)
      expect(() => validateDecimalQuantityInput('1000000.01')).toThrow(/cannot exceed 1,000,000/);
      expect(() => validateDecimalQuantityInput('2000000')).toThrow(/cannot exceed 1,000,000/);
    });

    it('validateQuantityInput acts as backward-compatible alias for validateDecimalQuantityInput', () => {
      const q = validateQuantityInput('2.5');
      expect(q).toBeInstanceOf(Decimal);
      expect(q.toString()).toBe('2.5');
    });
  });

  describe('validateMoneyInput', () => {
    it('accepts non-negative amounts with up to 2 decimal places and returns Decimal', () => {
      const m1 = validateMoneyInput('0');
      expect(m1.toString()).toBe('0');

      const m2 = validateMoneyInput('0.00');
      expect(m2.toString()).toBe('0');

      const m3 = validateMoneyInput('150');
      expect(m3.toString()).toBe('150');

      const m4 = validateMoneyInput('150.50');
      expect(m4.toString()).toBe('150.5');

      const m5 = validateMoneyInput('12.63');
      expect(m5.toString()).toBe('12.63');
    });

    it('rejects negative numbers, >2 decimal places, exponents, and invalid strings', () => {
      expect(() => validateMoneyInput('-1')).toThrow(/must be a valid non-negative amount/);
      expect(() => validateMoneyInput('10.123')).toThrow(/at most 2 decimal places/);
      expect(() => validateMoneyInput('100abc')).toThrow(FinancialValidationError);
      expect(() => validateMoneyInput('1e3')).toThrow(FinancialValidationError);
      expect(() => validateMoneyInput('')).toThrow(/required/);
      expect(() => validateMoneyInput(null)).toThrow(/required/);
      expect(() => validateMoneyInput(undefined)).toThrow(/required/);
    });
  });

  describe('escapeLike', () => {
    it('escapes %, _, and \\ characters for PostgreSQL ILIKE queries', () => {
      expect(escapeLike('test%product')).toBe('test\\%product');
      expect(escapeLike('test_product')).toBe('test\\_product');
      expect(escapeLike('test\\product')).toBe('test\\\\product');
      expect(escapeLike('normal text 123')).toBe('normal text 123');
    });
  });

  describe('khataService normalization', () => {
    it('normalizes customer phone numbers to canonical +91 format', () => {
      expect(khataService.normalizeCustomerPhone('9876543210')).toBe('+919876543210');
      expect(khataService.normalizeCustomerPhone('+91 98765 43210')).toBe('+919876543210');
      expect(khataService.normalizeCustomerPhone('09876543210')).toBe('+919876543210');
      expect(khataService.normalizeCustomerPhone('+91-98765-43210')).toBe('+919876543210');
      expect(khataService.normalizeCustomerPhone(null)).toBe(null);
      expect(khataService.normalizeCustomerPhone(undefined)).toBe(null);
      expect(khataService.normalizeCustomerPhone('')).toBe(null);
      expect(khataService.normalizeCustomerPhone('   ')).toBe(null);
    });

    it('rejects malformed non-empty phone numbers with HTTP 400', () => {
      expect(() => khataService.normalizeCustomerPhone('12345')).toThrow(/Invalid phone number format/);
      expect(() => khataService.normalizeCustomerPhone('abcdefghij')).toThrow(/Invalid phone number format/);
      expect(() => khataService.normalizeCustomerPhone('1234567890')).toThrow(/Invalid phone number format/);
    });

    it('normalizes customer names (NFKC, lowercase, whitespace collapse)', () => {
      expect(khataService.normalizeName('  Ramesh   Kumar  ')).toBe('ramesh kumar');
      expect(khataService.normalizeName('SURESH SHARMA')).toBe('suresh sharma');
    });
  });

  describe('Release #023: Strict Percentage, GST Rate & Discount Resolvers', () => {
    it('validatePercentageInput accepts 0..100 with <=2 decimals and rejects malformed/negative/>100', () => {
      expect(validatePercentageInput(0).toFixed(2)).toBe('0.00');
      expect(validatePercentageInput('0').toFixed(2)).toBe('0.00');
      expect(validatePercentageInput('12.5').toFixed(2)).toBe('12.50');
      expect(validatePercentageInput('100').toFixed(2)).toBe('100.00');

      for (const bad of [-0.01, -5, '100.01', 101, '1.234', '1e2', 'abc', NaN, Infinity]) {
        expect(() => validatePercentageInput(bad, 'Discount percentage')).toThrow(
          FinancialValidationError
        );
      }
    });

    it('validateGstRateInput accepts 0..100 with <=2 decimals and rejects invalid rates', () => {
      expect(validateGstRateInput(0).toFixed(2)).toBe('0.00');
      expect(validateGstRateInput(5.5).toFixed(2)).toBe('5.50');
      expect(validateGstRateInput('18.00').toFixed(2)).toBe('18.00');
      expect(validateGstRateInput(100).toFixed(2)).toBe('100.00');

      for (const bad of [-1, 100.01, '18.123', '1e1', 'abc', NaN, Infinity]) {
        expect(() => validateGstRateInput(bad, 'GST rate')).toThrow(FinancialValidationError);
      }
    });

    it('resolveValidatedDiscount enforces strict rules across omitted, zero, percentage, and fixed modes', () => {
      const subtotal = new Decimal('200.00');

      // Omitted / null -> 0.00
      expect(resolveValidatedDiscount(subtotal, {})).toMatchObject({
        discountType: null,
      });
      expect(resolveValidatedDiscount(subtotal, {}).discountAmountDec.toFixed(2)).toBe('0.00');

      // Explicit numeric 0 vs string '0'
      const numZero = resolveValidatedDiscount(subtotal, { discountType: 'percentage', discountValue: 0 });
      const strZero = resolveValidatedDiscount(subtotal, { discountType: 'percentage', discountValue: '0' });
      expect(numZero.discountValueDec.toFixed(2)).toBe('0.00');
      expect(strZero.discountValueDec.toFixed(2)).toBe('0.00');
      expect(numZero.discountAmountDec.toFixed(2)).toBe('0.00');
      expect(strZero.discountAmountDec.toFixed(2)).toBe('0.00');

      // Fixed discount exceeding subtotal clamps cleanly to subtotal
      const clamped = resolveValidatedDiscount(subtotal, {
        discountType: 'fixed',
        discountValue: '500.00',
      });
      expect(clamped.discountValueDec.toFixed(2)).toBe('500.00');
      expect(clamped.discountAmountDec.toFixed(2)).toBe('200.00');

      // Client tampering on discountAmount in percentage mode is recomputed, yet malformed discountAmount is rejected
      const recomputed = resolveValidatedDiscount(subtotal, {
        discountType: 'percentage',
        discountValue: '10',
        discountAmount: '199.00',
      });
      expect(recomputed.discountAmountDec.toFixed(2)).toBe('20.00');

      expect(() =>
        resolveValidatedDiscount(subtotal, {
          discountType: 'percentage',
          discountValue: '10',
          discountAmount: '-5',
        })
      ).toThrow(FinancialValidationError);

      // Invalid discountValue rejected even when discountType is omitted or null
      for (const badVal of [-5, '1.234', '1e2', 'abc']) {
        expect(() => resolveValidatedDiscount(subtotal, { discountValue: badVal })).toThrow(
          FinancialValidationError
        );
      }
      expect(() =>
        resolveValidatedDiscount(subtotal, { discountType: 'percentage', discountValue: 101 })
      ).toThrow(FinancialValidationError);
    });

    it('calculateGstBreakdown splits CGST/SGST and IGST identically with ROUND_HALF_UP', () => {
      const intra = calculateGstBreakdown(new Decimal('100.05'), 18, true);
      expect(intra.cgstRateDec.toFixed(2)).toBe('9.00');
      expect(intra.sgstRateDec.toFixed(2)).toBe('9.00');
      expect(intra.cgstAmountDec.toFixed(2)).toBe('9.00');
      expect(intra.sgstAmountDec.toFixed(2)).toBe('9.00');
      expect(intra.totalTaxDec.toFixed(2)).toBe('18.00');

      const inter = calculateGstBreakdown(new Decimal('100.55'), 5, false);
      expect(inter.igstRateDec.toFixed(2)).toBe('5.00');
      expect(inter.igstAmountDec.toFixed(2)).toBe('5.03');
      expect(inter.totalTaxDec.toFixed(2)).toBe('5.03');
    });
  });
});
