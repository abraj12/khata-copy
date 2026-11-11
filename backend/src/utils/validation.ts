import { Decimal } from 'decimal.js';
import { z } from 'zod';

export class FinancialValidationError extends Error {
  public status = 400;
  public code = 'VALIDATION_ERROR';
  constructor(message: string, code = 'VALIDATION_ERROR') {
    super(message);
    this.name = 'FinancialValidationError';
    this.code = code;
  }
}

/**
 * Escapes PostgreSQL LIKE/ILIKE wildcards (%, _, \) to prevent query manipulation
 */
export function escapeLike(str: string): string {
  return str.replace(/([%_\\])/g, '\\$1');
}

/**
 * Validates that money inputs (buying price, selling price, payments) are non-negative,
 * have AT MOST 2 decimal places, and contain no malformed characters, exponents, or excess precision.
 */
export function validateMoneyInput(
  value: unknown,
  fieldName = 'Amount',
  options?: { allowZero?: boolean }
): Decimal {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new FinancialValidationError(`${fieldName} is required.`);
  }

  const str = String(value).trim();

  // Strict regex: non-negative integer or up to 2 decimal places, max 10 integer digits
  const moneyRegex = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
  if (!moneyRegex.test(str)) {
    throw new FinancialValidationError(
      `${fieldName} must be a valid non-negative amount with at most 2 decimal places (e.g. 150.00).`
    );
  }

  const d = new Decimal(str);
  if (!d.isFinite() || d.isNaN()) {
    throw new FinancialValidationError(`${fieldName} must be a finite number.`);
  }
  if (d.isNegative()) {
    throw new FinancialValidationError(`${fieldName} cannot be negative.`);
  }
  if (options?.allowZero === false && d.isZero()) {
    throw new FinancialValidationError(`${fieldName} must be greater than zero.`);
  }
  if (d.decimalPlaces() > 2) {
    throw new FinancialValidationError(`${fieldName} cannot have more than 2 decimal places.`);
  }

  return d;
}

/**
 * Validates that quantity is a positive number with at most 2 decimal places.
 * Accepts: 1, 1.5, 1.25, 0.01, 0.25 (i.e., any positive NUMERIC(12,2) value).
 * Rejects: 0, negative, 1.234, 1.2abc, NaN, Infinity, exponent notation, empty.
 *
 * Regex: ^(?:0|[1-9]\d*)(?:\.\d{1,2})?$
 *   - Allows 0 as integer part only when fractional part is present (e.g., 0.5)
 *   - Disallows leading zeros (01, 001) except "0" itself
 *   - Allows 1 or 2 digits after the decimal point
 */
export function validateDecimalQuantityInput(value: unknown, fieldName = 'Quantity'): Decimal {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new FinancialValidationError(`${fieldName} is required.`, 'INVALID_QUANTITY');
  }

  const str = String(value).trim();

  // Strict regex: positive integer or up to 2 decimal places
  const quantityRegex = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
  if (!quantityRegex.test(str)) {
    throw new FinancialValidationError(
      `${fieldName} must be greater than 0 and may have up to 2 decimal places (e.g. 1, 1.5, 2.25).`,
      'INVALID_QUANTITY'
    );
  }

  const d = new Decimal(str);
  if (!d.isFinite() || d.isNaN()) {
    throw new FinancialValidationError(`${fieldName} must be a finite number.`, 'INVALID_QUANTITY');
  }
  if (d.lessThanOrEqualTo(0)) {
    throw new FinancialValidationError(
      `${fieldName} must be greater than 0 and may have up to 2 decimal places (e.g. 1, 1.5, 2.25).`,
      'INVALID_QUANTITY'
    );
  }
  if (d.decimalPlaces() > 2) {
    throw new FinancialValidationError(`${fieldName} cannot have more than 2 decimal places.`, 'INVALID_QUANTITY');
  }
  if (d.greaterThan(1000000)) {
    throw new FinancialValidationError(`${fieldName} cannot exceed 1,000,000 units.`, 'INVALID_QUANTITY');
  }

  return d;
}

/**
 * @deprecated Use validateDecimalQuantityInput instead.
 * Kept as an alias for backward-compatibility during transition; will be removed.
 */
/**
 * Validates a percentage input (0 to 100 inclusive, max 2 decimal places).
 */
export function validatePercentageInput(value: unknown, fieldName = 'Percentage'): Decimal {
  const amount = validateMoneyInput(value, fieldName, { allowZero: true });
  if (amount.greaterThan(100)) {
    throw new FinancialValidationError(`${fieldName} must be between 0 and 100.`, 'INVALID_PERCENTAGE');
  }
  return amount;
}

/**
 * Validates a GST rate input (0 to 100 inclusive, max 2 decimal places).
 */
export function validateGstRateInput(value: unknown, fieldName = 'GST rate'): Decimal {
  const amount = validateMoneyInput(value, fieldName, { allowZero: true });
  if (amount.greaterThan(100)) {
    throw new FinancialValidationError(`${fieldName} must be between 0 and 100.`, 'INVALID_GST_RATE');
  }
  return amount;
}

