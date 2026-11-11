import Decimal from 'decimal.js';
import PDFDocument from 'pdfkit';
import {
  formatDateToIndian,
  formatDecimalQty,
  formatIndianMoney,
  splitTextBlockToHeight,
  stampPageNumbers,
} from '../../utils/pdfLayout.js';
import { fetchSafeLogoBuffer } from './logoFetch.js';

export interface QuotationPdfItem {
  itemIndex?: number;
  description: string;
  hsnCode?: string | null;
  barcode?: string | null;
  quantity: string | number;
  unit?: string | null;
  rate: string | number;
  rateUnit?: string | null;
  amount: string | number;
}

export interface QuotationCompanySnapshot {
  companyName: string;
  logoUrl?: string | null;
  cin?: string | null;
  gstin?: string | null;
  address: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  state?: string;
  stateCode?: string;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  bankBranch?: string | null;
  signatoryTitle?: string;
  jurisdiction?: string | null;
}

export interface QuotationPdfData {
  quotationNumber: string;
  quotationDate: string | Date;
  validUntil?: string | Date | null;
  company: QuotationCompanySnapshot;
  customer: {
    name: string;
    address?: string | null;
    phone?: string | null;
    gstin?: string | null;
    state?: string;
    stateCode?: string;
  };
  projectTitle?: string | null;
  subject?: string | null;
  items: QuotationPdfItem[];
  totals: {
    subtotal: string | number;
    discountType?: string | null;
    discountValue?: string | number;
    discountAmount?: string | number;
    taxableAmount: string | number;
    gstEnabled: boolean;
    gstRate?: string | number;
    cgstAmount?: string | number;
    sgstAmount?: string | number;
    igstAmount?: string | number;
    taxAmount?: string | number;
    grandTotal: string | number;
  };
  amountInWords: string;
  termsAndConditions?: string | null;
  notes?: string | null;
}

export const formatIndianCurrency = formatIndianMoney;

