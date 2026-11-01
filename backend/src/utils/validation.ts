import { Decimal } from 'decimal.js';

export class FinancialValidationError extends Error {
  public status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'FinancialValidationError';
  }
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
 * Validates that quantity for hardware retail is a strict positive whole integer:
 * - Must be an integer >= 1 and <= 1,000,000.
 * - Any decimal or fractional input (1.5, 0.5, 2.00) is rejected with "Quantity must be a whole number."
 */
export function validateQuantityInput(value: unknown, fieldName = 'Quantity'): number {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new FinancialValidationError(`${fieldName} is required.`);
  }

  const str = String(value).trim();

  // Explicit check for decimal point
  if (str.includes('.') || !/^\d+$/.test(str)) {
    throw new FinancialValidationError('Quantity must be a whole number.');
  }

  const n = parseInt(str, 10);
  if (isNaN(n) || n <= 0) {
    throw new FinancialValidationError('Quantity must be a whole number.');
  }

  if (n > 1000000) {
    throw new FinancialValidationError(`${fieldName} cannot exceed 1,000,000 units.`);
  }

  return n;
}
