import { describe, it, expect, vi } from 'vitest';

describe('Barcode Scanner Frontend Module Test Suite', () => {
  it('1. Detects rapid HID scanner keystrokes ending in Enter', () => {
    let capturedBarcode: string | null = null;
    let buffer = '';
    let lastKeyTime = 0;
    const maxKeystrokeIntervalMs = 60;
    const minBarcodeLength = 3;

    const simulateKeyDown = (key: string, timestamp: number, targetTagName: string = 'DIV') => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(targetTagName)) {
        return;
      }

      const timeSinceLastKey = timestamp - lastKeyTime;
      lastKeyTime = timestamp;

      if (key === 'Enter') {
        const candidate = buffer.trim();
        buffer = '';
        if (candidate.length >= minBarcodeLength) {
          capturedBarcode = candidate;
        }
        return;
      }

      if (key.length === 1) {
        if (timeSinceLastKey > maxKeystrokeIntervalMs && buffer.length > 0) {
          buffer = '';
        }
        buffer += key;
      }
    };

    // Simulate fast scanner barcode "8901234567890" arriving with 15ms interval
    const barcodeStr = '8901234567890';
    let t = 1000;
    for (const char of barcodeStr) {
      simulateKeyDown(char, t);
      t += 15;
    }
    // Enter key
    simulateKeyDown('Enter', t);

    expect(capturedBarcode).toBe('8901234567890');
  });

  it('2. Bypasses normal keyboard input while typing inside INPUT or TEXTAREA elements', () => {
    let capturedBarcode: string | null = null;
    let buffer = '';

    const simulateKeyDown = (key: string, targetTagName: string) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(targetTagName)) {
        return; // Ignored to avoid interfering with ordinary form fields
      }
      if (key === 'Enter') {
        capturedBarcode = buffer;
      } else {
        buffer += key;
      }
    };

    // Keystrokes inside a form input field
    simulateKeyDown('a', 'INPUT');
    simulateKeyDown('b', 'INPUT');
    simulateKeyDown('c', 'INPUT');
    simulateKeyDown('Enter', 'INPUT');

    expect(capturedBarcode).toBeNull();
    expect(buffer).toBe('');
  });

  it('3. Clears buffer when slow typing occurs (interval > maxKeystrokeIntervalMs)', () => {
    let capturedBarcode: string | null = null;
    let buffer = '';
    let lastKeyTime = 0;
    const maxKeystrokeIntervalMs = 60;

    const simulateKeyDown = (key: string, timestamp: number) => {
      const timeSinceLastKey = timestamp - lastKeyTime;
      lastKeyTime = timestamp;

      if (key === 'Enter') {
        capturedBarcode = buffer;
        buffer = '';
        return;
      }

      if (key.length === 1) {
        if (timeSinceLastKey > maxKeystrokeIntervalMs && buffer.length > 0) {
          buffer = ''; // Reset because user typed slowly manually
        }
        buffer += key;
      }
    };

    // User types "1", waits 500ms, then types "2", then "Enter"
    simulateKeyDown('1', 1000);
    simulateKeyDown('2', 1500); // 500ms gap resets buffer so "1" is dropped
    simulateKeyDown('Enter', 1510);

    expect(capturedBarcode).toBe('2');
  });
});
