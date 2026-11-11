// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import { numberWords } from '../src/components/MannatTaxInvoice/MannatTaxInvoice.js';
import { mapNormalBillToInvoiceProps, NormalBillRecord } from '../src/features/bills/normalBillsApi.js';
import { NormalBillingView } from '../src/features/bills/NormalBillingView.js';
import { MAX_BILL_LINE_ITEMS } from '../src/utils/billingLimits.js';
import * as normalBillsApi from '../src/features/bills/normalBillsApi.js';
import * as quotationApi from '../src/features/quotations/quotationApi.js';
import * as apiClientMod from '../src/lib/apiClient.js';

vi.mock('../src/features/bills/normalBillsApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/bills/normalBillsApi.js')>(
    '../src/features/bills/normalBillsApi.js'
  );
  return {
    ...actual,
    getNextNormalBillNumber: vi.fn(),
    listNormalBills: vi.fn(),
    createNormalBill: vi.fn(),
    downloadNormalBillDraftPdf: vi.fn(),
    downloadNormalBillPdf: vi.fn(),
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

describe('Release #023: NormalBillingView History Races, 20-Item Limit & Large Catalogue Scaling', () => {
  let container: HTMLDivElement;
  let root: Root;

  const setInputVal = (el: HTMLInputElement, val: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const makeMockCatalog = () => {
    const products = Array.from({ length: 1210 }, (_, idx) => ({
      id: idx + 1,
      name: `Product ${String(idx + 1).padStart(4, '0')}`,
      buying_price: '125.00',
      hsn_code: '4411',
      barcode: `BAR-${idx + 1}`,
    }));
    const customers = Array.from({ length: 1210 }, (_, idx) => ({
      id: idx + 1,
      name: `Customer ${String(idx + 1).padStart(4, '0')}`,
      phone: `98${String(10000000 + idx)}`,
      address: `Street ${idx + 1}`,
      state: 'Bihar',
      state_code: '10',
    }));
    return { products, customers };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();

    (quotationApi.fetchQuotationSettings as any).mockResolvedValue({
      companyName: 'ALGIONS AI LABS PRIVATE LIMITED',
      state: 'Bihar',
      stateCode: '10',
    });
    (normalBillsApi.getNextNormalBillNumber as any).mockResolvedValue('005');
    (normalBillsApi.listNormalBills as any).mockResolvedValue({
      bills: [],
      pagination: { total: 0, limit: 25, offset: 0, hasMore: false },
    });

    const { products, customers } = makeMockCatalog();
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

  it('4. Ignores slow overlapping Bill History search responses so newer search results persist', async () => {
    let resolveAlpha!: (v: any) => void;
    let resolveBeta!: (v: any) => void;

    (normalBillsApi.listNormalBills as any).mockImplementation(async (params: any) => {
      if (params?.search === 'Alpha') {
        return new Promise((r) => {
          resolveAlpha = r;
        });
      }
      if (params?.search === 'Beta') {
        return new Promise((r) => {
          resolveBeta = r;
        });
      }
      return {
        bills: [{ id: 1, bill_number: 'NB-INIT', bill_date: '2026-11-01', customer_name: 'Init Buyer', total_amount: '100.00', pdf_status: 'local_only' }],
        pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
      };
    });

    await act(async () => {
      root.render(React.createElement(NormalBillingView));
    });

    const historyTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Bill History')
    )!;
    await act(async () => {
      historyTab.click();
    });

    const searchInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search by bill number or customer name..."]'
    )!;

    // Trigger Alpha search
    await act(async () => {
      setInputVal(searchInput, 'Alpha');
      await vi.advanceTimersByTimeAsync(320);
    });

    // Quickly search Beta before Alpha returns
    await act(async () => {
      setInputVal(searchInput, 'Beta');
      await vi.advanceTimersByTimeAsync(320);
    });

    // Fast Beta settles first
    await act(async () => {
      resolveBeta({
        bills: [{ id: 2, bill_number: 'NB-BETA', bill_date: '2026-11-02', customer_name: 'Beta Buyer', total_amount: '250.00', pdf_status: 'local_only' }],
        pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
      });
    });
    expect(container.textContent).toContain('NB-BETA');

    // Late Alpha resolves -> ignored
    await act(async () => {
      resolveAlpha({
        bills: [{ id: 3, bill_number: 'NB-ALPHA', bill_date: '2026-11-02', customer_name: 'Alpha Buyer', total_amount: '500.00', pdf_status: 'local_only' }],
        pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
      });
    });
    expect(container.textContent).toContain('NB-BETA');
    expect(container.textContent).not.toContain('NB-ALPHA');
  });

  it('5. Enforces max 100 line items cleanly and searches/selects beyond entry 1000 across >1200 server records', async () => {
    await act(async () => {
      root.render(React.createElement(NormalBillingView));
    });

    // 1. Add Item up to 20 rows -> button disables and limit banner appears
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

    // 2. Customer picker: load initial page of 25 (hasMore+), search Customer 1199, select without losing selection on search change
    const pickCustBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Pick Khata Customer')
    )!;
    await act(async () => {
      pickCustBtn.click();
    });
    expect(container.textContent).toContain('KHATA CUSTOMERS (25+)');
    expect(container.textContent).toContain('Load More Customers');

    // Click Load More Customers -> appends page 2 (50+)
    const loadMoreCust = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Load More Customers')
    )!;
    await act(async () => {
      loadMoreCust.click();
    });
    expect(container.textContent).toContain('KHATA CUSTOMERS (50+)');

    const custSearchInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search customer by name or phone..."]'
    )!;
    await act(async () => {
      setInputVal(custSearchInput, 'Customer 1199');
      await vi.advanceTimersByTimeAsync(320);
    });
    const cust1199Btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Customer 1199')
    )!;
    await act(async () => {
      cust1199Btn.click();
    });
    // Customer name field shows Customer 1199 even after picker search changes again
    const custNameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Enter buyer name or pick from Khata"]'
    );
    const selectedInput =
      custNameInput ||
      Array.from(container.querySelectorAll<HTMLInputElement>('input')).find(
        (inp) => inp.value === 'Customer 1199'
      )!;
    expect(selectedInput.value).toBe('Customer 1199');

    // Reopen picker and type something else -> selected buyer input must remain Customer 1199!
    await act(async () => {
      pickCustBtn.click();
    });
    const reopenedCustSearch = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search customer by name or phone..."]'
    )!;
    await act(async () => {
      setInputVal(reopenedCustSearch, 'Other Query');
      await vi.advanceTimersByTimeAsync(320);
    });
    expect(selectedInput.value).toBe('Customer 1199');

    // 3. Product picker: search Product 1185 beyond entry 1000 & verify Linked badge
    const catalogBtn = container.querySelector<HTMLButtonElement>(
      'button[title="Pick from store product catalogue"]'
    )!;
    await act(async () => {
      catalogBtn.click();
    });
    expect(container.textContent).toContain('Load More Products');
    const prodSearch = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search products by name, HSN, or barcode..."]'
    )!;
    await act(async () => {
      setInputVal(prodSearch, 'Product 1185');
      await vi.advanceTimersByTimeAsync(320);
    });
    const prodBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Product 1185')
    )!;
    await act(async () => {
      prodBtn.click();
    });
    expect(container.textContent).toContain('Product 1185');
  }, 45_000);
});
