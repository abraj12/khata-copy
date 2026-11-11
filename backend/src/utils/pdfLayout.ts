import Decimal from 'decimal.js';
import PDFDocument from 'pdfkit';

type PdfDoc = InstanceType<typeof PDFDocument>;

const ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];

const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function underThousand(n: number): string {
  let result = '';
  if (n >= 100) {
    result += `${ONES[Math.floor(n / 100)]} Hundred `;
  }
  const rem = n % 100;
  if (rem >= 20) {
    result += `${TENS[Math.floor(rem / 10)]}${rem % 10 ? ` ${ONES[rem % 10]}` : ''}`;
  } else if (rem > 0) {
    result += ONES[rem];
  }
  return result.trim();
}

function indianIntegerWords(numStr: string): string {
  const normalized = numStr.replace(/^0+/, '') || '0';
  if (normalized === '0') return 'Zero';

  let remaining = normalized;
  const croreVal = remaining.length > 7 ? remaining.slice(0, -7) : '';
  remaining = remaining.length > 7 ? remaining.slice(-7) : remaining;
  const lakhNum = remaining.length > 5 ? Number(remaining.slice(0, -5)) : 0;
  remaining = remaining.length > 5 ? remaining.slice(-5) : remaining;
  const thousandNum = remaining.length > 3 ? Number(remaining.slice(0, -3)) : 0;
  const unitsNum = Number(remaining.length > 3 ? remaining.slice(-3) : remaining);

  const parts: string[] = [];
  if (croreVal) parts.push(`${indianIntegerWords(croreVal)} Crore`);
  if (lakhNum) parts.push(`${underThousand(lakhNum)} Lakh`);
  if (thousandNum) parts.push(`${underThousand(thousandNum)} Thousand`);
  if (unitsNum) parts.push(underThousand(unitsNum));

  return parts.join(' ');
}

/**
 * Decimal-safe conversion to Indian currency words (Crores / Lakhs / Thousands / Paise).
 */
export function numberToIndianWords(value: number | string): string {
  if (value === null || value === undefined || value === '') return 'Rupees Zero Only';
  try {
    const dec = new Decimal(String(value).trim());
    if (!dec.isFinite()) return '';
    const rounded = dec.abs().toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const fixed = rounded.toFixed(2);
    const [intPart, decPart] = fixed.split('.');
    const paise = parseInt(decPart || '0', 10);
    const prefix = dec.isNegative() && !rounded.isZero() ? 'Minus ' : '';
    const words = `${prefix}Rupees ${indianIntegerWords(intPart)}${paise ? ` and ${underThousand(paise)} Paise` : ''} Only`;
    return words;
  } catch {
    return '';
  }
}

/**
 * Formats a numeric/string value with Indian comma grouping (XX,XX,XXX.XX) using Decimal.js
 * so large values never drift from floating-point rounding.
 */
export function formatIndianMoney(
  val: string | number | Decimal | null | undefined,
  decimals = 2
): string {
  if (val === null || val === undefined || val === '') {
    return decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
  }
  try {
    const dec = new Decimal(val instanceof Decimal ? val : String(val).trim());
    if (!dec.isFinite()) return decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
    const isNeg = dec.isNegative() && !dec.isZero();
    const fixed = dec.abs().toFixed(decimals, Decimal.ROUND_HALF_UP);
    const [intPart, decPart] = fixed.split('.');

    let groupedInt = intPart;
    if (intPart.length > 3) {
      const lastThree = intPart.slice(-3);
      const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
      groupedInt = `${rest},${lastThree}`;
    }

    const body = decimals > 0 ? `${groupedInt}.${decPart ?? '0'.repeat(decimals)}` : groupedInt;
    return isNeg ? `-${body}` : body;
  } catch {
    return decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
  }
}

/**
 * Formats Decimal quantity cleanly without trailing fractional zeroes (e.g. 2.000 -> 2, 2.500 -> 2.5).
 */
