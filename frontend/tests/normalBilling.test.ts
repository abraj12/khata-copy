import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { numberWords } from '../src/components/MannatTaxInvoice/MannatTaxInvoice.js';
import { mapNormalBillToInvoiceProps, NormalBillRecord } from '../src/features/bills/normalBillsApi.js';

describe('Normal Billing Module (Frontend Calculation & Bill Mapping)', () => {
  it('1. Calculates line items and grand total without any GST using Decimal.js', () => {
    const items = [
      { quantity: '2', rate: '1750' }, // 3500
      { quantity: '5', rate: '240' },  // 1200
      { quantity: '10', rate: '35.50' }, // 355
    ];

    let totalAmountDec = new Decimal(0);
    items.forEach((item) => {
      const q = new Decimal(item.quantity || 0);
      const r = new Decimal(item.rate || 0);
      totalAmountDec = totalAmountDec.plus(q.times(r).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
    });

    const totalAmount = totalAmountDec.toNumber();
    expect(totalAmount).toBe(5055);
    expect(numberWords(totalAmount)).toBe('Rupees Five Thousand Fifty Five Only');
  });

  it('2. Maps NormalBillRecord cleanly to MannatInvoiceProps with zero taxes', () => {
    const record: NormalBillRecord = {
      id: 88,
      bill_number: '005',
      bill_date: '2026-11-02',
      state: 'Uttar Pradesh',
      state_code: '09',
      transportation_mode: 'Tempo',
      vehicle_number: 'UP 22 T 5555',
      date_of_supply: '2026-11-02',
      place_of_supply: 'Bilaspur',
      customer_id: 1,
      customer_name: 'Khan Hardware Store',
      customer_address: 'Main Road Bilaspur',
      customer_phone: '9876543210',
      customer_state: 'Uttar Pradesh',
      customer_state_code: '09',
      total_amount: '4500.00',
      amount_in_words: 'Rupees Four Thousand Five Hundred Only',
      r2_object_key: null,
      pdf_status: 'local_only',
      notes: 'Cash payment',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      items: [
        {
          id: 1,
          bill_id: 88,
          product_id: 2,
          item_index: 1,
          description: 'HDF Board 12mm',
          hsn_code: '4411',
          quantity: '2.000',
          unit: 'pcs',
          rate: '2250.00',
          rate_unit: null,
          amount: '4500.00',
          created_at: new Date().toISOString(),
        },
      ],
    };

    const invoiceProps = mapNormalBillToInvoiceProps(record);

    expect(invoiceProps.id).toBe(88);
    expect(invoiceProps.invoiceNumber).toBe('005');
    expect(invoiceProps.invoiceDate).toBe('2026-11-02');
    expect(invoiceProps.customer?.name).toBe('Khan Hardware Store');
    expect(invoiceProps.totals?.taxableAmount).toBe('4500.00');
    expect(invoiceProps.totals?.taxAmount).toBe(0);
    expect(invoiceProps.totals?.grandTotal).toBe('4500.00');
    expect(invoiceProps.items).toHaveLength(1);
    expect(invoiceProps.items?.[0].name).toBe('HDF Board 12mm');
  });

  it('3. Accurately calculates half-up boundary cases with Decimal.js (e.g. 0.01 * 401.50 = 4.02)', () => {
    const qDec = new Decimal('0.01');
    const rDec = new Decimal('401.50');
    const lineAmt = qDec.times(rDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    expect(lineAmt).toBe(4.02);
  });
});