function isProvidedFinancialInput(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

/**
 * Validates and resolves discount inputs across normal bills, GST invoices and quotations.
 * Rejects any supplied invalid discountValue or discountAmount regardless of active discountType,
 * never trusts client totals, and clamps fixed discounts cleanly at subtotal.
 */
export function resolveValidatedDiscount(
  subtotalDec: Decimal,
  input: {
    discountType?: 'percentage' | 'fixed' | null;
    discountValue?: number | string | null;
    discountAmount?: number | string | null;
  }
): {
  discountType: 'percentage' | 'fixed' | null;
  discountValueDec: Decimal;
  discountAmountDec: Decimal;
} {
  const discountType = input.discountType || null;

  let suppliedDiscountAmountDec: Decimal | null = null;
  if (isProvidedFinancialInput(input.discountAmount)) {
    suppliedDiscountAmountDec = validateMoneyInput(input.discountAmount, 'Discount amount', {
      allowZero: true,
    });
  }

  let discountValueDec = new Decimal(0);
  let discountAmountDec = new Decimal(0);

  if (discountType === 'percentage') {
    if (isProvidedFinancialInput(input.discountValue)) {
      discountValueDec = validatePercentageInput(input.discountValue, 'Discount percentage');
    }
    discountAmountDec = subtotalDec
      .times(discountValueDec)
      .dividedBy(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else if (discountType === 'fixed') {
    if (isProvidedFinancialInput(input.discountValue)) {
      discountValueDec = validateMoneyInput(input.discountValue, 'Discount fixed amount', {
        allowZero: true,
      });
    }
    discountAmountDec = Decimal.min(discountValueDec, subtotalDec).toDecimalPlaces(
      2,
      Decimal.ROUND_HALF_UP
    );
  } else {
    // Reject invalid discountValue even when discountType is null or omitted
    if (isProvidedFinancialInput(input.discountValue)) {
      discountValueDec = validateMoneyInput(input.discountValue, 'Discount value', {
        allowZero: true,
      });
    }
    if (suppliedDiscountAmountDec !== null) {
      discountAmountDec = Decimal.min(suppliedDiscountAmountDec, subtotalDec).toDecimalPlaces(
        2,
        Decimal.ROUND_HALF_UP
      );
    }
  }

  return {
    discountType,
    discountValueDec,
    discountAmountDec,
  };
}

/**
 * Validates GST rate and computes intra-state (CGST + SGST) or inter-state (IGST) split using Decimal.js.
 */
export function calculateGstBreakdown(
  taxableAmountDec: Decimal,
  gstRateInput: unknown,
  isIntraState: boolean
): {
  gstRateDec: Decimal;
  cgstRateDec: Decimal;
  cgstAmountDec: Decimal;
  sgstRateDec: Decimal;
  sgstAmountDec: Decimal;
  igstRateDec: Decimal;
  igstAmountDec: Decimal;
  totalTaxDec: Decimal;
} {
  const gstRateDec = validateGstRateInput(gstRateInput, 'GST rate');
  let cgstRateDec = new Decimal(0);
  let cgstAmountDec = new Decimal(0);
  let sgstRateDec = new Decimal(0);
  let sgstAmountDec = new Decimal(0);
  let igstRateDec = new Decimal(0);
  let igstAmountDec = new Decimal(0);

  if (isIntraState) {
    cgstRateDec = gstRateDec.dividedBy(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    sgstRateDec = gstRateDec.minus(cgstRateDec);
    cgstAmountDec = taxableAmountDec
      .times(cgstRateDec)
      .dividedBy(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    sgstAmountDec = taxableAmountDec
      .times(sgstRateDec)
      .dividedBy(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else {
    igstRateDec = gstRateDec;
    igstAmountDec = taxableAmountDec
      .times(igstRateDec)
      .dividedBy(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  const totalTaxDec = cgstAmountDec
    .plus(sgstAmountDec)
    .plus(igstAmountDec)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    gstRateDec,
    cgstRateDec,
    cgstAmountDec,
    sgstRateDec,
    sgstAmountDec,
    igstRateDec,
    igstAmountDec,
    totalTaxDec,
  };
}

/**
 * Shared Zod field for optional non-negative money values (2 decimal places max).
 */
export function optionalNonNegativeMoneyZodField(fieldLabel: string) {
  return z
    .union([z.number(), z.string()])
    .nullable()
    .optional()
    .superRefine((val, ctx) => {
      if (!isProvidedFinancialInput(val)) {
        return;
      }
      try {
        validateMoneyInput(val, fieldLabel, { allowZero: true });
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: (err as Error).message,
        });
      }
    });
}

/**
 * Shared Zod field for required strict GST rate (0..100, 2 decimal places max).
 */
export const strictGstRateZodField = z.union([z.number(), z.string()]).superRefine((val, ctx) => {
  try {
    validateGstRateInput(val, 'GST rate');
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: (err as Error).message,
    });
  }
});

/**
 * Enforces percentage discount bounds (0..100) on request schemas with discountType + discountValue.
 */
export function addPercentageDiscountZodIssue(
  data: { discountType?: 'percentage' | 'fixed' | null; discountValue?: number | string | null },
  ctx: z.RefinementCtx
): void {
  if (data.discountType === 'percentage' && isProvidedFinancialInput(data.discountValue)) {
    try {
      validatePercentageInput(data.discountValue, 'Discount percentage');
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discountValue'],
        message: (err as Error).message,
      });
    }
  }
}

/**
 * @deprecated Use validateDecimalQuantityInput instead.
 * Kept as an alias for backward-compatibility during transition; will be removed.
 */
export function validateQuantityInput(value: unknown, fieldName = 'Quantity'): Decimal {
  return validateDecimalQuantityInput(value, fieldName);
}
