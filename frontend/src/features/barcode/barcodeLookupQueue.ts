export interface FifoBarcodeQueueOptions<TProduct> {
  lookup: (barcode: string) => Promise<TProduct | null>;
  onResolved: (barcode: string, product: TProduct) => void;
  onUnknown: (barcode: string) => void;
  onError: (barcode: string, error: unknown) => void;
  onBusyChange?: (busy: boolean, remainingInQueue: number) => void;
}

export interface FifoBarcodeQueue {
  enqueue: (rawBarcode: string) => Promise<void>;
  getPendingCount: () => number;
  isBusy: () => boolean;
  dispose: () => void;
}

/**
 * Serializes rapid hardware/manual/camera barcode lookups in strict FIFO order.
 * Prevents concurrent out-of-order API resolutions or dropped scans during bursts.
 */
export function createFifoBarcodeQueue<TProduct>(
  options: FifoBarcodeQueueOptions<TProduct>
): FifoBarcodeQueue {
  const queue: string[] = [];
  let processing = false;
  let disposed = false;
  let activePromise: Promise<void> | null = null;

  const notifyBusy = () => {
    if (!disposed) {
      options.onBusyChange?.(processing, queue.length);
    }
  };

  const drainQueue = async () => {
    if (processing || disposed) return;
    processing = true;
    notifyBusy();

    try {
      while (!disposed && queue.length > 0) {
        const code = queue.shift()!;
        notifyBusy();

        try {
          const product = await options.lookup(code);
          if (disposed) break;
          if (product) {
            options.onResolved(code, product);
          } else {
            options.onUnknown(code);
          }
        } catch (err) {
          if (disposed) break;
          options.onError(code, err);
        }
      }
    } finally {
      processing = false;
      activePromise = null;
      notifyBusy();
    }
  };

  return {
    enqueue(rawBarcode: string): Promise<void> {
      const code = rawBarcode.trim();
      if (!code || disposed) {
        return activePromise ?? Promise.resolve();
      }
      queue.push(code);
      notifyBusy();

      if (!processing) {
        activePromise = drainQueue();
      }
      return activePromise ?? Promise.resolve();
    },

    getPendingCount(): number {
      return queue.length;
    },

    isBusy(): boolean {
      return processing;
    },

    dispose(): void {
      disposed = true;
      queue.length = 0;
    },
  };
}
