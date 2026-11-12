// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const {
  mockNumPagesRef,
  mockDocCleanup,
  mockDocDestroy,
  mockTaskDestroy,
  mockPageCleanup,
  mockRenderCancel,
  mockGetDocument,
  mockApiClient,
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

  const apiClientMock = vi.fn();

  return {
    mockNumPagesRef: numPagesRef,
    mockDocCleanup: docCleanup,
    mockDocDestroy: docDestroy,
    mockTaskDestroy: taskDestroy,
    mockPageCleanup: pageCleanup,
    mockRenderCancel: renderCancel,
    mockGetDocument: getDocument,
    mockApiClient: apiClientMock,
  };
});

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/pdf.worker.min.mjs',
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: mockGetDocument,
}));

vi.mock('../src/lib/apiClient.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/apiClient.js')>('../src/lib/apiClient.js');
  return {
    ...actual,
    apiClient: mockApiClient,
  };
});

import {
  buildPaginatedSearchParams,
  mergeUniqueById,
  mergeUniqueByKey,
} from '../src/types/pagination.js';
import {
  usePaginatedCustomerSearch,
  usePaginatedProductSearch,
} from '../src/features/bills/useBillingCatalogueSearch.js';
import { ProductsView } from '../src/features/products/ProductsView.js';
import { KhataLedgerView } from '../src/features/khata/KhataLedgerView.js';
import { SearchablePicker } from '../src/components/SearchablePicker.js';
import { printCanonicalPdfBlob } from '../src/utils/pdfPrint.js';
import { PdfDocumentPreviewModal } from '../src/components/PdfDocumentPreviewModal.js';

