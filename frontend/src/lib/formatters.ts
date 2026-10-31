import Decimal from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export class DecimalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalValidationError';
  }
}

/**
 * Strict validator and parser for financial numbers.
 * Rejects non-numeric text, exponential notation (e.g. 1e5), NaN, Infinity, negative (unless allowed),
 * and precision exceeding max allowed decimal places.
 */
export function parseStrictDecimal(
  value: unknown,
  options: {
    allowNegative?: boolean;
    maxDecimalPlaces?: number;
    fieldName?: string;
  } = {}
): Decimal {
  const { allowNegative = false, maxDecimalPlaces = 2, fieldName = 'Value' } = options;
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new DecimalValidationError(`${fieldName} cannot be empty.`);
  }

  const str = String(value).trim();
  // Strictly enforce digit format with optional decimal part (no letters, symbols, scientific notation)
  const regex = allowNegative ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/;
  if (!regex.test(str)) {
    throw new DecimalValidationError(`${fieldName} must be a valid numeric amount (e.g. 150.00).`);
  }

  const d = new Decimal(str);
  if (!d.isFinite() || d.isNaN()) {
    throw new DecimalValidationError(`${fieldName} must be a finite number.`);
  }

  if (!allowNegative && d.isNegative()) {
    throw new DecimalValidationError(`${fieldName} cannot be negative.`);
  }

  if (d.decimalPlaces() > maxDecimalPlaces) {
    throw new DecimalValidationError(
      `${fieldName} cannot have more than ${maxDecimalPlaces} decimal places.`
    );
  }

  return d;
}

/**
 * Returns null if valid, or a descriptive error message if invalid.
 */
export function validateStrictDecimal(
  value: unknown,
  options: {
    allowNegative?: boolean;
    maxDecimalPlaces?: number;
    fieldName?: string;
  } = {}
): string | null {
  try {
    parseStrictDecimal(value, options);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Safely parses any value into a Decimal instance.
 * Defaults to 0 if null, undefined, NaN, or invalid.
 */
export function safeDecimal(value: unknown): Decimal {
  if (value === null || value === undefined || value === '') {
    return new Decimal(0);
  }
  if (value instanceof Decimal) {
    return value;
  }
  try {
    const str = String(value).trim();
    if (!/^-?\d+(\.\d+)?$/.test(str)) {
      return new Decimal(0);
    }
    const d = new Decimal(str);
    return d.isNaN() || !d.isFinite() ? new Decimal(0) : d;
  } catch {
    return new Decimal(0);
  }
}

/**
 * Formats a currency value with the Indian Rupee symbol (₹) and 2 decimal places.
 * Example: formatCurrency('1250.5') => "₹1,250.50"
 */
export function formatCurrency(value: unknown): string {
  const d = safeDecimal(value);
  const parts = d.toFixed(2).split('.');
  const intPart = parts[0];
  const decPart = parts[1];

  // Indian numbering system format (last 3 digits, then groups of 2)
  const lastThree = intPart.substring(intPart.length - 3);
  const otherNumbers = intPart.substring(0, intPart.length - 3);
  const formattedInt =
    otherNumbers !== ''
      ? otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree
      : lastThree;

  return `₹${formattedInt}.${decPart}`;
}

/**
 * Formats monetary amounts as exact decimal strings with 2 decimal places.
 * Example: formatMoneyString('100.5') => "100.50"
 */
export function formatMoneyString(value: unknown): string {
  return safeDecimal(value).toFixed(2);
}

/**
 * Formats quantity values with up to 3 decimal places, trimming trailing zeros.
 * Example: formatQuantity('2.500') => "2.5"
 */
export function formatQuantity(value: unknown): string {
  const d = safeDecimal(value);
  const str = d.toFixed(3);
  return str.replace(/\.?0+$/, '');
}
