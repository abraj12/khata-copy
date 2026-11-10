// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useHardwareBarcodeScanner } from '../src/features/barcode/useHardwareBarcodeScanner.js';

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
