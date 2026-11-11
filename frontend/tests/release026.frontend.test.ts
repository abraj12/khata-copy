// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Decimal from 'decimal.js';

const {
  mockCleanup,
  mockDestroy,
  mockPageCleanup,
  mockRenderCancel,
  mockGetDocument,
} = vi.hoisted(() => {
  const cleanup = vi.fn(async () => {});
  const destroy = vi.fn(async () => {});
  const pageCleanup = vi.fn();
  const renderCancel = vi.fn();
  const getDocument = vi.fn(() => {
    const numPages = 2;
    const pdfDoc = {
      numPages,
      cleanup,
      getPage: vi.fn(async (pageNumber: number) => ({
        pageNumber,
        getViewport: ({ scale }: { scale: number }) => ({
          width: Math.round(595 * scale),
          height: Math.round(842 * scale),
        }),
        render: vi.fn(() => ({
          promise: Promise.resolve(),
          cancel: renderCancel,
        })),
        cleanup: pageCleanup,
      })),
    };
    return {
      promise: Promise.resolve(pdfDoc),
      destroy,
    };
  });
  return {
    mockCleanup: cleanup,
    mockDestroy: destroy,
    mockPageCleanup: pageCleanup,
    mockRenderCancel: renderCancel,
    mockGetDocument: getDocument,
  };
});

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/pdf.worker.min.mjs',
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: mockGetDocument,
}));

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
    previewQuotationPdf: vi.fn(),
  };
});

vi.mock('../src/lib/apiClient.js', () => ({
  apiClient: vi.fn(),
  apiClientBlob: vi.fn(),
  API_BASE_URL: 'http://localhost:5000',
  getCsrfToken: vi.fn(() => 'csrf-test-token'),
  fetchCsrfToken: vi.fn(async () => 'csrf-test-token'),
}));

import { QuotationPreview } from '../src/features/quotations/QuotationPreview.js';
import { QuotationEditor } from '../src/features/quotations/QuotationEditor.js';
import * as quotationApi from '../src/features/quotations/quotationApi.js';
import * as apiClientMod from '../src/lib/apiClient.js';
import MannatTaxInvoice from '../src/components/MannatTaxInvoice/MannatTaxInvoice.js';
import { mapRecordToInvoiceProps } from '../src/features/bills/gstInvoicesApi.js';
import { mapNormalBillToInvoiceProps } from '../src/features/bills/normalBillsApi.js';
import { MAX_BILL_LINE_ITEMS } from '../src/utils/billingLimits.js';
import { downloadBlobSafely } from '../src/utils/blobDownload.js';
import {
  exportPdfBlobToWebpPages,
  cleanupExportedPageImages,
  shareOrDownloadPdfImages,
} from '../src/utils/pdfImageExporter.js';
import { compressImageFile } from '../src/utils/imageCompressor.js';
import type { Quotation } from '../src/features/quotations/quotation.types.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makePdfBlob(label = '%PDF-1.4\n%Release026'): Blob {
  const bytes = new TextEncoder().encode(label);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  if (typeof (blob as any).arrayBuffer !== 'function') {
    (blob as any).arrayBuffer = async () => bytes.buffer;
  }
  return blob;
}

