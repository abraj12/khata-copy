import { useEffect, useRef } from 'react';

export interface UseHardwareBarcodeScannerOptions {
  onScan: (barcode: string) => void;
  enabled?: boolean;
  maxKeystrokeIntervalMs?: number;
  minBarcodeLength?: number;
}

/**
 * Custom hook to detect USB / Bluetooth HID barcode scanners that behave as keyboards.
 *
 * Characteristics:
 * - Extremely rapid keystrokes (< 50ms interval between characters).
 * - Terminated by 'Enter'.
 * - Bypasses standard form fields so ordinary typing is never captured or interrupted.
 */
export function useHardwareBarcodeScanner({
  onScan,
  enabled = true,
  maxKeystrokeIntervalMs = 60,
  minBarcodeLength = 3,
}: UseHardwareBarcodeScannerOptions) {
  const bufferRef = useRef<string>('');
  const lastKeyTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Do not capture while the user is actively typing in an editable field
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const now = Date.now();
      const timeSinceLastKey = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      if (e.key === 'Enter') {
        const barcode = bufferRef.current.trim();
        bufferRef.current = '';

        if (barcode.length >= minBarcodeLength) {
          e.preventDefault();
          onScan(barcode);
        }
        return;
      }

      // Only accumulate single printable characters
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (timeSinceLastKey > maxKeystrokeIntervalMs && bufferRef.current.length > 0) {
          // Interval exceeded: reset buffer to start a fresh sequence
          bufferRef.current = '';
        }
        bufferRef.current += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, onScan, maxKeystrokeIntervalMs, minBarcodeLength]);
}
