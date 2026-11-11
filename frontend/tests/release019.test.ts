import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  getBusinessDateISO,
  isValidBusinessDate,
  addBusinessCalendarDays,
} from '../src/utils/businessDate.js';
import {
  INDIAN_STATES,
  getStateByCode,
  getStateByName,
  resolveCustomerStateSelection,
  extractStateCodeFromGstin,
} from '../src/lib/indianStates.js';
import {
  applyCatalogProductToDraftLine,
  validateQuantityInput,
  validateSellingRateInput,
} from '../src/utils/lineItemDraft.js';
import { mapRecordToInvoiceProps, GstInvoiceRecord } from '../src/features/bills/gstInvoicesApi.js';
import { mapNormalBillToInvoiceProps, NormalBillRecord } from '../src/features/bills/normalBillsApi.js';

describe('Khata Release #019 Frontend Regression Suite', () => {
  it('1. Computes business date strictly in Asia/Kolkata IST timezone around UTC midnight', () => {
    expect(DEFAULT_BUSINESS_TIMEZONE).toBe('Asia/Kolkata');

    // 18:29:59 UTC on Nov 10 = 23:59:59 IST on Nov 10
    expect(getBusinessDateISO('Asia/Kolkata', new Date('2026-11-10T18:29:59.000Z'))).toBe('2026-11-10');
    // 18:30:00 UTC on Nov 10 = 00:00:00 IST on Nov 11
    expect(getBusinessDateISO('Asia/Kolkata', new Date('2026-11-10T18:30:00.000Z'))).toBe('2026-11-11');

    expect(addBusinessCalendarDays(30, '2026-11-10', 'Asia/Kolkata')).toBe('2026-12-10');
    expect(isValidBusinessDate('2024-02-29')).toBe(true);
    expect(isValidBusinessDate('2025-02-29')).toBe(false);
    expect(isValidBusinessDate('2026-02-31')).toBe(false);
  });

  it('2. Resolves Indian states cleanly and clears previous customer state when switching to a customer without state', () => {
    expect(INDIAN_STATES.length).toBeGreaterThanOrEqual(36);
    expect(getStateByCode('9')).toEqual({ code: '09', name: 'Uttar Pradesh' });
    expect(getStateByName('Bihar')).toEqual({ code: '10', name: 'Bihar' });

    // Customer with state
    expect(resolveCustomerStateSelection({ state: 'Maharashtra', state_code: '27' })).toEqual({
      state: 'Maharashtra',
      stateCode: '27',
    });

    // Customer without state must clear state (never default to Bihar)
    expect(resolveCustomerStateSelection({ state: null, state_code: null })).toEqual({
      state: '',
      stateCode: '',
    });
    expect(resolveCustomerStateSelection(null)).toEqual({ state: '', stateCode: '' });
    expect(extractStateCodeFromGstin('09AABCS1429B1ZS')).toBe('09');
  });

  it('3. Product/barcode selection NEVER copies buying_price into selling rate and enforces 2-decimal quantity', () => {
    const emptyLine = {
      productId: null,
      description: '',
      hsnCode: '',
      barcode: '',
      rate: '',
      buyingPriceReference: null,
    };

    const product = {
      id: 42,
      name: 'Fevicol SH 1kg',
      buying_price: '450.00',
      hsn_code: '3506',
      barcode: '8901860001234',
    };

    const updatedFromEmpty = applyCatalogProductToDraftLine(emptyLine, product);
    expect(updatedFromEmpty.productId).toBe(42);
    expect(updatedFromEmpty.description).toBe('Fevicol SH 1kg');
    expect(updatedFromEmpty.buyingPriceReference).toBe('450.00');
    // Crucial: selling rate must stay empty rather than prefilling 450.00 buying cost
    expect(updatedFromEmpty.rate).toBe('');

    // Explicit selling rate already typed by operator is preserved
    const updatedWithExplicitRate = applyCatalogProductToDraftLine(
      { ...emptyLine, rate: '625.00' },
      product
    );
    expect(updatedWithExplicitRate.rate).toBe('625.00');
    expect(updatedWithExplicitRate.buyingPriceReference).toBe('450.00');

    // Quantity validation up to 2 decimal places
    expect(validateQuantityInput('1')).toBeNull();
    expect(validateQuantityInput('1.25')).toBeNull();
    expect(validateQuantityInput('0.01')).toBeNull();
    expect(validateQuantityInput('1000000')).toBeNull();
    expect(validateQuantityInput('0')).not.toBeNull();
    expect(validateQuantityInput('-1')).not.toBeNull();
    expect(validateQuantityInput('1.234')).not.toBeNull();
    expect(validateQuantityInput('1000000.01')).not.toBeNull();
    expect(validateQuantityInput('1e3')).not.toBeNull();

    // Selling rate allows 0 for promotional/free line or positive up to 2 decimals
    expect(validateSellingRateInput('0')).toBeNull();
    expect(validateSellingRateInput('580.50')).toBeNull();
    expect(validateSellingRateInput('-5')).not.toBeNull();
    expect(validateSellingRateInput('10.123')).not.toBeNull();
  });

  it('4. Invoice & Normal Bill prop mappers pass dynamic company profile and never invent Bihar for null buyer state', () => {
    const company = {
      name: 'DYNAMIC SELLER PVT LTD',
      address: 'Gopalganj, Bihar',
      gstin: '10ABGCA8624E1Z3',
      phone: '9493840000',
    };

    const normalBill: NormalBillRecord = {
      id: 9,
      bill_number: '009',
      bill_date: '2026-11-11',
      state: 'Bihar',
      state_code: '10',
      customer_id: null,
      customer_name: 'Walk-in Buyer',
      customer_state: null,
      customer_state_code: null,
      total_amount: '500.00',
      amount_in_words: 'Rupees Five Hundred Only',
      r2_object_key: null,
      pdf_status: 'local_only',
      created_at: '2026-11-11T00:00:00Z',
      updated_at: '2026-11-11T00:00:00Z',
      items: [],
    };

    const mappedNormal = mapNormalBillToInvoiceProps(normalBill, company);
    expect(mappedNormal.company?.name).toBe('DYNAMIC SELLER PVT LTD');
    expect(mappedNormal.customer?.state).toBeNull();
    expect(mappedNormal.customer?.stateCode).toBeNull();

    const gstInv: GstInvoiceRecord = {
      id: 10,
      invoice_number: '010',
      invoice_date: '2026-11-11',
      state: 'Bihar',
      state_code: '10',
      customer_id: null,
      customer_name: 'UP Buyer',
      customer_state: 'Uttar Pradesh',
      customer_state_code: '09',
      taxable_amount: '1000.00',
      cgst_rate: '0.00',
      cgst_amount: '0.00',
      sgst_rate: '0.00',
      sgst_amount: '0.00',
      igst_rate: '18.00',
      igst_amount: '180.00',
      tax_amount: '180.00',
      grand_total: '1180.00',
      amount_in_words: 'Rupees One Thousand One Hundred Eighty Only',
      r2_object_key: null,
      pdf_status: 'local_only',
      created_at: '2026-11-11T00:00:00Z',
      updated_at: '2026-11-11T00:00:00Z',
      items: [],
    };

    const mappedGst = mapRecordToInvoiceProps(gstInv, company);
    expect(mappedGst.company?.name).toBe('DYNAMIC SELLER PVT LTD');
    expect(mappedGst.customer?.state).toBe('Uttar Pradesh');
    expect(mappedGst.customer?.stateCode).toBe('09');
  });
});
