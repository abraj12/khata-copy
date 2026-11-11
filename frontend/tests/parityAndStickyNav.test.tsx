// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Decimal from 'decimal.js';

vi.mock('../src/features/bills/gstInvoicesApi.js', () => ({
  getNextInvoiceNumber: vi.fn(),
  createGstInvoice: vi.fn(),
  listGstInvoices: vi.fn(),
  getGstInvoiceById: vi.fn(),
  downloadInvoicePdf: vi.fn(),
  fetchInvoicePdfBlob: vi.fn(),
  fetchDraftPdfBlob: vi.fn(),
  retryGstInvoicePdf: vi.fn(),
}));

vi.mock('../src/features/bills/normalBillsApi.js', () => ({
  getNextNormalBillNumber: vi.fn(),
  createNormalBill: vi.fn(),
  listNormalBills: vi.fn(),
  getNormalBillById: vi.fn(),
  downloadNormalBillPdf: vi.fn(),
  fetchNormalBillPdfBlob: vi.fn(),
  fetchNormalBillDraftPdfBlob: vi.fn(),
  retryNormalBillPdf: vi.fn(),
}));

vi.mock('../src/features/quotations/quotationApi.js', () => ({
  fetchQuotationSettings: vi.fn(),
}));

vi.mock('../src/features/dashboard/dashboardApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/dashboard/dashboardApi.js')>(
    '../src/features/dashboard/dashboardApi.js'
  );
  return {
    ...actual,
    fetchDashboardOverview: vi.fn(),
    fetchExpenses: vi.fn(),
  };
});

