import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';
import PDFDocument from 'pdfkit';
import {
  formatDateToIndian,
  formatDecimalQty,
  formatIndianMoney,
  numberToIndianWords,
  splitTextBlockToHeight,
  stampPageNumbers,
} from '../../utils/pdfLayout.js';

export { numberToIndianWords, formatDateToIndian };

export interface GstInvoicePdfCompany {
  companyName: string;
  address: string;
  gstin?: string | null;
  phone?: string | null;
  state: string;
  stateCode: string;
  jurisdiction?: string | null;
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
  company?: GstInvoicePdfCompany;
  customer?: {
    name?: string | null;
    address?: string | null;
    gstin?: string | null;
    phone?: string | null;
    state?: string | null;
    stateCode?: string | null;
  };
  items?: Array<{
    name?: string | null;
    hsn?: string | null;
    quantity?: string | number | null;
    unit?: string | null;
    rate?: string | number | null;
    rateUnit?: string | null;
    amount?: string | number | null;
  }>;
  totals?: {
    subtotal?: string | number;
    discountType?: string | null;
    discountValue?: string | number;
    discountAmount?: string | number;
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

function toDec(val: string | number | null | undefined): Decimal {
  if (val === null || val === undefined || val === '') return new Decimal(0);
  try {
    const d = new Decimal(String(val).trim());
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

function resolveSignatureBuffer(): Buffer | null {
  try {
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
        return fs.readFileSync(p);
      }
    }
  } catch (sigErr) {
    console.warn('[PDF] Signature image failed to load:', (sigErr as Error).message);
  }
  return null;
}

/**
 * Generates an official A4 portrait Tax Invoice or Normal Bill PDF.
 * Supports 1 to 100+ items across any number of pages with repeated table headers,
 * non-truncated customer details and item descriptions (including single-item
 * cross-page wrapping), Decimal-accurate Indian currency formatting, single
 * end-of-document summary totals, and configurable jurisdiction notice.
 */
export function generateTaxInvoicePdf(data: GstInvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const isNormalBill = Boolean(data.isNormalBill);
      const invoiceTitle = data.billTitle || (isNormalBill ? 'NORMAL BILL' : 'TAX INVOICE');
      const supplierName = data.company?.companyName || 'ALGIONS AI LABS PRIVATE LIMITED';
      const supplierGstin = data.company?.gstin ?? '';
      const supplierPhone = data.company?.phone ?? '';
      const supplierAddress = (data.company?.address || '').replace(/\r?\n/g, ', ').trim();
      const supplierState = data.state || data.company?.state || '';
      const supplierStateCode = data.stateCode || data.company?.stateCode || '';
      const buyerState = data.customer?.state || '';
      const buyerStateCode = data.customer?.stateCode || '';
      const jurisdictionText =
        data.company?.jurisdiction?.trim() || 'Subject to seller jurisdiction.';

      const margin = 18;
      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const width = pageWidth - margin * 2; // 559.28pt
      const height = pageHeight - margin * 2 - 10; // 795.89pt frame, leaving 10pt below border for Page X of Y
      const left = margin;
      const top = margin;
      const frameBottom = top + height;

      const doc = new PDFDocument({
        size: 'A4',
        margin,
        bufferPages: true,
        info: {
          Title: `${invoiceTitle} ${data.invoiceNumber} - ${supplierName}`,
          Author: supplierName,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const drawOuterBorder = () => {
        doc.lineWidth(1.5).rect(left, top, width, height).stroke('#000000');
      };

      const colWidths = [
        width * 0.06, // S.No
        width * 0.39, // Description
        width * 0.13, // HSN
        width * 0.09, // Qty
        width * 0.16, // Rate
        width * 0.17, // Amount
      ];
      const colX = [
        left,
        left + colWidths[0],
        left + colWidths[0] + colWidths[1],
        left + colWidths[0] + colWidths[1] + colWidths[2],
        left + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3],
        left + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4],
      ];

      const tableHeaderHeight = 26;
      const drawTableHeader = (headerY: number): number => {
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8.5);
        doc.text('S.\nNo.', colX[0], headerY + 4, { width: colWidths[0], align: 'center' });
        doc.text('Description of goods', colX[1] + 4, headerY + 8, { width: colWidths[1] - 8, align: 'left' });
        doc.text('HSN', colX[2], headerY + 8, { width: colWidths[2], align: 'center' });
        doc.text('Qty.', colX[3], headerY + 8, { width: colWidths[3], align: 'center' });
        doc.text('Rate\n(Rs.)', colX[4], headerY + 4, { width: colWidths[4], align: 'center' });
        doc.text('Amount\n(Rs.)', colX[5], headerY + 4, { width: colWidths[5], align: 'center' });

        colX.slice(1).forEach((x) => {
          doc.lineWidth(0.5).moveTo(x, headerY).lineTo(x, headerY + tableHeaderHeight).stroke('#000000');
        });

        const nextY = headerY + tableHeaderHeight;
        doc.lineWidth(1).moveTo(left, nextY).lineTo(left + width, nextY).stroke('#000000');
        return nextY;
      };

      const drawColumnGrid = (fromY: number, toY: number) => {
        if (toY <= fromY) return;
        colX.slice(1).forEach((x) => {
          doc.lineWidth(0.5).moveTo(x, fromY).lineTo(x, toY).stroke('#000000');
        });
      };

      const startContinuationPage = (withTableHeader: boolean): { contentTop: number; yStart: number } => {
        doc.addPage({ size: 'A4', margin });
        drawOuterBorder();

        const stripHeight = 28;
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9.5);
        doc.text(`${invoiceTitle}  —  No. ${data.invoiceNumber || ''} (Contd.)`, left + 8, top + 9, {
          width: width * 0.56,
        });
        doc.font('Helvetica').fontSize(8.5).text(
          `${supplierName}  |  Date: ${formatDateToIndian(data.invoiceDate)}`,
          left + 8,
          top + 9,
          {
            width: width - 16,
            align: 'right',
          }
        );

        const lineY = top + stripHeight;
        doc.lineWidth(1).moveTo(left, lineY).lineTo(left + width, lineY).stroke('#000000');

        if (withTableHeader) {
          const contentTop = drawTableHeader(lineY);
          return { contentTop, yStart: contentTop + 4 };
        }
        return { contentTop: lineY, yStart: lineY + 8 };
      };

      // ================================================================
      // PAGE 1: BRANDED HEADER + META GRID + BILL-TO-PARTY (Dynamic!)
      // ================================================================
      drawOuterBorder();

      doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9);
      if (supplierGstin) {
        doc.text(`GSTIN : ${supplierGstin}`, left + 6, top + 6, { width: width * 0.36 });
      }
      doc.fontSize(14).text(invoiceTitle, left, top + 5, { width, align: 'center', underline: true });
      if (supplierPhone) {
        doc.fontSize(9).text(`Mob.: ${supplierPhone}`, left, top + 6, { align: 'right', width: width - 6 });
      }