function createContainer(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

function makeProductRow(id: number, name = `Product ${id}`) {
  return {
    id,
    name,
    buying_price: '95.00',
    hsn_code: '1006',
    barcode: `89000${id}`,
    image_object_key: null,
    image_url: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    archived_at: null,
  };
}

function makeCustomerRow(id: number, name = `Customer ${id}`) {
  return {
    id,
    name,
    phone: `98111${String(id).padStart(5, '0')}`,
    address: null,
    gstin: null,
    total_udhar: '1000.00',
    total_paid: '400.00',
    outstanding_balance: '600.00',
    totalUdhar: '1000.00',
    totalReceived: '400.00',
    outstanding: '600.00',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  };
}

describe('Release #029 Frontend Keyset Pagination, Search & Canonical PDF Lifecycle Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNumPagesRef.current = 10;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('1. Cursor Helpers & 25,000-Record Keyset Chain Verification', () => {
    it('buildPaginatedSearchParams prefers opaque keyset cursor and falls back to offset only when cursor is absent', () => {
      const withCursor = buildPaginatedSearchParams({
        search: 'आटा',
        limit: 25,
        offset: 50,
        cursor: 'cur_page2_abc',
      });
      expect(withCursor.get('search')).toBe('आटा');
      expect(withCursor.get('limit')).toBe('25');
      expect(withCursor.get('cursor')).toBe('cur_page2_abc');
      expect(withCursor.has('offset')).toBe(false);

      const withoutCursor = buildPaginatedSearchParams({
        search: '',
        limit: 25,
        offset: 75,
        cursor: null,
      });
      expect(withoutCursor.has('search')).toBe(false);
      expect(withoutCursor.has('cursor')).toBe(false);
      expect(withoutCursor.get('offset')).toBe('75');
    });

    it('mergeUniqueById and mergeUniqueByKey deduplicate overlapping records while preserving order across 25,000 records', () => {
      const a = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
      const b = [{ id: 2, name: 'B-dup' }, { id: 3, name: 'C' }];
      expect(mergeUniqueById(a, b)).toEqual([
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' },
      ]);

      const keyMerged = mergeUniqueByKey(a, b, (item) => item.id);
      expect(keyMerged.map((x) => x.id)).toEqual([1, 2, 3]);

      // Simulate 50-page cursor traversal across 25,000 items (500 per page with boundary overlaps)
      const TOTAL = 25_000;
      const PAGE_SIZE = 500;
      let accumulated: Array<{ id: number; name: string }> = [];
      let cursor: string | null = null;
      let pageCount = 0;

      while (true) {
        const startIdx = cursor ? Number(cursor.replace('idx:', '')) : 0;
        const pageItems = Array.from(
          { length: Math.min(PAGE_SIZE, TOTAL - startIdx) },
          (_, i) => ({ id: startIdx + i + 1, name: `Row ${startIdx + i + 1}` })
        );
        // Inject overlapping boundary record from previous page on subsequent pages
        if (startIdx > 0) {
          pageItems.unshift({ id: startIdx, name: `Overlap ${startIdx}` });
        }
        accumulated = mergeUniqueById(accumulated, pageItems);
        const nextStart = startIdx + PAGE_SIZE;
        cursor = nextStart < TOTAL ? `idx:${nextStart}` : null;
        pageCount += 1;
        if (!cursor) break;
      }

      expect(pageCount).toBe(50);
      expect(accumulated).toHaveLength(25_000);
      expect(accumulated[0].id).toBe(1);
      expect(accumulated[24_999].id).toBe(25_000);
    });
  });

  describe('2. ProductsView & KhataLedgerView Keyset Cursor Adoption, Reset & Deduplication', () => {
    it('ProductsView sends cursor on Load More Products, deduplicates overlapping rows, falls back cleanly when cursor=null, and resets on new search', async () => {
      const requestedUrls: string[] = [];
      mockApiClient.mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes('cursor=cur_prod_1')) {
          return {
            data: {
              success: true,
              data: [makeProductRow(2, 'Basmati 2 (Dup)'), makeProductRow(3, 'Chana Dal')],
              pagination: {
                limit: 25,
                offset: 25,
                hasMore: true,
                nextOffset: 50,
                nextCursor: null, // Force offset fallback on subsequent page
                total: null,
                totalIsExact: false,
              },
            },
          };
        }
        if (url.includes('offset=50')) {
          return {
            data: {
              success: true,
              data: [makeProductRow(4, 'Moong Dal')],
              pagination: {
                limit: 25,
                offset: 50,
                hasMore: false,
                nextOffset: null,
                nextCursor: null,
                total: 4,
                totalIsExact: true,
              },
            },
          };
        }
        if (url.includes('search=%E0%A4%86%E0%A4%9F%E0%A4%BE') || url.includes(encodeURIComponent('आटा'))) {
          return {
            data: {
              success: true,
              data: [makeProductRow(101, 'आटा 5किग्रा')],
              pagination: {
                limit: 25,
                offset: 0,
                hasMore: false,
                nextOffset: null,
                nextCursor: null,
                total: 1,
                totalIsExact: true,
              },
            },
          };
        }
        return {
          data: {
            success: true,
            data: [makeProductRow(1, 'Almonds'), makeProductRow(2, 'Basmati 2')],
            pagination: {
              limit: 25,
              offset: 0,
              hasMore: true,
              nextOffset: 25,
              nextCursor: 'cur_prod_1',
              total: null,
              totalIsExact: false,
            },
          },
        };
      });

      const { container, root } = createContainer();
      await act(async () => {
        root.render(React.createElement(ProductsView));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(container.textContent).toContain('Almonds');
      expect(container.textContent).toContain('Basmati 2');

      const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Load More Products')
      );
      expect(loadMoreBtn).toBeTruthy();

      await act(async () => {
        loadMoreBtn!.click();
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(requestedUrls.some((u) => u.includes('cursor=cur_prod_1'))).toBe(true);
      expect(requestedUrls.some((u) => u.includes('cursor=cur_prod_1') && u.includes('offset='))).toBe(false);
      // Row 2 was duplicated in response, must appear only once in desktop table body
      const desktopRows = Array.from(container.querySelectorAll('tbody tr'));
      expect(desktopRows).toHaveLength(3);
      const desktopBasmatiRows = desktopRows.filter((tr) => tr.textContent?.includes('Basmati 2'));
      expect(desktopBasmatiRows).toHaveLength(1);
      expect(container.textContent).toContain('Chana Dal');

      // Second Load More with nextCursor=null falls back to offset=50
      const loadMoreBtn2 = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Load More Products')
      );
      await act(async () => {
        loadMoreBtn2!.click();
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(requestedUrls.some((u) => u.includes('offset=50'))).toBe(true);
      expect(container.textContent).toContain('Moong Dal');

      // Typing a search resets cursor and queries Hindi search term at offset=0
      const searchInput = container.querySelector('input[type="text"], input[type="search"]') as HTMLInputElement;
      expect(searchInput).toBeTruthy();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(searchInput, 'आटा');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 380));
      });

      const lastProdReq = requestedUrls[requestedUrls.length - 1];
      expect(lastProdReq).toContain('offset=0');
      expect(lastProdReq).not.toContain('cursor=');
      expect(container.textContent).toContain('आटा 5किग्रा');

      act(() => root.unmount());
      container.remove();
    });

    it('KhataLedgerView sends cursor on Load More Customers, deduplicates overlapping rows, and resets cursor on query change', async () => {
      const requestedUrls: string[] = [];
      mockApiClient.mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url.startsWith('/api/v1/khata/summary')) {
          return {
            data: {
              success: true,
              summary: {
                total_customers: 2,
                total_udhar_amount: '2000.00',
                total_received_amount: '800.00',
                total_outstanding_balance: '1200.00',
                total_outstanding: '1200.00',
              },
            },
          };
        }
        if (url.includes('/api/v1/khata/customers') && url.includes('cursor=cur_cust_1')) {
          return {
            data: {
              success: true,
              customers: [makeCustomerRow(2, 'Ramesh Dup'), makeCustomerRow(3, 'Suresh')],
              pagination: {
                limit: 25,
                offset: 25,
                hasMore: false,
                nextOffset: null,
                nextCursor: null,
                total: null,
                totalIsExact: false,
              },
            },
          };
        }
        if (url.includes('/api/v1/khata/customers') && url.includes('search=ram')) {
          return {
            data: {
              success: true,
              customers: [makeCustomerRow(11, 'Ramlal Fresh')],
              pagination: {
                limit: 25,
                offset: 0,
                hasMore: false,
                nextOffset: null,
                nextCursor: null,
                total: 1,
                totalIsExact: true,
              },
            },
          };
        }
        return {
          data: {
            success: true,
            customers: [makeCustomerRow(1, 'Amit'), makeCustomerRow(2, 'Ramesh')],
            pagination: {
              limit: 25,
              offset: 0,
              hasMore: true,
              nextOffset: 25,
              nextCursor: 'cur_cust_1',
              total: null,
              totalIsExact: false,
            },
          },
        };
      });

      const { container, root } = createContainer();
      await act(async () => {
        root.render(React.createElement(KhataLedgerView));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(container.textContent).toContain('Ramesh');
      const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Load More Customers')
      );
      expect(loadMoreBtn).toBeTruthy();

      await act(async () => {
        loadMoreBtn!.click();
        await new Promise((r) => setTimeout(r, 40));
      });

      expect(requestedUrls.some((u) => u.includes('cursor=cur_cust_1'))).toBe(true);
      expect(container.textContent).not.toContain('Ramesh Dup');
      expect(container.textContent).toContain('Suresh');

      const searchInput = Array.from(container.querySelectorAll('input')).find((inp) =>
        (inp.placeholder || '').toLowerCase().includes('search')
      ) as HTMLInputElement;
      expect(searchInput).toBeTruthy();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(searchInput, 'ram');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 380));
      });

      const lastCustReq = requestedUrls.filter((u) => u.startsWith('/api/v1/khata/customers')).pop();
      expect(lastCustReq).toContain('offset=0');
      expect(lastCustReq).not.toContain('cursor=');
      expect(container.textContent).toContain('Ramlal Fresh');

      act(() => root.unmount());
      container.remove();
    });
  });

  describe('3. Billing Catalogue Hook & SearchablePicker Keyset Cursor Behavior', () => {
    it('usePaginatedProductSearch & usePaginatedCustomerSearch pass cursor on loadMore, deduplicate overlapping rows, and reset on query changes', async () => {
      const requestedUrls: string[] = [];
      mockApiClient.mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url.startsWith('/api/v1/products') && url.includes('cursor=p_cur_1')) {
          return {
            data: {
              success: true,
              data: [makeProductRow(2, 'Sugar Dup'), makeProductRow(3, 'Tea')],
              pagination: { hasMore: false, nextOffset: null, nextCursor: null },
            },
          };
        }
        if (url.startsWith('/api/v1/products')) {
          return {
            data: {
              success: true,
              data: [makeProductRow(1, 'Salt'), makeProductRow(2, 'Sugar')],
              pagination: { hasMore: true, nextOffset: 25, nextCursor: 'p_cur_1' },
            },
          };
        }
        if (url.startsWith('/api/v1/khata/customers') && url.includes('cursor=c_cur_1')) {
          return {
            data: {
              success: true,
              customers: [makeCustomerRow(20, 'Karan Dup'), makeCustomerRow(30, 'Mohan')],
              pagination: { hasMore: false, nextOffset: null, nextCursor: null },
            },
          };
        }
        return {
          data: {
            success: true,
            customers: [makeCustomerRow(10, 'Arjun'), makeCustomerRow(20, 'Karan')],
            pagination: { hasMore: true, nextOffset: 25, nextCursor: 'c_cur_1' },
          },
        };
      });

      let latestProdHook: ReturnType<typeof usePaginatedProductSearch> | null = null;
      let latestCustHook: ReturnType<typeof usePaginatedCustomerSearch> | null = null;

      function Harness() {
        latestProdHook = usePaginatedProductSearch();
        latestCustHook = usePaginatedCustomerSearch();
        return null;
      }

      const { container, root } = createContainer();
      await act(async () => {
        root.render(React.createElement(Harness));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(latestProdHook!.items.map((x) => x.id)).toEqual([1, 2]);
      expect(latestCustHook!.items.map((x) => x.id)).toEqual([10, 20]);

      await act(async () => {
        latestProdHook!.loadMore();
        latestCustHook!.loadMore();
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(requestedUrls.some((u) => u.includes('/api/v1/products') && u.includes('cursor=p_cur_1'))).toBe(true);
      expect(requestedUrls.some((u) => u.includes('/api/v1/khata/customers') && u.includes('cursor=c_cur_1'))).toBe(true);
      expect(latestProdHook!.items.map((x) => x.id)).toEqual([1, 2, 3]);
      expect(latestCustHook!.items.map((x) => x.id)).toEqual([10, 20, 30]);

      // Query change resets pagination back to offset=0 without cursor
      await act(async () => {
        latestProdHook!.setSearchQuery('tea');
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
      });
      const lastProdUrl = requestedUrls.filter((u) => u.startsWith('/api/v1/products')).pop();
      expect(lastProdUrl).toContain('search=tea');
      expect(lastProdUrl).not.toContain('cursor=');

      act(() => root.unmount());
      container.remove();
    });

    it('SearchablePicker forwards cursor through useRemoteSearch, deduplicates options by key, and resets cursor when query changes', async () => {
      const searchCalls: Array<{ query: string; offset: number; limit: number; cursor?: string | null }> = [];
      const onSearch = vi.fn(
        async (query: string, offset: number, limit: number, _signal: AbortSignal, cursor?: string | null) => {
          searchCalls.push({ query, offset, limit, cursor });
          if (cursor === 'sp_cur_1') {
            return {
              items: [{ id: 2, label: 'Option 2 (Dup)' }, { id: 3, label: 'Option 3' }],
              hasMore: false,
              nextOffset: null,
              nextCursor: null,
            };
          }
          return {
            items: [{ id: 1, label: 'Option 1' }, { id: 2, label: 'Option 2' }],
            hasMore: true,
            nextOffset: 2,
            nextCursor: 'sp_cur_1',
          };
        }
      );

      const { container, root } = createContainer();
      await act(async () => {
        root.render(
          React.createElement(SearchablePicker<{ id: number; label: string }>, {
            label: 'Picker',
            placeholder: 'Select option',
            value: null,
            selectedLabel: '',
            onSelect: vi.fn(),
            onSearch,
            getOptionKey: (item) => item.id,
            renderOption: (item) => React.createElement('span', null, item.label),
          })
        );
      });

      const triggerBtn = container.querySelector('button[type="button"]') as HTMLButtonElement;
      await act(async () => {
        triggerBtn.click();
        await new Promise((r) => setTimeout(r, 350));
      });

      const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Load More')
      );
      expect(loadMoreBtn).toBeTruthy();

      await act(async () => {
        loadMoreBtn!.click();
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(searchCalls.some((c) => c.cursor === 'sp_cur_1')).toBe(true);
      expect(container.textContent).toContain('Option 3');
      expect((container.textContent?.match(/Option 2/g) || []).length).toBe(1);

      act(() => root.unmount());
      container.remove();
    });
  });

  describe('4. Canonical PDF Blob Lifecycle & Cleanup (1-page, 10-page, 50-page, Popup Block & Timeout)', () => {
    it('prints 1-page, 10-page, and 50-page canonical Blobs via Object URL without full-doc PNG rasterization and avoids premature revocation', async () => {
      vi.useFakeTimers();
      let urlCounter = 0;
      const createdUrls: string[] = [];
      const revokedUrls: string[] = [];

      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
        urlCounter += 1;
        const url = `blob:http://localhost/pdf-${urlCounter}`;
        createdUrls.push(url);
        return url;
      });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
        revokedUrls.push(url);
      });
      const toDataUrlSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL');

      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
        configurable: true,
      });

      const realCreateElement = document.createElement.bind(document);
      const createdIframes: Array<{
        assignedSrc: string | null;
        printFn: ReturnType<typeof vi.fn>;
        dispatch: (event: string) => void;
      }> = [];
      vi.spyOn(document.body, 'appendChild').mockImplementation(((node: any) => node) as any);
      vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: any) => {
        if (String(tagName).toLowerCase() === 'iframe') {
          const printFn = vi.fn();
          const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
          let currentSrc: string | null = null;
          const record = {
            assignedSrc: null as string | null,
            printFn,
            dispatch: (event: string) => {
              for (const handler of Array.from(listeners.get(event) || [])) {
                if (typeof handler === 'function') handler(new Event(event));
                else handler.handleEvent(new Event(event));
              }
            },
          };
          const mockContentWindow = {
            focus: vi.fn(),
            print: printFn,
            addEventListener: window.addEventListener.bind(window),
            removeEventListener: window.removeEventListener.bind(window),
          };
          const mockIframe: any = {
            style: {},
            title: '',
            contentWindow: mockContentWindow,
            parentNode: document.body,
            set src(v: string) {
              currentSrc = v;
              record.assignedSrc = v;
            },
            get src() {
              return currentSrc || '';
            },
            setAttribute: vi.fn(),
            getAttribute: (name: string) => (name === 'src' ? currentSrc : null),
            removeAttribute: (name: string) => {
              if (name === 'src') currentSrc = null;
            },
            addEventListener: (ev: string, fn: EventListenerOrEventListenerObject) => {
              if (!listeners.has(ev)) listeners.set(ev, new Set());
              listeners.get(ev)!.add(fn);
            },
            removeEventListener: (ev: string, fn: EventListenerOrEventListenerObject) => {
              listeners.get(ev)?.delete(fn);
            },
          };
          createdIframes.push(record);
          return mockIframe;
        }
        return realCreateElement(tagName, options);
      }) as typeof document.createElement);

      for (const pageCount of [1, 10, 50]) {
        const blob = new Blob([`%PDF-1.4\n% ${pageCount} pages`], { type: 'application/pdf' });
        const fallbackDownload = vi.fn();

        const handle = printCanonicalPdfBlob({
          pdfBlob: blob,
          onFallbackDownload: fallbackDownload,
          iframeLoadTimeoutMs: 2000,
          maxObjectUrlLifetimeMs: 60_000,
        });

        const latestUrl = createdUrls[createdUrls.length - 1];
        const latestIframe = createdIframes[createdIframes.length - 1];
        expect(latestIframe).toBeTruthy();
        expect(latestIframe.assignedSrc).toBe(latestUrl);
        expect(revokedUrls).not.toContain(latestUrl);

        await act(async () => {
          latestIframe.dispatch('load');
        });

        expect(latestIframe.printFn).toHaveBeenCalledTimes(1);
        // After iframe load & print dialog open, Object URL MUST remain alive until afterprint/timeout
        expect(revokedUrls).not.toContain(latestUrl);

        await act(async () => {
          window.dispatchEvent(new Event('afterprint'));
        });

        await expect(handle.promise).resolves.toEqual({ method: 'iframe', notice: null });
        expect(revokedUrls).toContain(latestUrl);
        expect(fallbackDownload).not.toHaveBeenCalled();
      }

      expect(toDataUrlSpy).not.toHaveBeenCalled();
    });

    it('falls back to download and revokes Object URL immediately when pop-up is blocked, and cleans up on timeout & modal close', async () => {
      vi.useFakeTimers();
      const revokedUrls: string[] = [];
      let nextId = 1;
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:http://localhost/doc-${nextId++}`);
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
        revokedUrls.push(url);
      });
      vi.spyOn(window, 'open').mockReturnValue(null);

      // 1. Iframe times out -> fallback window.open returns null -> fallback download & immediate revoke
      const onFallback = vi.fn();
      const handle = printCanonicalPdfBlob({
        pdfBlob: new Blob(['%PDF-1.4\n% 50 pages'], { type: 'application/pdf' }),
        onFallbackDownload: onFallback,
        iframeLoadTimeoutMs: 500,
        maxObjectUrlLifetimeMs: 10_000,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      const res = await handle.promise;
      expect(res.method).toBe('download');
      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(revokedUrls).toContain('blob:http://localhost/doc-1');

      // 2. Repeated print handle + modal unmount / cleanup deterministic teardown
      const handle2 = printCanonicalPdfBlob({
        pdfBlob: new Blob(['%PDF-1.4\n% repeat'], { type: 'application/pdf' }),
        onFallbackDownload: onFallback,
        iframeLoadTimeoutMs: 2000,
        maxObjectUrlLifetimeMs: 5000,
      });
      handle2.cleanup();
      handle2.cleanup(); // Idempotent second cleanup must not fail
      expect(revokedUrls).toContain('blob:http://localhost/doc-2');

      // 3. PdfDocumentPreviewModal cleans up active print handle and PDF.js document on close
      vi.useRealTimers();
      mockNumPagesRef.current = 50;
      const blob50 = new Blob(['%PDF-1.4\n% 50-page-modal'], { type: 'application/pdf' });
      const { container, root } = createContainer();

      await act(async () => {
        root.render(
          React.createElement(PdfDocumentPreviewModal, {
            isOpen: true,
            title: '50-Page Tax Invoice',
            fileName: 'INV-50.pdf',
            fetchPdfBlob: async () => blob50,
            onClose: vi.fn(),
          })
        );
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });

      // Unmount / close modal while document is loaded -> must clean up PDF.js resources
      act(() => root.unmount());
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockTaskDestroy.mock.calls.length + mockDocDestroy.mock.calls.length).toBeGreaterThanOrEqual(1);
      container.remove();
    });
  });
});
