// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import { numberWords } from '../src/components/MannatTaxInvoice/MannatTaxInvoice.js';
import { mapRecordToInvoiceProps, GstInvoiceRecord } from '../src/features/bills/gstInvoicesApi.js';
import { getTodayLocalDate, GstBillingView } from '../src/features/bills/GstBillingView.js';
import { validatePercentageDraftInput } from '../src/utils/lineItemDraft.js';
import { MAX_BILL_LINE_ITEMS } from '../src/utils/billingLimits.js';
import * as gstInvoicesApi from '../src/features/bills/gstInvoicesApi.js';
import * as quotationApi from '../src/features/quotations/quotationApi.js';
import * as apiClientMod from '../src/lib/apiClient.js';

vi.mock('../src/features/bills/gstInvoicesApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/bills/gstInvoicesApi.js')>(
    '../src/features/bills/gstInvoicesApi.js'
  );
  return {
    ...actual,
    getNextInvoiceNumber: vi.fn(),
    listGstInvoices: vi.fn(),
    createGstInvoice: vi.fn(),
    downloadDraftPdf: vi.fn(),
    downloadInvoicePdf: vi.fn(),
  };
});

vi.mock('../src/features/quotations/quotationApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/quotations/quotationApi.js')>(
    '../src/features/quotations/quotationApi.js'
  );
  return {
    ...actual,
    fetchQuotationSettings: vi.fn(),
  };
});

