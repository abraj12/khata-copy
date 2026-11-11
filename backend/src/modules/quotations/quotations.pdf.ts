import PDFDocument from 'pdfkit';
import { numberToIndianWords, formatDateToIndian } from '../gstInvoices/gstInvoices.pdf.js';
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

/**
 * Format currency with Indian Comma grouping and 2 decimal places
 */
export function formatIndianCurrency(val: string | number): string {
  const num = Number(val || 0);
  if (!Number.isFinite(num)) return '0.00';
  return num.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Generates an executive, professional corporate PDF for Quotations.
 * Features:
 * - A4 portrait layout with crisp typography
 * - Safe HTTPS/R2 PNG & JPEG company logo embedding
 * - Deep navy blue brand headers (#1e3a8a)
 * - Multi-page item table pagination with repeated headers
 * - Clear commercial terms & bank details block
 * - Concurrency safe, streaming to buffer
 */
export async function generateQuotationPdf(data: QuotationPdfData): Promise<Buffer> {
  const logoBuffer = await fetchSafeLogoBuffer(data.company?.logoUrl);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36, // 0.5 inch margins (36pt)
        bufferPages: true,
      });

      const buffers: Buffer[] = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const margin = 36;
      const contentWidth = pageWidth - margin * 2; // 523.28pt
      const bottomLimit = pageHeight - 54; // Keep 54pt clear at bottom for footer

      // Colors
      const primaryNavy = '#1e3a8a';
      const secondarySlate = '#475569';
      const borderGrey = '#cbd5e1';
      const bgLight = '#f8fafc';
      const textDark = '#0f172a';

      // Table columns geometry
      // Total content width: 523pt
      const colWidths = [
        32, // S.No
        211, // Description & Barcode
        60, // HSN
        40, // Qty
        35, // Unit
        70, // Rate
        75, // Amount
      ];

      const colX = [
        margin,
        margin + colWidths[0],
        margin + colWidths[0] + colWidths[1],
        margin + colWidths[0] + colWidths[1] + colWidths[2],
        margin + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3],
        margin + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4],
        margin + colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3] + colWidths[4] + colWidths[5],
      ];

      let currentY = margin;

      // Header renderer
      const renderDocumentHeader = () => {
        const headerTop = margin;

        // Top accent bar
        doc.rect(margin, headerTop, contentWidth, 4).fill(primaryNavy);

        let companyTextX = margin;
        let companyTextWidth = 280;
        if (logoBuffer) {
          try {
            doc.image(logoBuffer, margin, headerTop + 12, { fit: [64, 46] });
            companyTextX = margin + 74;
            companyTextWidth = 215;
          } catch {
            companyTextX = margin;
            companyTextWidth = 280;
          }
        }

        // Left Company Info
        doc.fillColor(primaryNavy)
          .font('Helvetica-Bold')
          .fontSize(logoBuffer ? 13 : 15)
          .text(data.company.companyName || 'ALGIONS AI LABS PRIVATE LIMITED', companyTextX, headerTop + 12, {
            width: companyTextWidth,
          });

        doc.fillColor(secondarySlate)
          .font('Helvetica')
          .fontSize(8);

        let companyY = Math.max(headerTop + 32, doc.y + 3);
        if (data.company.cin) {
          doc.text(`CIN: ${data.company.cin}`, companyTextX, companyY, { width: companyTextWidth });
          companyY = doc.y + 2;
        }

        const addressLines = (data.company.address || '').split('\n');
        addressLines.forEach((line) => {
          if (line.trim()) {
            doc.text(line, companyTextX, companyY, { width: companyTextWidth });
            companyY = doc.y + 2;
          }
        });

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

        // Right Quotation Info Card
        const cardX = margin + 300;
        const cardWidth = contentWidth - 300;
        const cardTop = headerTop + 12;

        doc.rect(cardX, cardTop, cardWidth, 75).fillAndStroke(bgLight, borderGrey);

        doc.fillColor(primaryNavy)
          .font('Helvetica-Bold')
          .fontSize(16)
          .text('COMMERCIAL QUOTATION', cardX + 10, cardTop + 10, { width: cardWidth - 20, align: 'right' });

        doc.fillColor(textDark)
          .font('Helvetica')
          .fontSize(8.5);

        let cardTextY = cardTop + 32;
        doc.text('Quotation No:', cardX + 10, cardTextY);
        doc.font('Helvetica-Bold').text(data.quotationNumber || 'QT-001', cardX + 75, cardTextY, {
          align: 'right',
          width: cardWidth - 85,
        });
        cardTextY += 13;

        doc.font('Helvetica').text('Date:', cardX + 10, cardTextY);
        doc.font('Helvetica-Bold').text(formatDateToIndian(data.quotationDate), cardX + 75, cardTextY, {
          align: 'right',
          width: cardWidth - 85,
        });
        cardTextY += 13;

        if (data.validUntil) {
          doc.font('Helvetica').text('Valid Until:', cardX + 10, cardTextY);
          doc.font('Helvetica-Bold').text(formatDateToIndian(data.validUntil), cardX + 75, cardTextY, {
            align: 'right',
            width: cardWidth - 85,
          });
        }

        currentY = Math.max(companyY + 12, logoBuffer ? headerTop + 68 : cardTop + 85, cardTop + 85);

        // Divider
        doc.moveTo(margin, currentY).lineTo(margin + contentWidth, currentY).strokeColor(borderGrey).lineWidth(0.75).stroke();
        currentY += 10;

        // Customer & Project Section (Two columns)
        const custBoxWidth = (contentWidth - 14) / 2;
        const custBoxX = margin;
        const projBoxX = margin + custBoxWidth + 14;
        const boxTop = currentY;
        const boxHeight = 78;

        // Box 1: Customer Details
        doc.rect(custBoxX, boxTop, custBoxWidth, boxHeight).fillAndStroke(bgLight, borderGrey);
        doc.fillColor(primaryNavy).font('Helvetica-Bold').fontSize(8.5).text('QUOTATION ISSUED TO:', custBoxX + 8, boxTop + 7);
        doc.fillColor(textDark).font('Helvetica-Bold').fontSize(9.5).text(data.customer.name || 'Valued Customer', custBoxX + 8, boxTop + 20, {
          width: custBoxWidth - 16,
          ellipsis: true,
        });

        doc.font('Helvetica').fontSize(8).fillColor(secondarySlate);
        let custSubY = boxTop + 33;
        if (data.customer.address) {
          doc.text(data.customer.address, custBoxX + 8, custSubY, { width: custBoxWidth - 16, height: 18, ellipsis: true });
          custSubY += 19;
        }
        const custContact = [
          data.customer.phone ? `Phone: ${data.customer.phone}` : null,
          data.customer.gstin ? `GSTIN: ${data.customer.gstin}` : null,
          data.customer.state || data.customer.stateCode
            ? `State: ${data.customer.state || ''}${data.customer.stateCode ? ` (${data.customer.stateCode})` : ''}`
            : null,
        ]
          .filter(Boolean)
          .join('  |  ');
        if (custContact) {
          doc.text(custContact, custBoxX + 8, custSubY, { width: custBoxWidth - 16, height: 24 });
        }

        // Box 2: Project / Commercial Subject
        doc.rect(projBoxX, boxTop, custBoxWidth, boxHeight).fillAndStroke(bgLight, borderGrey);
        doc.fillColor(primaryNavy).font('Helvetica-Bold').fontSize(8.5).text('PROJECT / SUBJECT DETAILS:', projBoxX + 8, boxTop + 7);

        doc.fillColor(textDark).font('Helvetica-Bold').fontSize(9).text(data.projectTitle || 'Commercial Supply & Services Offer', projBoxX + 8, boxTop + 20, {
          width: custBoxWidth - 16,
          ellipsis: true,
        });

        doc.font('Helvetica').fontSize(8).fillColor(secondarySlate);
        const subjectText = data.subject || 'Quotation prepared in accordance with the requested scope of products and specifications.';
        doc.text(subjectText, projBoxX + 8, boxTop + 33, { width: custBoxWidth - 16, height: 34, ellipsis: true });

        currentY = boxTop + boxHeight + 8;
      };

      // Table Header renderer (called on page 1 and on every overflow page)
      const renderTableHeader = () => {
        const headerHeight = 22;
        doc.rect(margin, currentY, contentWidth, headerHeight).fill(primaryNavy);

        doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
        doc.text('S.No', colX[0], currentY + 7, { width: colWidths[0], align: 'center' });
        doc.text('Item Description', colX[1] + 6, currentY + 7, { width: colWidths[1] - 8, align: 'left' });
        doc.text('HSN', colX[2], currentY + 7, { width: colWidths[2], align: 'center' });
        doc.text('Qty', colX[3], currentY + 7, { width: colWidths[3], align: 'center' });
        doc.text('Unit', colX[4], currentY + 7, { width: colWidths[4], align: 'center' });
        doc.text('Rate (₹)', colX[5], currentY + 7, { width: colWidths[5] - 6, align: 'right' });
        doc.text('Amount (₹)', colX[6], currentY + 7, { width: colWidths[6] - 8, align: 'right' });

        currentY += headerHeight;
      };

      // Page break check helper
      const checkPageOverflow = (neededHeight: number) => {
        if (currentY + neededHeight > bottomLimit) {
          doc.addPage();
          currentY = margin;
          renderTableHeader();
        }
      };

      // 1. Render First Page Header & Table Header
      renderDocumentHeader();
      renderTableHeader();

      // 2. Render Table Items
      doc.font('Helvetica').fontSize(8).fillColor(textDark);

      data.items.forEach((item, index) => {
        const hasExtraDesc = Boolean(item.barcode);
        const rowHeight = hasExtraDesc ? 26 : 20;

        checkPageOverflow(rowHeight);

        // Zebra striping
        if (index % 2 === 1) {
          doc.rect(margin, currentY, contentWidth, rowHeight).fill(bgLight);
        }

        // Draw line underneath item
        doc.moveTo(margin, currentY + rowHeight)
          .lineTo(margin + contentWidth, currentY + rowHeight)
          .strokeColor(borderGrey)
          .lineWidth(0.5)
          .stroke();

        // Draw text
        doc.fillColor(textDark);
        doc.text(String(index + 1), colX[0], currentY + 6, { width: colWidths[0], align: 'center' });

        // Item name & optional barcode subtitle
        doc.font('Helvetica-Bold').text(item.description, colX[1] + 6, currentY + (hasExtraDesc ? 4 : 6), {
          width: colWidths[1] - 12,
          ellipsis: true,
        });
        if (item.barcode) {
          doc.font('Helvetica').fontSize(7).fillColor(secondarySlate).text(`Barcode: ${item.barcode}`, colX[1] + 6, currentY + 14, {
            width: colWidths[1] - 12,
            ellipsis: true,
          });
          doc.fontSize(8).fillColor(textDark);
        }

        doc.font('Helvetica');
        doc.text(item.hsnCode || '—', colX[2], currentY + 6, { width: colWidths[2], align: 'center' });
        doc.text(String(item.quantity), colX[3], currentY + 6, { width: colWidths[3], align: 'center' });
        doc.text(item.unit || 'pcs', colX[4], currentY + 6, { width: colWidths[4], align: 'center' });
        doc.text(formatIndianCurrency(item.rate), colX[5], currentY + 6, { width: colWidths[5] - 6, align: 'right' });
        doc.font('Helvetica-Bold').text(formatIndianCurrency(item.amount), colX[6], currentY + 6, {
          width: colWidths[6] - 8,
          align: 'right',
        });

        currentY += rowHeight;
      });

      // 3. Render Financial Summary Block
      const summaryBlockHeight = 120;
      checkPageOverflow(summaryBlockHeight);

      currentY += 8;
      const summaryLeftWidth = 300;
      const summaryRightWidth = contentWidth - summaryLeftWidth - 10;
      const rightColX = margin + summaryLeftWidth + 10;
      const summaryTop = currentY;

      // Left: Amount in Words & Bank Details
      doc.rect(margin, summaryTop, summaryLeftWidth, summaryBlockHeight - 8).fillAndStroke(bgLight, borderGrey);

      doc.fillColor(primaryNavy).font('Helvetica-Bold').fontSize(8).text('TOTAL AMOUNT IN WORDS:', margin + 8, summaryTop + 8);
      doc.fillColor(textDark).font('Helvetica-Bold').fontSize(8.5).text(data.amountInWords || 'Rupees Zero Only', margin + 8, summaryTop + 20, {
        width: summaryLeftWidth - 16,
      });

      // Bank Details Snapshot
      if (data.company.bankAccountNumber || data.company.bankName) {
        doc.moveTo(margin + 8, summaryTop + 45).lineTo(margin + summaryLeftWidth - 8, summaryTop + 45).strokeColor(borderGrey).lineWidth(0.5).stroke();
        doc.fillColor(primaryNavy).font('Helvetica-Bold').fontSize(8).text('BANK DETAILS FOR SETTLEMENT:', margin + 8, summaryTop + 52);
        doc.font('Helvetica').fontSize(7.5).fillColor(secondarySlate);
        let bankY = summaryTop + 64;
        if (data.company.bankName) {
          doc.text(`Bank: ${data.company.bankName}${data.company.bankBranch ? ` (${data.company.bankBranch})` : ''}`, margin + 8, bankY);
          bankY += 10;
        }
        if (data.company.bankAccountNumber) {
          doc.text(`A/C No: ${data.company.bankAccountNumber}    IFSC: ${data.company.bankIfsc || '—'}`, margin + 8, bankY);
        }
      }

      // Right: Detailed Financial Breakdown
      let totalRowY = summaryTop + 2;
      const drawSummaryRow = (label: string, amount: string | number, isBold: boolean = false, isAccent: boolean = false) => {
        doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(isBold ? 9 : 8);
        doc.fillColor(isAccent ? primaryNavy : textDark);
        doc.text(label, rightColX, totalRowY, { width: 110, align: 'left' });
        doc.text(`₹ ${formatIndianCurrency(amount)}`, rightColX + 110, totalRowY, {
          width: summaryRightWidth - 110,
          align: 'right',
        });
        totalRowY += 15;
      };

      drawSummaryRow('Subtotal', data.totals.subtotal);

      if (Number(data.totals.discountAmount || 0) > 0) {
        const discLabel = data.totals.discountType === 'percentage' ? `Discount (${data.totals.discountValue}%)` : 'Discount';
        drawSummaryRow(discLabel, `-${data.totals.discountAmount}`);
      }

      drawSummaryRow('Taxable Amount', data.totals.taxableAmount, true);

      if (data.totals.gstEnabled) {
        if (Number(data.totals.cgstAmount || 0) > 0 || Number(data.totals.sgstAmount || 0) > 0) {
          const halfRate = (Number(data.totals.gstRate || 0) / 2).toFixed(1);
          drawSummaryRow(`CGST (${halfRate}%)`, data.totals.cgstAmount || 0);
          drawSummaryRow(`SGST (${halfRate}%)`, data.totals.sgstAmount || 0);
        } else if (Number(data.totals.igstAmount || 0) > 0) {
          drawSummaryRow(`IGST (${data.totals.gstRate}%)`, data.totals.igstAmount || 0);
        }
      }

      // Grand Total Highlighted Box
      doc.rect(rightColX - 4, totalRowY - 2, summaryRightWidth + 4, 22).fill(primaryNavy);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff');
      doc.text('Grand Total', rightColX, totalRowY + 4, { width: 110, align: 'left' });
      doc.text(`₹ ${formatIndianCurrency(data.totals.grandTotal)}`, rightColX + 110, totalRowY + 4, {
        width: summaryRightWidth - 110,
        align: 'right',
      });

      currentY = summaryTop + summaryBlockHeight + 6;

      // 4. Commercial Terms & Authorized Signature Block
      const termsBlockHeight = 110;
      checkPageOverflow(termsBlockHeight);

      const termsWidth = contentWidth - 170;
      const termsX = margin;
      const signX = margin + termsWidth + 10;
      const signWidth = 160;
      const termsTop = currentY;

      // Terms Box
      doc.rect(termsX, termsTop, termsWidth, termsBlockHeight).fillAndStroke(bgLight, borderGrey);
      doc.fillColor(primaryNavy).font('Helvetica-Bold').fontSize(8.5).text('COMMERCIAL TERMS & CONDITIONS:', termsX + 8, termsTop + 8);

      doc.font('Helvetica').fontSize(7.5).fillColor(secondarySlate);
      let termLineY = termsTop + 22;
      const standardTerms = (
        data.termsAndConditions ||
        'Payment terms: 100% advance or as agreed.\nDelivery: As per standard schedule.\nWarranty: Standard manufacturer support.'
      ).split('\n');
      standardTerms.slice(0, 6).forEach((term) => {
        doc.text(`• ${term.trim()}`, termsX + 8, termLineY, { width: termsWidth - 16 });
        termLineY += 10;
      });

      if (data.company.bankName || data.company.bankAccountNumber) {
        termLineY += 2;
        const bankInfo = [
          data.company.bankName ? `Bank: ${data.company.bankName}` : null,
          data.company.bankAccountNumber ? `A/C: ${data.company.bankAccountNumber}` : null,
          data.company.bankIfsc ? `IFSC: ${data.company.bankIfsc}` : null,
          data.company.bankBranch ? `Branch: ${data.company.bankBranch}` : null,
        ]
          .filter(Boolean)
          .join(' | ');
        doc.font('Helvetica-Bold').text(bankInfo, termsX + 8, termLineY, { width: termsWidth - 16 });
        termLineY += 10;
      }

      if (data.notes) {
        termLineY += 2;
        doc.font('Helvetica-Bold').text(`Note: ${data.notes}`, termsX + 8, termLineY, { width: termsWidth - 16 });
      }

      // Signature Box
      doc.rect(signX, termsTop, signWidth, termsBlockHeight).strokeColor(borderGrey).stroke();
      doc.fillColor(primaryNavy).font('Helvetica-Bold').fontSize(8).text(`For ${data.company.companyName || 'ALGIONS AI LABS PRIVATE LIMITED'}`, signX + 6, termsTop + 8, {
        width: signWidth - 12,
        align: 'center',
      });

      doc.fillColor(secondarySlate).font('Helvetica').fontSize(7.5).text(data.company.signatoryTitle || 'Authorized Signatory', signX + 6, termsTop + termsBlockHeight - 18, {
        width: signWidth - 12,
        align: 'center',
      });

      // 5. Finalize All Page Footers ("Page X of Y" & Thank you note)
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);

        // Footer divider line
        doc.moveTo(margin, pageHeight - 34)
          .lineTo(margin + contentWidth, pageHeight - 34)
          .strokeColor(borderGrey)
          .lineWidth(0.5)
          .stroke();

        doc.font('Helvetica').fontSize(7.5).fillColor(secondarySlate);
        const companyLegalName = data.company.companyName || 'Algions AI Labs Private Limited';
        doc.text(`Thank you for your business. This quotation is a commercial offer issued by ${companyLegalName}.`, margin, pageHeight - 24, {
          align: 'left',
          width: contentWidth - 80,
        });

        doc.text(`Page ${i + 1} of ${range.count}`, margin + contentWidth - 70, pageHeight - 24, {
          align: 'right',
          width: 70,
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
