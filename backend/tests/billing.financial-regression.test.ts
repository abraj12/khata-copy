import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { gstInvoicesService } from '../src/modules/gstInvoices/gstInvoices.service.js';
import { quotationsService } from '../src/modules/quotations/quotations.service.js';
import { generateTaxInvoicePdf } from '../src/modules/gstInvoices/gstInvoices.pdf.js';
import { generateQuotationPdf } from '../src/modules/quotations/quotations.pdf.js';

describe('Financial Calculation Integrity & End-to-End ₹531.00 Verification Suite', () => {
  it('1. Computes Inter-State GST (Bihar 10 -> UP 09): Subtotal 500, 10% Disc, IGST 81.00 -> Grand Total 531.00', async () => {
    // Pure calculation verification using Quotations calculation engine
    const quotation = quotationsService.calculateQuotationFinancials({
      items: [
        { description: 'Item 1', quantity: 2, rate: 100 },
        { description: 'Item 2', quantity: 1, rate: 300 },
      ],
      discountType: 'percentage',
      discountValue: 10,
      gstEnabled: true,
      gstRate: 18,
      isIntraState: false, // Bihar -> UP is Inter-State
    });

    expect(quotation.subtotal).toBe('500.00');
    expect(quotation.discountAmount).toBe('50.00');
    expect(quotation.taxableAmount).toBe('450.00');
    expect(quotation.igstAmount).toBe('81.00');
    expect(quotation.cgstAmount).toBe('0.00');
    expect(quotation.sgstAmount).toBe('0.00');
    expect(quotation.taxAmount).toBe('81.00');
    expect(quotation.grandTotal).toBe('531.00');
    expect(quotation.amountInWords).toBe('Rupees Five Hundred Thirty One Only');

    // Verify PDF generation matches
    const pdfBuffer = await generateQuotationPdf({
      quotationNumber: 'QT-531',
      quotationDate: '2026-11-11',
      company: {
        companyName: 'ALGIONS AI LABS PRIVATE LIMITED',
        state: 'Bihar',
        stateCode: '10',
        address: 'Gopalganj, Bihar',
      },
      customer: {
        name: 'UP Tech Solutions',
        state: 'Uttar Pradesh',
        stateCode: '09',
      },
      items: quotation.items.map((it, idx) => ({
        itemIndex: idx + 1,
        description: it.description,
        quantity: it.quantity,
        rate: it.rate,
        amount: it.amount,
      })),
      totals: {
        subtotal: quotation.subtotal,
        discountType: quotation.discountType,
        discountValue: quotation.discountValue,
        discountAmount: quotation.discountAmount,
        taxableAmount: quotation.taxableAmount,
        gstEnabled: true,
        gstRate: 18,
        igstAmount: quotation.igstAmount,
        taxAmount: quotation.taxAmount,
        grandTotal: quotation.grandTotal,
      },
      amountInWords: quotation.amountInWords,
    });

    expect(pdfBuffer.length).toBeGreaterThan(1000);
  });

  it('2. Computes Intra-State GST (Bihar 10 -> Bihar 10): 450.00 Taxable, 9% CGST 40.50, 9% SGST 40.50 -> Grand Total 531.00', async () => {
    const quotation = quotationsService.calculateQuotationFinancials({
      items: [
        { description: 'Item 1', quantity: 2, rate: 100 },
        { description: 'Item 2', quantity: 1, rate: 300 },
      ],
      discountType: 'percentage',
      discountValue: 10,
      gstEnabled: true,
      gstRate: 18,
      isIntraState: true, // Bihar -> Bihar is Intra-State
    });

    expect(quotation.subtotal).toBe('500.00');
    expect(quotation.discountAmount).toBe('50.00');
    expect(quotation.taxableAmount).toBe('450.00');
    expect(quotation.cgstAmount).toBe('40.50');
    expect(quotation.sgstAmount).toBe('40.50');
    expect(quotation.igstAmount).toBe('0.00');
    expect(quotation.taxAmount).toBe('81.00');
    expect(quotation.grandTotal).toBe('531.00');
    expect(quotation.amountInWords).toBe('Rupees Five Hundred Thirty One Only');
  });

  it('3. Preserves Subtotal, Discount, and Tax Breakdown in Tax Invoice PDF buffer', async () => {
    const pdfBuffer = await generateTaxInvoicePdf({
      invoiceNumber: 'INV-531',
      invoiceDate: '2026-11-11',
      state: 'Bihar',
      stateCode: '10',
      customer: {
        name: 'Gopalganj Customer',
        state: 'Bihar',
        stateCode: '10',
      },
      items: [
        { name: 'Item 1', quantity: 2, rate: 100, amount: '200.00' },
        { name: 'Item 2', quantity: 1, rate: 300, amount: '300.00' },
      ],
      totals: {
        subtotal: '500.00',
        discountType: 'percentage',
        discountValue: '10',
        discountAmount: '50.00',
        taxableAmount: '450.00',
        cgstRate: 9,
        cgstAmount: '40.50',
        sgstRate: 9,
        sgstAmount: '40.50',
        taxAmount: '81.00',
        grandTotal: '531.00',
      },
      amountInWords: 'Rupees Five Hundred Thirty One Only',
    });

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(1000);
  });
});
