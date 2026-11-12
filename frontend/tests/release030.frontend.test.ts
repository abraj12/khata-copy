// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { mockApiClient } = vi.hoisted(() => ({
  mockApiClient: vi.fn(),
}));

vi.mock('../src/lib/apiClient.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/apiClient.js')>('../src/lib/apiClient.js');
  return {
    ...actual,
    apiClient: mockApiClient,
  };
});

import { useRemoteSearch, RemoteSearchResult } from '../src/hooks/useRemoteSearch.js';
import { SearchablePicker } from '../src/components/SearchablePicker.js';
import {
  usePaginatedCustomerSearch,
  usePaginatedProductSearch,
} from '../src/features/bills/useBillingCatalogueSearch.js';
import { ProductsView } from '../src/features/products/ProductsView.js';
import { KhataLedgerView } from '../src/features/khata/KhataLedgerView.js';

function createContainer(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setReactInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function makeProductRow(id: number, name = `Product ${id}`) {
  return {
    id,
    name,
    buying_price: '120.00',
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
    total_udhar: '500.00',
    total_paid: '100.00',
    outstanding_balance: '400.00',
    totalUdhar: '500.00',
    totalReceived: '100.00',
    outstanding: '400.00',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  };
}

describe('Release #030 Frontend Stale Request Cancellation, Picker Lifecycle & Pagination Concurrency Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1024,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('1. SearchablePicker Stale Request Races & Abort/RequestId Cancellation', () => {
    it('discards delayed response from request A when request B resolves earlier (A -> B -> late A, even ignoring AbortSignal)', async () => {
      vi.useFakeTimers();

      const deferreds = new Map<string, Deferred<RemoteSearchResult<{ id: number; label: string }>>>();
      const signals = new Map<string, AbortSignal>();

      const onSearch = vi.fn(
        (query: string, _offset: number, _limit: number, signal: AbortSignal) => {
          const d = createDeferred<RemoteSearchResult<{ id: number; label: string }>>();
          deferreds.set(query, d);
          signals.set(query, signal);
          return d.promise;
        }
      );

      const { container, root } = createContainer();
      await act(async () => {
        root.render(
          React.createElement(SearchablePicker<{ id: number; label: string }>, {
            label: 'Product',
            placeholder: 'Select product',
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
      });

      // Resolve initial '' open query cleanly
      await act(async () => {
        deferreds.get('')!.resolve({
          items: [{ id: 1, label: 'Initial Item' }],
          hasMore: false,
          nextOffset: null,
          nextCursor: null,
        });
      });

      const searchInput = container.querySelector('input[type="text"]') as HTMLInputElement;
      expect(searchInput).toBeTruthy();

      // 1. Type query A and advance debounce to dispatch request A
      await act(async () => {
        setReactInputValue(searchInput, 'sugar');
        vi.advanceTimersByTime(300);
      });
      expect(deferreds.has('sugar')).toBe(true);
      expect(signals.get('sugar')!.aborted).toBe(false);

      // 2. Type different query B -> immediately aborts A and invalidates requestId
      await act(async () => {
        setReactInputValue(searchInput, 'salt');
      });
      expect(signals.get('sugar')!.aborted).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(deferreds.has('salt')).toBe(true);

      // 3. Resolve B first
      await act(async () => {
        deferreds.get('salt')!.resolve({
          items: [{ id: 20, label: 'Rock Salt 1kg' }],
          hasMore: false,
          nextOffset: null,
          nextCursor: null,
        });
      });
      expect(container.textContent).toContain('Rock Salt 1kg');

      // 4. Delayed request A resolves AFTER B (ignoring signal.aborted)
      await act(async () => {
        deferreds.get('sugar')!.resolve({
          items: [{ id: 10, label: 'Stale Brown Sugar' }],
          hasMore: false,
          nextOffset: null,
          nextCursor: null,
        });
      });

      // Verify ONLY B is displayed
      expect(container.textContent).toContain('Rock Salt 1kg');
      expect(container.textContent).not.toContain('Stale Brown Sugar');

      act(() => root.unmount());
      container.remove();
    });

    it('reset() while loading aborts in-flight request, clears UI immediately, and blocks late completion', async () => {
      vi.useFakeTimers();

      const deferreds: Array<{
        query: string;
        signal: AbortSignal;
        deferred: Deferred<RemoteSearchResult<{ id: number; name: string }>>;
      }> = [];

      const fetcher = vi.fn(
        (query: string, _offset: number, _limit: number, signal: AbortSignal) => {
          const deferred = createDeferred<RemoteSearchResult<{ id: number; name: string }>>();
          deferreds.push({ query, signal, deferred });
          return deferred.promise;
        }
      );

      let hookState!: ReturnType<typeof useRemoteSearch<{ id: number; name: string }>>;
      function Harness() {
        hookState = useRemoteSearch({ fetcher, debounceMs: 250, enabled: true });
        return null;
      }

      const { container, root } = createContainer();
      await act(async () => {
        root.render(React.createElement(Harness));
      });

      // Resolve initial '' request
      await act(async () => {
        deferreds[0].deferred.resolve({
          items: [{ id: 1, name: 'Default Item' }],
          hasMore: false,
          nextOffset: null,
          nextCursor: null,
        });
      });

      // Dispatch 'tea' request and leave it in-flight
      await act(async () => {
        hookState.setQuery('tea');
        vi.advanceTimersByTime(260);
      });
      expect(hookState.isLoading).toBe(true);
      const teaCall = deferreds[deferreds.length - 1];
      expect(teaCall.query).toBe('tea');
      expect(teaCall.signal.aborted).toBe(false);

      // Reset while loading
      await act(async () => {
        hookState.reset();
      });

      expect(teaCall.signal.aborted).toBe(true);
      expect(hookState.query).toBe('');
      expect(hookState.items).toEqual([]);
      expect(hookState.isLoading).toBe(false);

      // Even if fake timers advance, reset() must NOT fire unsolicited fetch
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(deferreds).toHaveLength(2);

      // Delayed 'tea' resolves anyway -> ignored
      await act(async () => {
        teaCall.deferred.resolve({
          items: [{ id: 99, name: 'Stale Assam Tea' }],
          hasMore: true,
          nextOffset: 25,
          nextCursor: 'stale_cur',
        });
      });

      expect(hookState.items).toEqual([]);
      expect(hookState.hasMore).toBe(false);
      expect(hookState.nextCursor).toBeNull();

      act(() => root.unmount());
      container.remove();
    });

    it('closes picker while loading, reopens immediately, and prevents pre-close response from overwriting reopened state', async () => {
      vi.useFakeTimers();

      const requests: Array<{
        query: string;
        signal: AbortSignal;
        deferred: Deferred<RemoteSearchResult<{ id: number; label: string }>>;
      }> = [];

      const onSearch = vi.fn(
        (query: string, _offset: number, _limit: number, signal: AbortSignal) => {
          const deferred = createDeferred<RemoteSearchResult<{ id: number; label: string }>>();
          requests.push({ query, signal, deferred });
          return deferred.promise;
        }
      );

      const { container, root } = createContainer();
      await act(async () => {
        root.render(
          React.createElement(SearchablePicker<{ id: number; label: string }>, {
            label: 'Customer',
            placeholder: 'Pick customer',
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

      // Open picker #1 and search 'old'
      await act(async () => {
        triggerBtn.click();
      });
      await act(async () => {
        requests[0].deferred.resolve({ items: [], hasMore: false, nextOffset: null });
      });

      const input1 = container.querySelector('input[type="text"]') as HTMLInputElement;
      await act(async () => {
        setReactInputValue(input1, 'old');
        vi.advanceTimersByTime(300);
      });
      const oldReq = requests[requests.length - 1];
      expect(oldReq.query).toBe('old');

      // Close picker while 'old' is still loading
      await act(async () => {
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(oldReq.signal.aborted).toBe(true);

      // Reopen picker immediately (must fetch '' cleanly, NEVER stale 'old')
      await act(async () => {
        triggerBtn.click();
      });
      const reopenReq = requests[requests.length - 1];
      expect(reopenReq.query).toBe('');

      // Resolve reopened request first
      await act(async () => {
        reopenReq.deferred.resolve({
          items: [{ id: 501, label: 'Fresh Customer' }],
          hasMore: false,
          nextOffset: null,
        });
      });
      expect(container.textContent).toContain('Fresh Customer');

      // Late pre-close 'old' resolves AFTER reopen -> must be ignored
      await act(async () => {
        oldReq.deferred.resolve({
          items: [{ id: 502, label: 'Zombie Old Customer' }],
          hasMore: false,
          nextOffset: null,
        });
      });

      expect(container.textContent).toContain('Fresh Customer');
      expect(container.textContent).not.toContain('Zombie Old Customer');

      act(() => root.unmount());
      container.remove();
    });

    it('cancels and closes picker if disabled becomes true mid-flight and handles AbortError gracefully', async () => {
      vi.useFakeTimers();

      const requests: Array<{
        signal: AbortSignal;
        deferred: Deferred<RemoteSearchResult<{ id: number; label: string }>>;
      }> = [];

      const onSearch = vi.fn((_q: string, _o: number, _l: number, signal: AbortSignal) => {
        const deferred = createDeferred<RemoteSearchResult<{ id: number; label: string }>>();
        requests.push({ signal, deferred });
        return deferred.promise;
      });

      const { container, root } = createContainer();
      const renderPicker = (disabled: boolean) =>
        React.createElement(SearchablePicker<{ id: number; label: string }>, {
          label: 'Product',
          placeholder: 'Select product',
          value: null,
          selectedLabel: '',
          disabled,
          onSelect: vi.fn(),
          onSearch,
          getOptionKey: (item) => item.id,
          renderOption: (item) => React.createElement('span', null, item.label),
        });

      await act(async () => {
        root.render(renderPicker(false));
      });

      const triggerBtn = container.querySelector('button[type="button"]') as HTMLButtonElement;
      await act(async () => {
        triggerBtn.click();
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].signal.aborted).toBe(false);

      // Flip disabled=true while open & in-flight
      await act(async () => {
        root.render(renderPicker(true));
      });
      expect(requests[0].signal.aborted).toBe(true);
      expect(container.querySelector('[role="listbox"]')).toBeNull();

      // Reject with AbortError -> must remain closed with no error leakage
      await act(async () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        requests[0].deferred.reject(abortErr);
      });

      // Re-enable and open -> clean state
      await act(async () => {
        root.render(renderPicker(false));
      });
      await act(async () => {
        (container.querySelector('button[type="button"]') as HTMLButtonElement).click();
      });
      expect(container.textContent).not.toContain('Failed to fetch');

      act(() => root.unmount());
      container.remove();
    });

    it('handles 5 rapid queries, abort during load-more, synchronous double-click lock, and duplicate page boundaries', async () => {
      vi.useFakeTimers();

      const calls: Array<{
        query: string;
        cursor: string | null | undefined;
        signal: AbortSignal;
        deferred: Deferred<RemoteSearchResult<{ id: number; name: string }>>;
      }> = [];

      const fetcher = vi.fn(
        (query: string, _offset: number, _limit: number, signal: AbortSignal, cursor?: string | null) => {
          const deferred = createDeferred<RemoteSearchResult<{ id: number; name: string }>>();
          calls.push({ query, cursor, signal, deferred });
          return deferred.promise;
        }
      );

      let hookState!: ReturnType<typeof useRemoteSearch<{ id: number; name: string }>>;
      function Harness() {
        hookState = useRemoteSearch({
          fetcher,
          debounceMs: 280,
          enabled: true,
          getItemKey: (item) => item.id,
        });
        return null;
      }

      const { container, root } = createContainer();
      await act(async () => {
        root.render(React.createElement(Harness));
      });

      // Initial '' page 1 resolves with cursor
      await act(async () => {
        calls[0].deferred.resolve({
          items: [{ id: 1, name: 'Item 1' }, { id: 2, name: 'Item 2' }],
          hasMore: true,
          nextOffset: 2,
          nextCursor: 'cur_page_2',
        });
      });

      // Double-click loadMore in same synchronous tick -> must only issue ONE request!
      await act(async () => {
        hookState.loadMore();
        hookState.loadMore();
      });
      expect(calls).toHaveLength(2);
      const loadMoreCall = calls[1];
      expect(loadMoreCall.cursor).toBe('cur_page_2');

      // Rapidly type 5 different queries before page 2 resolves
      await act(async () => {
        hookState.setQuery('q1');
        hookState.setQuery('q2');
        hookState.setQuery('q3');
        hookState.setQuery('q4');
        hookState.setQuery('q5');
      });
      expect(loadMoreCall.signal.aborted).toBe(true);
      expect(hookState.hasMore).toBe(false);
      expect(hookState.nextCursor).toBeNull();

      // Advance debounce once -> dispatches only 'q5'
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(calls).toHaveLength(3);
      expect(calls[2].query).toBe('q5');

      // Late loadMore resolution from pre-search query must be ignored
      await act(async () => {
        loadMoreCall.deferred.resolve({
          items: [{ id: 3, name: 'Stale Page 2' }],
          hasMore: false,
          nextOffset: null,
        });
      });

      // Now resolve q5 page 1 and page 2 with duplicate boundary ID=50
      await act(async () => {
        calls[2].deferred.resolve({
          items: [{ id: 50, name: 'Q5 First' }],
          hasMore: true,
          nextOffset: 1,
          nextCursor: 'cur_q5_2',
        });
      });
      await act(async () => {
        hookState.loadMore();
      });
      expect(calls[3].cursor).toBe('cur_q5_2');
      await act(async () => {
        calls[3].deferred.resolve({
          items: [{ id: 50, name: 'Q5 Boundary Dup' }, { id: 51, name: 'Q5 Second' }],
          hasMore: false,
          nextOffset: null,
          nextCursor: null,
        });
      });

      expect(hookState.items).toEqual([
        { id: 50, name: 'Q5 First' },
        { id: 51, name: 'Q5 Second' },
      ]);

      // Quick query change & revert before debounce expires must not stall loading forever
      await act(async () => {
        hookState.setQuery('temp');
        vi.advanceTimersByTime(50);
        hookState.setQuery('q5');
        vi.advanceTimersByTime(300);
      });
      expect(calls.length).toBeGreaterThanOrEqual(5);
      expect(calls[calls.length - 1].query).toBe('q5');

      act(() => root.unmount());
      container.remove();
    });
  });

  describe('2. ProductsView, KhataLedgerView & Billing Hook Cursor Safety and Concurrency', () => {
    it('useBillingCatalogueSearch enforces synchronous loadMore lock and never reuses stale cursor on query change', async () => {
      vi.useFakeTimers();

      const seenUrls: string[] = [];
      let pendingNextCursorResolve: ((val: any) => void) | null = null;

      mockApiClient.mockImplementation(async (url: string) => {
        seenUrls.push(url);
        if (url.includes('search=beta')) {
          return new Promise((res) => {
            pendingNextCursorResolve = res;
          });
        }
        if (url.includes('cursor=cur_p1')) {
          return {
            data: {
              success: true,
              data: [makeProductRow(2, 'Alpha 2'), makeProductRow(3, 'Alpha 3')],
              pagination: { hasMore: false, nextOffset: null, nextCursor: null },
            },
          };
        }
        return {
          data: {
            success: true,
            data: [makeProductRow(1, 'Alpha 1'), makeProductRow(2, 'Alpha 2')],
            pagination: { hasMore: true, nextOffset: 25, nextCursor: 'cur_p1' },
          },
        };
      });

      let prodHook!: ReturnType<typeof usePaginatedProductSearch>;
      let custHook!: ReturnType<typeof usePaginatedCustomerSearch>;
      function Harness() {
        prodHook = usePaginatedProductSearch();
        custHook = usePaginatedCustomerSearch();
        return null;
      }

      const { container, root } = createContainer();
      await act(async () => {
        root.render(React.createElement(Harness));
        await Promise.resolve();
      });

      // Double-click loadMore on products & customers -> only 1 extra request each
      await act(async () => {
        prodHook.loadMore();
        prodHook.loadMore();
        custHook.loadMore();
        custHook.loadMore();
        await Promise.resolve();
      });

      const prodCursorCalls = seenUrls.filter(
        (u) => u.startsWith('/api/v1/products') && u.includes('cursor=cur_p1')
      );
      expect(prodCursorCalls).toHaveLength(1);
      expect(prodHook.items.map((x) => x.id)).toEqual([1, 2, 3]);

      // Start another search with cursor, then switch query to 'beta' -> loadMore during transition must be blocked
      await act(async () => {
        prodHook.refresh();
        await Promise.resolve();
      });
      expect(prodHook.nextCursor).toBe('cur_p1');

      await act(async () => {
        prodHook.setSearchQuery('beta');
        // Attempt loadMore immediately during debounce -> must NOT send cur_p1 with 'beta' or previous query
        prodHook.loadMore();
      });
      expect(prodHook.nextCursor).toBeNull();
      expect(seenUrls.some((u) => u.includes('beta') && u.includes('cursor='))).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(320);
        await Promise.resolve();
      });

      await act(async () => {
        pendingNextCursorResolve?.({
          data: {
            success: true,
            data: [makeProductRow(99, 'Beta Result')],
            pagination: { hasMore: false, nextOffset: null, nextCursor: null },
          },
        });
      });

      expect(prodHook.items.map((x) => x.id)).toEqual([99]);

      act(() => root.unmount());
      container.remove();
    });

    it('ProductsView and KhataLedgerView ignore old query cursors immediately when search changes and deduplicate load-more clicks', async () => {
      const requestedUrls: string[] = [];
      let slowSearchResolve: ((val: any) => void) | null = null;

      mockApiClient.mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url.startsWith('/api/v1/khata/summary')) {
          return {
            data: {
              success: true,
              summary: {
                total_customers: 2,
                total_udhar_amount: '500.00',
                total_received_amount: '100.00',
                total_outstanding_balance: '400.00',
              },
            },
          };
        }
        if (url.includes('search=newterm')) {
          return new Promise((res) => {
            slowSearchResolve = res;
          });
        }
        if (url.startsWith('/api/v1/products')) {
          return {
            data: {
              success: true,
              data: [makeProductRow(1, 'Initial Product')],
              pagination: { limit: 25, offset: 0, hasMore: true, nextOffset: 25, nextCursor: 'old_prod_cur' },
            },
          };
        }
        return {
          data: {
            success: true,
            customers: [makeCustomerRow(1, 'Initial Customer')],
            pagination: { limit: 25, offset: 0, hasMore: true, nextOffset: 25, nextCursor: 'old_cust_cur' },
          },
        };
      });

      // 1. ProductsView
      const pView = createContainer();
      await act(async () => {
        pView.root.render(React.createElement(ProductsView));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      const pInput = pView.container.querySelector('input[type="text"]') as HTMLInputElement;
      // Change search input: Load More button + stale cursor must immediately disappear before debounce fires
      await act(async () => {
        setReactInputValue(pInput, 'newterm');
      });
      const pLoadMoreWhileTyping = Array.from(pView.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Load More Products')
      );
      expect(pLoadMoreWhileTyping).toBeUndefined();

      await act(async () => {
        await new Promise((r) => setTimeout(r, 320));
      });
      await act(async () => {
        slowSearchResolve?.({
          data: {
            success: true,
            data: [makeProductRow(55, 'Newterm Product')],
            pagination: { limit: 25, offset: 0, hasMore: false, nextOffset: null, nextCursor: null },
          },
        });
      });
      expect(requestedUrls.some((u) => u.includes('search=newterm') && u.includes('cursor='))).toBe(false);
      expect(pView.container.textContent).toContain('Newterm Product');
      act(() => pView.root.unmount());
      pView.container.remove();

      // 2. KhataLedgerView
      slowSearchResolve = null;
      const kView = createContainer();
      await act(async () => {
        kView.root.render(React.createElement(KhataLedgerView));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      const kInput = Array.from(kView.container.querySelectorAll('input')).find((inp) =>
        (inp.placeholder || '').toLowerCase().includes('search')
      ) as HTMLInputElement;
      await act(async () => {
        setReactInputValue(kInput, 'newterm');
      });
      const kLoadMoreWhileTyping = Array.from(kView.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Load More Customers')
      );
      expect(kLoadMoreWhileTyping).toBeUndefined();

      await act(async () => {
        await new Promise((r) => setTimeout(r, 320));
      });
      await act(async () => {
        slowSearchResolve?.({
          data: {
            success: true,
            customers: [makeCustomerRow(77, 'Newterm Customer')],
            pagination: { limit: 25, offset: 0, hasMore: false, nextOffset: null, nextCursor: null },
          },
        });
      });
      expect(
        requestedUrls.some((u) => u.includes('/api/v1/khata/customers') && u.includes('search=newterm') && u.includes('cursor='))
      ).toBe(false);
      expect(kView.container.textContent).toContain('Newterm Customer');
      act(() => kView.root.unmount());
      kView.container.remove();
    });
  });
});