      doc.fontSize(17).font('Helvetica-Bold');
      const compNameText = supplierName.toUpperCase();
      doc.text(compNameText, left + 10, top + 25, { align: 'center', width: width - 20 });
      let headerEndY = Math.max(top + 48, doc.y + 2);

      if (supplierAddress) {
        doc.fontSize(8.5).font('Helvetica-Bold');
        doc.text(supplierAddress, left + 14, headerEndY, { align: 'center', width: width - 28 });
        headerEndY = Math.max(headerEndY + 14, doc.y + 4);
      } else {
        headerEndY += 6;
      }

      let y = Math.max(top + 68, headerEndY);
      doc.lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke('#000000');

      // Meta grid (left 44%, right 56%) with dynamic wrapping safeguard
      const metaMidX = left + width * 0.44;
      const leftMetaW = metaMidX - left - 12;
      const rightMetaW = left + width - metaMidX - 12;

      const leftMetaLine1 = `No. ${data.invoiceNumber || ''}   |   Date : ${formatDateToIndian(data.invoiceDate)}`;
      const leftMetaLine2 = `State : ${supplierState}   |   Code : ${supplierStateCode}`;
      const rightMetaLine1 = `Transportation Mode : ${data.transportationMode || '—'}   |   Vehicle No. : ${data.vehicleNumber || '—'}`;
      const rightMetaLine2 = `Dt. of Supply : ${formatDateToIndian(data.dateOfSupply) || '—'}   |   Place of Supply : ${data.placeOfSupply || '—'}`;

