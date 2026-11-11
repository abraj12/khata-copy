// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import { formatCurrency } from '../src/lib/formatters.js';
import { QuotationsView } from '../src/features/quotations/QuotationsView.js';
import { QuotationEditor } from '../src/features/quotations/QuotationEditor.js';
import * as quotationApi from '../src/features/quotations/quotationApi.js';
import * as apiClientMod from '../src/lib/apiClient.js';

vi.mock('../src/features/quotations/quotationApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/quotations/quotationApi.js')>(
    '../src/features/quotations/quotationApi.js'
  );
  return {
    ...actual,
    fetchQuotations: vi.fn(),
    fetchQuotationSettings: vi.fn(),
    fetchNextQuotationNumber: vi.fn(),
    createQuotation: vi.fn(),
    updateQuotationStatus: vi.fn(),
    updateQuotationSettings: vi.fn(),
    fetchSavedQuotationPdfBlob: vi.fn(),
  };
});

vi.mock('../src/lib/apiClient.js', () => ({
  apiClient: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Professional Quotations Frontend Module Test Suite', () => {
  it('1. Calculates subtotal, percentage discount, and taxable amount with Decimal.js', () => {
    const items = [
      { quantity: new Decimal('2.50'), rate: new Decimal('1200.00') }, // 3000.00
      { quantity: new Decimal('4'), rate: new Decimal('500.00') },      // 2000.00
    ];

    let subtotal = new Decimal(0);
    items.forEach((it) => {
      subtotal = subtotal.plus(it.quantity.times(it.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
    });

    expect(subtotal.toFixed(2)).toBe('5000.00');

    // 15% discount
    const discountRate = new Decimal(15);
    const discountAmount = subtotal.times(discountRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const taxable = subtotal.minus(discountAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    expect(discountAmount.toFixed(2)).toBe('750.00');
    expect(taxable.toFixed(2)).toBe('4250.00');
  });

  it('2. Computes Intra-State GST (CGST + SGST) accurately on taxable amount', () => {
    const taxable = new Decimal('4250.00');
    const gstRate = new Decimal(18);
    const halfRate = gstRate.dividedBy(2); // 9%

    const cgst = taxable.times(halfRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const sgst = taxable.times(halfRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const grandTotal = taxable.plus(cgst).plus(sgst);

    expect(cgst.toFixed(2)).toBe('382.50');
    expect(sgst.toFixed(2)).toBe('382.50');
    expect(grandTotal.toFixed(2)).toBe('5015.00');
  });

  it('3. Computes Inter-State GST (IGST only) without CGST/SGST', () => {
    const taxable = new Decimal('4250.00');
    const gstRate = new Decimal(18);

    const igst = taxable.times(gstRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const grandTotal = taxable.plus(igst);

    expect(igst.toFixed(2)).toBe('765.00');
    expect(grandTotal.toFixed(2)).toBe('5015.00');
  });

  it('4. Zero tax applied when GST is disabled', () => {
    const taxable = new Decimal('4250.00');
    const gstEnabled = false;

    const tax = gstEnabled ? taxable.times(0.18) : new Decimal(0);
    const grandTotal = taxable.plus(tax);

    expect(tax.toFixed(2)).toBe('0.00');
    expect(grandTotal.toFixed(2)).toBe('4250.00');
  });

  it('5. Currency formatter outputs formatted Indian Rupee amounts with currency symbol', () => {
    expect(formatCurrency('1250000.50')).toBe('₹12,50,000.50');
    expect(formatCurrency('5015')).toBe('₹5,015.00');
  });
});

describe('Release #023: QuotationsView Filter Races & QuotationEditor Live Decimal Safety', () => {
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
      state: 'Bihar',
      stateCode: '10',
      defaultValidityDays: 15,
    });
    (quotationApi.fetchNextQuotationNumber as any).mockResolvedValue('QT-010');
    (quotationApi.createQuotation as any).mockResolvedValue({ id: 1, quotationNumber: 'QT-010' });
    (apiClientMod.apiClient as any).mockResolvedValue({
      status: 200,
      data: { success: true, data: [], customers: [], pagination: { hasMore: false, nextOffset: null } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('6. QuotationsView discards slow overlapping filter responses and resets page to 1 synchronously on filter/search changes', async () => {
    let resolveDraft!: (v: any) => void;
    let resolveAccepted!: (v: any) => void;

    const baseCounts = { total: 40, draft: 15, sent: 10, accepted: 5, converted: 5, rejectedOrExpired: 5 };

    (quotationApi.fetchQuotations as any).mockImplementation(async (query: any) => {
      if (query?.status === 'draft') {
        return new Promise((r) => {
          resolveDraft = r;
        });
      }
      if (query?.status === 'accepted') {
        return new Promise((r) => {
          resolveAccepted = r;
        });
      }
      return {
        quotations: [
          {
            id: 10,
            quotation_number: query?.offset === 20 ? 'QT-PAGE2' : 'QT-PAGE1',
            quotation_date: '2026-11-01',
            valid_until: '2026-11-16',
            customer_name: 'Default Client',
            grand_total: '1000.00',
            status: 'draft',
          },
        ],
        summaryCounts: baseCounts,
        pagination: { limit: 20, offset: query?.offset || 0, hasMore: true, nextOffset: 20 },
      };
    });

    await act(async () => {
      root.render(React.createElement(QuotationsView));
    });
    expect(container.textContent).toContain('Page 1');

    // Advance to Page 2
    const nextBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === 'Next'
    )!;
    await act(async () => {
      nextBtn.click();
    });
    expect(container.textContent).toContain('Page 2');

    // Click Draft status filter (resets page to 0 immediately while request stays pending)
    const draftCard = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('draft')
    )!;
    await act(async () => {
      draftCard.click();
    });
    expect(quotationApi.fetchQuotations).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft', offset: 0 })
    );

    // Quickly click Accepted status filter before Draft finishes
    const acceptedCard = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('accepted')
    )!;
    await act(async () => {
      acceptedCard.click();
    });
    expect(quotationApi.fetchQuotations).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'accepted', offset: 0 })
    );

    // Accepted resolves first
    await act(async () => {
      resolveAccepted({
        quotations: [
          {
            id: 20,
            quotation_number: 'QT-ACCEPTED-1',
            quotation_date: '2026-11-02',
            valid_until: '2026-11-17',
            customer_name: 'Accepted Client',
            grand_total: '2000.00',
            status: 'accepted',
          },
        ],
        summaryCounts: baseCounts,
        pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
      });
    });
    expect(container.textContent).toContain('QT-ACCEPTED-1');
    expect(container.textContent).toContain('Page 1');

    // Slow Draft resolves late -> MUST NOT overwrite QT-ACCEPTED-1
    await act(async () => {
      resolveDraft({
        quotations: [
          {
            id: 30,
            quotation_number: 'QT-STALE-DRAFT',
            quotation_date: '2026-11-02',
            valid_until: '2026-11-17',
            customer_name: 'Stale Draft Client',
            grand_total: '500.00',
            status: 'draft',
          },
        ],
        summaryCounts: baseCounts,
        pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
      });
    });
    expect(container.textContent).toContain('QT-ACCEPTED-1');
    expect(container.textContent).not.toContain('QT-STALE-DRAFT');
  });

  it('7. QuotationEditor stays crash-free on incomplete discount/rate inputs and rejects invalid discounts on submit', async () => {
    await act(async () => {
      root.render(
        React.createElement(QuotationEditor, {
          onCancel: vi.fn(),
          onSaved: vi.fn(),
        })
      );
    });

    // Fill required customer name and item description + valid qty/rate
    const customerNameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Acme Corporation"]'
    )!;
    const itemDescInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Type item description..."]'
    )!;
    await act(async () => {
      setInputVal(customerNameInput, 'Test Buyer');
      setInputVal(itemDescInput, 'Custom Board');
    });

    // Enable percentage discount
    const pctBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Percentage')
    )!;
    await act(async () => {
      pctBtn.click();
    });

    const discInput = container.querySelector<HTMLInputElement>('input[placeholder="e.g. 10%"]')!;

    // Typing incomplete characters '.', '-', '' must NOT throw or produce NaN in live summary
    for (const frag of ['.', '-', '']) {
      await act(async () => {
        setInputVal(discInput, frag);
      });
      expect(container.textContent).toContain('Grand Total');
      expect(container.textContent).not.toContain('NaN');
    }

    // Enter invalid percentage (> 100%) and submit -> shows validation error and never calls createQuotation
    await act(async () => {
      setInputVal(discInput, '150');
    });
    const saveDraftBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save Draft')
    )!;
    await act(async () => {
      saveDraftBtn.click();
    });
    expect(quotationApi.createQuotation).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/between 0 and 100/i);
  });
});