export function formatDecimalQty(val: string | number | Decimal | null | undefined): string {
  if (val === null || val === undefined || val === '') return '';
  try {
    const dec = new Decimal(val instanceof Decimal ? val : String(val).trim());
    if (!dec.isFinite()) return String(val);
    return dec.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed().replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
  } catch {
    return String(val);
  }
}

/**
 * Strictly format date to DD-MM-YYYY without UTC/local shift bugs on YYYY-MM-DD strings.
 */
export function formatDateToIndian(val: string | Date | null | undefined): string {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${d}-${m}-${y}`;
  }
  const str = String(val).trim();
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${d}-${m}-${y}`;
  }
  return str.slice(0, 10);
}

/**
 * Splits arbitrarily long text cleanly at newline, word, or character boundaries so
 * `head` fits within `maxHeight` at the current font and fontSize on `doc`.
 * Guarantees forward progress whenever at least one character fits.
 */
export function splitTextBlockToHeight(
  doc: PdfDoc,
  rawText: string,
  width: number,
  maxHeight: number,
  options: { lineGap?: number } = {}
): { head: string; tail: string } {
  const normalized = (rawText || '').replace(/\r\n/g, '\n');
  if (!normalized) return { head: '', tail: '' };

  const textOpts = { width, lineGap: options.lineGap ?? 0 };
  if (doc.heightOfString(normalized, textOpts) <= maxHeight) {
    return { head: normalized, tail: '' };
  }

  const singleLineHeight = doc.heightOfString('Ay', textOpts);
  if (maxHeight < singleLineHeight) {
    return { head: '', tail: normalized };
  }

  // Split by word/whitespace tokens preserving newlines cleanly for natural wrapping
  const tokens = normalized.match(/\S+[ \t]*|\n/g) || [];
  let lo = 0;
  let hi = tokens.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = tokens.slice(0, mid).join('').replace(/[ \t\n]+$/, '');
    if (doc.heightOfString(candidate || ' ', textOpts) <= maxHeight) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (lo > 0) {
    const head = tokens.slice(0, lo).join('').replace(/[ \t\n]+$/, '');
    const tail = tokens.slice(lo).join('').replace(/^[ \t\n]+/, '');
    return { head, tail };
  }

  // Fallback for an unbroken mega-token (e.g. a 1,500-char URL or barcode) exceeding one page
  let cLo = 1;
  let cHi = normalized.length;
  while (cLo < cHi) {
    const mid = Math.ceil((cLo + cHi) / 2);
    const candidate = normalized.slice(0, mid);
    if (doc.heightOfString(candidate, textOpts) <= maxHeight) {
      cLo = mid;
    } else {
      cHi = mid - 1;
    }
  }

  return {
    head: normalized.slice(0, cLo),
    tail: normalized.slice(cLo).replace(/^[ \t\n]+/, ''),
  };
}

/**
 * Stamps consistent footer captions and "Page X of Y" onto buffered pages WITHOUT
 * triggering PDFKit's implicit page-overflow wrap (always uses lineBreak: false and
 * restores margins cleanly).
 */
export function stampPageNumbers(
  doc: PdfDoc,
  options: {
    margin: number;
    contentWidth: number;
    footerY: number;
    leftText?: string;
    textColor?: string;
    fontSize?: number;
  }
): void {
  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  const color = options.textColor ?? '#475569';
  const fontSize = options.fontSize ?? 7.5;

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const pageMargins = doc.page.margins;
    const savedBottomMargin = pageMargins ? pageMargins.bottom : 0;
    if (pageMargins) {
      pageMargins.bottom = 0;
    }

    doc.save();
    doc.fillColor(color).font('Helvetica').fontSize(fontSize);

    if (options.leftText) {
      doc.text(options.leftText, options.margin, options.footerY, {
        width: options.contentWidth * 0.68,
        lineBreak: false,
      });
    }

    doc.text(
      `Page ${i - range.start + 1} of ${totalPages}`,
      options.margin,
      options.footerY,
      {
        width: options.contentWidth,
        align: 'right',
        lineBreak: false,
      }
    );

    doc.restore();
    if (pageMargins) {
      pageMargins.bottom = savedBottomMargin;
    }
  }
}
