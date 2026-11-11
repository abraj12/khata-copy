import type { ProductBarcodeRecord } from './barcodeApi.js';

export interface CameraBarcodePresenceLock {
  onFrameDetection: (rawCode: string, nowMs?: number) => boolean;
  onFrameNoBarcode: (nowMs?: number) => boolean;
  reset: () => void;
  getLockedCode: () => string | null;
}

/**
 * Presence/absence lock for continuous camera barcode scanning.
 *
 * Behavior:
 * - First detection of barcode A accepts once and locks A while visible in camera frames.
 * - Any consecutive frames showing A return false (even across arbitrarily long durations).
 * - Immediately switching to a different barcode B unlocks A and accepts B once.
 * - Re-scanning the same barcode A is only unlocked after `rearmAbsenceMs` of genuine no-barcode frames
 *   (any frame containing A resets the absence clock).
 */
export function createCameraBarcodePresenceLock(
  rearmAbsenceMs = 750
): CameraBarcodePresenceLock {
  let lockedCode: string | null = null;
  let absentSinceMs: number | null = null;

  return {
    onFrameDetection(rawCode: string, _nowMs: number = Date.now()): boolean {
      const code = rawCode.trim();
      if (!code) return false;

      absentSinceMs = null;
      if (lockedCode === code) {
        return false;
      }

      lockedCode = code;
      return true;
    },

    onFrameNoBarcode(nowMs: number = Date.now()): boolean {
      if (lockedCode === null) {
        absentSinceMs = null;
        return false;
      }
      if (absentSinceMs === null) {
        absentSinceMs = nowMs;
        return false;
      }
      if (nowMs - absentSinceMs >= rearmAbsenceMs) {
        lockedCode = null;
        absentSinceMs = null;
        return true;
      }
      return false;
    },

    reset(): void {
      lockedCode = null;
      absentSinceMs = null;
    },

    getLockedCode(): string | null {
      return lockedCode;
    },
  };
}

export async function resolveContinuousBarcodeLookup(options: {
  code: string;
  continuousScan: boolean;
  lookupProduct: (code: string) => Promise<ProductBarcodeRecord | null>;
  onFound: (product: ProductBarcodeRecord) => void;
  onStopCamera: () => void;
  onClose: () => void;
  onUnknown: (code: string) => void;
  onContinuousFeedback: (product: ProductBarcodeRecord, code: string) => void;
  vibrate?: () => void;
}): Promise<'found' | 'unknown'> {
  const product = await options.lookupProduct(options.code);
  if (product) {
    options.vibrate?.();
    if (options.continuousScan) {
      options.onContinuousFeedback(product, options.code);
      options.onFound(product);
    } else {
      options.onStopCamera();
      options.onFound(product);
      options.onClose();
    }
    return 'found';
  }

  options.onUnknown(options.code);
  return 'unknown';
}
