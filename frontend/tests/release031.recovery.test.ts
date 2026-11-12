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

import { useRemoteSearch } from '../src/hooks/useRemoteSearch.js';
import { SearchablePicker } from '../src/components/SearchablePicker.js';

function createContainer(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

describe('Khata Release #031 — Frontend Service Recovery & 503 Gating Suite', () => {
  let activeContainers: { container: HTMLDivElement; root: Root }[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    mockApiClient.mockReset();
    activeContainers = [];
  });

  afterEach(() => {
    for (const { container, root } of activeContainers) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    activeContainers = [];
  });

  describe('1. useRemoteSearch captures 503 MANDATORY_SERVICE_UNAVAILABLE & READ_MODEL_UNAVAILABLE', () => {
    it('sets isServiceUnavailable = true on 503 MANDATORY_SERVICE_UNAVAILABLE error', async () => {
      let hookState: any = null;

      function TestComponent() {
        hookState = useRemoteSearch({
          fetcher: async () => {
            const err = new Error('Mandatory service unavailable') as any;
            err.statusCode = 503;
            err.code = 'MANDATORY_SERVICE_UNAVAILABLE';
            throw err;
          },
          debounceMs: 10,
        });
        return React.createElement('div', null, hookState.isServiceUnavailable ? 'UNAVAILABLE' : 'OK');
      }

      const { container, root } = createContainer();
      activeContainers.push({ container, root });

      await act(async () => {
        root.render(React.createElement(TestComponent));
      });

      // useRemoteSearch immediately fetches on mount and captures 503
      expect(hookState.isServiceUnavailable).toBe(true);
      expect(hookState.errorMessage).toContain('Search service is temporarily unavailable');
      expect(container.textContent).toBe('UNAVAILABLE');
    });

    it('sets isServiceUnavailable = true on 503 READ_MODEL_UNAVAILABLE error', async () => {
      let hookState: any = null;

      function TestComponent() {
        hookState = useRemoteSearch({
          fetcher: async () => {
            const err = new Error('Read models unavailable') as any;
            err.statusCode = 503;
            err.code = 'READ_MODEL_UNAVAILABLE';
            throw err;
          },
          debounceMs: 10,
        });
        return React.createElement('div', null, hookState.isServiceUnavailable ? 'UNAVAILABLE' : 'OK');
      }

      const { container, root } = createContainer();
      activeContainers.push({ container, root });

      await act(async () => {
        root.render(React.createElement(TestComponent));
      });

      expect(hookState.isServiceUnavailable).toBe(true);
      expect(container.textContent).toBe('UNAVAILABLE');
    });

    it('clears isServiceUnavailable when retry successfully resolves', async () => {
      let hookState: any = null;
      let shouldFail = true;

      function TestComponent() {
        hookState = useRemoteSearch({
          fetcher: async () => {
            if (shouldFail) {
              const err = new Error('Service down') as any;
              err.statusCode = 503;
              err.code = 'MANDATORY_SERVICE_UNAVAILABLE';
              throw err;
            }
            return {
              items: [{ id: 1, name: 'Recovered Cement' }],
              nextCursor: null,
            };
          },
          debounceMs: 10,
        });
        return React.createElement('div', null, hookState.isServiceUnavailable ? 'UNAVAILABLE' : 'OK');
      }

      const { container, root } = createContainer();
      activeContainers.push({ container, root });

      await act(async () => {
        root.render(React.createElement(TestComponent));
      });

      expect(hookState.isServiceUnavailable).toBe(true);
      expect(container.textContent).toBe('UNAVAILABLE');

      // Now recover service
      shouldFail = false;

      await act(async () => {
        hookState.retry();
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(hookState.isServiceUnavailable).toBe(false);
      expect(hookState.items).toEqual([{ id: 1, name: 'Recovered Cement' }]);
      expect(container.textContent).toBe('OK');
    });
  });

  describe('2. SearchablePicker Outage UI & Controlled Retry', () => {
    it('displays outage banner and controlled Retry Connection button when 503 occurs and opens', async () => {
      let searchCalls = 0;

      function PickerWrapper() {
        return React.createElement(SearchablePicker, {
          mode: 'product',
          value: '',
          selectedOption: null,
          placeholder: 'Select a product...',
          searchPlaceholder: 'Search product catalogue...',
          pageSize: 25,
          getOptionKey: (item: any) => item.id,
          getOptionLabel: (item: any) => item.name,
          onSelect: () => {},
          onSearch: async () => {
            searchCalls++;
            const err = new Error('Database reconnection in progress') as any;
            err.statusCode = 503;
            err.code = 'MANDATORY_SERVICE_UNAVAILABLE';
            throw err;
          },
        });
      }

      const { container, root } = createContainer();
      activeContainers.push({ container, root });

      await act(async () => {
        root.render(React.createElement(PickerWrapper));
      });

      // Click to open picker dropdown
      const triggerButton = container.querySelector('button');
      expect(triggerButton).toBeDefined();

      await act(async () => {
        triggerButton?.click();
        await new Promise((r) => setTimeout(r, 350));
      });

      // Banner should be visible with specific outage text
      expect(container.textContent).toContain('MongoDB read service is currently unavailable');

      // Find 'Retry Connection' button
      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Retry Connection')
      );
      expect(retryBtn).toBeDefined();

      // Click retry
      const initialCalls = searchCalls;
      await act(async () => {
        retryBtn?.click();
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(searchCalls).toBeGreaterThan(initialCalls);
    });
  });
});