vi.mock('../src/lib/apiClient.js', () => ({
  apiClient: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
      customer_gstin: '09AABCS1429B1ZS',
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
    const istParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const expectedYear = istParts.find((p) => p.type === 'year')?.value;
    const expectedMonth = istParts.find((p) => p.type === 'month')?.value;
    const expectedDay = istParts.find((p) => p.type === 'day')?.value;
    expect(today).toBe(`${expectedYear}-${expectedMonth}-${expectedDay}`);

    // Verify IST midnight rollover (18:30 UTC) returns next IST calendar date on UTC CI runners
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-10T18:30:00.000Z'));
      expect(getTodayLocalDate()).toBe('2026-11-11');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Release #023: GstBillingView Races, Live Decimal Safety, 20-Item Limit & Large Catalogue Scaling', () => {
  let container: HTMLDivElement;
  let root: Root;

  const setInputVal = (el: HTMLInputElement, val: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();

    (quotationApi.fetchQuotationSettings as any).mockResolvedValue({
      companyName: 'ALGIONS AI LABS PRIVATE LIMITED',
      gstin: '09AAAAA0000A1Z0',
      state: 'Uttar Pradesh',
      stateCode: '09',
    });
    (gstInvoicesApi.getNextInvoiceNumber as any).mockResolvedValue('009');
    (gstInvoicesApi.listGstInvoices as any).mockResolvedValue({
      invoices: [],
      pagination: { total: 0, limit: 25, offset: 0, hasMore: false },
    });

    const products = Array.from({ length: 1210 }, (_, idx) => ({
      id: idx + 1,
      name: `GST Product ${String(idx + 1).padStart(4, '0')}`,
      buying_price: '210.00',
      hsn_code: '4411',
      barcode: `GST-BAR-${idx + 1}`,
    }));
    const customers = Array.from({ length: 1210 }, (_, idx) => ({
      id: idx + 1,
      name: `GST Buyer ${String(idx + 1).padStart(4, '0')}`,
      phone: `97${String(10000000 + idx)}`,
      address: 'Station Road',
      gstin: '09AABCS1429B1ZS',
      state: 'Uttar Pradesh',
      state_code: '09',
    }));

    (apiClientMod.apiClient as any).mockImplementation(async (url: string) => {
      const parsed = new URL(url, 'http://localhost');
      const search = (parsed.searchParams.get('search') || '').trim().toLowerCase();
      const offset = Number(parsed.searchParams.get('offset') || '0');
      const limit = Number(parsed.searchParams.get('limit') || '25');
      if (parsed.pathname === '/api/v1/products') {
        const filtered = search
          ? products.filter((p) => p.name.toLowerCase().includes(search))
          : products;
        const page = filtered.slice(offset, offset + limit);
        const hasMore = offset + page.length < filtered.length;
        return {
          status: 200,
          data: {
            success: true,
            data: page,
            pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + page.length : null },
          },
        };
      }
      if (parsed.pathname === '/api/v1/khata/customers') {
        const filtered = search
          ? customers.filter((c) => c.name.toLowerCase().includes(search))
          : customers;
        const page = filtered.slice(offset, offset + limit);
        const hasMore = offset + page.length < filtered.length;
        return {
          status: 200,
          data: {
            success: true,
            customers: page,
            pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + page.length : null },
          },
        };
      }
      return { status: 200, data: {} };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('6. Prevents Invoice History stale responses and preserves safe live totals while typing partial decimals', async () => {
    let resolveFirst!: (v: any) => void;
    let resolveSecond!: (v: any) => void;

    (gstInvoicesApi.listGstInvoices as any).mockImplementation(async (params: any) => {
      if (params?.search === 'FirstCo') {
        return new Promise((r) => {
          resolveFirst = r;
        });
      }
      if (params?.search === 'SecondCo') {
        return new Promise((r) => {
          resolveSecond = r;
        });
      }
      return { invoices: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } };
    });

    await act(async () => {
      root.render(React.createElement(GstBillingView));
    });

    // Live UI must never crash when user types incomplete numeric fragments (".", "-", "") in rate/qty inputs
    const numericTextInputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"], input[type="number"]'));
    if (numericTextInputs.length > 0) {
      for (const badFrag of ['.', '-', '']) {
        await act(async () => {
          setInputVal(numericTextInputs[0], badFrag);
        });
        expect(container.textContent).toContain('T. Amt. Before Tax');
        expect(container.textContent).not.toContain('NaN');
      }
    }

    // Strict GST rate validation helper rejects negative, >100, >2 decimals, exponent & text
    for (const badRate of [-5, 100.01, '18.123', '1e1', 'abc']) {
      expect(validatePercentageDraftInput(badRate, 'GST Rate')).not.toBeNull();
    }
    expect(validatePercentageDraftInput(5.5, 'GST Rate')).toBeNull();

    // History stale race check
    const historyTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Invoice History')
    )!;
    await act(async () => {
      historyTab.click();
    });

    const histSearch = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search by invoice # or customer name..."]'
    )!;
    await act(async () => {
      setInputVal(histSearch, 'FirstCo');
      await vi.advanceTimersByTimeAsync(320);
    });
    await act(async () => {
      setInputVal(histSearch, 'SecondCo');
      await vi.advanceTimersByTimeAsync(320);
    });

    await act(async () => {
      resolveSecond({
        invoices: [{ id: 2, invoice_number: 'GST-SECOND', invoice_date: '2026-11-02', customer_name: 'SecondCo', grand_total: '590.00', pdf_status: 'local_only' }],
        pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
      });
    });
    expect(container.textContent).toContain('GST-SECOND');

    await act(async () => {
      resolveFirst({
        invoices: [{ id: 1, invoice_number: 'GST-FIRST', invoice_date: '2026-11-02', customer_name: 'FirstCo', grand_total: '118.00', pdf_status: 'local_only' }],
        pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
      });
    });
    expect(container.textContent).toContain('GST-SECOND');
    expect(container.textContent).not.toContain('GST-FIRST');
  });

  it('7. Enforces 100-item cap and discovers >1000 server products & customers via debounced search', async () => {
    await act(async () => {
      root.render(React.createElement(GstBillingView));
    });

    const getAddBtn = () =>
      Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Add Item')
      )!;
    const addBtn = getAddBtn();
    await act(async () => {
      for (let i = 1; i < MAX_BILL_LINE_ITEMS; i++) {
        vi.advanceTimersByTime(1);
        addBtn.click();
      }
    });
    expect(getAddBtn().disabled).toBe(true);
    expect(container.textContent).toContain(`Maximum limit of ${MAX_BILL_LINE_ITEMS} line items reached`);

    // Customer beyond entry 1000
    const pickCust = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Pick Khata Customer')
    )!;
    await act(async () => {
      pickCust.click();
    });
    const custSearch = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search customer by name or phone..."]'
    )!;
    await act(async () => {
      setInputVal(custSearch, 'GST Buyer 1150');
      await vi.advanceTimersByTimeAsync(320);
    });
    const buyer1150 = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('GST Buyer 1150')
    )!;
    await act(async () => {
      buyer1150.click();
    });
    const hasSelected = Array.from(container.querySelectorAll<HTMLInputElement>('input')).some(
      (i) => i.value === 'GST Buyer 1150'
    );
    expect(hasSelected).toBe(true);

    // Product beyond entry 1000
    const catalogBtn = container.querySelector<HTMLButtonElement>(
      'button[title="Pick from store product catalogue"]'
    )!;
    await act(async () => {
      catalogBtn.click();
    });
    const prodSearch = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search products by name, HSN, or barcode..."]'
    )!;
    await act(async () => {
      setInputVal(prodSearch, 'GST Product 1150');
      await vi.advanceTimersByTimeAsync(320);
    });
    const prod1150 = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('GST Product 1150')
    )!;
    await act(async () => {
      prod1150.click();
    });
    expect(container.textContent).toContain('GST Product 1150');
  }, 45_000);
});