import {
  calculateCommercialDiscount,
  validateCommercialDiscountInput,
} from '../src/utils/lineItemDraft.js';
import * as gstInvoicesApi from '../src/features/bills/gstInvoicesApi.js';
import * as normalBillsApi from '../src/features/bills/normalBillsApi.js';
import * as quotationApi from '../src/features/quotations/quotationApi.js';
import * as dashboardApi from '../src/features/dashboard/dashboardApi.js';
import * as appDataApi from '../src/lib/appDataApi.js';
import { GstBillingView } from '../src/features/bills/GstBillingView.js';
import { NormalBillingView } from '../src/features/bills/NormalBillingView.js';
import { KhataLedgerView } from '../src/features/khata/KhataLedgerView.js';
import {
  ThemeAccessibilityProvider,
  useThemeAccessibility,
} from '../src/context/ThemeAccessibilityContext.js';
import { AppearanceAccessibilityModal } from '../src/components/AppearanceAccessibilityModal.js';
import { HomeDashboard } from '../src/features/dashboard/HomeDashboard.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Backend-to-Frontend Feature Parity & Commercial Discounts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes('/api/v1/products')) {
          return new Response(
            JSON.stringify({
              success: true,
              products: [],
              pagination: { total: 0, limit: 25, offset: 0, hasMore: false, nextOffset: null },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (u.includes('/api/v1/khata/summary')) {
          return new Response(
            JSON.stringify({
              success: true,
              summary: { totalCustomers: 1, totalOutstanding: '1000.00', totalReceived: '0.00' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (u.includes('/api/v1/khata/customers/55/history')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                customer: {
                  id: 55,
                  name: 'Shree Laxmi Traders',
                  phone: '9876543210',
                  address: 'Sector 2, Industrial Area',
                  state: 'Maharashtra',
                  state_code: '27',
                  totalUdhar: '1000.00',
                  totalReceived: '0.00',
                  outstanding: '1000.00',
                },
                transactions: [],
                payments: [],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (u.includes('/api/v1/khata/customers')) {
          return new Response(
            JSON.stringify({
              success: true,
              customers: [
                {
                  id: 55,
                  name: 'Shree Laxmi Traders',
                  phone: '9876543210',
                  state: 'Maharashtra',
                  state_code: '27',
                  totalUdhar: '1000.00',
                  totalReceived: '0.00',
                  outstanding: '1000.00',
                  created_at: new Date().toISOString(),
                },
              ],
              pagination: { limit: 25, offset: 0, hasMore: false, nextOffset: null },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (u.includes('/api/v1/auth/csrf')) {
          return new Response(JSON.stringify({ csrfToken: 'test-csrf' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('1. calculateCommercialDiscount & validateCommercialDiscountInput match backend Decimal rules', () => {
    const pct = calculateCommercialDiscount(new Decimal('1000'), 'percentage', '12.5');
    expect(pct.discountAmountDec.toFixed(2)).toBe('125.00');
    expect(pct.netSubtotalDec.toFixed(2)).toBe('875.00');

    const cappedFixed = calculateCommercialDiscount(new Decimal('300'), 'fixed', '500');
    expect(cappedFixed.discountAmountDec.toFixed(2)).toBe('300.00');
    expect(cappedFixed.netSubtotalDec.toFixed(2)).toBe('0.00');

    expect(validateCommercialDiscountInput('percentage', '105')).toContain('0 and 100');
    expect(validateCommercialDiscountInput('fixed', '-10')).toBeTruthy();
    expect(validateCommercialDiscountInput('fixed', '25.555')).toBeTruthy();
    expect(validateCommercialDiscountInput('percentage', '')).toBeNull();
    expect(validateCommercialDiscountInput(null, '9999')).toBeNull();
  });

  it('2. GstBillingView submits commercial discounts and inspects saved invoices via getGstInvoiceById', async () => {
    (quotationApi.fetchQuotationSettings as any).mockResolvedValue({
      company_name: 'Mannat Hardware',
      address: 'Chandigarh',
      gstin: '04AAAAA0000A1Z5',
      phone: '9876543210',
      state: 'Chandigarh',
      state_code: '04',
    });
    (gstInvoicesApi.getNextInvoiceNumber as any).mockResolvedValue('INV-2026-001');
    (gstInvoicesApi.createGstInvoice as any).mockResolvedValue({
      id: 101,
      invoice_number: 'INV-2026-001',
      invoice_date: '2026-11-12',
      state: 'Chandigarh',
      state_code: '04',
      customer_id: null,
      customer_name: 'ABC Builders',
      customer_address: null,
      customer_gstin: null,
      customer_state: 'Chandigarh',
      customer_state_code: '04',
      subtotal_amount: '1000.00',
      discount_type: 'percentage',
      discount_value: '10.00',
      discount_amount: '100.00',
      taxable_amount: '900.00',
      cgst_rate: '9.00',
      cgst_amount: '81.00',
      sgst_rate: '9.00',
      sgst_amount: '81.00',
      igst_rate: '0.00',
      igst_amount: '0.00',
      tax_amount: '162.00',
      grand_total: '1062.00',
      amount_in_words: 'One Thousand Sixty Two Rupees Only',
      r2_object_key: null,
      pdf_status: 'uploaded',
      notes: null,
      created_at: '2026-11-12T00:00:00Z',
      updated_at: '2026-11-12T00:00:00Z',
    });
    (gstInvoicesApi.listGstInvoices as any).mockResolvedValue({
      invoices: [
        {
          id: 101,
          invoice_number: 'INV-2026-001',
          invoice_date: '2026-11-12',
          customer_name: 'ABC Builders',
          customer_state: 'Chandigarh',
          customer_state_code: '04',
          taxable_amount: '900.00',
          cgst_rate: '9.00',
          cgst_amount: '81.00',
          sgst_rate: '9.00',
          sgst_amount: '81.00',
          igst_rate: '0.00',
          igst_amount: '0.00',
          tax_amount: '162.00',
          grand_total: '1062.00',
          pdf_status: 'uploaded',
        },
      ],
      pagination: { total: 1, limit: 15, offset: 0 },
    });
    (gstInvoicesApi.getGstInvoiceById as any).mockResolvedValue({
      id: 101,
      invoice_number: 'INV-2026-001',
      invoice_date: '2026-11-12',
      state: 'Chandigarh',
      state_code: '04',
      customer_id: null,
      customer_name: 'ABC Builders',
      customer_address: 'Sector 17',
      customer_gstin: null,
      customer_state: 'Chandigarh',
      customer_state_code: '04',
      subtotal_amount: '1000.00',
      discount_type: 'percentage',
      discount_value: '10.00',
      discount_amount: '100.00',
      taxable_amount: '900.00',
      cgst_rate: '9.00',
      cgst_amount: '81.00',
      sgst_rate: '9.00',
      sgst_amount: '81.00',
      igst_rate: '0.00',
      igst_amount: '0.00',
      tax_amount: '162.00',
      grand_total: '1062.00',
      amount_in_words: 'One Thousand Sixty Two Rupees Only',
      r2_object_key: null,
      pdf_status: 'uploaded',
      notes: 'Rush delivery',
      created_at: '2026-11-12T00:00:00Z',
      updated_at: '2026-11-12T00:00:00Z',
      items: [
        {
          id: 1,
          invoice_id: 101,
          product_id: null,
          item_index: 0,
          description: 'Marine Plywood 19mm',
          hsn_code: '4412',
          quantity: '2.00',
          unit: 'pcs',
          rate: '500.00',
          rate_unit: null,
          amount: '1000.00',
        },
      ],
    });

    await act(async () => {
      root.render(<GstBillingView />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Fill Customer Name, State, Item Description, Rate
    const allInputs = Array.from(container.querySelectorAll('input'));
    const customerNameField = allInputs.find((el) => el.placeholder.includes('Sharma'))!;
    const itemDescField = allInputs.find((el) => el.placeholder.toLowerCase().includes('description'))!;
    const rateField = allInputs.find((el) => el.placeholder === '0.00' || el.placeholder.toLowerCase().includes('rate'))!;
    const stateSelect = Array.from(container.querySelectorAll('select')).find((sel) =>
      Array.from(sel.options).some((opt) => opt.value === '04')
    ) as HTMLSelectElement;

    await act(async () => {
      setInputValue(customerNameField, 'ABC Builders');
      setInputValue(stateSelect, '04');
      setInputValue(itemDescField, 'Marine Plywood 19mm');
      setInputValue(rateField, '1000');
    });

    // Activate Percentage discount (10%)
    const pctBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Percentage (%)')
    ) as HTMLButtonElement;
    expect(pctBtn).toBeDefined();
    await act(async () => {
      pctBtn.click();
    });

    const discountInput = container.querySelector('input[aria-label="Discount percentage value"]') as HTMLInputElement;
    expect(discountInput).not.toBeNull();
    await act(async () => {
      setInputValue(discountInput, '10');
    });

    expect(container.textContent).toContain('-₹100.00');
    expect(container.textContent).toContain('₹900.00');

    // Submit invoice
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save') && b.textContent?.includes('Invoice')
    ) as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gstInvoicesApi.createGstInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        subtotalAmount: '1000.00',
        discountType: 'percentage',
        discountValue: '10.00',
        discountAmount: '100.00',
      })
    );

    // Dismiss success modal & switch to History tab to verify Details modal (`getGstInvoiceById`)
    const closeCreateAnother = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Create Another Invoice')
    ) as HTMLButtonElement;
    await act(async () => {
      closeCreateAnother.click();
    });

    const historyTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('History')
    ) as HTMLButtonElement;
    await act(async () => {
      historyTab.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const inspectBtn = container.querySelector('button[aria-label="Inspect details for invoice INV-2026-001"]') as HTMLButtonElement;
    expect(inspectBtn).not.toBeNull();
    await act(async () => {
      inspectBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gstInvoicesApi.getGstInvoiceById).toHaveBeenCalledWith(101);
    const detailDialog = container.querySelector('[role="dialog"][aria-label="GST Invoice Details"]');
    expect(detailDialog).not.toBeNull();
    expect(detailDialog?.textContent).toContain('Marine Plywood 19mm');
    expect(detailDialog?.textContent).toContain('Rush delivery');
  });

  it('3. NormalBillingView submits commercial discounts and opens Normal Bill Details via getNormalBillById', async () => {
    (quotationApi.fetchQuotationSettings as any).mockResolvedValue({
      company_name: 'Mannat Hardware',
      address: 'Chandigarh',
      gstin: null,
      phone: '9876543210',
      state: 'Chandigarh',
      state_code: '04',
    });
    (normalBillsApi.getNextNormalBillNumber as any).mockResolvedValue('NB-2026-007');
    (normalBillsApi.createNormalBill as any).mockResolvedValue({
      id: 202,
      bill_number: 'NB-2026-007',
      bill_date: '2026-11-12',
      state: 'Chandigarh',
      state_code: '04',
      customer_id: null,
      customer_name: 'Walk-in Buyer',
      customer_address: null,
      customer_phone: null,
      customer_state: null,
      customer_state_code: null,
      subtotal_amount: '500.00',
      discount_type: 'fixed',
      discount_value: '50.00',
      discount_amount: '50.00',
      total_amount: '450.00',
      amount_in_words: 'Four Hundred Fifty Rupees Only',
      r2_object_key: null,
      pdf_status: 'uploaded',
      notes: null,
      created_at: '2026-11-12T00:00:00Z',
      updated_at: '2026-11-12T00:00:00Z',
    });
    (normalBillsApi.listNormalBills as any).mockResolvedValue({
      bills: [
        {
          id: 202,
          bill_number: 'NB-2026-007',
          bill_date: '2026-11-12',
          customer_name: 'Walk-in Buyer',
          total_amount: '450.00',
          pdf_status: 'uploaded',
          items: [{ id: 1 }],
        },
      ],
      pagination: { total: 1, limit: 25, offset: 0 },
    });
    (normalBillsApi.getNormalBillById as any).mockResolvedValue({
      id: 202,
      bill_number: 'NB-2026-007',
      bill_date: '2026-11-12',
      state: 'Chandigarh',
      state_code: '04',
      customer_id: null,
      customer_name: 'Walk-in Buyer',
      customer_address: null,
      customer_phone: '9988776655',
      customer_state: null,
      customer_state_code: null,
      subtotal_amount: '500.00',
      discount_type: 'fixed',
      discount_value: '50.00',
      discount_amount: '50.00',
      total_amount: '450.00',
      amount_in_words: 'Four Hundred Fifty Rupees Only',
      r2_object_key: null,
      pdf_status: 'uploaded',
      notes: 'Cash counter bill',
      created_at: '2026-11-12T00:00:00Z',
      updated_at: '2026-11-12T00:00:00Z',
      items: [
        {
          id: 9,
          bill_id: 202,
          product_id: null,
          item_index: 0,
          description: 'Door Closer Brass',
          hsn_code: '8302',
          quantity: '1.00',
          unit: 'pcs',
          rate: '500.00',
          rate_unit: null,
          amount: '500.00',
        },
      ],
    });

    await act(async () => {
      root.render(<NormalBillingView />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const allInputs = Array.from(container.querySelectorAll('input'));
    const customerField = allInputs.find((el) => el.placeholder.toLowerCase().includes('receiver') || el.placeholder.toLowerCase().includes('customer'))!;
    const itemDescField = allInputs.find((el) => el.placeholder.toLowerCase().includes('description'))!;
    const rateField = allInputs.find((el) => el.placeholder === '0.00' || el.placeholder.toLowerCase().includes('rate'))!;

    await act(async () => {
      setInputValue(customerField, 'Walk-in Buyer');
      setInputValue(itemDescField, 'Door Closer Brass');
      setInputValue(rateField, '500');
    });

    const fixedBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Fixed')
    ) as HTMLButtonElement;
    await act(async () => {
      fixedBtn.click();
    });

    const discountInput = container.querySelector('input[aria-label="Discount fixed amount"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(discountInput, '50');
    });

    expect(container.textContent).toContain('-₹50.00');
    expect(container.textContent).toContain('450.00');

    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save Normal Bill')
    ) as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(normalBillsApi.createNormalBill).toHaveBeenCalledWith(
      expect.objectContaining({
        subtotalAmount: '500.00',
        discountType: 'fixed',
        discountValue: '50.00',
        discountAmount: '50.00',
      })
    );

    const createAnotherBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Create Another Bill')
    ) as HTMLButtonElement;
    await act(async () => {
      createAnotherBtn.click();
    });

    const historyTab = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('History')
    ) as HTMLButtonElement;
    await act(async () => {
      historyTab.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const detailsBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Details')
    ) as HTMLButtonElement;
    await act(async () => {
      detailsBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(normalBillsApi.getNormalBillById).toHaveBeenCalledWith(202);
    const detailDialog = container.querySelector('[role="dialog"][aria-label="Normal Bill Details"]');
    expect(detailDialog?.textContent).toContain('Door Closer Brass');
    expect(detailDialog?.textContent).toContain('Cash counter bill');
  });

  it('4. KhataLedgerView creates new customer (POST /customers) and edits full profile (PATCH /customers/:id)', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);

    await act(async () => {
      root.render(<KhataLedgerView />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Click Add Customer
    const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add Customer')
    ) as HTMLButtonElement;
    expect(addBtn).toBeDefined();
    await act(async () => {
      addBtn.click();
    });

    const nameInput = container.querySelector('#new-khata-customer-name') as HTMLInputElement;
    const phoneInput = container.querySelector('#new-khata-customer-phone') as HTMLInputElement;
    const addrInput = container.querySelector('#new-khata-customer-address') as HTMLTextAreaElement;
    const stateSelect = container.querySelector('#new-khata-customer-state') as HTMLSelectElement;

    await act(async () => {
      setInputValue(nameInput, 'Bharat Timber Mart');
      setInputValue(phoneInput, '9812345678');
      setInputValue(addrInput, 'Plot 9, Timber Market');
      setInputValue(stateSelect, '07');
    });

    const saveCustBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save Customer')
    ) as HTMLButtonElement;
    await act(async () => {
      saveCustBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/v1/khata/customers') && init?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall![1]?.body))).toEqual({
      name: 'Bharat Timber Mart',
      phone: '9812345678',
      address: 'Plot 9, Timber Market',
      state: 'Delhi',
      stateCode: '07',
    });

    // Open customer detail and edit full profile
    const customerRow = Array.from(container.querySelectorAll('tr, div.cursor-pointer')).find((el) =>
      el.textContent?.includes('Shree Laxmi Traders')
    ) as HTMLElement;
    expect(customerRow).toBeDefined();
    await act(async () => {
      customerRow.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const editProfileBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Edit Profile')
    ) as HTMLButtonElement;
    expect(editProfileBtn).toBeDefined();
    await act(async () => {
      editProfileBtn.click();
    });

    const editName = container.querySelector('#edit-customer-name') as HTMLInputElement;
    const editAddr = container.querySelector('#edit-customer-address') as HTMLInputElement;
    await act(async () => {
      setInputValue(editName, 'Shree Laxmi Hardware LLP');
      setInputValue(editAddr, 'Plot 42, MIDC');
    });

    const saveProfileBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Save Profile')
    ) as HTMLButtonElement;
    await act(async () => {
      saveProfileBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/v1/khata/customers/55') && init?.method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall![1]?.body))).toEqual({
      name: 'Shree Laxmi Hardware LLP',
      phone: '9876543210',
      address: 'Plot 42, MIDC',
      state: 'Maharashtra',
      stateCode: '27',
    });
  });

  it('5. Preferences sync dashboardDefaults & printPreferences, HomeDashboard honors default preset, and Appearance checks system/realtime status', async () => {
    vi.spyOn(appDataApi, 'fetchPreferencesApi').mockResolvedValue({
      success: true,
      source: 'mongodb',
      preferences: {
        preferenceKey: 'owner',
        theme: { version: 3, preset: 'flat' },
        dashboardDefaults: { defaultDatePreset: 'this_month' },
        printPreferences: { defaultPaperSize: 'A4', autoOpenPreview: false },
        updatedAt: '2026-11-12T00:00:00Z',
      },
    });
    const updatePrefSpy = vi.spyOn(appDataApi, 'updatePreferencesApi').mockResolvedValue({
      success: true,
      source: 'mongodb',
      preferences: {
        preferenceKey: 'owner',
        theme: {},
        dashboardDefaults: { defaultDatePreset: 'this_fy' },
        printPreferences: { defaultPaperSize: 'A4', autoOpenPreview: true },
        updatedAt: null,
      },
    });
    const healthSpy = vi.spyOn(appDataApi, 'fetchHealthReadyApi').mockResolvedValue({
      status: 'ready',
      services: { postgres: 'ready', mongodb: 'ready' },
    });
    const realtimeSpy = vi.spyOn(appDataApi, 'fetchRealtimeStatusApi').mockResolvedValue({
      success: true,
      data: {
        enabled: false,
        status: 'deferred',
        authoritativeSource: 'REST_API',
        realtimeEndpoint: null,
        notes: 'REST endpoints authoritative',
      },
    });
    const telemetrySpy = vi.spyOn(appDataApi, 'sendTelemetryApi').mockResolvedValue();
    (dashboardApi.fetchDashboardOverview as any).mockResolvedValue({
      businessDate: '2026-11-12',
      timeZone: 'Asia/Kolkata',
      dateRange: { fromDate: '2026-11-01', toDate: '2026-11-12' },
      sales: {
        normalBillsTotal: '0.00',
        normalBillsCount: 0,
        gstTaxableSales: '0.00',
        gstCollected: '0.00',
        gstInvoicesGrandTotal: '0.00',
        gstInvoicesCount: 0,
        totalSalesRevenue: '0.00',
        totalBilledAmountIncludingGst: '0.00',
        totalBillsCount: 0,
        averageBillValue: '0.00',
      },
      profitability: {
        totalSalesRevenue: '0.00',
        costedSalesRevenue: '0.00',
        uncostedSalesRevenue: '0.00',
        estimatedCostOfGoodsSold: '0.00',
        estimatedGrossProfit: '0.00',
        estimatedGrossMarginPercent: '0.00',
        costCoveragePercent: '0.00',
        operatingExpenses: '0.00',
        operatingExpensesCount: 0,
        voidedExpensesCount: 0,
        estimatedNetOperatingResult: '0.00',
        hasIncompleteCostData: false,
      },
      expensesByCategory: [],
      customersKhata: {
        totalCustomers: 0,
        activeCustomers: 0,
        newCustomersCount: 0,
        customersWithOutstanding: 0,
        totalOutstandingReceivable: '0.00',
        creditGiven: '0.00',
        paymentsReceived: '0.00',
        paymentCount: 0,
      },
      products: {
        totalProducts: 0,
        activeProducts: 0,
        archivedProducts: 0,
        topProducts: [],
      },
      suppliers: {
        totalSuppliers: 0,
        activeSuppliers: 0,
        totalPurchases: '0.00',
        purchaseBillsCount: 0,
        cancelledBillsCount: 0,
        totalPaymentsMade: '0.00',
        paymentsCount: 0,
        totalPaymentsReversed: '0.00',
        totalOutstandingPayable: '0.00',
        totalAdvanceCredit: '0.00',
        totalUnallocatedPayments: '0.00',
      },
      quotations: {
        totalCount: 0,
        draftCount: 0,
        sentCount: 0,
        acceptedCount: 0,
        convertedCount: 0,
        rejectedCount: 0,
        expiredCount: 0,
        conversionRatePercent: '0.00',
        pendingPipelineValue: '0.00',
        convertedValue: '0.00',
      },
      salesTrend: {
        granularity: 'day',
        points: [],
      },
      recentActivity: [],
    });
    (dashboardApi.fetchExpenses as any).mockResolvedValue({
      items: [],
      total: 0,
      totalActiveAmount: '0.00',
      limit: 25,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });

    let ctxRef: ReturnType<typeof useThemeAccessibility> | null = null;
    const Harness = () => {
      const ctx = useThemeAccessibility();
      ctxRef = ctx;
      return (
        <>
          <HomeDashboard onNavigate={() => {}} />
          <AppearanceAccessibilityModal isOpen={true} onClose={() => {}} />
        </>
      );
    };

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <Harness />
        </ThemeAccessibilityProvider>
      );
    });
    await act(async () => {
      await ctxRef!.syncFromServer();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ctxRef!.workflowDefaults.defaultDatePreset).toBe('this_month');
    expect(ctxRef!.workflowDefaults.autoOpenPreview).toBe(false);
    // HomeDashboard fetched initially and then synced 'this_month' default range ending in '-01'
    const calls = (dashboardApi.fetchDashboardOverview as any).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const lastRange = calls[calls.length - 1][0];
    expect(String(lastRange.fromDate)).toMatch(/^\d{4}-\d{2}-01$/);

    // Check on-demand System & Realtime Diagnostics button
    const checkStatusBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Check Status')
    ) as HTMLButtonElement;
    expect(checkStatusBtn).toBeDefined();
    await act(async () => {
      checkStatusBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(healthSpy).toHaveBeenCalledTimes(1);
    expect(realtimeSpy).toHaveBeenCalledTimes(1);
    expect(telemetrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'read_latency', name: 'system_diagnostics', ok: true })
    );
    expect(container.textContent).toContain('Backend: ready');
    expect(container.textContent).toContain('MongoDB: ready');
    expect(container.textContent).toContain('REST_API');

    // Update default period in modal -> debounced server preference save includes dashboardDefaults & printPreferences
    vi.useFakeTimers();
    const defaultSelect = container.querySelector('#appearance-default-date-preset') as HTMLSelectElement;
    await act(async () => {
      setInputValue(defaultSelect, 'this_fy');
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(updatePrefSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardDefaults: { defaultDatePreset: 'this_fy' },
        printPreferences: { defaultPaperSize: 'A4', autoOpenPreview: false },
      })
    );
  });
});
