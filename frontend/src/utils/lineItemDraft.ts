import Decimal from 'decimal.js';
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

/**
 * Safely parses live UI draft numeric inputs (such as incomplete '.', '-', or empty strings)
 * without throwing during reactive calculation. Submit validation must still use strict validators.
 */
export function decimalOrZero(value: unknown, fallback: number | string = 0): Decimal {
  if (value === null || value === undefined) {
    return new Decimal(fallback);
  }
  const str = String(value).trim();
  if (!str) {
    return new Decimal(fallback);
  }
  try {
    const parsed = new Decimal(str);
    return parsed.isFinite() && !parsed.isNaN() ? parsed : new Decimal(fallback);
  } catch {
    return new Decimal(fallback);
  }
}

/**
 * Strictly validates a percentage input (0..100 inclusive, max 2 decimal places) prior to form submit.
 */
export function validatePercentageDraftInput(value: unknown, fieldLabel = 'GST Rate'): string | null {
  try {
    const dec = parseStrictDecimal(value, {
      allowNegative: false,
      maxDecimalPlaces: 2,
      fieldName: fieldLabel,
    });
    if (dec.greaterThan(100)) {
      return `${fieldLabel} must be between 0 and 100.`;
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export interface DraftLineBase {
  productId?: number | null;
  description: string;
  hsnCode?: string | null;
  barcode?: string | null;
  quantity: string;
  rate: string;
  buyingPriceReference?: string | null;
}

export type BarcodeUpsertAction = 'incremented' | 'filled_empty' | 'added';

/**
 * Finds and increments quantity (+1) for an already-present product/barcode line,
 * or fills the first blank placeholder row, or appends a new draft line.
 * Never copies `buying_price` into customer-facing selling `rate`.
 */
export function upsertScannedProductLine<T extends DraftLineBase>(
  lines: T[],
  product: ProductCatalogReference,
  createEmptyLine: () => T,
  options?: { maxItems?: number; maxItemsErrorMessage?: string }
): {
  nextLines: T[];
  action: BarcodeUpsertAction;
  targetIndex: number;
  error: string | null;
} {
  const cleanBarcode = product.barcode ? String(product.barcode).trim() : '';

  const existingIdx = lines.findIndex((line) => {
    if (line.productId && Number(line.productId) === Number(product.id)) {
      return true;
    }
    if (cleanBarcode && line.barcode && String(line.barcode).trim() === cleanBarcode) {
      return true;
    }
    return false;
  });

  if (existingIdx >= 0) {
    const existing = lines[existingIdx];
    let currentQty = new Decimal(0);
    try {
      const trimmedQty = String(existing.quantity || '').trim();
      currentQty = trimmedQty ? new Decimal(trimmedQty) : new Decimal(0);
    } catch {
      currentQty = new Decimal(0);
    }
    const nextQty = currentQty.plus(1).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (nextQty.greaterThan(1000000)) {
      return {
        nextLines: lines,
        action: 'incremented',
        targetIndex: existingIdx,
        error: `Quantity for "${product.name}" cannot exceed 1,000,000.`,
      };
    }

    const formattedQty = nextQty.decimalPlaces() === 0 ? nextQty.toFixed(0) : nextQty.toString();
    const nextLines = lines.map((line, idx) =>
      idx === existingIdx
        ? {
            ...line,
            quantity: formattedQty,
            barcode: cleanBarcode || line.barcode || '',
            buyingPriceReference:
              product.buying_price !== undefined && product.buying_price !== null
                ? String(product.buying_price)
                : line.buyingPriceReference ?? null,
          }
        : line
    );

    return { nextLines, action: 'incremented', targetIndex: existingIdx, error: null };
  }

  const emptyIdx = lines.findIndex(
    (line) =>
      !line.productId &&
      !String(line.description || '').trim() &&
      !String(line.rate || '').trim() &&
      !String(line.barcode || '').trim()
  );

  if (emptyIdx >= 0) {
    const filled = {
      ...applyCatalogProductToDraftLine(lines[emptyIdx], product),
      quantity: '1',
    };
    const nextLines = lines.map((line, idx) => (idx === emptyIdx ? filled : line));
    return { nextLines, action: 'filled_empty', targetIndex: emptyIdx, error: null };
  }

  if (options?.maxItems !== undefined && lines.length >= options.maxItems) {
    return {
      nextLines: lines,
      action: 'added',
      targetIndex: -1,
      error: options.maxItemsErrorMessage || `A bill can contain a maximum of ${options.maxItems} items.`,
    };
  }

  const created = {
    ...applyCatalogProductToDraftLine(createEmptyLine(), product),
    quantity: '1',
  };
  return {
    nextLines: [...lines, created],
    action: 'added',
    targetIndex: lines.length,
    error: null,
  };
}
