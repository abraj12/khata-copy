// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useHardwareBarcodeScanner } from '../src/features/barcode/useHardwareBarcodeScanner.js';
import { createFifoBarcodeQueue } from '../src/features/barcode/barcodeLookupQueue.js';
import { BillingBarcodeControls } from '../src/features/barcode/BillingBarcodeControls.js';
import {
  createCameraBarcodePresenceLock,
  resolveContinuousBarcodeLookup,
} from '../src/features/barcode/barcodePresenceLock.js';
import { upsertScannedProductLine, DraftLineBase, ProductCatalogReference } from '../src/utils/lineItemDraft.js';
import * as barcodeApi from '../src/features/barcode/barcodeApi.js';

vi.mock('../src/features/barcode/barcodeApi.js', () => ({
  fetchProductByBarcode: vi.fn(),
  updateProductBarcode: vi.fn(),
}));

describe('useHardwareBarcodeScanner Hook & Integration Test Suite', () => {
  let container: HTMLDivElement | null = null;
  let root: any = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    root = null;
  });

  const mountScanner = (props: {
    onScan: (barcode: string) => void;
    enabled?: boolean;
    maxKeystrokeIntervalMs?: number;
    minBarcodeLength?: number;
  }) => {
    const Component = () => {
      useHardwareBarcodeScanner(props);
      return React.createElement('div', { 'data-testid': 'scanner-host' }, 'Scanner Active');
    };
    act(() => {
      root.render(React.createElement(Component));
    });
  };

  it('1. Detects rapid HID scanner keystrokes ending in Enter and triggers onScan', () => {
    const onScan = vi.fn();
    mountScanner({ onScan });

    const barcode = '8901234567890';
    let baseTime = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => baseTime);

    for (const char of barcode) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: char,
          bubbles: true,
        })
      );
      baseTime += 15; // 15ms intervals (< 60ms)
    }

    // Terminate with Enter key
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
      })
    );

    expect(onScan).toHaveBeenCalledWith('8901234567890');
    vi.restoreAllMocks();
  });

  it('2. Bypasses keystrokes when typing inside INPUT or TEXTAREA elements', () => {
    const onScan = vi.fn();
    mountScanner({ onScan });

    const input = document.createElement('input');
    document.body.appendChild(input);

    const barcode = '8901234567890';
    let baseTime = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => baseTime);

    for (const char of barcode) {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: char,
          bubbles: true,
        })
      );
      baseTime += 15;
    }

    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
      })
    );

    expect(onScan).not.toHaveBeenCalled();
    input.remove();
    vi.restoreAllMocks();
  });

  it('3. Clears buffer when keystroke interval exceeds maxKeystrokeIntervalMs', () => {
    const onScan = vi.fn();
    mountScanner({ onScan, maxKeystrokeIntervalMs: 60 });

    let baseTime = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => baseTime);

    // Type '1'
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));

    // User pauses for 300ms (> 60ms)
    baseTime += 300;

    // Type '2', '3'
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    baseTime += 10;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
    baseTime += 10;

    // Press Enter -> candidate buffer has only '23' which is < 3 characters (minBarcodeLength)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onScan).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('4. Ignores keystrokes when enabled=false', () => {
    const onScan = vi.fn();
    mountScanner({ onScan, enabled: false });

    for (const char of '12345') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onScan).not.toHaveBeenCalled();
  });

  it('5. Ignores short barcodes under minBarcodeLength', () => {
    const onScan = vi.fn();
    mountScanner({ onScan, minBarcodeLength: 5 });

    let baseTime = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => baseTime);

    // Type 4 characters (< 5)
    for (const char of '1234') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      baseTime += 10;
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onScan).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

interface MockLine extends DraftLineBase {
  localId: string;
}

const makeBlankMockLine = (): MockLine => ({
  localId: 'blank-' + Math.random().toString(36).slice(2, 7),
  productId: null,
  description: '',
  hsnCode: '',
  barcode: '',
  quantity: '1',
  rate: '',
  buyingPriceReference: null,
});

function createDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FIFO Barcode Queue, Synchronous State Commit & BillingBarcodeControls Burst Tests', () => {
  let container: HTMLDivElement | null = null;
  let root: any = null;

  beforeEach(() => {
    vi.mocked(barcodeApi.fetchProductByBarcode).mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    root = null;
    vi.restoreAllMocks();
  });

  it('6. Strictly serializes rapid scans in FIFO order even when slower first lookup resolves after faster second lookup', async () => {
    const deferredA = createDeferred<any>();
    const deferredB = createDeferred<any>();
    const resolvedOrder: string[] = [];
    const busyStates: Array<{ busy: boolean; remaining: number }> = [];

    const queue = createFifoBarcodeQueue({
      lookup: async (code) => {
        if (code === 'CODE-A') return deferredA.promise;
        if (code === 'CODE-B') return deferredB.promise;
        return null;
      },
      onResolved: (code) => {
        resolvedOrder.push(code);
      },
      onUnknown: vi.fn(),
      onError: vi.fn(),
      onBusyChange: (busy, remaining) => {
        busyStates.push({ busy, remaining });
      },
    });

    const pA = queue.enqueue('CODE-A');
    const pB = queue.enqueue('CODE-B');
    // CODE-A immediately starts in-flight while CODE-B waits in queue
    expect(queue.getPendingCount()).toBe(1);
    expect(queue.isBusy()).toBe(true);

    // Resolve CODE-B first even though CODE-A was scanned first
    deferredB.resolve({ id: 2, name: 'Second Product', buying_price: '20.00' });
    await Promise.resolve();
    await Promise.resolve();

    // Must still wait for CODE-A to complete before applying CODE-B
    expect(resolvedOrder).toEqual([]);

    deferredA.resolve({ id: 1, name: 'First Product', buying_price: '10.00' });
    await Promise.all([pA, pB]);

    expect(resolvedOrder).toEqual(['CODE-A', 'CODE-B']);
    expect(queue.isBusy()).toBe(false);
    expect(queue.getPendingCount()).toBe(0);
    expect(busyStates[busyStates.length - 1]).toEqual({ busy: false, remaining: 0 });
  });

  it('7. Routes unknown and known scans in the same rapid burst without dropping unknown callback', async () => {
    const unknownCodes: string[] = [];
    const resolvedNames: string[] = [];

    const queue = createFifoBarcodeQueue({
      lookup: async (code) => {
        if (code === 'UNKNOWN-1') return null;
        return { id: 9, name: 'Copper Wire 1.5mm', buying_price: '88.00' };
      },
      onResolved: (_code, prod: any) => resolvedNames.push(prod.name),
      onUnknown: (code) => unknownCodes.push(code),
      onError: vi.fn(),
    });

    await Promise.all([queue.enqueue('UNKNOWN-1'), queue.enqueue('KNOWN-2')]);

    expect(unknownCodes).toEqual(['UNKNOWN-1']);
    expect(resolvedNames).toEqual(['Copper Wire 1.5mm']);
  });

  it('8. Synchronous itemsRef + commitItems updater prevents stale closure data loss across 3 rapid consecutive scans', () => {
    const itemsRef = { current: [makeBlankMockLine()] };
    let renderedItems = itemsRef.current;

    const commitItems = (updater: (prev: MockLine[]) => MockLine[]) => {
      const next = updater(itemsRef.current);
      itemsRef.current = next;
      renderedItems = next;
      return next;
    };

    const prod1: ProductCatalogReference = {
      id: 101,
      name: 'LED Bulb 9W',
      buying_price: '45.00',
      hsn_code: '8539',
      barcode: '890000101',
    };
    const prod2: ProductCatalogReference = {
      id: 102,
      name: 'MCB Switch 16A',
      buying_price: '110.00',
      hsn_code: '8536',
      barcode: '890000102',
    };

    // Three scans finish in the same JS turn before any React re-render occurs
    commitItems((prev) => upsertScannedProductLine(prev, prod1, makeBlankMockLine).nextLines);
    commitItems((prev) => upsertScannedProductLine(prev, prod2, makeBlankMockLine).nextLines);
    commitItems((prev) => upsertScannedProductLine(prev, prod1, makeBlankMockLine).nextLines);

    expect(renderedItems).toHaveLength(2);
    expect(renderedItems[0]).toMatchObject({
      productId: 101,
      quantity: '2',
      rate: '',
      buyingPriceReference: '45.00',
    });
    expect(renderedItems[1]).toMatchObject({
      productId: 102,
      quantity: '1',
      rate: '',
      buyingPriceReference: '110.00',
    });
  });

  it('9. BillingBarcodeControls preserves Unknown Barcode banner during [unknown, known] burst and stops cleanly on unmount', async () => {
    const d1 = createDeferred<any>();
    const d2 = createDeferred<any>();
    vi.mocked(barcodeApi.fetchProductByBarcode)
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const resolvedProducts: ProductCatalogReference[] = [];
    const linesRef = { current: [makeBlankMockLine()] };

    const handleResolved = (product: ProductCatalogReference) => {
      resolvedProducts.push(product);
      const outcome = upsertScannedProductLine(linesRef.current, product, makeBlankMockLine);
      linesRef.current = outcome.nextLines;
      return { action: outcome.action, error: outcome.error };
    };

    act(() => {
      root.render(
        React.createElement(BillingBarcodeControls, {
          onProductResolved: handleResolved,
          enableGlobalScanner: true,
        })
      );
    });

    // Simulate two rapid hardware scanner scans: UNK-999 then OK-200
    const sendScan = (code: string) => {
      let now = 2000000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      for (const ch of code) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        now += 10;
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      nowSpy.mockRestore();
    };

    act(() => {
      sendScan('UNK-999');
      sendScan('OK-200');
    });

    // Queue indicator should reflect queued count without locking controls
    expect(barcodeApi.fetchProductByBarcode).toHaveBeenCalledTimes(1);
    expect(barcodeApi.fetchProductByBarcode).toHaveBeenCalledWith('UNK-999');

    // First scan finishes as unknown (null), second scan resolves to a known product
    await act(async () => {
      d1.resolve(null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(barcodeApi.fetchProductByBarcode).toHaveBeenCalledTimes(2);
    expect(barcodeApi.fetchProductByBarcode).toHaveBeenNthCalledWith(2, 'OK-200');

    await act(async () => {
      d2.resolve({
        id: 77,
        name: 'PVC Tape Roll',
        buying_price: '12.50',
        hsn_code: '3919',
        barcode: 'OK-200',
        created_at: '2026-04-01T00:00:00.000Z',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Both outcomes must be preserved: OK-200 added AND UNK-999 banner visible
    expect(resolvedProducts).toHaveLength(1);
    expect(resolvedProducts[0].name).toBe('PVC Tape Roll');
    expect(container?.textContent).toContain('Unknown Barcode');
    expect(container?.textContent).toContain('UNK-999');

    // Also test dispose on unmount with an in-flight lookup
    const d3 = createDeferred<any>();
    vi.mocked(barcodeApi.fetchProductByBarcode).mockImplementationOnce(() => d3.promise);
    act(() => {
      sendScan('LATE-300');
    });
    act(() => {
      root.unmount();
    });
    root = null;
    await act(async () => {
      d3.resolve({
        id: 78,
        name: 'Late Product',
        buying_price: '5.00',
        created_at: '2026-04-01T00:00:00.000Z',
      });
      await Promise.resolve();
    });
    expect(resolvedProducts).toHaveLength(1);
  });

  it('8. Supermarket camera presence lock blocks stationary duplicate frames, switches immediately to a new barcode, and re-arms after genuine absence', () => {
    const lock = createCameraBarcodePresenceLock(750);

    // Barcode A enters frame -> accepted once
    expect(lock.onFrameDetection('ITEM-A', 1000)).toBe(true);
    expect(lock.getLockedCode()).toBe('ITEM-A');

    // Remains locked across many frames & beyond 750ms while ITEM-A stays in view
    expect(lock.onFrameDetection('ITEM-A', 1200)).toBe(false);
    expect(lock.onFrameDetection('ITEM-A', 2500)).toBe(false);
    expect(lock.onFrameDetection('ITEM-A', 5000)).toBe(false);

    // Single brief blurry miss (400ms < 750ms) resets absence clock once ITEM-A reappears
    expect(lock.onFrameNoBarcode(5100)).toBe(false);
    expect(lock.onFrameNoBarcode(5500)).toBe(false);
    expect(lock.onFrameDetection('ITEM-A', 5550)).toBe(false);

    // Switch straight to different barcode B without waiting for absence -> immediate accept
    expect(lock.onFrameDetection('ITEM-B', 5600)).toBe(true);
    expect(lock.getLockedCode()).toBe('ITEM-B');
    expect(lock.onFrameDetection('ITEM-B', 5700)).toBe(false);

    // Remove item from camera view for >= 750ms -> re-arms so ITEM-B can be intentionally rescanned
    expect(lock.onFrameNoBarcode(6000)).toBe(false);
    expect(lock.onFrameNoBarcode(6500)).toBe(false);
    expect(lock.onFrameNoBarcode(6750)).toBe(true);
    expect(lock.getLockedCode()).toBeNull();
    expect(lock.onFrameDetection('ITEM-B', 6800)).toBe(true);
  });

  it('9. Keeps modal open and triggers continuous feedback when continuousScan=true while preserving single-scan close behavior when false', async () => {
    const mockProduct = {
      id: 91,
      name: 'LED Tube 20W',
      buying_price: '120.00',
      hsn_code: '9405',
      barcode: 'LED-20W',
      created_at: '2026-04-01T00:00:00.000Z',
    };

    const onFoundContinuous = vi.fn();
    const onStopContinuous = vi.fn();
    const onCloseContinuous = vi.fn();
    const onFeedbackContinuous = vi.fn();
    const onUnknownContinuous = vi.fn();

    const continuousOutcome = await resolveContinuousBarcodeLookup({
      code: 'LED-20W',
      continuousScan: true,
      lookupProduct: async () => mockProduct,
      onFound: onFoundContinuous,
      onStopCamera: onStopContinuous,
      onClose: onCloseContinuous,
      onUnknown: onUnknownContinuous,
      onContinuousFeedback: onFeedbackContinuous,
    });

    expect(continuousOutcome).toBe('found');
    expect(onFoundContinuous).toHaveBeenCalledWith(mockProduct);
    expect(onFeedbackContinuous).toHaveBeenCalledWith(mockProduct, 'LED-20W');
    expect(onStopContinuous).not.toHaveBeenCalled();
    expect(onCloseContinuous).not.toHaveBeenCalled();

    const onFoundSingle = vi.fn();
    const onStopSingle = vi.fn();
    const onCloseSingle = vi.fn();
    const onFeedbackSingle = vi.fn();

    const singleOutcome = await resolveContinuousBarcodeLookup({
      code: 'LED-20W',
      continuousScan: false,
      lookupProduct: async () => mockProduct,
      onFound: onFoundSingle,
      onStopCamera: onStopSingle,
      onClose: onCloseSingle,
      onUnknown: vi.fn(),
      onContinuousFeedback: onFeedbackSingle,
    });

    expect(singleOutcome).toBe('found');
    expect(onStopSingle).toHaveBeenCalledTimes(1);
    expect(onFoundSingle).toHaveBeenCalledWith(mockProduct);
    expect(onCloseSingle).toHaveBeenCalledTimes(1);
    expect(onFeedbackSingle).not.toHaveBeenCalled();
  });

  it('10. Handles continuous FIFO 4-item scan sequence into billing lines without losing items or overwriting rates', async () => {
    const products: Record<string, any> = {
      'SKU-1': {
        id: 101,
        name: 'MCB 16A',
        buying_price: '85.00',
        hsn_code: '8536',
        barcode: 'SKU-1',
        created_at: '2026-04-01T00:00:00.000Z',
      },
      'SKU-2': {
        id: 102,
        name: 'Modular Switch',
        buying_price: '24.00',
        hsn_code: '8536',
        barcode: 'SKU-2',
        created_at: '2026-04-01T00:00:00.000Z',
      },
    };

    vi.mocked(barcodeApi.fetchProductByBarcode).mockImplementation(async (code) => {
      return products[code] || null;
    });

    let items: Array<DraftLineBase & { localId: string }> = [
      {
        localId: 'seed',
        productId: null,
        description: '',
        hsnCode: '',
        barcode: '',
        quantity: '1',
        rate: '',
        buyingPriceReference: null,
      },
    ];
    const itemsRef = { current: items };
    const onScannedProducts: string[] = [];

    const containerEl = document.createElement('div');
    document.body.appendChild(containerEl);
    const r = createRoot(containerEl);

    act(() => {
      r.render(
        React.createElement(BillingBarcodeControls, {
          enableGlobalScanner: true,
          onProductResolved: (product) => {
            onScannedProducts.push(product.name);
            const result = upsertScannedProductLine(itemsRef.current, product, () => ({
              localId: `line-${Math.random()}`,
              productId: null,
              description: '',
              hsnCode: '',
              barcode: '',
              quantity: '1',
              rate: '',
              buyingPriceReference: null,
            }));
            if (!result.error) {
              items = result.nextLines;
              itemsRef.current = result.nextLines;
            }
            return { action: result.action, error: result.error };
          },
        })
      );
    });

    // Simulate rapid supermarket scan sequence: SKU-1 -> SKU-2 -> SKU-1 (qty 2) -> SKU-2 (qty 2)
    let nowMs = 500000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      for (const code of ['SKU-1', 'SKU-2', 'SKU-1', 'SKU-2']) {
        await act(async () => {
          // Trigger fast HID bursts (< 25ms keystrokes) so continuous BillingBarcodeControls FIFO queue processes all 4
          for (const ch of code) {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
            nowMs += 10;
          }
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          nowMs += 200;
          await new Promise((resolve) => setTimeout(resolve, 15));
        });
      }
    } finally {
      dateSpy.mockRestore();
    }

    expect(items).toHaveLength(2);
    expect(items[0].description).toBe('MCB 16A');
    expect(items[0].quantity).toBe('2');
    expect(items[0].rate).toBe(''); // buying_price never copied into selling rate
    expect(items[0].buyingPriceReference).toBe('85.00');
    expect(items[1].description).toBe('Modular Switch');
    expect(items[1].quantity).toBe('2');
    expect(items[1].rate).toBe('');
    expect(items[1].buyingPriceReference).toBe('24.00');
    expect(onScannedProducts).toEqual([
      'MCB 16A',
      'Modular Switch',
      'MCB 16A',
      'Modular Switch',
    ]);

    act(() => {
      r.unmount();
    });
    containerEl.remove();
  });

  it('allows up to 20 distinct scanned products, blocks the 21st distinct item cleanly, increments existing product at 20 rows, and never copies buying_price into rate', async () => {
    const initial20 = Array.from({ length: 20 }, (_, idx) => ({
      id: `row-${idx + 1}`,
      productId: String(idx + 1),
      description: `Existing Product ${idx + 1}`,
      hsnCode: '4411',
      quantity: '1',
      rate: '',
      buyingPriceReference: '100.00',
    }));

    // 1. Direct helper test: 20th distinct item succeeds on 19-row bill
    const nineteenRows = initial20.slice(0, 19);
    const prod20: ProductCatalogReference = {
      id: 20,
      name: 'Distinct Product 20',
      buying_price: '250.00',
      hsn_code: '4411',
    };
    const res20 = upsertScannedProductLine(nineteenRows, prod20, () => 'row-20', {
      maxItems: 20,
      maxItemsErrorMessage: 'A bill can contain a maximum of 20 items.',
    });
    expect(res20.error).toBeNull();
    expect(res20.nextLines).toHaveLength(20);
    expect(res20.nextLines[19].rate).toBe('');
    expect(res20.nextLines[19].buyingPriceReference).toBe('250.00');

    // 2. Direct helper test: 21st distinct item blocked while preserving all 20 rows
    const prod21: ProductCatalogReference = {
      id: 21,
      name: 'Distinct Product 21',
      buying_price: '300.00',
      hsn_code: '4411',
    };
    const res21 = upsertScannedProductLine(res20.nextLines, prod21, () => 'row-21', {
      maxItems: 20,
      maxItemsErrorMessage: 'A bill can contain a maximum of 20 items.',
    });
    expect(res21.error).toBe('A bill can contain a maximum of 20 items.');
    expect(res21.nextLines).toHaveLength(20);

    // 3. Direct helper test: rescanning existing product #5 while at 20 rows still increments qty (+1)
    const existing5: ProductCatalogReference = {
      id: 5,
      name: 'Existing Product 5',
      buying_price: '100.00',
      hsn_code: '4411',
    };
    const resInc = upsertScannedProductLine(res20.nextLines, existing5, () => 'unused', {
      maxItems: 20,
      maxItemsErrorMessage: 'A bill can contain a maximum of 20 items.',
    });
    expect(resInc.error).toBeNull();
    expect(resInc.nextLines).toHaveLength(20);
    expect(resInc.nextLines[4].quantity).toBe('2');
    expect(resInc.nextLines[4].rate).toBe('');

    // 4. Component-level BillingBarcodeControls callback test with 20 existing rows
    const product21FromApi = { id: 21, name: 'Product 21', buying_price: '450.00', hsn_code: '4411', barcode: 'BAR-021' };
    const product5FromApi = { id: 5, name: 'Existing Product 5', buying_price: '100.00', hsn_code: '4411', barcode: 'BAR-005' };
    (barcodeApi.fetchProductByBarcode as any).mockImplementation(async (code: string) => {
      if (code === 'BAR-021') return product21FromApi;
      if (code === 'BAR-005') return product5FromApi;
      throw new Error('Unexpected barcode');
    });

    let currentItems = [...initial20];
    const containerEl = document.createElement('div');
    document.body.appendChild(containerEl);
    const r = createRoot(containerEl);

    const handleResolve = (product: any) => {
      const outcome = upsertScannedProductLine(currentItems, product, () => 'extra-row', {
        maxItems: 20,
        maxItemsErrorMessage: 'A bill can contain a maximum of 20 items.',
      });
      if (outcome.error) {
        return { action: outcome.action, error: outcome.error };
      }
      currentItems = outcome.nextLines;
      return { action: outcome.action, error: null };
    };

    await act(async () => {
      r.render(React.createElement(BillingBarcodeControls, { onProductResolved: handleResolve }));
    });

    const inputEl = containerEl.querySelector<HTMLInputElement>('input[placeholder*="barcode" i]')!;
    const submitBarcode = async (code: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(inputEl, code);
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await act(async () => {
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
    };

    // Scanning 21st distinct product fails cleanly without mutating 20 rows
    await submitBarcode('BAR-021');
    expect(currentItems).toHaveLength(20);
    expect(containerEl.textContent).toContain('A bill can contain a maximum of 20 items.');

    // Scanning existing BAR-005 succeeds even at 20 rows and increments quantity without copying buying_price
    await submitBarcode('BAR-005');
    expect(currentItems).toHaveLength(20);
    expect(currentItems[4].quantity).toBe('2');
    expect(currentItems[4].rate).toBe('');

    act(() => {
      r.unmount();
    });
    containerEl.remove();
  });
});
