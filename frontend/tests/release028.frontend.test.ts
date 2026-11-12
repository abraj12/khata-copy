// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { printCanonicalPdfBlob } from '../src/utils/pdfPrint.js';
import { PdfDocumentPreviewModal } from '../src/components/PdfDocumentPreviewModal.js';
import { NotificationCenterButton } from '../src/components/NotificationCenterButton.js';
import { HomeDashboard } from '../src/features/dashboard/HomeDashboard.js';
import * as dashboardApi from '../src/features/dashboard/dashboardApi.js';
import * as appDataApi from '../src/lib/appDataApi.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/utils/pdfImageExporter.js', () => ({
  loadPdfJs: vi.fn(async () => ({
    getDocument: vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 3,
        getPage: vi.fn(async () => ({
          getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: vi.fn(),
        })),
        cleanup: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
      }),
      destroy: vi.fn(async () => {}),
    })),
  })),
  exportPdfBlobToPngPages: vi.fn(async () => []),
}));

describe('Release #028 Frontend Printing Memory, Concurrency Guards & Sync Diagnostics Suite', () => {
  let container: HTMLDivElement;
  let root: Root;
  let origCreateObjectURL: typeof URL.createObjectURL;
  let origRevokeObjectURL: typeof URL.revokeObjectURL;
  let objectUrlSeq = 0;

  beforeEach(() => {
    vi.restoreAllMocks();
    objectUrlSeq = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    origCreateObjectURL = URL.createObjectURL;
    origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => `blob:r28-url-${++objectUrlSeq}`) as any;
    URL.revokeObjectURL = vi.fn() as any;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '#fff',
      fillRect: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
    } as any);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
  });

  it('1. printCanonicalPdfBlob prints via hidden iframe without canvas rasterization and revokes Object URL on afterprint', async () => {
    const iframeMockPrint = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    let capturedIframe: any = null;
    const listeners = new Map<string, Array<() => void>>();

    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName.toLowerCase() === 'iframe') {
        capturedIframe = {
          style: {},
          setAttribute: vi.fn(),
          removeAttribute: vi.fn(),
          title: '',
          src: '',
          parentNode: { removeChild: vi.fn() },
          contentWindow: {
            focus: vi.fn(),
            print: iframeMockPrint,
            addEventListener: vi.fn((ev: string, fn: () => void) => {
              listeners.set(ev, [...(listeners.get(ev) || []), fn]);
            }),
            removeEventListener: vi.fn(),
          },
          addEventListener: vi.fn((ev: string, fn: () => void) => {
            listeners.set(ev, [...(listeners.get(ev) || []), fn]);
          }),
          removeEventListener: vi.fn(),
        };
        return capturedIframe;
      }
      return origCreateElement(tagName);
    }) as any);
    vi.spyOn(document.body, 'appendChild').mockImplementation(((el: any) => el) as any);

    const toDataUrlSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL');
    const pdfBlob = new Blob(['%PDF-1.4\n%EOF'], { type: 'application/pdf' });

    const handle = printCanonicalPdfBlob({
      pdfBlob,
      onFallbackDownload: vi.fn(),
      iframeLoadTimeoutMs: 500,
    });

    expect(URL.createObjectURL).toHaveBeenCalledWith(pdfBlob);
    expect(capturedIframe.src).toBe('blob:r28-url-1');

    // Simulate iframe finishing load
    for (const fn of listeners.get('load') || []) fn();
    const res = await handle.promise;
    expect(res.method).toBe('iframe');
    expect(iframeMockPrint).toHaveBeenCalledTimes(1);
    expect(toDataUrlSpy).not.toHaveBeenCalled();

    // afterprint listener cleanly tears down iframe & revokes blob URL once
    for (const fn of listeners.get('afterprint') || []) fn();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:r28-url-1');
    expect(capturedIframe.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('2. PdfDocumentPreviewModal cleans up active print Object URL on modal close', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({
      opener: window,
      document: { readyState: 'loading' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      focus: vi.fn(),
      print: vi.fn(),
    } as any);

    const pdfBlob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(PdfDocumentPreviewModal, {
          isOpen: true,
          title: 'Invoice #28',
          fileName: 'inv-28.pdf',
          documentLabel: 'Invoice',
          fetchPdfBlob: async () => pdfBlob,
          fetchKey: 'inv-28',
          onClose,
        })
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const printBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.title === 'Print PDF'
    )!;
    await act(async () => {
      printBtn.click();
    });

    expect(openSpy).toHaveBeenCalledWith('blob:r28-url-1', '_blank');

    // Closing the modal must revoke any outstanding print object URL immediately
    await act(async () => {
      root.render(
        React.createElement(PdfDocumentPreviewModal, {
          isOpen: false,
          title: 'Invoice #28',
          fileName: 'inv-28.pdf',
          documentLabel: 'Invoice',
          fetchPdfBlob: async () => pdfBlob,
          fetchKey: 'inv-28',
          onClose,
        })
      );
    });

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:r28-url-1');
  });

  it('3. NotificationCenterButton aborts superseded fetches and prevents out-of-order stale overwrites', async () => {
    let callNum = 0;
    let resolveFirst!: (val: any) => void;
    let firstSignal!: AbortSignal;

    vi.spyOn(appDataApi, 'fetchNotificationsApi').mockImplementation(async (opts = {}) => {
      callNum += 1;
      if (callNum === 1) {
        firstSignal = opts.signal!;
        return new Promise((resolve, reject) => {
          resolveFirst = resolve;
          opts.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Aborted'), { code: 'REQUEST_ABORTED' }));
          });
        });
      }
      return {
        success: true,
        source: 'mongodb',
        unreadCount: 1,
        notifications: [
          {
            id: 'n-fresh',
            category: 'system',
            severity: 'info',
            title: 'Newest notification',
            message: 'Current state',
            entityType: null,
            entityId: null,
            isRead: false,
            readAt: null,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    });

    await act(async () => {
      root.render(React.createElement(NotificationCenterButton));
    });

    const bellBtn = container.querySelector('button[title="Notifications"]') as HTMLButtonElement;
    expect(bellBtn).toBeTruthy();

    // Toggling bell open while first request is still pending aborts first request & shows fresh response
    await act(async () => {
      bellBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(firstSignal.aborted).toBe(true);
    // Even if first promise tried resolving late, newest state stays intact & zero error shown
    resolveFirst?.({ success: true, source: 'mongodb', unreadCount: 9, notifications: [] });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Newest notification');
    expect(container.textContent).not.toContain('Unable to load alerts.');
  });

  it('4. HomeDashboard displays degraded and dead-letter sync badges accurately', async () => {
    vi.spyOn(dashboardApi, 'fetchDashboardOverview').mockResolvedValue({
      businessDate: '2026-11-12',
      timeZone: 'Asia/Kolkata',
      syncStatus: {
        source: 'mongodb',
        syncedAt: new Date().toISOString(),
        ageMs: 250,
        isStale: true,
        deadLetterCount: 2,
        outboxDegraded: true,
      },
      dateRange: { fromDate: null, toDate: null },
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
        estimatedGrossMarginPercent: null,
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
        granularity: 'month',
        points: [],
      },
      recentActivity: [],
    });

    await act(async () => {
      root.render(
        React.createElement(HomeDashboard, {
          defaultDatePreset: 'today',
          onNavigateTab: vi.fn(),
        })
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const staleBadge = container.querySelector('[data-testid="sync-stale-badge"]');
    expect(staleBadge).toBeTruthy();
    expect(staleBadge?.textContent).toContain('Sync needs attention (2 failed)');
  });
});
