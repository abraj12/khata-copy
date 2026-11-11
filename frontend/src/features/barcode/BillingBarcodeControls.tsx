import React, { useCallback, useEffect, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import {
  AlertCircle,
  Barcode,
  CheckCircle2,
  Loader2,
  PlusCircle,
  Scan,
  X,
} from 'lucide-react';
import { apiClient } from '../../lib/apiClient.js';
import { BarcodeScannerModal } from './BarcodeScannerModal.js';
import { fetchProductByBarcode, ProductBarcodeRecord } from './barcodeApi.js';
import { createFifoBarcodeQueue, FifoBarcodeQueue } from './barcodeLookupQueue.js';
import { useHardwareBarcodeScanner } from './useHardwareBarcodeScanner.js';
import { ProductCatalogReference } from '../../utils/lineItemDraft.js';

export interface BillingBarcodeControlsProps {
  onProductResolved: (product: ProductCatalogReference) => {
    action: 'incremented' | 'filled_empty' | 'added';
    error?: string | null;
  };
  onCatalogProductCreated?: (product: ProductBarcodeRecord) => void;
  enableGlobalScanner?: boolean;
  compact?: boolean;
}

function validateNonNegative2DpPrice(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Buying price is required.';
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(trimmed)) {
    return 'Buying price must be a non-negative amount with at most 2 decimal places.';
  }
  const d = new Decimal(trimmed);
  if (!d.isFinite() || d.isNegative()) {
    return 'Buying price must be 0 or greater.';
  }
  return null;
}