function toDec(val: string | number | null | undefined): Decimal {
  if (val === null || val === undefined || val === '') return new Decimal(0);
  try {
    const d = new Decimal(String(val).trim());
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/**
 * Generates a commercial Quotation PDF on A4 portrait with dynamic measurement,
 * clean multi-page pagination (including very long descriptions and unlimited terms),
 * Decimal-safe Indian money formatting, and accurate page numbering.
 */
export async function generateQuotationPdf(data: QuotationPdfData): Promise<Buffer> {
  const logoBuffer = await fetchSafeLogoBuffer(data.company?.logoUrl);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        bufferPages: true,
        info: {
          Title: `Quotation ${data.quotationNumber || 'DRAFT'} - ${data.company?.companyName || 'Khata'}`,
          Author: data.company?.companyName || 'Khata',
        },
      });

      const buffers: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const margin = 36;
      const contentWidth = pageWidth - margin * 2; // 523.28pt
      const bottomLimit = pageHeight - 52;

      const primaryNavy = '#1e3a8a';
      const secondarySlate = '#475569';
      const borderGrey = '#cbd5e1';
      const bgLight = '#f8fafc';
      const textDark = '#0f172a';

      const colWidths = [
        30, // S.No
        205.28, // Description & Barcode
        58, // HSN
        42, // Qty
        36, // Unit
        72, // Rate
        80, // Amount
      ];

      const colX = [margin];
      for (let i = 0; i < colWidths.length - 1; i++) {
        colX.push(colX[i] + colWidths[i]);
      }

      let currentY = margin;

      const renderTableHeader = () => {
        const headerHeight = 22;
        doc.rect(margin, currentY, contentWidth, headerHeight).fill(primaryNavy);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);

        doc.text('S.No', colX[0] + 4, currentY + 7, { width: colWidths[0] - 8, align: 'center' });
        doc.text('Description & Specifications', colX[1] + 6, currentY + 7, {
          width: colWidths[1] - 12,
          align: 'left',
        });
        doc.text('HSN', colX[2] + 4, currentY + 7, { width: colWidths[2] - 8, align: 'center' });
        doc.text('Qty', colX[3] + 4, currentY + 7, { width: colWidths[3] - 8, align: 'right' });
        doc.text('Unit', colX[4] + 3, currentY + 7, { width: colWidths[4] - 6, align: 'center' });
        doc.text('Rate (Rs.)', colX[5] + 4, currentY + 7, { width: colWidths[5] - 8, align: 'right' });
        doc.text('Amount (Rs.)', colX[6] + 4, currentY + 7, { width: colWidths[6] - 8, align: 'right' });

        currentY += headerHeight;
      };

      const startContinuationPage = (includeTableHeader: boolean) => {
        doc.addPage({ size: 'A4', margin });
        currentY = margin;

        // Compact navy header strip on continuation pages
        doc.rect(margin, currentY, contentWidth, 3).fill(primaryNavy);
        currentY += 8;

        doc.fillColor(primaryNavy)
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .text(data.company?.companyName || 'QUOTATION', margin, currentY, {
            width: contentWidth * 0.58,
          });

        doc.fillColor(secondarySlate)
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .text(
            `Quotation: ${data.quotationNumber || 'DRAFT'}  |  Date: ${formatDateToIndian(data.quotationDate)}`,
            margin,
            currentY,
            {
              width: contentWidth,
              align: 'right',
            }
          );

        currentY += 16;
        doc.moveTo(margin, currentY)
          .lineTo(margin + contentWidth, currentY)
          .strokeColor(borderGrey)
          .lineWidth(0.75)
          .stroke();
        currentY += 8;

        if (includeTableHeader) {
          renderTableHeader();
        }
      };

      const ensureSpace = (neededHeight: number, includeTableHeader = true) => {
        if (currentY + neededHeight > bottomLimit) {
          startContinuationPage(includeTableHeader);
        }
      };

      // ================================================================
      // 1. FIRST PAGE BRANDED HEADER
      // ================================================================
      const headerTop = margin;
      doc.rect(margin, headerTop, contentWidth, 4).fill(primaryNavy);

      const cardWidth = 216;
      const cardX = margin + contentWidth - cardWidth;

      let companyTextX = margin;
      let companyTextWidth = contentWidth - cardWidth - 14;
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, margin, headerTop + 12, { fit: [64, 48] });
          companyTextX = margin + 74;
          companyTextWidth = Math.max(150, cardX - companyTextX - 10);
        } catch {
          companyTextX = margin;
          companyTextWidth = contentWidth - cardWidth - 14;
        }
      }

      let companyY = headerTop + 12;
      doc.fillColor(primaryNavy)
        .font('Helvetica-Bold')
        .fontSize(logoBuffer ? 13 : 15)
        .text(data.company.companyName || 'ALGIONS AI LABS PRIVATE LIMITED', companyTextX, companyY, {
          width: companyTextWidth,
        });
      companyY = doc.y + 3;

      doc.fillColor(secondarySlate).font('Helvetica').fontSize(8);
      if (data.company.cin) {
        doc.text(`CIN: ${data.company.cin}`, companyTextX, companyY, { width: companyTextWidth });
        companyY = doc.y + 2;
      }

      for (const line of (data.company.address || '').split('\n')) {
        if (line.trim()) {
          doc.text(line.trim(), companyTextX, companyY, { width: companyTextWidth });
          companyY = doc.y + 2;
        }
      }

      const contactParts = [
        data.company.phone ? `Phone: ${data.company.phone}` : null,
        data.company.email ? `Email: ${data.company.email}` : null,
        data.company.website ? `Web: ${data.company.website}` : null,
      ].filter(Boolean);
      if (contactParts.length > 0) {
        doc.text(contactParts.join('  |  '), companyTextX, companyY, { width: companyTextWidth });
        companyY = doc.y + 2;
      }

      if (data.company.gstin) {
        doc.font('Helvetica-Bold').text(`GSTIN: ${data.company.gstin}`, companyTextX, companyY, {
          width: companyTextWidth,
        });
        companyY = doc.y + 2;
      }

      if (data.company.state || data.company.stateCode) {
        doc.font('Helvetica').text(
          `State: ${data.company.state || ''}${data.company.stateCode ? ` (Code: ${data.company.stateCode})` : ''}`,
          companyTextX,
          companyY,
          { width: companyTextWidth }
        );
        companyY = doc.y + 2;
      }

      // Dynamic Right Quotation Info Card
      const cardTop = headerTop + 12;
      doc.font('Helvetica-Bold').fontSize(8.5);
      const qNumWidth = cardWidth - 90;
      const qNumHeight = doc.heightOfString(data.quotationNumber || 'DRAFT', { width: qNumWidth });
      const cardInnerRowsHeight = Math.max(13, qNumHeight + 3) + 14 + (data.validUntil ? 14 : 0);
      const cardHeight = Math.max(76, 36 + cardInnerRowsHeight + 10);

      doc.rect(cardX, cardTop, cardWidth, cardHeight).fillAndStroke(bgLight, borderGrey);
      doc.fillColor(primaryNavy)
        .font('Helvetica-Bold')
        .fontSize(15)
        .text('COMMERCIAL QUOTATION', cardX + 10, cardTop + 10, {
          width: cardWidth - 20,
          align: 'right',
        });

      let cardTextY = cardTop + 34;
      doc.fillColor(textDark).font('Helvetica').fontSize(8.5).text('Quotation No:', cardX + 10, cardTextY);
      doc.font('Helvetica-Bold').text(data.quotationNumber || 'DRAFT', cardX + 80, cardTextY, {
        align: 'right',
        width: qNumWidth,
      });
      cardTextY += Math.max(14, qNumHeight + 4);

      doc.font('Helvetica').text('Date:', cardX + 10, cardTextY);
      doc.font('Helvetica-Bold').text(formatDateToIndian(data.quotationDate), cardX + 80, cardTextY, {
        align: 'right',
        width: qNumWidth,
      });
      cardTextY += 14;

      if (data.validUntil) {
        doc.font('Helvetica').text('Valid Until:', cardX + 10, cardTextY);
        doc.font('Helvetica-Bold').text(formatDateToIndian(data.validUntil), cardX + 80, cardTextY, {
          align: 'right',
          width: qNumWidth,
        });
      }

      currentY = Math.max(companyY + 10, logoBuffer ? headerTop + 66 : cardTop + cardHeight + 8, cardTop + cardHeight + 8);
      doc.moveTo(margin, currentY)
        .lineTo(margin + contentWidth, currentY)
        .strokeColor(borderGrey)
        .lineWidth(0.75)
        .stroke();
      currentY += 10;

      // ================================================================
      // 2. CUSTOMER & PROJECT DETAILS (Dynamic measurement, zero truncation)
      // ================================================================
      const custBoxWidth = (contentWidth - 14) / 2;
      const rightBoxX = margin + custBoxWidth + 14;
      const boxInnerWidth = custBoxWidth - 20;

      interface TextEntry {
        text: string;
        font: 'Helvetica' | 'Helvetica-Bold';
        size: number;
        color: string;
        gapAfter: number;
      }

      const leftEntries: TextEntry[] = [
        {
          text: data.customer.name || 'Customer',
          font: 'Helvetica-Bold',
          size: 9.5,
          color: textDark,
          gapAfter: 3,
        },
      ];
      if (data.customer.address?.trim()) {
        leftEntries.push({
          text: data.customer.address.trim(),
          font: 'Helvetica',
          size: 8,
          color: secondarySlate,
          gapAfter: 2.5,
        });
      }
      if (data.customer.phone?.trim()) {
        leftEntries.push({
          text: `Phone: ${data.customer.phone.trim()}`,
          font: 'Helvetica',
          size: 8,
          color: secondarySlate,
          gapAfter: 2,
        });
      }
      if (data.customer.gstin?.trim()) {
        leftEntries.push({
          text: `GSTIN: ${data.customer.gstin.trim()}`,
          font: 'Helvetica-Bold',
          size: 8,
          color: secondarySlate,
          gapAfter: 2,
        });
      }
      if (data.customer.state || data.customer.stateCode) {
        leftEntries.push({
          text: `Place of Supply: ${data.customer.state || ''}${data.customer.stateCode ? ` (${data.customer.stateCode})` : ''}`,
          font: 'Helvetica',
          size: 8,
          color: secondarySlate,
          gapAfter: 2,
        });
      }

      const rightEntries: TextEntry[] = [];
      if (data.projectTitle?.trim()) {
        rightEntries.push({
          text: `Project: ${data.projectTitle.trim()}`,
          font: 'Helvetica-Bold',
          size: 9,
          color: textDark,
          gapAfter: 3,
        });
      }
      if (data.subject?.trim()) {
        rightEntries.push({
          text: `Subject: ${data.subject.trim()}`,
          font: 'Helvetica',
          size: 8.5,
          color: secondarySlate,
          gapAfter: 3,
        });
      }
      if (rightEntries.length === 0) {
        rightEntries.push({
          text: 'General Commercial Proposal',
          font: 'Helvetica',
          size: 8.5,
          color: secondarySlate,
          gapAfter: 2,
        });
      }

      const measureBoxEntriesHeight = (entries: TextEntry[]): number => {
        let total = 26; // Top padding + header label height
        for (const entry of entries) {
          doc.font(entry.font).fontSize(entry.size);
          total += doc.heightOfString(entry.text, { width: boxInnerWidth }) + entry.gapAfter;
        }
        return total + 8;
      };

      const leftBoxHeight = measureBoxEntriesHeight(leftEntries);
      const rightBoxHeight = measureBoxEntriesHeight(rightEntries);
      const boxHeight = Math.max(76, leftBoxHeight, rightBoxHeight);

      if (currentY + boxHeight > bottomLimit) {
        startContinuationPage(false);
      }

      const renderMetaCard = (
        x: number,
        title: string,
        entries: TextEntry[],
        cardH: number
      ) => {
        doc.rect(x, currentY, custBoxWidth, cardH).strokeColor(borderGrey).lineWidth(0.75).stroke();
        doc.fillColor(primaryNavy).font('Helvetica-Bold').fontSize(8.5).text(title, x + 10, currentY + 8);
        let yCursor = currentY + 23;
        for (const entry of entries) {
          doc.fillColor(entry.color).font(entry.font).fontSize(entry.size).text(entry.text, x + 10, yCursor, {
            width: boxInnerWidth,
          });
          yCursor = doc.y + entry.gapAfter;
        }
      };

      renderMetaCard(margin, 'QUOTATION TO', leftEntries, boxHeight);
      renderMetaCard(rightBoxX, 'PROJECT / SCOPE DETAILS', rightEntries, boxHeight);
      currentY += boxHeight + 12;

      // ================================================================
      // 3. ITEMS TABLE WITH DYNAMIC ROWS & LONG-DESCRIPTION SPLITTING
      // ================================================================
      renderTableHeader();

      const items = data.items || [];
      const rowPadY = 6;
      const minNormalRowHeight = 22;
      const singlePageMaxTableBody = bottomLimit - (margin + 52);

      items.forEach((item, idx) => {
        const sNoText = `${idx + 1}`;
        const rawDesc = (item.description || '').trim();
        const barcodeText = item.barcode?.trim() ? `Barcode: ${item.barcode.trim()}` : '';
        const hsnText = item.hsnCode?.trim() || '—';
        const qtyText = formatDecimalQty(item.quantity);
        const unitText = item.unit?.trim() || '—';
        const rateText = formatIndianMoney(item.rate);
        const amtText = formatIndianMoney(item.amount);

        doc.font('Helvetica-Bold').fontSize(8.5);
        const fullDescH = doc.heightOfString(rawDesc || ' ', { width: colWidths[1] - 12 });
        doc.font('Helvetica').fontSize(7);
        const barcodeH = barcodeText ? doc.heightOfString(barcodeText, { width: colWidths[1] - 12 }) + 2 : 0;

        doc.font('Helvetica').fontSize(8.5);
        const hsnH = doc.heightOfString(hsnText, { width: colWidths[2] - 8 });
        const qtyH = doc.heightOfString(qtyText, { width: colWidths[3] - 8 });
        const unitH = doc.heightOfString(unitText, { width: colWidths[4] - 6 });
        const rateH = doc.heightOfString(rateText, { width: colWidths[5] - 8 });
        const amtH = doc.heightOfString(amtText, { width: colWidths[6] - 8 });

        const maxFullH = Math.max(fullDescH + barcodeH, hsnH, qtyH, unitH, rateH, amtH);
        const fullRowHeight = Math.max(minNormalRowHeight, maxFullH + rowPadY * 2);

        const drawRowBox = (opts: {
          rowH: number;
          sNo: string;
          descChunk: string;
          barcodeToDraw: string;
          showNumericCols: boolean;
          isEven: boolean;
        }) => {
          if (opts.isEven) {
            doc.rect(margin, currentY, contentWidth, opts.rowH).fill(bgLight);
          }

          const cellY = currentY + rowPadY;

          doc.fillColor(textDark).font('Helvetica').fontSize(8.5);
          doc.text(opts.sNo, colX[0] + 4, cellY, { width: colWidths[0] - 8, align: 'center' });

          doc.font('Helvetica-Bold').fontSize(8.5);
          doc.text(opts.descChunk, colX[1] + 6, cellY, { width: colWidths[1] - 12, align: 'left' });

          if (opts.barcodeToDraw) {
            doc.fillColor(secondarySlate).font('Helvetica').fontSize(7);
            doc.text(opts.barcodeToDraw, colX[1] + 6, doc.y + 2, {
              width: colWidths[1] - 12,
              align: 'left',
            });
          }

          if (opts.showNumericCols) {
            doc.fillColor(secondarySlate).font('Helvetica').fontSize(8.5);
            doc.text(hsnText, colX[2] + 4, cellY, { width: colWidths[2] - 8, align: 'center' });

            doc.fillColor(textDark);
            doc.text(qtyText, colX[3] + 4, cellY, { width: colWidths[3] - 8, align: 'right' });
            doc.fillColor(secondarySlate);
            doc.text(unitText, colX[4] + 3, cellY, { width: colWidths[4] - 6, align: 'center' });

            doc.fillColor(textDark);
            doc.text(rateText, colX[5] + 4, cellY, { width: colWidths[5] - 8, align: 'right' });
            doc.font('Helvetica-Bold').text(amtText, colX[6] + 4, cellY, {
              width: colWidths[6] - 8,
              align: 'right',
            });
          }

          // Vertical & bottom row dividers
          doc.strokeColor(borderGrey).lineWidth(0.5);
          colX.forEach((cx) => {
            doc.moveTo(cx, currentY).lineTo(cx, currentY + opts.rowH).stroke();
          });
          doc.moveTo(margin + contentWidth, currentY)
            .lineTo(margin + contentWidth, currentY + opts.rowH)
            .stroke();
          doc.moveTo(margin, currentY + opts.rowH)
            .lineTo(margin + contentWidth, currentY + opts.rowH)
            .stroke();

          currentY += opts.rowH;
        };

        // Normal single-shot row when it fits cleanly on current page
        if (currentY + fullRowHeight <= bottomLimit) {
          drawRowBox({
            rowH: fullRowHeight,
            sNo: sNoText,
            descChunk: rawDesc,
            barcodeToDraw: barcodeText,
            showNumericCols: true,
            isEven: idx % 2 === 1,
          });
          return;
        }

        // Short/medium row that cleanly fits on next page without mid-row split
        if (fullRowHeight <= Math.min(180, singlePageMaxTableBody)) {
          startContinuationPage(true);
          drawRowBox({
            rowH: fullRowHeight,
            sNo: sNoText,
            descChunk: rawDesc,
            barcodeToDraw: barcodeText,
            showNumericCols: true,
            isEven: idx % 2 === 1,
          });
          return;
        }

        // Tall/multi-paragraph description row: split cleanly across page boundaries
        let remainingDesc = rawDesc;
        let isFirstChunk = true;

        while (remainingDesc.length > 0) {
          const minNeededForChunk = rowPadY * 2 + 16;
          if (bottomLimit - currentY < minNeededForChunk) {
            startContinuationPage(true);
          }

          const availTextHeight = Math.max(12, bottomLimit - currentY - rowPadY * 2 - (barcodeText ? barcodeH + 2 : 0));
          doc.font('Helvetica-Bold').fontSize(8.5);
          const { head, tail } = splitTextBlockToHeight(doc, remainingDesc, colWidths[1] - 12, availTextHeight);

          if (!head) {
            startContinuationPage(true);
            continue;
          }

          doc.font('Helvetica-Bold').fontSize(8.5);
          const chunkDescH = doc.heightOfString(head, { width: colWidths[1] - 12 });
          const drawBarcodeOnChunk = !tail && Boolean(barcodeText);
          const extraBarcodeH = drawBarcodeOnChunk ? barcodeH : 0;
          const numericColsMinH = isFirstChunk ? Math.max(hsnH, qtyH, unitH, rateH, amtH) : 0;
          const chunkRowH = Math.max(
            minNormalRowHeight,
            Math.max(chunkDescH + extraBarcodeH, numericColsMinH) + rowPadY * 2
          );

          drawRowBox({
            rowH: chunkRowH,
            sNo: isFirstChunk ? sNoText : '...',
            descChunk: head,
            barcodeToDraw: drawBarcodeOnChunk ? barcodeText : '',
            showNumericCols: isFirstChunk,
            isEven: idx % 2 === 1,
          });

          remainingDesc = tail;
          isFirstChunk = false;
        }
      });

      currentY += 12;

      // ================================================================
      // 4. FINANCIAL SUMMARY BLOCK & AMOUNT IN WORDS (Drawn once, dynamic height)
      // ================================================================
      const totals = data.totals;
      const discountAmtDec = toDec(totals.discountAmount);
      const gstRateDec = toDec(totals.gstRate);
      const cgstAmtDec = toDec(totals.cgstAmount);
      const sgstAmtDec = toDec(totals.sgstAmount);
      const igstAmtDec = toDec(totals.igstAmount);
      const halfGstRateStr = formatDecimalQty(gstRateDec.div(2));
      const fullGstRateStr = formatDecimalQty(gstRateDec);

      const summaryRows: Array<{ label: string; value: string; color?: string; bold?: boolean }> = [
        { label: 'Subtotal', value: `Rs. ${formatIndianMoney(totals.subtotal)}` },
      ];

      if (discountAmtDec.gt(0)) {
        const discLabel =
          totals.discountType === 'percentage'
            ? `Discount (${formatDecimalQty(totals.discountValue)}%)`
            : 'Discount';
        summaryRows.push({
          label: discLabel,
          value: `- Rs. ${formatIndianMoney(discountAmtDec)}`,
          color: '#b91c1c',
        });
      }

      if (totals.gstEnabled) {
        summaryRows.push({
          label: 'Taxable Value',
          value: `Rs. ${formatIndianMoney(totals.taxableAmount)}`,
        });
        if (igstAmtDec.gt(0)) {
          summaryRows.push({
            label: `IGST (${fullGstRateStr}%)`,
            value: `Rs. ${formatIndianMoney(igstAmtDec)}`,
          });
        } else {
          summaryRows.push({
            label: `CGST (${halfGstRateStr}%)`,
            value: `Rs. ${formatIndianMoney(cgstAmtDec)}`,
          });
          summaryRows.push({
            label: `SGST (${halfGstRateStr}%)`,
            value: `Rs. ${formatIndianMoney(sgstAmtDec)}`,
          });
        }
      } else {
        summaryRows.push({
          label: 'GST Tax',
          value: 'Not Applicable',
          color: secondarySlate,
        });
      }

      const wordsBoxWidth = 272;
      const summaryBoxWidth = contentWidth - wordsBoxWidth - 15;
      const summaryBoxX = margin + wordsBoxWidth + 15;

      doc.font('Helvetica-Bold').fontSize(8.5);
      const amountWordsStr = data.amountInWords || 'Rupees Zero Only';
      const wordsTextHeight = doc.heightOfString(amountWordsStr, { width: wordsBoxWidth - 16 });
      const leftSummaryH = Math.max(58, 28 + wordsTextHeight + 10);

      const lineSpacing = 14;
      const rightSummaryRowsH = 10 + summaryRows.length * lineSpacing + 30; // +30 for divider & Grand Total band
      const summaryBlockHeight = Math.max(leftSummaryH, rightSummaryRowsH, 92);

      ensureSpace(summaryBlockHeight + 10, false);
      const summaryTop = currentY;

      // Left box: Amount in Words
      doc.rect(margin, summaryTop, wordsBoxWidth, leftSummaryH).fillAndStroke(bgLight, borderGrey);
      doc.fillColor(secondarySlate).font('Helvetica-Bold').fontSize(7.5).text('AMOUNT IN WORDS', margin + 8, summaryTop + 8);
      doc.fillColor(textDark).font('Helvetica-Bold').fontSize(8.5).text(amountWordsStr, margin + 8, summaryTop + 21, {
        width: wordsBoxWidth - 16,
      });

      // Right box: Summary Totals
      doc.rect(summaryBoxX, summaryTop, summaryBoxWidth, summaryBlockHeight).strokeColor(borderGrey).lineWidth(0.75).stroke();

      let sY = summaryTop + 9;
      for (const row of summaryRows) {
        doc.fillColor(secondarySlate).font('Helvetica').fontSize(8.5).text(row.label, summaryBoxX + 10, sY, {
          width: summaryBoxWidth * 0.52,
        });
        doc.fillColor(row.color || textDark)
          .font(row.bold ? 'Helvetica-Bold' : 'Helvetica-Bold')
          .fontSize(8.5)
          .text(row.value, summaryBoxX + 10, sY, {
            width: summaryBoxWidth - 20,
            align: 'right',
          });
        sY += lineSpacing;
      }

      // Grand Total Bar at bottom of summary box
      const grandTotalBarY = summaryTop + summaryBlockHeight - 24;
      doc.moveTo(summaryBoxX, grandTotalBarY - 2)
        .lineTo(summaryBoxX + summaryBoxWidth, grandTotalBarY - 2)
        .strokeColor(primaryNavy)
        .lineWidth(1)
        .stroke();
      doc.rect(summaryBoxX, grandTotalBarY, summaryBoxWidth, 24).fill(primaryNavy);

      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5).text('GRAND TOTAL', summaryBoxX + 10, grandTotalBarY + 7);
      doc.text(`Rs. ${formatIndianMoney(totals.grandTotal)}`, summaryBoxX + 10, grandTotalBarY + 7, {
        width: summaryBoxWidth - 20,
        align: 'right',
      });

      currentY = summaryTop + summaryBlockHeight + 14;

      // ================================================================
      // 5. NOTES SECTION (Dynamic, multi-page safe, zero clipping)
      // ================================================================
      if (data.notes?.trim()) {
        let remainingNotes = data.notes.trim();
        let notesHeaderPrefix = 'NOTES & SPECIAL INSTRUCTIONS';

        while (remainingNotes.length > 0) {
          if (bottomLimit - currentY < 42) {
            startContinuationPage(false);
          }

          const availTextH = bottomLimit - currentY - 24;
          doc.font('Helvetica').fontSize(8);
          const { head, tail } = splitTextBlockToHeight(doc, remainingNotes, contentWidth - 16, availTextH);
          if (!head) {
            startContinuationPage(false);
            continue;
          }

          doc.font('Helvetica').fontSize(8);
          const chunkH = doc.heightOfString(head, { width: contentWidth - 16 });
          const notesCardH = chunkH + 26;

          doc.rect(margin, currentY, contentWidth, notesCardH).fillAndStroke(bgLight, borderGrey);
          doc.fillColor(primaryNavy)
            .font('Helvetica-Bold')
            .fontSize(8)
            .text(notesHeaderPrefix, margin + 8, currentY + 6);
          doc.fillColor(textDark)
            .font('Helvetica')
            .fontSize(8)
            .text(head, margin + 8, currentY + 18, { width: contentWidth - 16 });

          currentY += notesCardH + 10;
          remainingNotes = tail;
          notesHeaderPrefix = 'NOTES & SPECIAL INSTRUCTIONS (Contd.)';
        }
      }

      // ================================================================
      // 6. COMMERCIAL TERMS & CONDITIONS (NO slice(0, 6) cap, multi-page!)
      // ================================================================
      const termParagraphs: string[] = [];
      if (data.termsAndConditions?.trim()) {
        data.termsAndConditions
          .replace(/\r\n/g, '\n')
          .split('\n')
          .forEach((line) => {
            const trimmed = line.trim();
            if (trimmed) termParagraphs.push(trimmed);
          });
      }

      if (termParagraphs.length > 0) {
        let termHeadingDrawnOnCurrentPage = false;

        const drawTermsHeading = (continued: boolean) => {
          ensureSpace(26, false);
          doc.fillColor(primaryNavy)
            .font('Helvetica-Bold')
            .fontSize(8.5)
            .text(continued ? 'Commercial Terms & Conditions (Contd.):' : 'Commercial Terms & Conditions:', margin, currentY);
          currentY = doc.y + 4;
          termHeadingDrawnOnCurrentPage = true;
        };

        drawTermsHeading(false);

        for (let idx = 0; idx < termParagraphs.length; idx++) {
          let remainingLine = `${idx + 1}. ${termParagraphs[idx]}`;
          while (remainingLine.length > 0) {
            if (bottomLimit - currentY < 16) {
              startContinuationPage(false);
              termHeadingDrawnOnCurrentPage = false;
            }
            if (!termHeadingDrawnOnCurrentPage) {
              drawTermsHeading(true);
            }

            const availH = bottomLimit - currentY - 4;
            doc.font('Helvetica').fontSize(7.8);
            const { head, tail } = splitTextBlockToHeight(doc, remainingLine, contentWidth - 12, availH);
            if (!head) {
              startContinuationPage(false);
              termHeadingDrawnOnCurrentPage = false;
              continue;
            }

            doc.fillColor(secondarySlate).font('Helvetica').fontSize(7.8).text(head, margin + 6, currentY, {
              width: contentWidth - 12,
            });
            currentY = doc.y + 3;
            remainingLine = tail;
          }
        }
        currentY += 8;
      }

      // ================================================================
      // 7. BANK DETAILS & AUTHORIZED SIGNATORY BLOCK
      // ================================================================
      const bankLines: string[] = [];
      if (data.company.bankName) bankLines.push(`Bank: ${data.company.bankName}`);
      if (data.company.bankAccountNumber) bankLines.push(`A/C No: ${data.company.bankAccountNumber}`);
      if (data.company.bankIfsc) bankLines.push(`IFSC: ${data.company.bankIfsc}`);
      if (data.company.bankBranch) bankLines.push(`Branch: ${data.company.bankBranch}`);

      const signWidth = 175;
      const bankColWidth = contentWidth - signWidth - 18;
      let bankHeight = 20;
      doc.font('Helvetica').fontSize(8);
      for (const bl of bankLines) {
        bankHeight += doc.heightOfString(bl, { width: bankColWidth - 16 }) + 3;
      }
      if (bankLines.length === 0) bankHeight = 0;

      const signBoxHeight = 82;
      const closingBlockHeight = Math.max(bankHeight, signBoxHeight);

      ensureSpace(closingBlockHeight + 8, false);
      const closingTop = currentY;

      if (bankLines.length > 0) {
        doc.rect(margin, closingTop, bankColWidth, closingBlockHeight).fillAndStroke(bgLight, borderGrey);
        doc.fillColor(primaryNavy).font('Helvetica-Bold').fontSize(8).text('Bank Settlement Details:', margin + 8, closingTop + 8);
        let bankY = closingTop + 21;
        doc.fillColor(textDark).font('Helvetica').fontSize(8);
        for (const bl of bankLines) {
          doc.text(bl, margin + 8, bankY, { width: bankColWidth - 16 });
          bankY = doc.y + 3;
        }
      }

      const signX = margin + contentWidth - signWidth;
      doc.rect(signX, closingTop, signWidth, closingBlockHeight).strokeColor(borderGrey).lineWidth(0.75).stroke();
      doc.fillColor(textDark)
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(`For ${data.company.companyName || 'ALGIONS AI LABS'}`, signX + 6, closingTop + 8, {
          width: signWidth - 12,
          align: 'center',
        });

      doc.moveTo(signX + 18, closingTop + closingBlockHeight - 24)
        .lineTo(signX + signWidth - 18, closingTop + closingBlockHeight - 24)
        .strokeColor(borderGrey)
        .lineWidth(0.75)
        .stroke();

      doc.fillColor(secondarySlate)
        .font('Helvetica')
        .fontSize(7.5)
        .text(
          data.company.signatoryTitle || 'Authorized Signatory',
          signX + 6,
          closingTop + closingBlockHeight - 19,
          {
            width: signWidth - 12,
            align: 'center',
          }
        );

      // ================================================================
      // 8. PAGE FOOTERS (Stamped cleanly without blank extra pages)
      // ================================================================
      const jurisdictionNote = data.company?.jurisdiction?.trim()
        ? ` | ${data.company.jurisdiction.trim()}`
        : '';

      stampPageNumbers(doc, {
        margin,
        contentWidth,
        footerY: pageHeight - 28,
        leftText: `Computer-generated quotation — Valid without wet signature${jurisdictionNote}`,
        textColor: secondarySlate,
        fontSize: 7.2,
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
