// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockNumPagesRef,
  mockDocCleanup,
  mockDocDestroy,
  mockTaskDestroy,
  mockPageCleanup,
  mockRenderCancel,
  mockGetDocument,
} = vi.hoisted(() => {
  const numPagesRef = { current: 10 };
  const docCleanup = vi.fn(async () => {});
  const docDestroy = vi.fn(async () => {});
  const taskDestroy = vi.fn(async () => {});
  const pageCleanup = vi.fn();
  const renderCancel = vi.fn();

  const getDocument = vi.fn(() => {
    const pdfDoc = {
      numPages: numPagesRef.current,
      cleanup: docCleanup,
      destroy: docDestroy,
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
      destroy: taskDestroy,
    };
  });

  return {
    mockNumPagesRef: numPagesRef,
    mockDocCleanup: docCleanup,
    mockDocDestroy: docDestroy,
    mockTaskDestroy: taskDestroy,
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

vi.mock('../src/features/bills/gstInvoicesApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/bills/gstInvoicesApi.js')>(
    '../src/features/bills/gstInvoicesApi.js'
  );
  return {
    ...actual,
    getNextInvoiceNumber: vi.fn(),
    listGstInvoices: vi.fn(),
    fetchDraftPdfBlob: vi.fn(),
    fetchInvoicePdfBlob: vi.fn(),
  };
});

vi.mock('../src/features/bills/normalBillsApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/bills/normalBillsApi.js')>(
    '../src/features/bills/normalBillsApi.js'
  );
  return {
    ...actual,
    getNextNormalBillNumber: vi.fn(),
    listNormalBills: vi.fn(),
    fetchNormalBillDraftPdfBlob: vi.fn(),
    fetchNormalBillPdfBlob: vi.fn(),
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

vi.mock('../src/lib/appDataApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/appDataApi.js')>(
    '../src/lib/appDataApi.js'
  );
  return {
    ...actual,
    fetchPreferencesApi: vi.fn(),
    updatePreferencesApi: vi.fn(),
    fetchNotificationsApi: vi.fn(),
    markNotificationReadApi: vi.fn(),
    markAllNotificationsReadApi: vi.fn(),
    sendTelemetryApi: vi.fn(),
  };
});

vi.mock('../src/features/dashboard/dashboardApi.js', async () => {
  const actual = await vi.importActual<typeof import('../src/features/dashboard/dashboardApi.js')>(
    '../src/features/dashboard/dashboardApi.js'
  );
  return {
    ...actual,
    fetchDashboardOverview: vi.fn(),
    fetchDashboardExpenses: vi.fn(),
  };
});

vi.mock('../src/utils/imageCompressor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/imageCompressor.js')>(
    '../src/utils/imageCompressor.js'
  );
  return {
    ...actual,
    compressImageFile: vi.fn(),
  };
});

vi.mock('../src/lib/apiClient.js', () => ({
  apiClient: vi.fn(),
  apiClientBlob: vi.fn(),
  API_BASE_URL: 'http://localhost:5000',
  getCsrfToken: vi.fn(() => 'csrf-r27-token'),
  fetchCsrfToken: vi.fn(async () => 'csrf-r27-token'),
}));

import {
  PdfDocumentPreviewModal,
  MAX_ACTIVE_PREVIEW_CANVASES,
  computeActivePageWindow,
} from '../src/components/PdfDocumentPreviewModal.js';
import { GstBillingView } from '../src/features/bills/GstBillingView.js';
import { NormalBillingView } from '../src/features/bills/NormalBillingView.js';
import { preparePurchaseBillAttachment } from '../src/features/suppliers/PurchaseBillsView.js';
import { NotificationCenterButton } from '../src/components/NotificationCenterButton.js';
import {
  ThemeAccessibilityProvider,
  useThemeAccessibility,
} from '../src/context/ThemeAccessibilityContext.js';
import { HomeDashboard } from '../src/features/dashboard/HomeDashboard.js';
import * as gstInvoicesApi from '../src/features/bills/gstInvoicesApi.js';
import * as normalBillsApi from '../src/features/bills/normalBillsApi.js';
import * as quotationApi from '../src/features/quotations/quotationApi.js';
import * as appDataApi from '../src/lib/appDataApi.js';
import * as dashboardApi from '../src/features/dashboard/dashboardApi.js';
import * as imageCompressorMod from '../src/utils/imageCompressor.js';
import * as apiClientMod from '../src/lib/apiClient.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makePdfBlob(label = '%PDF-1.4\n%Release027Multipage'): Blob {
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

