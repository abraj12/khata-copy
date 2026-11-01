import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { NASREEN_SIGNATURE_BASE64 } from './gstInvoices.signature.js';

export interface GstInvoicePdfItem {
  name: string;
  hsn?: string | null;
  quantity: number | string;
  unit?: string | null;
  rate: number | string;
  rateUnit?: string | null;
  amount: number | string;
}

export interface GstInvoicePdfData {
  invoiceNumber: string;
  invoiceDate: string;
  state?: string;
  stateCode?: string;
  transportationMode?: string | null;
  vehicleNumber?: string | null;
  dateOfSupply?: string | null;
  placeOfSupply?: string | null;
  customer: {
    name: string;
    address?: string | null;
    gstin?: string | null;
    state?: string | null;
    stateCode?: string | null;
  };
  items: GstInvoicePdfItem[];
  totals: {
    taxableAmount: number | string;
    cgstRate?: number | string;
    cgstAmount?: number | string;
    sgstRate?: number | string;
    sgstAmount?: number | string;
    igstRate?: number | string;
    igstAmount?: number | string;
    taxAmount: number | string;
    grandTotal: number | string;
  };
  amountInWords?: string;
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

export function formatDateToIndian(val?: any): string {
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

export function generateMannatInvoicePdf(data: GstInvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 18,
        info: {
          Title: `Tax Invoice ${data.invoiceNumber} - M/s Mannat Hardware Store`,
          Author: 'M/s Mannat Hardware Store',
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
      doc.text('GSTIN : 09DFEPN5357D1ZB', left + 6, top + 6);
      doc.fontSize(14).text('TAX INVOICE', left, top + 5, { align: 'center', underline: true });
      doc.fontSize(9).text('Mob.: 94938 40000', left, top + 6, { align: 'right', width: width - 6 });

      // Shop Name & Address
      doc.fontSize(22).font('Helvetica-Bold').text('M/s Mannat Hardware Store', left, top + 26, { align: 'center' });
      doc.fontSize(10).font('Helvetica-Bold').text('Shaniwar Bazar Ki Pulia, Near Shama Marriage Hall, Bilaspur (Rampur) U. P.', left, top + 52, { align: 'center' });

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
      doc.font('Helvetica-Bold').fontSize(9).text('Uttar Pradesh   ', { continued: true });
      doc.font('Helvetica').fontSize(8).text('State Code : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(9).text('09');

      // Right meta
      doc.font('Helvetica').fontSize(8).text('Transportation Mode : ', metaMidX + 6, y + 8, { continued: true });
      doc.font('Helvetica-Bold').fontSize(8).text(`${data.transportationMode || ''}   `, { continued: true });
      doc.font('Helvetica').fontSize(8).text('Vehicle No. : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(8).text(data.vehicleNumber || '');

      doc.font('Helvetica').fontSize(8).text('Dt. of Supply : ', metaMidX + 6, y + 26, { continued: true });
      doc.font('Helvetica-Bold').fontSize(8).text(`${formatDateToIndian(data.dateOfSupply)}   `, { continued: true });
      doc.font('Helvetica').fontSize(8).text('Place of Supply : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(8).text(data.placeOfSupply || '');

      // Line below meta
      y += 45;
      doc.lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke();

      // Receiver details
      doc.font('Helvetica-Bold').fontSize(9).text('Details of Receiver (Bill to Party)', left + 6, y + 5);
      doc.font('Helvetica-Bold').fontSize(8.5).text('Name : ', left + 6, y + 20, { continued: true });
      doc.font('Helvetica').text(data.customer?.name || '');

      doc.font('Helvetica-Bold').fontSize(8.5).text('Address : ', left + 6, y + 35, { continued: true });
      doc.font('Helvetica').text(data.customer?.address || '');

      doc.font('Helvetica-Bold').fontSize(8.5).text('GSTIN : ', left + 6, y + 50, { continued: true });
      doc.font('Helvetica').text(`${data.customer?.gstin || ''}   `, { continued: true });
      doc.font('Helvetica-Bold').text('State : ', { continued: true });
      doc.font('Helvetica').text(`${data.customer?.state || 'Uttar Pradesh'}   `, { continued: true });
      doc.font('Helvetica-Bold').text('State Code : ', { continued: true });
      doc.font('Helvetica').text(data.customer?.stateCode || '09');

      // Line below Receiver
      y += 66;
      doc.lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke();

      // Table Columns definition: 6%, 39%, 13%, 9%, 16%, 17%
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
        left + width,
      ];

      const tableHeaderHeight = 24;
      // Header labels
      doc.font('Helvetica-Bold').fontSize(8.5);
      doc.text('S.\nNo.', colX[0], y + 3, { width: colWidths[0], align: 'center' });
      doc.text('Description of goods', colX[1], y + 8, { width: colWidths[1], align: 'center' });
      doc.text('HSN', colX[2], y + 8, { width: colWidths[2], align: 'center' });
      doc.text('Qty.', colX[3], y + 8, { width: colWidths[3], align: 'center' });
      doc.text('Rate\n(Rs.)', colX[4], y + 3, { width: colWidths[4], align: 'center' });
      doc.text('Amount\n(Rs.)', colX[5], y + 3, { width: colWidths[5], align: 'center' });

      // Table line below headers
      const tableContentTop = y + tableHeaderHeight;
      doc.lineWidth(1).moveTo(left, tableContentTop).lineTo(left + width, tableContentTop).stroke();

      // Table Body area
      const tableHeight = 350;
      const tableBottom = tableContentTop + tableHeight;

      // Draw vertical column dividers across table
      for (let i = 1; i < colX.length - 1; i++) {
        doc.lineWidth(0.8).moveTo(colX[i], y).lineTo(colX[i], tableBottom).stroke();
      }

      // Draw items
      let itemY = tableContentTop + 5;
      (data.items || []).forEach((item, idx) => {
        doc.font('Helvetica').fontSize(8);
        doc.text(`${idx + 1}.`, colX[0], itemY, { width: colWidths[0], align: 'center' });
        doc.text(item.name || '', colX[1] + 4, itemY, { width: colWidths[1] - 8, align: 'left' });
        doc.text(item.hsn || '', colX[2], itemY, { width: colWidths[2], align: 'center' });
        doc.text(`${item.quantity ?? ''}${item.unit ? ' ' + item.unit : ''}`, colX[3], itemY, { width: colWidths[3], align: 'center' });
        doc.text(item.rate !== undefined && item.rate !== null ? Number(item.rate).toFixed(2) : '', colX[4], itemY, { width: colWidths[4] - 4, align: 'right' });
        doc.text(item.amount !== undefined && item.amount !== null ? Number(item.amount).toFixed(2) : '', colX[5], itemY, { width: colWidths[5] - 4, align: 'right' });
        itemY += 18;
      });

      // Tax summary box at bottom right (width 42% = covers col 4 and col 5)
      const taxBoxWidth = width * 0.42;
      const taxBoxLeft = left + width - taxBoxWidth;
      const taxBoxRowHeight = 16.5;
      const taxBoxRows = 6;
      const taxBoxHeight = taxBoxRowHeight * taxBoxRows;
      const taxBoxTop = tableBottom - taxBoxHeight;

      // Fill white background for tax box to obscure table dividers
      doc.rect(taxBoxLeft, taxBoxTop, taxBoxWidth, taxBoxHeight).fillAndStroke('#ffffff', '#000000');

      const taxSplitX = taxBoxLeft + taxBoxWidth * 0.58;
      doc.moveTo(taxSplitX, taxBoxTop).lineTo(taxSplitX, tableBottom).stroke();

      const totals = data.totals || {};
      const cgstDisplay = totals.cgstRate ? `CGST @ ${totals.cgstRate}%` : 'CGST @';
      const sgstDisplay = totals.sgstRate ? `SGST @ ${totals.sgstRate}%` : 'SGST @';
      const igstDisplay = totals.igstRate ? `IGST @ ${totals.igstRate}%` : 'IGST @';

      const taxRows = [
        ['T. Amt. Before Tax', Number(totals.taxableAmount || 0).toFixed(2)],
        [cgstDisplay, Number(totals.cgstAmount || 0).toFixed(2)],
        [sgstDisplay, Number(totals.sgstAmount || 0).toFixed(2)],
        [igstDisplay, Number(totals.igstAmount || 0).toFixed(2)],
        ['Tax Amount GST', Number(totals.taxAmount || 0).toFixed(2)],
        ['T. Amount After Tax', Number(totals.grandTotal || 0).toFixed(2)],
      ];

      taxRows.forEach((r, idx) => {
        const ry = taxBoxTop + idx * taxBoxRowHeight;
        if (idx > 0) {
          doc.lineWidth(0.5).moveTo(taxBoxLeft, ry).lineTo(taxBoxLeft + taxBoxWidth, ry).stroke();
        }
        const isTotal = idx === taxRows.length - 1;
        doc.font(isTotal ? 'Helvetica-Bold' : 'Helvetica-Bold').fontSize(isTotal ? 8.5 : 7.5);
        doc.fillColor('#000000').text(r[0], taxBoxLeft + 4, ry + 4, { width: taxBoxWidth * 0.55 });
        doc.text(r[1], taxSplitX, ry + 4, { width: taxBoxWidth * 0.42 - 4, align: 'right' });
      });

      // Line below table
      doc.lineWidth(1).moveTo(left, tableBottom).lineTo(left + width, tableBottom).stroke();

      // Amount in words
      const wordsY = tableBottom;
      const wordsHeight = 24;
      const amountWords = data.amountInWords || numberToIndianWords(totals.grandTotal);
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
      doc.font('Helvetica-Bold').fontSize(9).text('Rampur Jurisdiction only.', left + 6, footerY + 36);

      // Footer Right
      const rightW = width - (footerMidX - left);
      doc.font('Helvetica-Oblique').fontSize(8).text('Certified that the particulars given above are true and correct.', footerMidX, footerY + 6, { align: 'right', width: rightW - 8 });
      doc.font('Helvetica-Bold').fontSize(10).text('For M/s Mannat Hardware Store', footerMidX, footerY + 18, { align: 'right', width: rightW - 8 });

      // Embed signature
      try {
        let sigBuffer: Buffer | null = null;
        const candidatePaths = [
          path.resolve('backend/assets/nasreen-signature.png'),
          path.resolve('assets/nasreen-signature.png'),
          path.resolve(process.cwd(), 'backend/assets/nasreen-signature.png'),
          path.resolve(process.cwd(), 'assets/nasreen-signature.png'),
        ];
        for (const p of candidatePaths) {
          if (fs.existsSync(p)) {
            sigBuffer = fs.readFileSync(p);
            break;
          }
        }
        if (!sigBuffer && NASREEN_SIGNATURE_BASE64) {
          sigBuffer = Buffer.from(NASREEN_SIGNATURE_BASE64, 'base64');
        }
        if (sigBuffer) {
          doc.image(sigBuffer, left + width - 110, footerY + 28, { width: 90, height: 26 });
        }
      } catch (sigErr) {
        console.warn('[PDF] Could not embed signature image:', sigErr);
      }

      // Signature line & label
      doc.lineWidth(0.8).moveTo(left + width - 120, footerY + 58).lineTo(left + width - 10, footerY + 58).stroke();
      doc.font('Helvetica-Bold').fontSize(8.5).text('Authorised Signatory', left + width - 120, footerY + 62, { width: 110, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
