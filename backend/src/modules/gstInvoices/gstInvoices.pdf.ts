import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';


export interface GstInvoicePdfItem {
  name: string;
  hsn?: string | null;
  quantity: string | number;
  unit?: string | null;
  rate: string | number;
  rateUnit?: string | null;
  amount: string | number;
}

export interface GstInvoicePdfData {
  invoiceNumber: string;
  invoiceDate: string | Date;
  state?: string;
  stateCode?: string;
  transportationMode?: string | null;
  vehicleNumber?: string | null;
  dateOfSupply?: string | Date | null;
  placeOfSupply?: string | null;
  customer?: {
    name: string;
    address?: string | null;
    gstin?: string | null;
    state?: string;
    stateCode?: string;
    phone?: string | null;
  };
  items: GstInvoicePdfItem[];
  totals?: {
    taxableAmount?: string | number;
    cgstRate?: string | number;
    cgstAmount?: string | number;
    sgstRate?: string | number;
    sgstAmount?: string | number;
    igstRate?: string | number;
    igstAmount?: string | number;
    taxAmount?: string | number;
    grandTotal?: string | number;
  };
  amountInWords?: string;
  isNormalBill?: boolean;
  billTitle?: string;
}

export function numberToIndianWords(value: number | string): string {
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

  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return '';
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  const rupees = Math.floor(rounded);
  const paise = Math.round((rounded - rupees) * 100);
  return `Rupees ${indianInteger(rupees)}${paise ? ` and ${indianInteger(paise)} Paise` : ''} Only`;
}