function buildOverviewFixture(isStale: boolean) {
  return {
    dateRange: { fromDate: null, toDate: null },
    sales: {
      totalSalesRevenue: '4500.00',
      normalBillsTotal: '2500.00',
      normalBillsCount: 2,
      gstTaxableSales: '2000.00',
      gstCollected: '360.00',
      gstGrandTotal: '2360.00',
      gstInvoicesCount: 1,
      averageBillValue: '1500.00',
    },
    profitability: {
      totalSalesRevenue: '4500.00',
      costedSalesRevenue: '4500.00',
      uncostedSalesRevenue: '0.00',
      estimatedCostOfGoodsSold: '3000.00',
      estimatedGrossProfit: '1500.00',
      estimatedGrossMarginPercent: '33.33',
      costCoveragePercent: '100.00',
      operatingExpenses: '200.00',
      operatingExpensesCount: 1,
      voidedExpensesCount: 0,
      estimatedNetOperatingResult: '1300.00',
      hasIncompleteCostData: false,
    },
    expensesByCategory: [],
    customersKhata: {
      totalCustomers: 3,
      activeCustomers: 3,
      newCustomersCount: 1,
      customersWithOutstanding: 1,
      totalOutstandingReceivable: '900.00',
      creditGiven: '1200.00',
      paymentsReceived: '300.00',
      paymentCount: 1,
    },
    products: {
      totalProducts: 4,
      activeProducts: 4,
      archivedProducts: 0,
      topProducts: [],
    },
    suppliers: {
      totalSuppliers: 1,
      activeSuppliers: 1,
      totalPurchases: '1000.00',
      purchaseBillsCount: 1,
      cancelledBillsCount: 0,
      totalPaymentsMade: '400.00',
      paymentsCount: 1,
      totalPaymentsReversed: '0.00',
      totalOutstandingPayable: '600.00',
      totalAdvanceCredit: '0.00',
      totalUnallocatedPayments: '0.00',
    },
    quotations: {
      totalCount: 1,
      draftCount: 1,
      sentCount: 0,
      acceptedCount: 0,
      convertedCount: 0,
      rejectedCount: 0,
      expiredCount: 0,
      conversionRatePercent: '0.00',
      pendingPipelineValue: '500.00',
      convertedValue: '0.00',
    },
    salesTrend: { granularity: 'month' as const, points: [] },
    recentActivity: [],
    syncStatus: {
      source: 'mongodb' as const,
      syncedAt: new Date().toISOString(),
      ageMs: 1200,
      isStale,
    },
  };
}