export const BillingBarcodeControls: React.FC<BillingBarcodeControlsProps> = ({
  onProductResolved,
  onCatalogProductCreated,
  enableGlobalScanner = true,
  compact = false,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [barcodeInput, setBarcodeInput] = useState('');
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [isCameraOpen, setIsCameraOpen] = useState(false);

  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [unknownBarcode, setUnknownBarcode] = useState<string | null>(null);
  const batchHadUnknownRef = useRef(false);
  const fifoQueueRef = useRef<FifoBarcodeQueue | null>(null);

  // Explicit confirmation-gated quick product creation modal state
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBuyingPrice, setNewBuyingPrice] = useState('');
  const [newHsn, setNewHsn] = useState('');
  const [newBarcode, setNewBarcode] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreatingProduct, setIsCreatingProduct] = useState(false);

  const applyResolvedProduct = useCallback(
    (product: ProductBarcodeRecord, options?: { preserveBurstUnknown?: boolean }) => {
      if (!options?.preserveBurstUnknown || !batchHadUnknownRef.current) {
        setUnknownBarcode(null);
      }
      const outcome = onProductResolved(product);
      if (outcome.error) {
        setStatusMessage({ type: 'error', text: outcome.error });
        return;
      }
      const actionLabel =
        outcome.action === 'incremented' ? 'Quantity incremented (+1)' : 'Added item';
      setStatusMessage({
        type: 'success',
        text: `${actionLabel}: ${product.name}`,
      });
    },
    [onProductResolved]
  );

  const applyResolvedProductRef = useRef(applyResolvedProduct);
  applyResolvedProductRef.current = applyResolvedProduct;

  const getBarcodeQueue = useCallback((): FifoBarcodeQueue => {
    if (!fifoQueueRef.current) {
      fifoQueueRef.current = createFifoBarcodeQueue<ProductBarcodeRecord>({
        lookup: fetchProductByBarcode,
        onResolved: (_barcode, product) => {
          applyResolvedProductRef.current(product, { preserveBurstUnknown: true });
        },
        onUnknown: (code) => {
          batchHadUnknownRef.current = true;
          setUnknownBarcode(code);
        },
        onError: (_barcode, err: any) => {
          setStatusMessage({
            type: 'error',
            text: err?.message || 'Error looking up product barcode.',
          });
        },
        onBusyChange: (busy, remainingInQueue) => {
          setIsLookingUp(busy);
          setQueuedCount(remainingInQueue);
          if (!busy && remainingInQueue === 0) {
            batchHadUnknownRef.current = false;
          }
        },
      });
    }
    return fifoQueueRef.current;
  }, []);

  useEffect(() => {
    return () => {
      fifoQueueRef.current?.dispose();
      fifoQueueRef.current = null;
    };
  }, []);

  const lookupAndApplyBarcode = useCallback(
    (rawCode: string): Promise<void> => {
      const code = rawCode.trim();
      if (!code) return Promise.resolve();

      // Clear input immediately so rapid hardware scanner bursts never concatenate
      setBarcodeInput('');
      const queue = getBarcodeQueue();
      if (!queue.isBusy()) {
        batchHadUnknownRef.current = false;
        setStatusMessage(null);
        setUnknownBarcode(null);
      }

      return queue.enqueue(code);
    },
    [getBarcodeQueue]
  );

  useHardwareBarcodeScanner({
    enabled: enableGlobalScanner && !isCameraOpen && !quickCreateOpen,
    onScan: (scannedCode) => {
      // If user is scanning directly into the dedicated input field, its Enter handler processes it cleanly
      if (typeof document !== 'undefined' && document.activeElement === inputRef.current) {
        return;
      }
      void lookupAndApplyBarcode(scannedCode);
    },
  });

  const handleBarcodeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (barcodeInput.trim()) {
        void lookupAndApplyBarcode(barcodeInput);
      }
    }
  };

  const openQuickCreateModal = useCallback((barcode: string) => {
    setNewBarcode(barcode.trim());
    setNewName('');
    setNewBuyingPrice('');
    setNewHsn('');
    setCreateError(null);
    setQuickCreateOpen(true);
  }, []);

  const handleConfirmQuickCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      setCreateError('Product name is required.');
      return;
    }
    const priceErr = validateNonNegative2DpPrice(newBuyingPrice);
    if (priceErr) {
      setCreateError(priceErr);
      return;
    }

    setCreateError(null);
    setIsCreatingProduct(true);
    try {
      const formattedPrice = new Decimal(newBuyingPrice.trim()).toFixed(2);
      const res = await apiClient<{ success: boolean; data: ProductBarcodeRecord }>(
        '/api/v1/products',
        {
          method: 'POST',
          body: JSON.stringify({
            name: newName.trim(),
            buying_price: formattedPrice,
            hsn_code: newHsn.trim() || null,
            barcode: newBarcode.trim() || null,
          }),
        }
      );

      const created = res.data?.data;
      if (created) {
        onCatalogProductCreated?.(created);
        applyResolvedProduct(created);
      }
      setQuickCreateOpen(false);
      setUnknownBarcode(null);
    } catch (err: any) {
      setCreateError(err?.message || 'Failed to create product.');
    } finally {
      setIsCreatingProduct(false);
    }
  };

  return (
    <div className={compact ? 'space-y-2' : 'space-y-2.5'}>
      {/* USB/Bluetooth/Manual Barcode Entry + Camera Scanner Trigger */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[210px]">
          <Barcode className="w-4 h-4 text-[var(--khata-accent)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={barcodeInput}
            onChange={(e) => setBarcodeInput(e.target.value)}
            onKeyDown={handleBarcodeKeyDown}
            placeholder="Scan USB/Bluetooth barcode or type & press Enter..."
            maxLength={64}
            aria-label="Scan or enter product barcode"
            className="neu-input w-full pl-9 pr-3 py-1.5 text-xs font-mono font-semibold"
          />
        </div>

        <button
          type="button"
          disabled={!barcodeInput.trim()}
          onClick={() => lookupAndApplyBarcode(barcodeInput)}
          className="neu-btn-secondary text-xs px-3 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-50 w-full sm:w-auto justify-center"
        >
          {isLookingUp ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
          ) : (
            <Barcode className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
          )}
          <span>{queuedCount > 0 ? `Lookup (${queuedCount} queued)` : 'Lookup Barcode'}</span>
        </button>

        <button
          type="button"
          onClick={() => setIsCameraOpen(true)}
          className="neu-btn-secondary text-xs px-3 py-1.5 font-bold inline-flex items-center gap-1.5 w-full sm:w-auto justify-center"
        >
          <Scan className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
          <span>Camera Scan</span>
        </button>
      </div>

      {/* Inline Success / Lookup Error Status */}
      {statusMessage && (
        <div
          className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-semibold ${
            statusMessage.type === 'success'
              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
              : 'bg-rose-500/10 border border-rose-500/30 text-rose-700 dark:text-rose-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{statusMessage.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            className="p-0.5 rounded hover:bg-black/10"
            aria-label="Dismiss barcode notice"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Unknown Barcode Prompt (Confirmation-gated Create Product) */}
      {unknownBarcode && (
        <div className="p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300 flex flex-wrap items-center justify-between gap-2.5 text-xs">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="font-bold">Unknown Barcode: Product not found for this barcode.</p>
              <p className="font-mono text-[11px] font-bold mt-0.5">{unknownBarcode}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openQuickCreateModal(unknownBarcode)}
              className="px-3 py-1.5 rounded-lg bg-[var(--khata-accent)] text-white font-bold inline-flex items-center gap-1.5 hover:opacity-90 transition"
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>Create Product</span>
            </button>
            <button
              type="button"
              onClick={() => setUnknownBarcode(null)}
              className="px-2.5 py-1.5 rounded-lg border border-amber-500/30 font-semibold hover:bg-black/5 transition"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Camera Scanner Modal */}
      <BarcodeScannerModal
        isOpen={isCameraOpen}
        onClose={() => setIsCameraOpen(false)}
        title="Scan Product Barcode"
        continuousScan={true}
        onProductFound={(product) => applyResolvedProduct(product)}
        onCreateWithBarcode={(code) => {
          setIsCameraOpen(false);
          openQuickCreateModal(code);
        }}
      />

      {/* Explicit Confirmation Quick-Create Product Modal */}
      {quickCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="neu-card w-full max-w-md rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-3">
              <div className="flex items-center gap-2">
                <PlusCircle className="w-5 h-5 text-[var(--khata-accent)]" />
                <h3 className="text-base font-extrabold text-[var(--khata-text)]">
                  Create Product from Barcode
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setQuickCreateOpen(false)}
                className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {createError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs font-semibold">
                {createError}
              </div>
            )}

            <form onSubmit={handleConfirmQuickCreate} className="space-y-3">
              <div>
                <label className="block text-xs font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                  Barcode
                </label>
                <input
                  type="text"
                  value={newBarcode}
                  onChange={(e) => setNewBarcode(e.target.value)}
                  maxLength={64}
                  className="neu-input w-full text-xs font-mono font-bold"
                  placeholder="Optional barcode"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                  Product Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={255}
                  className="neu-input w-full text-sm font-semibold"
                  placeholder="e.g. Copper Pipe 1 inch"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Buying Price (₹) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    value={newBuyingPrice}
                    onChange={(e) => setNewBuyingPrice(e.target.value)}
                    className="neu-input w-full text-sm font-mono font-semibold"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    HSN Code
                  </label>
                  <input
                    type="text"
                    value={newHsn}
                    onChange={(e) => setNewHsn(e.target.value)}
                    maxLength={20}
                    className="neu-input w-full text-sm font-mono"
                    placeholder="Optional"
                  />
                </div>
              </div>

              <p className="text-[11px] text-[var(--khata-text-muted)] bg-[var(--khata-surface-inset)]/50 p-2.5 rounded-lg">
                Buying price is saved in your Product Master reference only and will not auto-fill the customer selling rate on this bill.
              </p>

              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setQuickCreateOpen(false)}
                  className="neu-btn-secondary px-4 py-2 text-xs font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreatingProduct}
                  className="neu-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isCreatingProduct ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <PlusCircle className="w-3.5 h-3.5" />
                  )}
                  <span>Save &amp; Add to Bill</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
