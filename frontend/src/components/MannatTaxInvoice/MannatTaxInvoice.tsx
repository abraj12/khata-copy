import { useState, useEffect } from 'react';
import Decimal from 'decimal.js';
import './MannatTaxInvoice.css';

export interface MannatInvoiceCompany {
  name?: string;
  address?: string | null;
  gstin?: string | null;
  phone?: string | null;
  state?: string | null;
  stateCode?: string | null;
  jurisdiction?: string | null;
}

const DEFAULT_COMPANY: MannatInvoiceCompany = Object.freeze({
  name: 'ALGIONS AI LABS PRIVATE LIMITED',
  address: '',
  gstin: '',
  phone: '',
  state: '',
  stateCode: '',
  jurisdiction: 'Subject to seller jurisdiction.',
});

function toDec(value: unknown): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  try {
    const parsed = new Decimal(String(value).trim());
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

export const numberWords = (value: number | string): string => {
  const ones = [
    'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen',
  ];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const underThousand = (n: number): string => {
    let result = '';
    if (n >= 100) result += `${ones[Math.floor(n / 100)]} Hundred `;
    n %= 100;
    if (n >= 20) result += `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`;
    else if (n > 0) result += ones[n];
    return result.trim();
  };

  const indianInteger = (n: number): string => {
    if (!n) return 'Zero';
    const parts: string[] = [];
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push(`${indianInteger(crore)} Crore`);
    if (lakh) parts.push(`${underThousand(lakh)} Lakh`);
    if (thousand) parts.push(`${underThousand(thousand)} Thousand`);
    if (n) parts.push(underThousand(n));
    return parts.join(' ');
  };

  const dec = toDec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!dec.isFinite() || dec.lt(0)) return '';
  const fixedStr = dec.toFixed(2);
  const [rupeesStr, paiseStr] = fixedStr.split('.');
  const rupees = parseInt(rupeesStr, 10) || 0;
  const paise = parseInt(paiseStr, 10) || 0;
  return `Rupees ${indianInteger(rupees)}${paise ? ` and ${indianInteger(paise)} Paise` : ''} Only`;
};

const money = (value: unknown): string => {
  const dec = toDec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const num = dec.toNumber();
  return Number.isFinite(num)
    ? num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';
};