      doc.font('Helvetica').fontSize(8);
      const l1H = doc.heightOfString(leftMetaLine1, { width: leftMetaW });
      const l2H = doc.heightOfString(leftMetaLine2, { width: leftMetaW });
      const r1H = doc.heightOfString(rightMetaLine1, { width: rightMetaW });
      const r2H = doc.heightOfString(rightMetaLine2, { width: rightMetaW });
      const metaHeight = Math.max(46, Math.max(l1H + l2H, r1H + r2H) + 18);

      doc.lineWidth(1).moveTo(metaMidX, y).lineTo(metaMidX, y + metaHeight).stroke('#000000');

      // Left meta values
      doc.font('Helvetica').fontSize(8).text('No. ', left + 6, y + 7, { continued: true });
      doc.font('Helvetica-Bold').fontSize(9).text(`${data.invoiceNumber || ''}   `, { continued: true });
      doc.font('Helvetica').fontSize(8).text('Date : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(9).text(formatDateToIndian(data.invoiceDate));

      const leftSecondY = y + Math.max(25, 11 + l1H);
      doc.font('Helvetica').fontSize(8).text('State : ', left + 6, leftSecondY, { continued: true });
      doc.font('Helvetica-Bold').fontSize(8.5).text(`${supplierState}   `, { continued: true });
      doc.font('Helvetica').fontSize(8).text('Code : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(8.5).text(supplierStateCode);

      // Right meta values
      const rightColLeft = metaMidX + 6;
      doc.font('Helvetica').fontSize(7.5).text('Transportation Mode : ', rightColLeft, y + 7, { continued: true });
      doc.font('Helvetica-Bold').fontSize(8).text(`${data.transportationMode || ''}   `, { continued: true });
      doc.font('Helvetica').fontSize(7.5).text('Vehicle No. : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(8).text(data.vehicleNumber || '', { width: rightMetaW });

      const rightSecondY = y + Math.max(25, 11 + r1H);
      doc.font('Helvetica').fontSize(7.5).text('Dt. of Supply : ', rightColLeft, rightSecondY, { continued: true });
      doc.font('Helvetica-Bold').fontSize(8).text(`${formatDateToIndian(data.dateOfSupply)}   `, { continued: true });
      doc.font('Helvetica').fontSize(7.5).text('Place of Supply : ', { continued: true });
      doc.font('Helvetica-Bold').fontSize(8).text(data.placeOfSupply || '', { width: rightMetaW });

      y += metaHeight;
      doc.lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke('#000000');

      // Bill to Party Section (Dynamic height — NO height cap, NO ellipsis clipping!)
      const billNameLine = `Name : ${data.customer?.name || ''}`;
      const addressText = (data.customer?.address || '').trim();
      const addrLine = addressText ? `Address : ${addressText}` : 'Address :';
      const receiverMetaParts = [
        !isNormalBill || data.customer?.gstin ? `GSTIN : ${data.customer?.gstin || ''}` : null,
        data.customer?.phone ? `Phone : ${data.customer.phone}` : null,
        `State : ${buyerState}`,
        `State Code : ${buyerStateCode}`,
      ].filter(Boolean);
      const receiverMetaText = receiverMetaParts.join('       ');

      doc.font('Helvetica').fontSize(8.5);
      const billNameH = doc.heightOfString(billNameLine, { width: width - 16 });
      doc.font('Helvetica').fontSize(8);
      const billAddrH = doc.heightOfString(addrLine, { width: width - 16 });
      doc.font('Helvetica').fontSize(8.5);
      const billMetaH = doc.heightOfString(receiverMetaText, { width: width - 16 });

      const billToHeight = Math.max(66, 20 + billNameH + 3 + billAddrH + 4 + billMetaH + 6);

      doc.font('Helvetica-Bold').fontSize(9).text('Details of Receiver (Bill to Party)', left + 6, y + 5);
      let btY = y + 18;
      doc.font('Helvetica-Bold').fontSize(8.5).text('Name : ', left + 6, btY, { continued: true });
      doc.font('Helvetica').fontSize(8.5).text(data.customer?.name || '', { width: width - 16 });
      btY = Math.max(btY + 12, doc.y + 2);

      doc.font('Helvetica-Bold').fontSize(8).text('Address : ', left + 6, btY, { continued: true });
      doc.font('Helvetica').fontSize(8).text(addressText, { width: width - 16 });
      btY = Math.max(btY + 14, doc.y + 3);

      doc.font('Helvetica').fontSize(8.5).text(receiverMetaText, left + 6, btY, { width: width - 16 });

      y += billToHeight;
      doc.lineWidth(1).moveTo(left, y).lineTo(left + width, y).stroke('#000000');

      // ================================================================
      // PREPARE FINAL SUMMARY ROWS & HEIGHTS (Drawn ONCE at the very end)
      // ================================================================
      const totals = data.totals || {};
      const cgstRateDec = toDec(totals.cgstRate);
      const sgstRateDec = toDec(totals.sgstRate);
      const igstRateDec = toDec(totals.igstRate);
      const cgstAmtDec = toDec(totals.cgstAmount);
      const sgstAmtDec = toDec(totals.sgstAmount);
      const igstAmtDec = toDec(totals.igstAmount);
      const discountAmtDec = toDec(totals.discountAmount);
      const hasDiscount = discountAmtDec.gt(0);
      const discountLabel =
        totals.discountType === 'percentage'
          ? `Discount (${formatDecimalQty(totals.discountValue)}%)`
          : 'Discount';

      // Determine intra-state vs inter-state cleanly
      const hasExplicitInterStateTax = igstAmtDec.gt(0) || igstRateDec.gt(0);
      const hasExplicitIntraStateTax =
        cgstAmtDec.gt(0) || sgstAmtDec.gt(0) || cgstRateDec.gt(0) || sgstRateDec.gt(0);
      const statesDiffer =
        Boolean(supplierStateCode && buyerStateCode && supplierStateCode !== buyerStateCode);
      const isInterState =
        hasExplicitInterStateTax || (!hasExplicitIntraStateTax && statesDiffer);

      const cgstDisplay = cgstRateDec.gt(0) ? `CGST @ ${formatDecimalQty(cgstRateDec)}%` : 'CGST @';
      const sgstDisplay = sgstRateDec.gt(0) ? `SGST @ ${formatDecimalQty(sgstRateDec)}%` : 'SGST @';
      const igstDisplay = igstRateDec.gt(0) ? `IGST @ ${formatDecimalQty(igstRateDec)}%` : 'IGST @';

      const taxRows: Array<[string, string]> = [];
      if (isNormalBill) {
        if (hasDiscount) {
          taxRows.push(['Subtotal', formatIndianMoney(totals.subtotal ?? totals.taxableAmount ?? totals.grandTotal)]);
          taxRows.push([discountLabel, `-${formatIndianMoney(discountAmtDec)}`]);
          taxRows.push(['Grand Total', formatIndianMoney(totals.grandTotal)]);
        } else {
          taxRows.push(['Total Amount', formatIndianMoney(totals.subtotal ?? totals.taxableAmount ?? totals.grandTotal)]);
          taxRows.push(['Grand Total', formatIndianMoney(totals.grandTotal)]);
        }
      } else {
        if (hasDiscount) {
          taxRows.push(['Subtotal', formatIndianMoney(totals.subtotal ?? totals.taxableAmount)]);
          taxRows.push([discountLabel, `-${formatIndianMoney(discountAmtDec)}`]);
        }
        taxRows.push(['T. Amt. Before Tax', formatIndianMoney(totals.taxableAmount)]);
        if (isInterState) {
          taxRows.push([igstDisplay, formatIndianMoney(igstAmtDec)]);
        } else {
          taxRows.push([cgstDisplay, formatIndianMoney(cgstAmtDec)]);
          taxRows.push([sgstDisplay, formatIndianMoney(sgstAmtDec)]);
        }
        taxRows.push(['Tax Amount GST', formatIndianMoney(totals.taxAmount)]);
        taxRows.push(['T. Amount After Tax', formatIndianMoney(totals.grandTotal)]);
      }

      const taxBoxWidth = width * 0.44;
      const taxBoxLeft = left + width - taxBoxWidth;
      const taxBoxRowHeight = isNormalBill ? (hasDiscount ? 18 : 22) : taxRows.length > 6 ? 15.5 : 17.5;
      const taxBoxHeight = taxBoxRowHeight * taxRows.length;

      const amountWords = data.amountInWords || numberToIndianWords(totals.grandTotal || 0);
      doc.font('Helvetica-Oblique').fontSize(8.5);
      const wordsTextHeight = doc.heightOfString(`Amount in Words : ${amountWords}`, {
        width: width - 16,
      });
      const wordsHeight = Math.max(24, wordsTextHeight + 12);

      doc.font('Helvetica-Bold').fontSize(8.5);
      const jurHeight = doc.heightOfString(jurisdictionText, { width: width * 0.37 });
      const footerHeight = Math.max(82, 42 + jurHeight + 8);
      const closingSectionHeight = taxBoxHeight + wordsHeight + footerHeight;

      // ================================================================
      // 3. MULTI-PAGE ITEMS TABLE RENDERER (Supports 1 to 100+ items + long text)
      // ================================================================
      let tableContentTop = drawTableHeader(y);
      let itemY = tableContentTop + 4;
      const intermediatePageBottom = frameBottom - 16;

      const items = data.items || [];
      const itemFontSize = 8;
      const minRowHeight = 17;
      const singlePageMaxBody = intermediatePageBottom - (top + 58);

      let drawnCount = 0;

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        const sNoText = `${idx + 1}.`;
        const descText = (item.name || '').trim();
        const hsnText = item.hsn?.trim() || '';
        const qtyStr = `${formatDecimalQty(item.quantity)}${item.unit ? ' ' + item.unit : ''}`;
        const rateStr =
          item.rate !== undefined && item.rate !== null && item.rate !== ''
            ? formatIndianMoney(item.rate)
            : '';
        const amtStr =
          item.amount !== undefined && item.amount !== null && item.amount !== ''
            ? formatIndianMoney(item.amount)
            : '';

        doc.font('Helvetica').fontSize(itemFontSize);
        const nameH = doc.heightOfString(descText || ' ', { width: colWidths[1] - 8 });
        const hsnH = doc.heightOfString(hsnText, { width: colWidths[2] - 4 });
        const qtyH = doc.heightOfString(qtyStr, { width: colWidths[3] - 4 });
        const fullContentH = Math.max(nameH, hsnH, qtyH);
        const fullRowHeight = Math.max(minRowHeight, fullContentH + 5);

        const drawInvoiceRow = (opts: {
          sNo: string;
          descChunk: string;
          showMetaCols: boolean;
          rowH: number;
        }) => {
          doc.fillColor('#000000').font('Helvetica').fontSize(itemFontSize);
          doc.text(opts.sNo, colX[0], itemY, { width: colWidths[0], align: 'center' });
          doc.text(opts.descChunk, colX[1] + 4, itemY, {
            width: colWidths[1] - 8,
            align: 'left',
          });
          if (opts.showMetaCols) {
            doc.text(hsnText, colX[2] + 2, itemY, { width: colWidths[2] - 4, align: 'center' });
            doc.text(qtyStr, colX[3] + 2, itemY, { width: colWidths[3] - 4, align: 'center' });
            doc.text(rateStr, colX[4], itemY, { width: colWidths[4] - 5, align: 'right' });
            doc.font('Helvetica-Bold').text(amtStr, colX[5], itemY, {
              width: colWidths[5] - 5,
              align: 'right',
            });
          }
          itemY += opts.rowH;
        };

        if (itemY + fullRowHeight <= intermediatePageBottom) {
          drawInvoiceRow({
            sNo: sNoText,
            descChunk: descText,
            showMetaCols: true,
            rowH: fullRowHeight,
          });
          drawnCount++;
          continue;
        }

        // Row doesn't fit on current page: close table grid on current page cleanly
        if (fullRowHeight <= Math.min(200, singlePageMaxBody)) {
          drawColumnGrid(tableContentTop, frameBottom);
          const next = startContinuationPage(true);
          tableContentTop = next.contentTop;
          itemY = next.yStart;

          drawInvoiceRow({
            sNo: sNoText,
            descChunk: descText,
            showMetaCols: true,
            rowH: fullRowHeight,
          });
          drawnCount++;
          continue;
        }

        // Extraordinarily tall single item description: split smoothly across pages
        let remaining = descText;
        let firstChunk = true;
        while (remaining.length > 0) {
          if (intermediatePageBottom - itemY < 22) {
            drawColumnGrid(tableContentTop, frameBottom);
            const next = startContinuationPage(true);
            tableContentTop = next.contentTop;
            itemY = next.yStart;
          }

          const availH = Math.max(12, intermediatePageBottom - itemY - 5);
          doc.font('Helvetica').fontSize(itemFontSize);
          const { head, tail } = splitTextBlockToHeight(doc, remaining, colWidths[1] - 8, availH);
          if (!head) {
            drawColumnGrid(tableContentTop, frameBottom);
            const next = startContinuationPage(true);
            tableContentTop = next.contentTop;
            itemY = next.yStart;
            continue;
          }

          const chunkH = doc.heightOfString(head, { width: colWidths[1] - 8 });
          const rowH = Math.max(minRowHeight, chunkH + 5);
          drawInvoiceRow({
            sNo: firstChunk ? sNoText : '...',
            descChunk: head,
            showMetaCols: firstChunk,
            rowH,
          });
          remaining = tail;
          firstChunk = false;
        }
        drawnCount++;
      }

      if (drawnCount < items.length) {
        throw new Error(`PDF generation failure: Only ${drawnCount} of ${items.length} items were rendered.`);
      }

      // ================================================================
      // 4. ANCHORED END-OF-DOCUMENT SUMMARY, WORDS, JURISDICTION & SIGNATURE
      // ================================================================
      // Check if full closing block fits below last item on current page
      const availableForClosingOnCurrentPage = frameBottom - itemY - 6;
      const summaryHeaderOnSeparatePage = availableForClosingOnCurrentPage < closingSectionHeight;

      if (summaryHeaderOnSeparatePage) {
        // Close intermediate items table cleanly all the way to bottom border
        drawColumnGrid(tableContentTop, frameBottom);
        const next = startContinuationPage(false);
        const closingStartY = next.yStart;

        doc.fillColor('#000000')
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .text(`${invoiceTitle} — Summary & Tax Breakdown`, left + 8, closingStartY);
        const ruleAfterTitleY = closingStartY + 16;
        doc.lineWidth(0.75).moveTo(left, ruleAfterTitleY).lineTo(left + width, ruleAfterTitleY).stroke('#000000');

        // Draw closing block cleanly anchored to bottom of final page
        tableContentTop = ruleAfterTitleY;
      }

      const wordsY = frameBottom - footerHeight - wordsHeight;
      const tableBottom = wordsY;
      const taxBoxTop = tableBottom - taxBoxHeight;

      if (!summaryHeaderOnSeparatePage) {
        drawColumnGrid(tableContentTop, tableBottom);
      }

      // Draw Tax / Financial Summary Box at bottom right of final table/summary area
      doc.rect(taxBoxLeft, taxBoxTop, taxBoxWidth, taxBoxHeight).fillAndStroke('#ffffff', '#000000');
      const taxSplitX = taxBoxLeft + taxBoxWidth * 0.58;
      doc.lineWidth(0.5).moveTo(taxSplitX, taxBoxTop).lineTo(taxSplitX, tableBottom).stroke('#000000');

      taxRows.forEach((r, idx) => {
        const ry = taxBoxTop + idx * taxBoxRowHeight;
        if (idx > 0) {
          doc.lineWidth(0.5).moveTo(taxBoxLeft, ry).lineTo(taxBoxLeft + taxBoxWidth, ry).stroke('#000000');
        }
        const isTotal = idx === taxRows.length - 1;
        const fontSize = isNormalBill ? 9 : isTotal ? 8.5 : 7.5;
        const textOffsetY = ry + Math.max(2, (taxBoxRowHeight - fontSize - 2) / 2);

        doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#000000');
        doc.text(r[0], taxBoxLeft + 5, textOffsetY, { width: taxBoxWidth * 0.54 });
        doc.text(r[1], taxSplitX, textOffsetY, {
          width: taxBoxWidth * 0.42 - 5,
          align: 'right',
        });
      });

      // Horizontal separator above Amount in Words
      doc.lineWidth(1).moveTo(left, tableBottom).lineTo(left + width, tableBottom).stroke('#000000');

      // Amount in Words Band
      doc.font('Helvetica-BoldOblique')
        .fontSize(8.5)
        .fillColor('#000000')
        .text('Amount in Words : ', left + 6, wordsY + 6, { continued: true });
      doc.font('Helvetica-Oblique').fontSize(8.5).text(amountWords, { width: width - 16 });
      doc.lineWidth(1).moveTo(left, wordsY + wordsHeight).lineTo(left + width, wordsY + wordsHeight).stroke('#000000');

      // Bottom Footer: E.&O.E. + Configurable Jurisdiction | Signatory
      const footerY = wordsY + wordsHeight;
      const footerMidX = left + width * 0.39;
      doc.lineWidth(1).moveTo(footerMidX, footerY).lineTo(footerMidX, frameBottom).stroke('#000000');

      doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10).text('E.&O.E.', left + 6, footerY + 8);
      doc.font('Helvetica').fontSize(8.5).text('All disputes are subject to', left + 6, footerY + 23);
      doc.font('Helvetica-Bold').fontSize(9).text(jurisdictionText, left + 6, footerY + 35, {
        width: footerMidX - left - 12,
      });

      const rightW = width - (footerMidX - left);
      doc.font('Helvetica-Oblique')
        .fontSize(8)
        .text('Certified that the particulars given above are true and correct.', footerMidX, footerY + 6, {
          align: 'right',
          width: rightW - 8,
        });
      doc.font('Helvetica-Bold')
        .fontSize(10)
        .text(`For ${supplierName}`, footerMidX, footerY + 18, {
          align: 'right',
          width: rightW - 8,
        });

      const sigBuffer = resolveSignatureBuffer();
      if (sigBuffer) {
        try {
          doc.image(sigBuffer, left + width - 110, footerY + 32, { width: 90, height: 24 });
        } catch {
          // Non-fatal signature load
        }
      }

      doc.font('Helvetica-Bold')
        .fontSize(8.5)
        .text('Authorised Signatory', footerMidX, frameBottom - 16, {
          align: 'right',
          width: rightW - 8,
        });

      // Stamp "Page X of Y" cleanly below the bordered frame across all pages
      stampPageNumbers(doc, {
        margin,
        contentWidth: width,
        footerY: frameBottom + 2,
        leftText: `Computer-generated ${isNormalBill ? 'bill' : 'tax invoice'}`,
        textColor: '#475569',
        fontSize: 7.2,
      });

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
