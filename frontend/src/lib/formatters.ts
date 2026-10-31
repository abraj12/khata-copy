import Decimal from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

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
    const d = new Decimal(String(value).trim());
    return d.isNaN() ? new Decimal(0) : d;
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