const printableDate = (value: unknown): string => {
  if (!value) return '';
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${d}-${m}-${y}`;
  }
  const str = String(value).trim();
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
};

export interface MannatInvoiceItem {
  id?: string | number;
  name?: string;
  description?: string;
  hsn?: string | null;
  quantity?: number | string;
  unit?: string | null;
  rate?: number | string;
  rateUnit?: string | null;
  amount?: number | string;
}

export interface MannatInvoiceCustomer {
  name?: string;
  address?: string | null;
  gstin?: string | null;
  state?: string | null;
  stateCode?: string | null;
  phone?: string | null;
}

export interface MannatInvoiceTotals {
  subtotal?: number | string;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | string;
  discountAmount?: number | string;
  taxableAmount?: number | string;
  cgstRate?: number | string;
  cgstAmount?: number | string;
  sgstRate?: number | string;
  sgstAmount?: number | string;
  igstRate?: number | string;
  igstAmount?: number | string;
  taxAmount?: number | string;
  grandTotal?: number | string;
}

export interface MannatInvoiceProps {
  id?: number;
  invoiceNumber?: string;
  invoiceDate?: string;
  transportationMode?: string | null;
  vehicleNumber?: string | null;
  dateOfSupply?: string | null;
  placeOfSupply?: string | null;
  company?: MannatInvoiceCompany;
  customer?: MannatInvoiceCustomer;
  items?: MannatInvoiceItem[];
  totals?: MannatInvoiceTotals;
  amountInWords?: string;
}

export interface MannatTaxInvoiceComponentProps {
  invoice?: MannatInvoiceProps;
  showPrintButton?: boolean;
  onDownloadPdf?: () => void;
  onExportImages?: () => void;
  isDownloadingPdf?: boolean;
  isNormalBill?: boolean;
  billTitle?: string;
}

/**
 * Print-ready Algions AI Labs Private Limited invoice & bill component.
 * Reproduces the exact A4 portrait black-and-white physical invoice.
 * Supports both GST Tax Invoices and Non-GST Normal Bills.
 */
export default function MannatTaxInvoice({
  invoice = {},
  showPrintButton = true,
  onDownloadPdf,
  onExportImages,
  isDownloadingPdf,
  isNormalBill = false,
  billTitle,
}: MannatTaxInvoiceComponentProps) {
  const company: MannatInvoiceCompany = {
    ...DEFAULT_COMPANY,
    ...(invoice.company || {}),
  };
  const customer = invoice.customer || {};
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const suppliedTotals = invoice.totals || {};

  const [scale, setScale] = useState(1);
  const [isMobileScreen, setIsMobileScreen] = useState(false);
  const [fitScreen, setFitScreen] = useState(true);

  useEffect(() => {
    const handleResize = () => {
      if (typeof window !== 'undefined') {
        const isMobile = window.innerWidth < 820;
        setIsMobileScreen(isMobile);
        if (isMobile && fitScreen) {
          const availWidth = window.innerWidth - 20;
          // 210mm @ 96dpi is ~794px
          const s = Math.min(1, Math.max(0.38, availWidth / 794));
          setScale(s);
        } else {
          setScale(1);
        }
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [fitScreen]);

  const toggleFitMode = () => {
    if (fitScreen) {
      setFitScreen(false);
      setScale(1);
    } else {
      setFitScreen(true);
      const availWidth = (typeof window !== 'undefined' ? window.innerWidth : 794) - 20;
      setScale(Math.min(1, Math.max(0.38, availWidth / 794)));
    }
  };

  const lineAmountsDec = items.map((item) => {
    if (item.amount !== undefined && item.amount !== null && item.amount !== '') {
      return toDec(item.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
    return toDec(item.quantity).times(toDec(item.rate)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  });

  const rawItemsSubtotalDec = lineAmountsDec.reduce((sum, amt) => sum.plus(amt), new Decimal(0));
  const subtotalDec =
    suppliedTotals.subtotal !== undefined && suppliedTotals.subtotal !== ''
      ? toDec(suppliedTotals.subtotal)
      : rawItemsSubtotalDec;
  const discountAmountDec = toDec(suppliedTotals.discountAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const hasExplicitTaxable =
    suppliedTotals.taxableAmount !== undefined && suppliedTotals.taxableAmount !== '';
  const taxableAmountDec = hasExplicitTaxable
    ? toDec(suppliedTotals.taxableAmount)
    : Decimal.max(0, subtotalDec.minus(discountAmountDec));

  const effectiveDiscountDec = discountAmountDec.gt(0)
    ? discountAmountDec
    : Decimal.max(0, subtotalDec.minus(taxableAmountDec));
  const hasDiscount = effectiveDiscountDec.gt(0);

  const cgstAmountDec = isNormalBill ? new Decimal(0) : toDec(suppliedTotals.cgstAmount);
  const sgstAmountDec = isNormalBill ? new Decimal(0) : toDec(suppliedTotals.sgstAmount);
  const igstAmountDec = isNormalBill ? new Decimal(0) : toDec(suppliedTotals.igstAmount);
  const igstRateDec = toDec(suppliedTotals.igstRate);

  const hasExplicitTax = suppliedTotals.taxAmount !== undefined && suppliedTotals.taxAmount !== '';
  const taxAmountDec = isNormalBill
    ? new Decimal(0)
    : hasExplicitTax
      ? toDec(suppliedTotals.taxAmount)
      : cgstAmountDec.plus(sgstAmountDec).plus(igstAmountDec);

  const hasExplicitGrandTotal =
    suppliedTotals.grandTotal !== undefined && suppliedTotals.grandTotal !== '';
  const grandTotalDec = hasExplicitGrandTotal
    ? toDec(suppliedTotals.grandTotal)
    : taxableAmountDec.plus(taxAmountDec);

  const isInterState =
    !isNormalBill &&
    (igstAmountDec.gt(0) || igstRateDec.gt(0)) &&
    cgstAmountDec.eq(0) &&
    sgstAmountDec.eq(0);

  const discountLabel =
    suppliedTotals.discountType === 'percentage' && toDec(suppliedTotals.discountValue).gt(0)
      ? `Discount (${toDec(suppliedTotals.discountValue).toFixed(2).replace(/\.00$/, '')}%)`
      : 'Discount';

  const amountWords = invoice.amountInWords || numberWords(grandTotalDec.toFixed(2));

  const printInvoice = () => window.print();
  const displayTitle = billTitle || (isNormalBill ? 'NORMAL BILL' : 'TAX INVOICE');

  return (
    <div className="mhi-root">
      {showPrintButton && (
        <div className="mhi-toolbar mhi-no-print">
          <div className="flex items-center gap-2">
            <span className="font-bold text-neutral-800 text-xs sm:text-sm">
              {isNormalBill ? 'Official Bill · A4' : 'Official Tax Invoice · A4'}
            </span>
            {isMobileScreen && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-semibold">
                Mobile Preview
              </span>
            )}
          </div>
          <div className="mhi-toolbar-actions flex flex-wrap items-center gap-2">
            {isMobileScreen && (
              <button
                type="button"
                onClick={toggleFitMode}
                className="bg-neutral-200 hover:bg-neutral-300 text-neutral-800 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition"
                title={fitScreen ? 'Switch to 100% full size' : 'Fit full invoice to phone screen'}
              >
                {fitScreen ? '🔍 100% Zoom' : '📱 Fit Screen'}
              </button>
            )}

            {onDownloadPdf && (
              <button
                type="button"
                onClick={onDownloadPdf}
                disabled={isDownloadingPdf}
                className="bg-neutral-800 hover:bg-neutral-900 text-white px-3.5 py-1.5 rounded-lg text-xs font-bold transition disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {isDownloadingPdf ? 'Generating PDF...' : 'Download Official PDF'}
              </button>
            )}

            {onExportImages && (
              <button
                type="button"
                onClick={onExportImages}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5"
              >
                Export Images (.webp)
              </button>
            )}

            <button
              type="button"
              onClick={printInvoice}
              className="bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5"
            >
              Print / Save PDF (A4)
            </button>
          </div>
        </div>
      )}

      <div className="mhi-preview-container">
        <main
          className="mhi-page"
          style={
            scale < 1
              ? {
                  transform: `scale(${scale})`,
                  transformOrigin: 'top center',
                  marginBottom: `-${Math.round((1 - scale) * 1100)}px`,
                }
              : undefined
          }
        >
          <article className="mhi-invoice" aria-label={`${company.name || ''} ${displayTitle}`.trim()}>
          <header className="mhi-shop-header">
            <div className="mhi-topline">
              <strong>GSTIN : {company.gstin || ''}</strong>
              <strong className="mhi-tax-title">{displayTitle}</strong>
              <strong>Mob.: {company.phone || ''}</strong>
            </div>
            <div className="mhi-shop-name">{company.name || ''}</div>
            <div className="mhi-shop-address">{company.address || ''}</div>
          </header>

          <section className="mhi-invoice-meta">
            <div className="mhi-meta-left">
              <div className="mhi-meta-line">
                <span>No.</span><strong>{invoice.invoiceNumber || ''}</strong>
                <span>Date :</span><strong>{printableDate(invoice.invoiceDate)}</strong>
              </div>
              <div className="mhi-meta-line mhi-state-line">
                <span>State :</span><strong>{company.state || ''}</strong>
                <span>State Code :</span><strong>{company.stateCode || ''}</strong>
              </div>
            </div>
            <div className="mhi-meta-right">
              <div className="mhi-meta-line">
                <span>Transportation Mode :</span><span className="mhi-fill-line">{invoice.transportationMode || ''}</span>
                <span>Vehicle No. :</span><span className="mhi-fill-line">{invoice.vehicleNumber || ''}</span>
              </div>
              <div className="mhi-meta-line">
                <span>Dt. of Supply :</span><span className="mhi-fill-line">{printableDate(invoice.dateOfSupply)}</span>
                <span>Place of Supply :</span><span className="mhi-fill-line">{invoice.placeOfSupply || ''}</span>
              </div>
            </div>
          </section>

          <section className="mhi-bill-to">
            <div className="mhi-section-label">Details of Receiver (Bill to Party)</div>
            <div className="mhi-customer-line"><strong>Name :</strong><span>{customer.name || ''}</span></div>
            <div className="mhi-customer-line"><strong>Address :</strong><span>{customer.address || ''}</span></div>
            <div className="mhi-customer-bottom">
              <div className="mhi-customer-gstin"><strong>GSTIN :</strong><span>{customer.gstin || ''}</span></div>
              <div><strong>State :</strong><span>{customer.state || ''}</span></div>
              <div><strong>State Code :</strong><span>{customer.stateCode || ''}</span></div>
            </div>
          </section>

          <section className="mhi-goods-section">
            <div className="mhi-goods-heading mhi-columns">
              <div>S.<br />No.</div>
              <div>Description of goods</div>
              <div>HSN</div>
              <div>Qty.</div>
              <div>Rate<br />(Rs.)</div>
              <div>Amount<br />(Rs.)</div>
            </div>

            <div className="mhi-goods-area">
              <div className="mhi-items-list">
                {items.map((item, index) => (
                  <div className="mhi-item-row mhi-columns" key={item.id || `${item.name}-${index}`}>
                    <div>{index + 1}.</div>
                    <div className="mhi-item-description">{item.name || item.description || ''}</div>
                    <div>{item.hsn || ''}</div>
                    <div>{item.quantity ?? ''}{item.unit ? ` ${item.unit}` : ''}</div>
                    <div>{item.rate === undefined || item.rate === null ? '' : money(item.rate)}{item.rateUnit ? ` / ${item.rateUnit}` : ''}</div>
                    <div>{money(lineAmountsDec[index].toFixed(2))}</div>
                  </div>
                ))}
              </div>

              <div className="mhi-tax-summary">
                {isNormalBill ? (
                  <>
                    {hasDiscount && (
                      <>
                        <div>
                          <strong>Subtotal</strong>
                          <span>{money(subtotalDec.toFixed(2))}</span>
                        </div>
                        <div>
                          <strong>{discountLabel}</strong>
                          <span>- {money(effectiveDiscountDec.toFixed(2))}</span>
                        </div>
                      </>
                    )}
                    <div>
                      <strong>Total Amount</strong>
                      <span>{money((taxableAmountDec.gt(0) || hasDiscount ? taxableAmountDec : grandTotalDec).toFixed(2))}</span>
                    </div>
                    <div className="mhi-grand-total">
                      <strong>Grand Total</strong>
                      <span>{money(grandTotalDec.toFixed(2))}</span>
                    </div>
                  </>
                ) : (
                  <>
                    {hasDiscount && (
                      <>
                        <div>
                          <strong>Subtotal</strong>
                          <span>{money(subtotalDec.toFixed(2))}</span>
                        </div>
                        <div>
                          <strong>{discountLabel}</strong>
                          <span>- {money(effectiveDiscountDec.toFixed(2))}</span>
                        </div>
                      </>
                    )}
                    <div><strong>T. Amt. Before Tax</strong><span>{money(taxableAmountDec.toFixed(2))}</span></div>
                    {isInterState ? (
                      <div>
                        <strong>IGST @ {suppliedTotals.igstRate ?? ''}{suppliedTotals.igstRate !== undefined && suppliedTotals.igstRate !== '' ? '%' : ''}</strong>
                        <span>{money(igstAmountDec.toFixed(2))}</span>
                      </div>
                    ) : (
                      <>
                        <div>
                          <strong>CGST @ {suppliedTotals.cgstRate ?? ''}{suppliedTotals.cgstRate !== undefined && suppliedTotals.cgstRate !== '' ? '%' : ''}</strong>
                          <span>{money(cgstAmountDec.toFixed(2))}</span>
                        </div>
                        <div>
                          <strong>SGST @ {suppliedTotals.sgstRate ?? ''}{suppliedTotals.sgstRate !== undefined && suppliedTotals.sgstRate !== '' ? '%' : ''}</strong>
                          <span>{money(sgstAmountDec.toFixed(2))}</span>
                        </div>
                      </>
                    )}
                    <div><strong>Tax Amount GST</strong><span>{money(taxAmountDec.toFixed(2))}</span></div>
                    <div className="mhi-grand-total"><strong>T. Amount After Tax</strong><span>{money(grandTotalDec.toFixed(2))}</span></div>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="mhi-amount-words">
            <strong>Amount in Words :</strong>
            <span>{amountWords}</span>
          </section>

          <footer className="mhi-invoice-footer">
            <div className="mhi-footer-left">
              <strong className="mhi-eoe">E.&amp;O.E.</strong>
              <div>All disputes are subject to</div>
              <strong>{company.jurisdiction || 'Subject to seller jurisdiction.'}</strong>
            </div>
            <div className="mhi-footer-right">
              <em>Certified that the particulars given above are true and correct.</em>
              <strong className="mhi-for-shop">{company.name ? `For ${company.name}` : 'Authorised Signatory'}</strong>
              <div className="mhi-signature-wrap">
                <div className="mhi-signature-rule" />
                <strong>Authorised Signatory</strong>
              </div>
            </div>
          </footer>
        </article>
      </main>
      </div>
    </div>
  );
}