/**
 * Strictly format date to DD-MM-YYYY
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

export function generateTaxInvoicePdf(data: GstInvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const isNormalBill = Boolean(data.isNormalBill);
      const invoiceTitle = data.billTitle || (isNormalBill ? 'NORMAL BILL' : 'TAX INVOICE');

      const doc = new PDFDocument({
        size: 'A4',
        margin: 18,
        info: {
          Title: `${invoiceTitle} ${data.invoiceNumber} - Algions AI Labs Private Limited`,
          Author: 'Algions AI Labs Private Limited',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const margin = 18;
      const width = 595.28 - margin * 2; // 559.28 pt
      const height = 841.89 - margin * 2; // 805.89 pt
      const left = margin;
      const top = margin;

      // Outer border (1.5pt solid black)
      doc.lineWidth(1.5).rect(left, top, width, height).stroke('#000000');

      // Top Header
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');
      doc.text('GSTIN : 10ABGCA8624E1Z3', left + 6, top + 6);
      doc.fontSize(14).text(invoiceTitle, left, top + 5, { align: 'center', underline: true });
      doc.fontSize(9).text('Mob.: 94938 40000', left, top + 6, { align: 'right', width: width - 6 });

      // Company Name & Address
      doc.fontSize(18).font('Helvetica-Bold').text('ALGIONS AI LABS PRIVATE LIMITED', left, top + 26, { align: 'center' });
      doc.fontSize(8.5).font('Helvetica-Bold').text('House no 145A, Ward no 26, Haziyapur, Gopalganj, Bihar - 841428', left, top + 52, { align: 'center' });

      // Horizontal line below header
      let y = top + 70;
      doc.lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke();

      // Meta grid (left 44%, right 56%)
      const metaMidX = left + width * 0.44;
      doc.moveTo(metaMidX, y).lineTo(metaMidX, y + 45).stroke();

      doc.fontSize(8).font('Helvetica');
      // Left meta
      doc.text('No.', left + 6, y + 8, { continued: true });
      doc.font('Helvetica-Bold').fontSize(9).text(`  ${data.invoiceNumber || ''}   `, { continued: true });
      doc.font('Helvetica').fontSize(8).text('Date : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(9).text(formatDateToIndian(data.invoiceDate));

      doc.font('Helvetica').fontSize(8).text('State : ', left + 6, y + 26, { continued: true });
      doc.font('Helvetica-Bold').fontSize(9).text(`${data.state || 'Bihar'}   `, { continued: true });
      doc.font('Helvetica').fontSize(8).text('State Code : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(9).text(data.stateCode || '10');

      // Right meta
      const rightColLeft = metaMidX + 6;
      doc.font('Helvetica').fontSize(7.5).text('Transportation Mode : ', rightColLeft, y + 8, { continued: true });
      doc.font('Helvetica-Bold').fontSize(8.5).text(`${data.transportationMode || ''}   `, { continued: true });
      doc.font('Helvetica').fontSize(7.5).text('Vehicle No. : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(8.5).text(data.vehicleNumber || '');

      doc.font('Helvetica').fontSize(7.5).text('Dt. of Supply : ', rightColLeft, y + 26, { continued: true });
      doc.font('Helvetica-Bold').fontSize(8.5).text(`${formatDateToIndian(data.dateOfSupply)}   `, { continued: true });
      doc.font('Helvetica').fontSize(7.5).text('Place of Supply : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(8.5).text(data.placeOfSupply || '');

      y += 45;
      // Line below meta
      doc.lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke();

      // Bill to Party Section
      const billToHeight = 70;
      doc.font('Helvetica-Bold').fontSize(9).text('Details of Receiver (Bill to Party)', left + 6, y + 5);
      doc.font('Helvetica-Bold').fontSize(8.5).text('Name : ', left + 6, y + 18, { continued: true });
      doc.font('Helvetica').fontSize(8.5).text(data.customer?.name || '');

      // Guarded Address Section: Supports multi-line addresses with ellipsis safety boundary
      doc.font('Helvetica-Bold').fontSize(8.5).text('Address : ', left + 6, y + 30, { continued: true });
      const addressText = (data.customer?.address || '').trim();
      doc.font('Helvetica').fontSize(7.5).text(addressText, {
        width: width - 70,
        height: 22,
        ellipsis: true,
      });

      const bottomLineY = y + 54;
      doc.font('Helvetica-Bold').fontSize(8.5).text('GSTIN : ', left + 6, bottomLineY, { continued: true });
      doc.font('Helvetica').fontSize(8.5).text(`${data.customer?.gstin || ''}              `, { continued: true });
      doc.font('Helvetica-Bold').fontSize(8.5).text('State : ', { continued: true });
      doc.font('Helvetica').fontSize(8.5).text(`${data.customer?.state || 'Bihar'}           `, { continued: true });
      doc.font('Helvetica-Bold').fontSize(8.5).text('State Code : ', { continued: true });
      doc.font('Helvetica').fontSize(8.5).text(data.customer?.stateCode || '10');

      y += billToHeight;
      // Line below Bill to
      doc.lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke();

      // Table Header
      const tableHeaderHeight = 26;
      const colWidths = [
        width * 0.06,  // S.No
        width * 0.39,  // Description
        width * 0.13,  // HSN
        width * 0.09,  // Qty
        width * 0.16,  // Rate
        width * 0.17,  // Amount
      ];
      const colX = [
        left,
        left + colWidths[0],
        left + colWidths[0] + colWidths[1],
        left + colWidths[0] + colWidths[1] + colWidths[2],
        left + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3],
        left + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4],
      ];

      doc.font('Helvetica-Bold').fontSize(8.5);
      doc.text('S.\nNo.', colX[0], y + 4, { width: colWidths[0], align: 'center' });
      doc.text('Description of goods', colX[1] + 4, y + 8, { width: colWidths[1] - 8, align: 'left' });
      doc.text('HSN', colX[2], y + 8, { width: colWidths[2], align: 'center' });
      doc.text('Qty.', colX[3], y + 8, { width: colWidths[3], align: 'center' });
      doc.text('Rate\n(Rs.)', colX[4], y + 4, { width: colWidths[4], align: 'center' });
      doc.text('Amount\n(Rs.)', colX[5], y + 4, { width: colWidths[5], align: 'center' });

      // Draw vertical lines in header
      colX.slice(1).forEach((x) => {
        doc.lineWidth(0.5).moveTo(x, y).lineTo(x, y + tableHeaderHeight).stroke();
      });

      y += tableHeaderHeight;
      doc.lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke();

      // Table Content Area
      const tableContentTop = y;
      const tableBottom = top + height - 120; // Reserve footer space

      // Tax/Bill summary box at bottom right (width 42% = covers col 4 and col 5)
      const taxBoxWidth = width * 0.42;
      const taxBoxLeft = left + width - taxBoxWidth;
      const totals = data.totals || {};

      const cgstDisplay = totals.cgstRate ? `CGST @ ${totals.cgstRate}%` : 'CGST @';
      const sgstDisplay = totals.sgstRate ? `SGST @ ${totals.sgstRate}%` : 'SGST @';
      const igstDisplay = totals.igstRate ? `IGST @ ${totals.igstRate}%` : 'IGST @';

      const taxRows: Array<[string, string]> = isNormalBill
        ? [
            ['Total Amount', Number(totals.taxableAmount || totals.grandTotal || 0).toFixed(2)],
            ['Grand Total', Number(totals.grandTotal || 0).toFixed(2)],
          ]
        : [
            ['T. Amt. Before Tax', Number(totals.taxableAmount || 0).toFixed(2)],
            [cgstDisplay, Number(totals.cgstAmount || 0).toFixed(2)],
            [sgstDisplay, Number(totals.sgstAmount || 0).toFixed(2)],
            [igstDisplay, Number(totals.igstAmount || 0).toFixed(2)],
            ['Tax Amount GST', Number(totals.taxAmount || 0).toFixed(2)],
            ['T. Amount After Tax', Number(totals.grandTotal || 0).toFixed(2)],
          ];

      const taxBoxRowHeight = isNormalBill ? 22 : 16.5;
      const taxBoxRows = taxRows.length;
      const taxBoxHeight = taxBoxRowHeight * taxBoxRows;
      const taxBoxTop = tableBottom - taxBoxHeight;

      // Draw table column vertical lines down to tableBottom
      colX.slice(1).forEach((x) => {
        doc.lineWidth(0.5).moveTo(x, tableContentTop).lineTo(x, tableBottom).stroke();
      });

      // Item sizing and strict overflow guard
      const items = data.items || [];
      const itemCount = items.length;
      const itemFontSize = itemCount > 16 ? 6.5 : itemCount > 12 ? 7.5 : 8;
      const minRowHeight = itemCount > 16 ? 13 : itemCount > 12 ? 14 : 16;

      // 1. Preflight calculation: verify that EVERY item can fit in the printable area
      let simulatedY = tableContentTop + 4;
      for (const item of items) {
        doc.font('Helvetica').fontSize(itemFontSize);
        const nameHeight = doc.heightOfString(item.name || '', { width: colWidths[1] - 8 });
        const hsnHeight = doc.heightOfString(item.hsn || '', { width: colWidths[2] });
        const qtyHeight = doc.heightOfString(`${item.quantity ?? ''}${item.unit ? ' ' + item.unit : ''}`, { width: colWidths[3] });
        const maxContentHeight = Math.max(nameHeight, hsnHeight, qtyHeight);
        const rowHeight = Math.max(minRowHeight, maxContentHeight + 3);
        simulatedY += rowHeight;
      }

      if (simulatedY > taxBoxTop - 2) {
        throw new Error(
          `Cannot generate PDF: Invoice has ${itemCount} items whose total description heights exceed the single-page printable area. Total required height: ${Math.round(simulatedY - tableContentTop)}pt, available: ${Math.round(taxBoxTop - tableContentTop - 2)}pt. Please split into multiple invoices or shorten item descriptions.`
        );
      }

      // 2. Draw all verified items without omitting any item
      let itemY = tableContentTop + 4;
      let drawnCount = 0;

      items.forEach((item, idx) => {
        doc.font('Helvetica').fontSize(itemFontSize);
        const nameHeight = doc.heightOfString(item.name || '', { width: colWidths[1] - 8 });
        const hsnHeight = doc.heightOfString(item.hsn || '', { width: colWidths[2] });
        const qtyHeight = doc.heightOfString(`${item.quantity ?? ''}${item.unit ? ' ' + item.unit : ''}`, { width: colWidths[3] });
        const maxContentHeight = Math.max(nameHeight, hsnHeight, qtyHeight);
        const rowHeight = Math.max(minRowHeight, maxContentHeight + 3);

        doc.text(`${idx + 1}.`, colX[0], itemY, { width: colWidths[0], align: 'center' });
        doc.text(item.name || '', colX[1] + 4, itemY, { width: colWidths[1] - 8, align: 'left', lineBreak: true });
        doc.text(item.hsn || '', colX[2], itemY, { width: colWidths[2], align: 'center' });
        doc.text(`${item.quantity ?? ''}${item.unit ? ' ' + item.unit : ''}`, colX[3], itemY, { width: colWidths[3], align: 'center' });
        doc.text(item.rate !== undefined && item.rate !== null ? Number(item.rate).toFixed(2) : '', colX[4], itemY, { width: colWidths[4] - 4, align: 'right' });
        doc.text(item.amount !== undefined && item.amount !== null ? Number(item.amount).toFixed(2) : '', colX[5], itemY, { width: colWidths[5] - 4, align: 'right' });
        itemY += rowHeight;
        drawnCount++;
      });

      if (drawnCount < itemCount) {
        throw new Error(`PDF generation failure: Only ${drawnCount} of ${itemCount} items were rendered.`);
      }

      // Fill white background for tax box to obscure table dividers
      doc.rect(taxBoxLeft, taxBoxTop, taxBoxWidth, taxBoxHeight).fillAndStroke('#ffffff', '#000000');

      const taxSplitX = taxBoxLeft + taxBoxWidth * 0.58;
      doc.moveTo(taxSplitX, taxBoxTop).lineTo(taxSplitX, tableBottom).stroke();

      taxRows.forEach((r, idx) => {
        const ry = taxBoxTop + idx * taxBoxRowHeight;
        if (idx > 0) {
          doc.lineWidth(0.5).moveTo(taxBoxLeft, ry).lineTo(taxBoxLeft + taxBoxWidth, ry).stroke();
        }
        const isTotal = idx === taxRows.length - 1;
        doc.font('Helvetica-Bold').fontSize(isNormalBill ? 9 : isTotal ? 8.5 : 7.5);
        doc.fillColor('#000000').text(r[0], taxBoxLeft + 4, ry + (taxBoxRowHeight - (isNormalBill ? 10 : 8)) / 2, { width: taxBoxWidth * 0.55 });
        doc.text(r[1], taxSplitX, ry + (taxBoxRowHeight - (isNormalBill ? 10 : 8)) / 2, { width: taxBoxWidth * 0.42 - 4, align: 'right' });
      });

      // Line below table
      doc.lineWidth(1).moveTo(left, tableBottom).lineTo(left + width, tableBottom).stroke();

      // Amount in words
      const wordsY = tableBottom;
      const wordsHeight = 24;
      const amountWords = data.amountInWords || numberToIndianWords(totals.grandTotal || 0);
      doc.font('Helvetica-BoldOblique').fontSize(8.5).fillColor('#000000').text('Amount in Words : ', left + 6, wordsY + 6, { continued: true });
      doc.font('Helvetica-Oblique').fontSize(8.5).text(amountWords);
      doc.lineWidth(1).moveTo(left, wordsY + wordsHeight).lineTo(left + width, wordsY + wordsHeight).stroke();

      // Footer
      const footerY = wordsY + wordsHeight;
      const footerMidX = left + width * 0.39;
      doc.lineWidth(1).moveTo(footerMidX, footerY).lineTo(footerMidX, top + height).stroke();

      // Footer Left
      doc.font('Helvetica-Bold').fontSize(10).text('E.&O.E.', left + 6, footerY + 8);
      doc.font('Helvetica').fontSize(8.5).text('All disputes are subject to', left + 6, footerY + 24);
      doc.font('Helvetica-Bold').fontSize(9).text('Gopalganj Jurisdiction only.', left + 6, footerY + 36);

      // Footer Right
      const rightW = width - (footerMidX - left);
      doc.font('Helvetica-Oblique').fontSize(8).text('Certified that the particulars given above are true and correct.', footerMidX, footerY + 6, { align: 'right', width: rightW - 8 });
      doc.font('Helvetica-Bold').fontSize(10).text('For Algions AI Labs Private Limited', footerMidX, footerY + 18, { align: 'right', width: rightW - 8 });

      // Embed signature if configured
      try {
        let sigBuffer: Buffer | null = null;
        const candidatePaths = [
          path.resolve('backend/assets/company-signature.png'),
          path.resolve('assets/company-signature.png'),
          path.resolve(process.cwd(), 'backend/assets/company-signature.png'),
          path.resolve(process.cwd(), 'assets/company-signature.png'),
          path.resolve('backend/assets/signature.png'),
          path.resolve('assets/signature.png'),
        ];
        for (const p of candidatePaths) {
          if (fs.existsSync(p)) {
            sigBuffer = fs.readFileSync(p);
            break;
          }
        }
        if (sigBuffer) {
          doc.image(sigBuffer, left + width - 110, footerY + 28, { width: 90, height: 26 });
        }
      } catch (sigErr) {
        console.warn('[PDF] Signature image failed to load:', (sigErr as Error).message);
      }

      doc.font('Helvetica-Bold').fontSize(8.5).text('Authorised Signatory', footerMidX, footerY + 58, { align: 'right', width: rightW - 8 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Backward-compatible alias for existing callers.
 */
export const generateMannatInvoicePdf = generateTaxInvoicePdf;
