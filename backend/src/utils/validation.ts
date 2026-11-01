import { Decimal } from 'decimal.js';

export class FinancialValidationError extends Error {
  public status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'FinancialValidationError';
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
export function validateMoneyInput(value: unknown, fieldName = 'Amount'): Decimal {
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
    throw new FinancialValidationError(`${fieldName} is required.`);
  }

  const str = String(value).trim();

  // Strict regex: positive integer or up to 2 decimal places
  const quantityRegex = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
  if (!quantityRegex.test(str)) {
    throw new FinancialValidationError(
      `${fieldName} must be greater than 0 and may have up to 2 decimal places (e.g. 1, 1.5, 2.25).`
    );
  }

  const d = new Decimal(str);
  if (!d.isFinite() || d.isNaN()) {
    throw new FinancialValidationError(`${fieldName} must be a finite number.`);
  }
  if (d.lessThanOrEqualTo(0)) {
    throw new FinancialValidationError(
      `${fieldName} must be greater than 0 and may have up to 2 decimal places (e.g. 1, 1.5, 2.25).`
    );
  }
  if (d.decimalPlaces() > 2) {
    throw new FinancialValidationError(`${fieldName} cannot have more than 2 decimal places.`);
  }
  if (d.greaterThan(1000000)) {
    throw new FinancialValidationError(`${fieldName} cannot exceed 1,000,000 units.`);
  }

  return d;
}

/**
 * @deprecated Use validateDecimalQuantityInput instead.
 * Kept as an alias for backward-compatibility during transition; will be removed.
 */
export function validateQuantityInput(value: unknown, fieldName = 'Quantity'): Decimal {
  return validateDecimalQuantityInput(value, fieldName);
}