function setInputVal(el: HTMLInputElement, val: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Release #026 Frontend Remediation Verification Suite', () => {
  let container: HTMLDivElement;
  let root: Root;
  let origCreateObjectURL: typeof URL.createObjectURL;
  let origRevokeObjectURL: typeof URL.revokeObjectURL;
  let objectUrlSeq = 0;
  let createdCanvases: HTMLCanvasElement[] = [];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    createdCanvases = [];
    objectUrlSeq = 0;

    origCreateObjectURL = URL.createObjectURL;
    origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => `blob:test-url-${++objectUrlSeq}`) as any;
    URL.revokeObjectURL = vi.fn() as any;

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement
    ) {
      createdCanvases.push(this);
      return {
        fillStyle: '#FFFFFF',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        fillRect: vi.fn(),
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    });

    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback,
      type?: string
    ) {
      const mime = type || 'image/webp';
      const payloadSize = Math.max(120, Math.round((this.width || 100) * 2));
      cb(new Blob([new Uint8Array(payloadSize)], { type: mime }));
    });

    (quotationApi.fetchQuotationSettings as any).mockResolvedValue({
      company_name: 'ALGIONS AI LABS PRIVATE LIMITED',
      company_state: 'Bihar',
      company_state_code: '10',
      standard_validity_days: 30,
      jurisdiction: 'Patna Jurisdiction only',
    });
    (quotationApi.fetchNextQuotationNumber as any).mockResolvedValue('QT-2026-026');
    (quotationApi.createQuotation as any).mockResolvedValue({
      id: 42,
      quotation_number: 'QT-2026-026',
    });
    (apiClientMod.apiClient as any).mockResolvedValue({
      status: 200,
      data: { success: true, data: [], customers: [] },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      root.unmount();
    });
    container.remove();
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    vi.restoreAllMocks();
  });

  describe('A. QuotationPreview PDF.js Rendering, Retry, Abort & Cleanup', () => {
    const sampleQuotation: Quotation = {
      id: 99,
      quotation_number: 'QT-099',
      quotation_date: '2026-11-10',
      valid_until: '2026-12-10',
      customer_name: 'Apex Hardware',
      subtotal: '1000.00',
      taxable_amount: '1000.00',
      cgst_amount: '0.00',
      sgst_amount: '0.00',
      igst_amount: '0.00',
      total_tax: '0.00',
      grand_total: '1000.00',
      status: 'draft',
      items: [],
    };

    it('1. Renders multi-page PDF.js canvases, Retry recovery, deferred blob download, and cleans up resources on unmount', async () => {
      let attempt = 0;
      let capturedSignal: AbortSignal | undefined;

      (quotationApi.fetchSavedQuotationPdfBlob as any).mockImplementation(
        async (_id: number, signal?: AbortSignal) => {
          attempt += 1;
          capturedSignal = signal;
          if (attempt === 1) {
            throw new Error('Network glitch loading quotation PDF');
          }
          return makePdfBlob('%PDF-1.4\nPage1\nPage2');
        }
      );

      await act(async () => {
        root.render(
          React.createElement(QuotationPreview, {
            isOpen: true,
            quotation: sampleQuotation,
            onClose: vi.fn(),
          })
        );
      });

      expect(container.textContent).toContain('Network glitch loading quotation PDF');
      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Retry')
      )!;
      expect(retryBtn).toBeDefined();

      await act(async () => {
        retryBtn.click();
      });

      expect(attempt).toBe(2);
      expect(container.textContent).toContain('Page 1 of 2');
      expect(container.querySelector('[data-testid="pdf-page-1"] canvas')).not.toBeNull();
      expect(container.querySelector('[data-testid="pdf-page-2"] canvas')).not.toBeNull();
      expect(
        container.querySelector('canvas[aria-label="Quotation page 1 of 2"]')
      ).not.toBeNull();

      // Test Download button defers URL revocation
      vi.useFakeTimers();
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {});
      const dlBtn = container.querySelector<HTMLButtonElement>('button[title="Download PDF"]')!;
      expect(dlBtn.disabled).toBe(false);

      await act(async () => {
        dlBtn.click();
      });
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
      clickSpy.mockRestore();
      vi.useRealTimers();

      // Unmount triggers abort + pdfDoc.cleanup() + loadingTask.destroy()
      await act(async () => {
        root.unmount();
      });
      expect(capturedSignal?.aborted).toBe(true);
      expect(mockCleanup).toHaveBeenCalled();
      expect(mockDestroy).toHaveBeenCalled();
    });
  });

  describe('B. QuotationEditor Date Cross-Validation & draftKey Autocomplete Isolation', () => {
    it('2. Recalculates Valid Until until manually edited, enforces Valid Until >= Quotation Date, and disables actions when invalid', async () => {
      await act(async () => {
        root.render(
          React.createElement(QuotationEditor, {
            onCancel: vi.fn(),
            onSaved: vi.fn(),
          })
        );
      });

      const qtDateInput = container.querySelector<HTMLInputElement>(
        'input[aria-label="Quotation Date"]'
      )!;
      const validUntilInput = container.querySelector<HTMLInputElement>(
        'input[aria-label="Valid Until"]'
      )!;
      expect(validUntilInput.min).toBe(qtDateInput.value);

      // Update Quotation Date -> automatically shifts Valid Until (+30 days)
      await act(async () => {
        setInputVal(qtDateInput, '2026-11-15');
      });
      expect(validUntilInput.value).toBe('2026-12-15');

      // Set Valid Until earlier than Quotation Date -> shows inline alert and disables Save/Preview buttons
      await act(async () => {
        setInputVal(validUntilInput, '2026-11-10');
      });
      const alertEl = container.querySelector('[role="alert"]');
      expect(alertEl?.textContent).toContain(
        'Valid Until date cannot be earlier than Quotation Date.'
      );

      const actionButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
        ['Preview', 'Save Draft', 'Finalize & Send'].some((label) =>
          b.textContent?.includes(label)
        )
      );
      expect(actionButtons.length).toBeGreaterThanOrEqual(3);
      for (const btn of actionButtons) {
        expect(btn.disabled).toBe(true);
      }
      expect(quotationApi.createQuotation).not.toHaveBeenCalled();

      // Fix date >= Quotation Date -> clears alert and preserves manual date across Quotation Date minor change >=? Wait only preserves when valid
      await act(async () => {
        setInputVal(validUntilInput, '2026-12-20');
      });
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it('3. Keying per-row product autocomplete by draftKey aborts deleted row requests, ignores stale results, aborts short customer search, and strips draftKey on save', async () => {
      vi.useFakeTimers();

      const rowRequests: Array<{
        url: string;
        signal?: AbortSignal;
        resolve: (val: any) => void;
      }> = [];
      const customerRequests: Array<{
        url: string;
        signal?: AbortSignal;
        resolve: (val: any) => void;
      }> = [];

      (apiClientMod.apiClient as any).mockImplementation((url: string, opts?: any) => {
        return new Promise((resolve) => {
          if (url.includes('/api/v1/products')) {
            rowRequests.push({ url, signal: opts?.signal, resolve });
          } else if (url.includes('/customers')) {
            customerRequests.push({ url, signal: opts?.signal, resolve });
          } else {
            resolve({ status: 200, data: { success: true, data: [] } });
          }
        });
      });

      await act(async () => {
        root.render(
          React.createElement(QuotationEditor, {
            onCancel: vi.fn(),
            onSaved: vi.fn(),
          })
        );
      });

      // Add second line item row
      const addItemBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Add Another Item')
      )!;
      await act(async () => {
        addItemBtn.click();
      });

      // Desktop table description inputs (table has 2 rows; mobile cards also have 2 rows -> select tbody inputs)
      const getDesktopDescInputs = () =>
        Array.from(
          container.querySelectorAll<HTMLInputElement>(
            'table tbody input[placeholder="Type item description..."]'
          )
        );
      expect(getDesktopDescInputs()).toHaveLength(2);

      // Type in Row 1 -> waits 250ms debounce
      await act(async () => {
        setInputVal(getDesktopDescInputs()[0], 'Hammer');
        await vi.advanceTimersByTimeAsync(260);
      });
      expect(rowRequests).toHaveLength(1);
      expect(rowRequests[0].url).toContain('search=Hammer');
      expect(rowRequests[0].signal?.aborted).toBe(false);

      // Delete Row 1 BEFORE its search resolves -> Row 1's AbortController is aborted cleanly!
      const deleteButtons = Array.from(
        container.querySelectorAll<HTMLButtonElement>('table tbody button[title="Remove row"]')
      );
      await act(async () => {
        deleteButtons[0].click();
      });
      expect(getDesktopDescInputs()).toHaveLength(1);
      expect(rowRequests[0].signal?.aborted).toBe(true);

      // Even if a broken transport resolves the aborted request anyway, surviving Row 2 must NEVER render Hammer suggestions!
      await act(async () => {
        rowRequests[0].resolve({
          status: 200,
          data: {
            success: true,
            data: [{ id: 101, name: 'Stale Hammer Item', buying_price: '250.00' }],
          },
        });
      });
      expect(container.textContent).not.toContain('Stale Hammer Item');

      // Customer search aborts when cleared to < 2 chars
      const custSearchInput = container.querySelector<HTMLInputElement>(
        'input[placeholder="Search registered customers..."]'
      )!;
      await act(async () => {
        setInputVal(custSearchInput, 'Ac');
        await vi.advanceTimersByTimeAsync(260);
      });
      expect(customerRequests).toHaveLength(1);
      expect(customerRequests[0].signal?.aborted).toBe(false);

      await act(async () => {
        setInputVal(custSearchInput, 'A');
      });
      expect(customerRequests[0].signal?.aborted).toBe(true);

      await act(async () => {
        customerRequests[0].resolve({
          status: 200,
          data: { customers: [{ id: 5, name: 'Stale Acme Client', phone: '9876543210' }] },
        });
      });
      expect(container.textContent).not.toContain('Stale Acme Client');

      // Fill required customer name + remaining row description & rate, Save Draft -> verify payload omits draftKey
      const customerNameInput = container.querySelector<HTMLInputElement>(
        'input[placeholder="e.g. Acme Corporation"]'
      )!;
      const rateInput = container.querySelector<HTMLInputElement>(
        'table tbody tr input[step="0.01"][min="0"]'
      )!;
      await act(async () => {
        setInputVal(customerNameInput, 'Clean Buyer');
        setInputVal(getDesktopDescInputs()[0], 'Surviving Steel Pipe');
        setInputVal(rateInput, '450');
      });

      const saveDraftBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Save Draft')
      )!;
      await act(async () => {
        saveDraftBtn.click();
      });

      expect(quotationApi.createQuotation).toHaveBeenCalledTimes(1);
      const submittedPayload = (quotationApi.createQuotation as any).mock.calls[0][0];
      expect(submittedPayload.items).toHaveLength(1);
      expect(submittedPayload.items[0].description).toBe('Surviving Steel Pipe');
      expect('draftKey' in submittedPayload.items[0]).toBe(false);
    });
  });

  describe('C. Invoice Mappers, Normal Bill Rs. 531 Discount, GST Mutual Exclusion & Configurable Jurisdiction', () => {
    it('4. Reconciles Normal Bill Rs. 531 discount (fixes subtotal = total_amount regression), enforces intra/inter GST mutual exclusion, and uses configured jurisdiction', async () => {
      expect(MAX_BILL_LINE_ITEMS).toBe(100);

      const normalProps = mapNormalBillToInvoiceProps(
        {
          id: 77,
          bill_number: 'NB-531',
          bill_date: '2026-11-10',
          customer_name: 'Vikram Builders',
          subtotal_amount: '5310.00',
          discount_type: 'fixed',
          discount_value: '531.00',
          discount_amount: '531.00',
          total_amount: '4779.00',
          amount_in_words: 'Rupees Four Thousand Seven Hundred Seventy Nine Only',
          pdf_status: 'synced',
          created_at: '2026-11-10T10:00:00Z',
          items: [
            {
              item_index: 1,
              description: 'MS Channel 100mm',
              quantity: '10',
              unit: 'pcs',
              rate: '531.00',
              amount: '5310.00',
            },
          ],
        },
        {
          name: 'ALGIONS AI LABS PRIVATE LIMITED',
          jurisdiction: 'Patna Jurisdiction only',
        }
      );

      expect(normalProps.totals?.subtotal).toBe('5310.00');
      expect(normalProps.totals?.discountAmount).toBe('531.00');
      expect(normalProps.totals?.grandTotal).toBe('4779.00');
      expect(normalProps.company?.jurisdiction).toBe('Patna Jurisdiction only');

      await act(async () => {
        root.render(
          React.createElement(MannatTaxInvoice, {
            invoice: normalProps,
            showPrintButton: false,
            isNormalBill: true,
          })
        );
      });
      expect(container.textContent).toContain('Subtotal');
      expect(container.textContent).toContain('5,310.00');
      expect(container.textContent).toContain('531.00');
      expect(container.textContent).toContain('4,779.00');
      expect(container.textContent).toContain('Patna Jurisdiction only');
      expect(container.textContent).not.toContain('Gopalganj Jurisdiction only');

      // Fallback jurisdiction when company omits jurisdiction
      const fallbackProps = mapRecordToInvoiceProps(
        {
          id: 88,
          invoice_number: 'INV-INTRA-01',
          invoice_date: '2026-11-10',
          customer_name: 'Intra Buyer',
          customer_state: 'Bihar',
          customer_state_code: '10',
          subtotal_amount: '1000.00',
          taxable_amount: '1000.00',
          cgst_rate: '9',
          cgst_amount: '90.00',
          sgst_rate: '9',
          sgst_amount: '90.00',
          igst_rate: '0',
          igst_amount: '0.00',
          tax_amount: '180.00',
          grand_total: '1180.00',
          amount_in_words: 'Rupees One Thousand One Hundred Eighty Only',
          pdf_status: 'synced',
          created_at: '2026-11-10T10:00:00Z',
          items: [
            {
              item_index: 1,
              description: 'Cement Bag',
              quantity: '2',
              rate: '500.00',
              amount: '1000.00',
            },
          ],
        },
        { name: 'ALGIONS AI LABS PRIVATE LIMITED' }
      );

      await act(async () => {
        root.render(
          React.createElement(MannatTaxInvoice, {
            invoice: fallbackProps,
            showPrintButton: false,
          })
        );
      });
      expect(container.textContent).toContain('CGST @ 9%');
      expect(container.textContent).toContain('SGST @ 9%');
      expect(container.textContent).not.toContain('IGST');
      expect(container.textContent).toContain('Subject to seller jurisdiction.');
      expect(container.textContent).not.toContain('Gopalganj Jurisdiction only');

      // Inter-state GST mutual exclusion: IGST shown, CGST/SGST hidden
      const interProps = mapRecordToInvoiceProps(
        {
          id: 89,
          invoice_number: 'INV-INTER-01',
          invoice_date: '2026-11-10',
          customer_name: 'Delhi Buyer',
          customer_state: 'Delhi',
          customer_state_code: '07',
          subtotal_amount: '1000.00',
          taxable_amount: '1000.00',
          cgst_rate: '0',
          cgst_amount: '0.00',
          sgst_rate: '0',
          sgst_amount: '0.00',
          igst_rate: '18',
          igst_amount: '180.00',
          tax_amount: '180.00',
          grand_total: '1180.00',
          amount_in_words: 'Rupees One Thousand One Hundred Eighty Only',
          pdf_status: 'synced',
          created_at: '2026-11-10T10:00:00Z',
          items: [
            {
              item_index: 1,
              description: 'Cement Bag',
              quantity: '2',
              rate: '500.00',
              amount: '1000.00',
            },
          ],
        },
        { name: 'ALGIONS AI LABS PRIVATE LIMITED', jurisdiction: 'Delhi Arbitration Only' }
      );

      await act(async () => {
        root.render(
          React.createElement(MannatTaxInvoice, {
            invoice: interProps,
            showPrintButton: false,
          })
        );
      });
      expect(container.textContent).toContain('IGST @ 18%');
      expect(container.textContent).not.toContain('CGST');
      expect(container.textContent).not.toContain('SGST');
      expect(container.textContent).toContain('Delhi Arbitration Only');
    });
  });

  describe('D. Deferred Blob Download, Multi-Page WebP PDF Export & Adaptive Image Compression', () => {
    it('5. downloadBlobSafely defers URL.revokeObjectURL for 60s and exposes manual revoke', () => {
      vi.useFakeTimers();
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {});

      const blob = makePdfBlob('%PDF-1.4\nDownloadTest');
      const cleanup = downloadBlobSafely(blob, 'Invoice_INV-001.pdf');

      expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();

      vi.advanceTimersByTime(59_000);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);

      cleanup(); // idempotent
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
      clickSpy.mockRestore();
    });

    it('6. exportPdfBlobToWebpPages exports crisp WebP pages with standard naming, cleans up canvases/preview URLs, and handles Web Share + fallback', async () => {
      const progressEvents: Array<{ currentPage: number; totalPages: number }> = [];
      const pages = await exportPdfBlobToWebpPages({
        blob: makePdfBlob('%PDF-1.4\n2pages'),
        baseFileName: 'Invoice_INV-001.pdf',
        onProgress: (p) => progressEvents.push(p),
      });

      expect(pages).toHaveLength(2);
      expect(progressEvents).toEqual([
        { currentPage: 1, totalPages: 2 },
        { currentPage: 2, totalPages: 2 },
      ]);
      expect(pages[0].fileName).toBe('Invoice_INV-001_page_01.webp');
      expect(pages[1].fileName).toBe('Invoice_INV-001_page_02.webp');
      expect(pages[0].file.type).toBe('image/webp');
      expect(pages[0].sizeBytes).toBeGreaterThan(0);

      // Canvases reset to 0x0 and PDF.js document cleaned up
      expect(createdCanvases.length).toBeGreaterThanOrEqual(2);
      for (const c of createdCanvases) {
        expect(c.width).toBe(0);
        expect(c.height).toBe(0);
      }
      expect(mockPageCleanup).toHaveBeenCalledTimes(2);
      expect(mockCleanup).toHaveBeenCalledTimes(1);
      expect(mockDestroy).toHaveBeenCalledTimes(1);

      // Normal Bill naming check
      const nbPages = await exportPdfBlobToWebpPages({
        blob: makePdfBlob('%PDF-1.4\nnb'),
        baseFileName: 'Normal Bill #NB-001',
      });
      expect(nbPages[0].fileName).toBe('Normal_Bill_NB-001_page_01.webp');

      // Native Web Share path when supported
      const origShare = navigator.share;
      const origCanShare = navigator.canShare;
      (navigator as any).canShare = vi.fn(() => true);
      (navigator as any).share = vi.fn(async () => {});

      const shareRes = await shareOrDownloadPdfImages(pages, 'Invoice #INV-001');
      expect(shareRes).toEqual({ method: 'share' });
      expect((navigator as any).share).toHaveBeenCalledTimes(1);

      // Fallback download path when canShare returns false
      (navigator as any).canShare = vi.fn(() => false);
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {});
      const dlRes = await shareOrDownloadPdfImages(pages, 'Invoice #INV-001');
      expect(dlRes).toEqual({ method: 'download' });
      expect(clickSpy).toHaveBeenCalledTimes(2);

      cleanupExportedPageImages(pages);
      cleanupExportedPageImages(nbPages);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4);

      clickSpy.mockRestore();
      (navigator as any).share = origShare;
      (navigator as any).canShare = origCanShare;
    });

    it('7. compressImageFile downscales 4000x3000 camera photos to <=1200x900 and reduces oversized payload iteratively below maxSizeBytes', async () => {
      const OrigFileReader = globalThis.FileReader;
      const OrigImage = globalThis.Image;

      class MockFileReader {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL() {
          this.result = 'data:image/jpeg;base64,ZmFrZQ==';
          queueMicrotask(() => this.onload?.());
        }
      }

      class MockImage {
        width = 4000;
        height = 3000;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_val: string) {
          queueMicrotask(() => this.onload?.());
        }
      }

      (globalThis as any).FileReader = MockFileReader;
      (globalThis as any).Image = MockImage;

      let toBlobPass = 0;
      const recordedSizes: Array<{ w: number; h: number; q?: number }> = [];
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
        this: HTMLCanvasElement,
        cb: BlobCallback,
        type?: string,
        quality?: number
      ) {
        toBlobPass += 1;
        recordedSizes.push({ w: this.width, h: this.height, q: quality });
        // Pass 1 intentionally exceeds 500KB to verify adaptive shrink pass shrinks dimensions & quality
        const bytes = toBlobPass === 1 ? 750_000 : 120_000;
        cb(new Blob([new Uint8Array(bytes)], { type: type || 'image/jpeg' }));
      });

      try {
        const rawBytes = new Uint8Array(4 * 1024 * 1024); // 4 MB photo
        const inputFile = new File([rawBytes], 'camera-photo.png', { type: 'image/png' });

        const compressed = await compressImageFile(inputFile, {
          maxWidth: 1200,
          maxHeight: 1200,
          quality: 0.82,
          maxSizeBytes: 500_000,
          targetType: 'image/jpeg',
        });

        expect(recordedSizes[0]).toEqual({ w: 1200, h: 900, q: 0.82 });
        expect(recordedSizes[1].w).toBe(900);
        expect(recordedSizes[1].h).toBe(675);
        expect(recordedSizes[1].q).toBeCloseTo(0.67, 5);
        expect(compressed.size).toBe(120_000);
        expect(compressed.name).toBe('camera-photo.jpg');
        expect(compressed.type).toBe('image/jpeg');
      } finally {
        (globalThis as any).FileReader = OrigFileReader;
        (globalThis as any).Image = OrigImage;
      }
    });
  });
});
