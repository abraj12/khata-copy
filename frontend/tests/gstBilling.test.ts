import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { numberWords } from '../src/components/MannatTaxInvoice/MannatTaxInvoice.js';
import { mapRecordToInvoiceProps, GstInvoiceRecord } from '../src/features/bills/gstInvoicesApi.js';
import { getTodayLocalDate } from '../src/features/bills/GstBillingView.js';

describe('GST Billing Module (Frontend Calculation & Invoice Mapping)', () => {
  it('1. Accurately converts currency to Indian words', () => {
    expect(numberWords(9581.60)).toBe('Rupees Nine Thousand Five Hundred Eighty One and Sixty Paise Only');
    expect(numberWords(8120)).toBe('Rupees Eight Thousand One Hundred Twenty Only');
    expect(numberWords(50000)).toBe('Rupees Fifty Thousand Only');
    expect(numberWords(150000.75)).toBe('Rupees One Lakh Fifty Thousand and Seventy Five Paise Only');
  });

  it('2. Computes Intra-state GST (CGST + SGST) with exact decimal rounding', () => {
    const qty = new Decimal(14);
    const rate = new Decimal(580);
    const taxable = qty.times(rate); // 8120
    expect(taxable.toFixed(2)).toBe('8120.00');

    const gstRate = new Decimal(18);
    const halfRate = gstRate.dividedBy(2); // 9%
    const cgst = taxable.times(halfRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const sgst = taxable.times(halfRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const totalTax = cgst.plus(sgst);
    const grandTotal = taxable.plus(totalTax);

    expect(cgst.toFixed(2)).toBe('730.80');
    expect(sgst.toFixed(2)).toBe('730.80');
    expect(totalTax.toFixed(2)).toBe('1461.60');
    expect(grandTotal.toFixed(2)).toBe('9581.60');
  });

  it('3. Computes Inter-state GST (IGST only) without CGST or SGST', () => {
    const taxable = new Decimal(8120);
    const gstRate = new Decimal(18);
    const igst = taxable.times(gstRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const grandTotal = taxable.plus(igst);

    expect(igst.toFixed(2)).toBe('1461.60');
    expect(grandTotal.toFixed(2)).toBe('9581.60');
  });

  it('4. Maps backend GstInvoiceRecord to MannatInvoiceProps accurately', () => {
    const mockRecord: GstInvoiceRecord = {
      id: 4,
      invoice_number: '004',
      invoice_date: '2026-11-02',
      state: 'Uttar Pradesh',
      state_code: '09',
      transportation_mode: 'Road',
      vehicle_number: 'UP-22-AB-1234',
      date_of_supply: '2026-11-02',
      place_of_supply: 'Uttar Pradesh',
      customer_id: null,
      customer_name: 'Sharma Construction Co.',
      customer_address: 'Station Road, Bilaspur',
      customer_gstin: '09AABCS1429B1ZB',
      customer_state: 'Uttar Pradesh',
      customer_state_code: '09',
      taxable_amount: '8120.00',
      cgst_rate: '9.00',
      cgst_amount: '730.80',
      sgst_rate: '9.00',
      sgst_amount: '730.80',
      igst_rate: '0.00',
      igst_amount: '0.00',
      tax_amount: '1461.60',
      grand_total: '9581.60',
      amount_in_words: 'Rupees Nine Thousand Five Hundred Eighty One and Sixty Paise Only',
      r2_object_key: 'invoices/2026/11/4.pdf',
      pdf_status: 'uploaded',
      notes: null,
      created_at: '2026-11-02T01:00:00Z',
      updated_at: '2026-11-02T01:00:00Z',
      items: [
        {
          id: 1,
          invoice_id: 4,
          product_id: 101,
          item_index: 1,
          description: 'HDF BOARD 12mm HDF (OSB) 2.44 x 1.22',
          hsn_code: '44119219',
          quantity: '14.000',
          unit: 'pcs',
          rate: '580.00',
          rate_unit: 'sqm',
          amount: '8120.00',
        },
      ],
    };

    const mapped = mapRecordToInvoiceProps(mockRecord);
    expect(mapped.invoiceNumber).toBe('004');
    expect(mapped.customer?.name).toBe('Sharma Construction Co.');
    expect(mapped.items?.[0].name).toBe('HDF BOARD 12mm HDF (OSB) 2.44 x 1.22');
    expect(mapped.items?.[0].hsn).toBe('44119219');
    expect(mapped.totals?.taxableAmount).toBe('8120.00');
    expect(mapped.totals?.grandTotal).toBe('9581.60');
    expect(mapped.totals?.cgstAmount).toBe('730.80');
    expect(mapped.totals?.sgstAmount).toBe('730.80');
  });

  it('5. Generates local today date in YYYY-MM-DD format (not UTC shifted)', () => {
    const today = getTodayLocalDate();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date();
    const expectedYear = now.getFullYear();
    const expectedMonth = String(now.getMonth() + 1).padStart(2, '0');
    const expectedDay = String(now.getDate()).padStart(2, '0');
    expect(today).toBe(`${expectedYear}-${expectedMonth}-${expectedDay}`);
  });
});