describe('Release #027 Frontend Hardening, Bounded Multipage PDF & Mongo UI Suite', () => {
  let container: HTMLDivElement;
  let root: Root;
  let origCreateObjectURL: typeof URL.createObjectURL;
  let origRevokeObjectURL: typeof URL.revokeObjectURL;
  let trackedCanvases: HTMLCanvasElement[];

  beforeEach(() => {
    mockNumPagesRef.current = 10;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    trackedCanvases = [];

    origCreateObjectURL = URL.createObjectURL;
    origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:r27-preview-url') as any;
    URL.revokeObjectURL = vi.fn() as any;

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement
    ) {
      trackedCanvases.push(this);
      return {
        fillStyle: '#FFFFFF',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        fillRect: vi.fn(),
        clearRect: vi.fn(),
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D;
    });

    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,iVBORw0KGgo=');
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback,
      type?: string
    ) {
      cb(new Blob([new Uint8Array(128)], { type: type || 'image/webp' }));
    });

    (quotationApi.fetchQuotationSettings as any).mockResolvedValue({
      company_name: 'ALGIONS AI LABS PRIVATE LIMITED',
      gstin: '09AAAAA0000A1Z0',
      address: 'Main Road, Patna',
      phone: '9876543210',
      state: 'Uttar Pradesh',
      state_code: '09',
      jurisdiction: 'Patna Jurisdiction only',
    });
    (gstInvoicesApi.getNextInvoiceNumber as any).mockResolvedValue('GST-027');
    (gstInvoicesApi.listGstInvoices as any).mockResolvedValue({
      invoices: [],
      pagination: { total: 0, limit: 25, offset: 0, hasMore: false },
    });
    (normalBillsApi.getNextNormalBillNumber as any).mockResolvedValue('NB-027');
    (normalBillsApi.listNormalBills as any).mockResolvedValue({
      bills: [],
      pagination: { total: 0, limit: 25, offset: 0, hasMore: false },
    });
    (apiClientMod.apiClient as any).mockResolvedValue({
      status: 200,
      data: { success: true, data: [], customers: [] },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    act(() => {
      root.unmount();
    });
    container.remove();
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    localStorage.clear();
  });

  it('1. PdfDocumentPreviewModal enforces bounded <= 6 active canvases across 10 pages, zeros evicted canvases, and cleans up PDF.js on close', async () => {
    expect(computeActivePageWindow(1, 10, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(computeActivePageWindow(5, 10, 6)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(computeActivePageWindow(9, 10, 6)).toEqual([5, 6, 7, 8, 9, 10]);

    const onClose = vi.fn();
    const pdfBlob = makePdfBlob();

    await act(async () => {
      root.render(
        React.createElement(PdfDocumentPreviewModal, {
          isOpen: true,
          title: 'Tax Invoice 10-Page PDF',
          fileName: 'invoice-10-pages.pdf',
          documentLabel: 'Invoice',
          fetchPdfBlob: async () => pdfBlob,
          fetchKey: 'inv-10-pages',
          onClose,
        })
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Window [1..6] active, pages [7..10] rendered as lightweight placeholders
    const initialCanvases = Array.from(container.querySelectorAll('canvas'));
    expect(initialCanvases.length).toBeLessThanOrEqual(MAX_ACTIVE_PREVIEW_CANVASES);
    expect(initialCanvases.length).toBe(6);
    expect(container.querySelector('[data-testid="pdf-page-1"] canvas')).not.toBeNull();
    expect(container.querySelector('[data-testid="pdf-page-7-placeholder"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pdf-page-10-placeholder"]')).not.toBeNull();
    expect(initialCanvases[0].width).toBeGreaterThan(0);

    // Jump to Page 9 via placeholder button -> window shifts to [5..10], evicting & zeroing canvases 1..4
    const jumpPage9Btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="pdf-page-9-placeholder"] button')
    )[0];
    expect(jumpPage9Btn).toBeDefined();

    await act(async () => {
      jumpPage9Btn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const shiftedCanvases = Array.from(container.querySelectorAll('canvas'));
    expect(shiftedCanvases.length).toBeLessThanOrEqual(MAX_ACTIVE_PREVIEW_CANVASES);
    expect(shiftedCanvases.length).toBe(6);
    expect(container.querySelector('[data-testid="pdf-page-1-placeholder"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pdf-page-9"] canvas')).not.toBeNull();

    // Evicted canvas for page 1 was zeroed (0x0 bitmap release)
    expect(initialCanvases[0].width).toBe(0);
    expect(initialCanvases[0].height).toBe(0);

    // Close/unmount zeros all active canvases & destroys PDF.js resources
    await act(async () => {
      root.unmount();
    });
    for (const c of shiftedCanvases) {
      expect(c.width).toBe(0);
      expect(c.height).toBe(0);
    }
    expect(mockDocCleanup).toHaveBeenCalled();
    expect(mockDocDestroy).toHaveBeenCalled();
    expect(mockTaskDestroy).toHaveBeenCalled();

    // Re-initialize empty root for afterEach cleanly
    root = createRoot(container);
  });

  it('2. PdfDocumentPreviewModal prints canonical pdfBlob via Object URL without full-doc PNG rasterization and handles blocked popups', async () => {
    const pdfBlob = makePdfBlob();
    await act(async () => {
      root.render(
        React.createElement(PdfDocumentPreviewModal, {
          isOpen: true,
          title: 'Multi-Page Print Test',
          fileName: 'multi-print.pdf',
          documentLabel: 'Bill',
          fetchPdfBlob: async () => pdfBlob,
          fetchKey: 'multi-print',
          onClose: vi.fn(),
        })
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const toDataUrlBeforePrint = (HTMLCanvasElement.prototype.toDataURL as any).mock.calls.length;
    const mockPrint = vi.fn();
    const fakePopup: any = {
      opener: window,
      document: { readyState: 'complete' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      focus: vi.fn(),
      print: mockPrint,
      close: vi.fn(),
    };

    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakePopup);
    const printBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.title === 'Print PDF'
    )!;
    expect(printBtn).toBeDefined();

    await act(async () => {
      printBtn.click();
    });

    // Must open canonical PDF Object URL directly WITHOUT rasterizing pages to PNG data URLs
    expect(URL.createObjectURL).toHaveBeenCalledWith(pdfBlob);
    expect((HTMLCanvasElement.prototype.toDataURL as any).mock.calls.length).toBe(toDataUrlBeforePrint);
    // Fallback opens canonical blob URL WITHOUT noopener/noreferrer, then nulls opener and triggers print()
    expect(openSpy).toHaveBeenCalledWith('blob:r27-preview-url', '_blank');
    expect(fakePopup.opener).toBeNull();
    expect(mockPrint).toHaveBeenCalledTimes(1);

    // Pop-up blocked fallback revokes object URL, downloads canonical PDF, and shows banner notice
    openSpy.mockReturnValue(null);
    await act(async () => {
      printBtn.click();
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:r27-preview-url');
    expect(container.textContent).toContain('Pop-up blocked by browser — downloaded canonical PDF instead.');
  });

  it('3. GstBillingView and NormalBillingView use canonical backend PDF blobs inside PdfDocumentPreviewModal for preview', async () => {
    const gstDraftBlob = makePdfBlob('%PDF-1.4 GST');
    const normalDraftBlob = makePdfBlob('%PDF-1.4 NORMAL');
    (gstInvoicesApi.fetchDraftPdfBlob as any).mockResolvedValue(gstDraftBlob);
    (normalBillsApi.fetchNormalBillDraftPdfBlob as any).mockResolvedValue(normalDraftBlob);

    await act(async () => {
      root.render(React.createElement(GstBillingView));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Fill required customer name, customer state, and line item in GST billing
    const customerInput = container.querySelector<HTMLInputElement>('input[placeholder*="Sharma Construction"]')!;
    expect(customerInput).not.toBeNull();
    await act(async () => setInputVal(customerInput, 'Sharma Hardware'));

    const stateSelect = Array.from(container.querySelectorAll<HTMLSelectElement>('select')).find((s) =>
      s.textContent?.includes('Select customer state')
    );
    if (stateSelect) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        setter?.call(stateSelect, '09');
        stateSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    const descInput = container.querySelector<HTMLInputElement>('input[placeholder*="Enter item description"]')!;
    expect(descInput).not.toBeNull();
    await act(async () => setInputVal(descInput, 'Steel Bar 12mm'));

    const rateInput = container.querySelector<HTMLInputElement>('input[placeholder="0.00"]')!;
    expect(rateInput).not.toBeNull();
    await act(async () => setInputVal(rateInput, '500'));

    const previewGstBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Preview A4 Invoice')
    )!;
    expect(previewGstBtn).toBeDefined();

    await act(async () => {
      previewGstBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(gstInvoicesApi.fetchDraftPdfBlob).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pdf-page-1"] canvas')).not.toBeNull();

    // Now test NormalBillingView canonical preview
    await act(async () => {
      root.render(React.createElement(NormalBillingView));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const nbCustomerInput = container.querySelector<HTMLInputElement>('input[placeholder*="Search existing customer"]')!;
    expect(nbCustomerInput).not.toBeNull();
    await act(async () => setInputVal(nbCustomerInput, 'Patel Cement'));

    const nbDescInput = container.querySelector<HTMLInputElement>('input[placeholder*="Enter item description"]')!;
    expect(nbDescInput).not.toBeNull();
    await act(async () => setInputVal(nbDescInput, 'Cement Bag 50kg'));

    const nbRateInput = container.querySelector<HTMLInputElement>('input[placeholder="0.00"]')!;
    expect(nbRateInput).not.toBeNull();
    await act(async () => setInputVal(nbRateInput, '350'));

    const previewNbBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Preview Bill')
    )!;
    expect(previewNbBtn).toBeDefined();

    await act(async () => {
      previewNbBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(normalBillsApi.fetchNormalBillDraftPdfBlob).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('4. preparePurchaseBillAttachment validates types, rejects >10MB PDFs, and compresses >9.5MB images before R2 upload', async () => {
    const emptyFile = new File([], 'empty.jpg', { type: 'image/jpeg' });
    await expect(preparePurchaseBillAttachment(emptyFile)).rejects.toThrow(/empty/i);

    const badMime = new File([new Uint8Array(64)], 'script.exe', { type: 'application/x-msdownload' });
    await expect(preparePurchaseBillAttachment(badMime)).rejects.toThrow(/JPEG, PNG, WebP images and PDF/i);

    const bigPdf = new File([new Uint8Array(10 * 1024 * 1024 + 100)], 'huge-bill.pdf', {
      type: 'application/pdf',
    });
    await expect(preparePurchaseBillAttachment(bigPdf)).rejects.toThrow(/must not exceed 10 MB/i);

    const validPdf = new File([new Uint8Array(1024)], 'bill.pdf', { type: 'application/pdf' });
    await expect(preparePurchaseBillAttachment(validPdf)).resolves.toBe(validPdf);

    const rawPhoto = new File([new Uint8Array(12 * 1024 * 1024)], 'camera-bill.jpg', {
      type: 'image/jpeg',
    });
    const smallCompressed = new File([new Uint8Array(512 * 1024)], 'camera-bill.webp', {
      type: 'image/webp',
    });
    (imageCompressorMod.compressImageFile as any).mockResolvedValueOnce(smallCompressed);

    const prepared = await preparePurchaseBillAttachment(rawPhoto);
    expect(prepared).toBe(smallCompressed);
    expect(imageCompressorMod.compressImageFile).toHaveBeenCalledWith(rawPhoto, {
      maxWidth: 1600,
      maxHeight: 1600,
      quality: 0.82,
      maxSizeBytes: 9.5 * 1024 * 1024,
    });
  });

  it('5. Renders sync freshness badges in HomeDashboard, NotificationCenterButton without polling, and ThemeAccessibilityContext Mongo sync', async () => {
    // 5a. HomeDashboard sync-stale-badge vs sync-fresh-badge
    (dashboardApi.fetchDashboardExpenses as any).mockResolvedValue({
      items: [],
      total: 0,
      totalActiveAmount: '0.00',
      limit: 10,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    (dashboardApi.fetchDashboardOverview as any)
      .mockResolvedValueOnce(buildOverviewFixture(true))
      .mockResolvedValueOnce(buildOverviewFixture(false));

    await act(async () => {
      root.render(React.createElement(HomeDashboard, { onNavigate: vi.fn() }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="sync-stale-badge"]')?.textContent).toContain('Sync catching up');
    expect(container.querySelector('[data-testid="sync-fresh-badge"]')).toBeNull();

    // Refresh dashboard -> receives fresh overview
    const refreshBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.title?.toLowerCase().includes('refresh') || b.textContent?.includes('Refresh')
    )!;
    expect(refreshBtn).toBeDefined();
    await act(async () => {
      refreshBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="sync-fresh-badge"]')?.textContent).toContain('Read model synced');
    expect(container.querySelector('[data-testid="sync-stale-badge"]')).toBeNull();

    // 5b. NotificationCenterButton fetches ONLY on mount/open/manual click with zero setInterval polling
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    (appDataApi.fetchNotificationsApi as any).mockResolvedValue({
      success: true,
      unreadCount: 1,
      notifications: [
        {
          id: 'notif-1',
          category: 'outbox_sync',
          severity: 'info',
          title: 'Read models healthy',
          message: 'All collections synchronized.',
          isRead: false,
          readAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    (appDataApi.markNotificationReadApi as any).mockResolvedValue({ success: true });

    await act(async () => {
      root.render(React.createElement(NotificationCenterButton));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(appDataApi.fetchNotificationsApi).toHaveBeenCalledTimes(1);

    const bellBtn = container.querySelector<HTMLButtonElement>('button[title="Notifications"]')!;
    expect(bellBtn).not.toBeNull();
    expect(container.querySelector('[aria-label="1 unread notifications"]')).not.toBeNull();

    await act(async () => {
      bellBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"][aria-label="Business notifications"]')).not.toBeNull();
    expect(container.textContent).toContain('Read models healthy');

    const markReadBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Mark read')
    )!;
    await act(async () => {
      markReadBtn.click();
    });
    expect(appDataApi.markNotificationReadApi).toHaveBeenCalledWith('notif-1');
    expect(container.querySelector('[aria-label$="unread notifications"]')).toBeNull();

    // 5c. ThemeAccessibilityContext syncFromServer -> debounced PUT -> resetServerSync stops sync
    vi.useFakeTimers();
    (appDataApi.fetchPreferencesApi as any).mockResolvedValue({
      success: true,
      source: 'mongodb',
      preferences: {
        theme: {
          version: 3,
          preset: 'soft-dark',
          textSize: '115',
          contrastOverride: 'enhanced',
          reduceMotion: 'system',
          increaseSpacing: false,
          strongFocus: false,
        },
      },
    });
    (appDataApi.updatePreferencesApi as any).mockResolvedValue({ success: true });

    let latestCtx: ReturnType<typeof useThemeAccessibility> | null = null;
    const ThemeHarness = () => {
      const ctx = useThemeAccessibility();
      latestCtx = ctx;
      return React.createElement('div', { 'data-testid': 'preset' }, ctx.preferences.preset);
    };

    await act(async () => {
      root.render(
        React.createElement(ThemeAccessibilityProvider, null, React.createElement(ThemeHarness))
      );
    });

    await act(async () => {
      await latestCtx!.syncFromServer();
    });
    expect(document.documentElement.getAttribute('data-neu-preset')).toBe('soft-dark');

    await act(async () => {
      latestCtx!.setPreset('flat');
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(appDataApi.updatePreferencesApi).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({ preset: 'flat' }),
      })
    );

    await act(async () => {
      latestCtx!.resetServerSync();
      latestCtx!.setPreset('high-contrast');
      vi.advanceTimersByTime(500);
    });
    expect(appDataApi.updatePreferencesApi).toHaveBeenCalledTimes(1);
  });
});
