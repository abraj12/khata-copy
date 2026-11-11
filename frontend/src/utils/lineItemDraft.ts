import { parseStrictDecimal } from '../lib/formatters.js';

export interface ProductCatalogReference {
  id: number;
  name: string;
  buying_price?: string | null;
  hsn_code?: string | null;
  hsnCode?: string | null;
  barcode?: string | null;
}

/**
 * Attaches catalog product metadata to a customer-facing bill or quotation row.
 * Buying price is strictly stored as an internal reference display field (`buyingPriceReference`)
 * and NEVER copied into customer-facing selling `rate`.
 */
export function applyCatalogProductToDraftLine<
  T extends { rate?: string | number | null; hsnCode?: string | null; barcode?: string | null }
>(
  currentLine: T,
  product: ProductCatalogReference
): T & {
  productId: number;
  description: string;
  hsnCode: string;
  barcode: string;
  buyingPriceReference: string | null;
  rate: string;
} {
  const rawHsn = product.hsn_code ?? product.hsnCode;
  const cleanHsn = rawHsn ? String(rawHsn).trim() : '';

  const currentRateStr =
    currentLine.rate === null || currentLine.rate === undefined ? '' : String(currentLine.rate).trim();

  // Preserve an explicit positive/edited rate if present, otherwise keep empty so shopkeeper enters selling price.
  // Specifically clear sentinel default '0' / '0.00' so buying_price is never leaked or masked.
  const preservedRate =
    currentRateStr && currentRateStr !== '0' && currentRateStr !== '0.0' && currentRateStr !== '0.00'
      ? currentRateStr
      : '';

  return {
    ...currentLine,
    productId: Number(product.id),
    description: product.name,
    hsnCode: cleanHsn || (currentLine.hsnCode ? String(currentLine.hsnCode) : ''),
    barcode: product.barcode ? String(product.barcode).trim() : currentLine.barcode ? String(currentLine.barcode) : '',
    buyingPriceReference:
      product.buying_price !== undefined && product.buying_price !== null
        ? String(product.buying_price)
        : null,
    rate: preservedRate,
  };
}

/**
 * Validates customer-entered quantity (max 2 decimal places, > 0 and <= 1,000,000).
 */
export function validateQuantityInput(value: unknown, fieldLabel = 'Quantity'): string | null {
  try {
    const dec = parseStrictDecimal(value, { maxDecimalPlaces: 2, fieldName: fieldLabel });
    if (dec.lessThanOrEqualTo(0)) {
      return `${fieldLabel} must be greater than 0.`;
    }
    if (dec.greaterThan(1000000)) {
      return `${fieldLabel} cannot exceed 1,000,000.`;
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Validates explicitly entered selling rate (max 2 decimal places, >= 0, non-empty).
 */
export function validateSellingRateInput(value: unknown, fieldLabel = 'Rate'): string | null {
  try {
    const dec = parseStrictDecimal(value, { maxDecimalPlaces: 2, fieldName: fieldLabel });
    if (dec.lessThan(0)) {
      return `${fieldLabel} cannot be negative.`;
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
