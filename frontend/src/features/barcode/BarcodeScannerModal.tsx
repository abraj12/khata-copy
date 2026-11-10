import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Camera,
  Keyboard,
  Flashlight,
  FlashlightOff,
  RefreshCw,
  AlertCircle,
  Plus,
  Link as LinkIcon,
  CheckCircle,
  Loader2,
  Scan,
} from 'lucide-react';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { fetchProductByBarcode, updateProductBarcode, ProductBarcodeRecord } from './barcodeApi.js';
import { apiClient } from '../../lib/apiClient.js';

export interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProductFound?: (product: ProductBarcodeRecord) => void;
  onCreateWithBarcode?: (barcode: string) => void;
  title?: string;
}

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  isOpen,
  onClose,
  onProductFound,
  onCreateWithBarcode,
  title = 'Scan Barcode',
}) => {
  const [activeTab, setActiveTab] = useState<'camera' | 'manual'>('camera');
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [isLookingUp, setIsLookingUp] = useState(false);

  // Unknown barcode resolution state
  const [unknownBarcode, setUnknownBarcode] = useState<string | null>(null);
  const [linkSearch, setLinkSearch] = useState('');
  const [linkProducts, setLinkProducts] = useState<ProductBarcodeRecord[]>([]);
  const [isSearchingLink, setIsSearchingLink] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const [linkSuccess, setLinkSuccess] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const activeTrackRef = useRef<MediaStreamTrack | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const lastScanTimeRef = useRef<number>(0);
  const isCooldownRef = useRef(false);

  // Cleanup helper that halts all hardware camera streams safely
  const stopCamera = useCallback(() => {
    try {
      if (controlsRef.current) {
        controlsRef.current.stop();
        controlsRef.current = null;
      }
      if (activeTrackRef.current) {
        if (isTorchOn) {
          try {
            (activeTrackRef.current as any).applyConstraints?.({ advanced: [{ torch: false }] });
          } catch {
            // Ignore failure on unmount
          }
        }
        activeTrackRef.current.stop();
        activeTrackRef.current = null;
      }
      if (videoRef.current && videoRef.current.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((track) => track.stop());
        videoRef.current.srcObject = null;
      }
    } catch (e) {
      console.warn('[BARCODE SCANNER] Cleanup warning:', e);
    }
    setIsTorchOn(false);
    setHasTorch(false);
    setCameraLoading(false);
  }, [isTorchOn]);

  const handleBarcodeIdentified = useCallback(
    async (rawCode: string) => {
      const code = rawCode.trim();
      if (!code) return;

      const now = Date.now();
      if (isCooldownRef.current || now - lastScanTimeRef.current < 1600) {
        return;
      }
      lastScanTimeRef.current = now;
      isCooldownRef.current = true;

      // Haptic feedback if available on mobile
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate(60);
        } catch {
          // Non-fatal
        }
      }

      setIsLookingUp(true);
      setCameraError(null);
      setUnknownBarcode(null);

      try {
        const product = await fetchProductByBarcode(code);
        if (product) {
          stopCamera();
          if (onProductFound) {
            onProductFound(product);
          }
          onClose();
        } else {
          // Barcode unknown in this shop's database
          setUnknownBarcode(code);
        }
      } catch (err: any) {
        setCameraError(err?.message || 'Error communicating with product catalog.');
      } finally {
        setIsLookingUp(false);
        setTimeout(() => {
          isCooldownRef.current = false;
        }, 1200);
      }
    },
    [onProductFound, onClose, stopCamera]
  );

  // Initialize camera scanner only when open and camera tab is active
  useEffect(() => {
    if (!isOpen || activeTab !== 'camera' || unknownBarcode) {
      stopCamera();
      return;
    }

    let isSubscribed = true;
    setCameraLoading(true);
    setCameraError(null);

    const initScanner = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Camera access is not supported by your browser.');
        }

        if (!readerRef.current) {
          readerRef.current = new BrowserMultiFormatReader();
        }

        // Wait a tick for the video element ref to mount
        await new Promise((r) => setTimeout(r, 50));
        if (!isSubscribed || !videoRef.current) return;

        // Request rear camera with flexible fallback
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!isSubscribed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
          activeTrackRef.current = videoTrack;
          const capabilities = (videoTrack as any).getCapabilities?.();
          if (capabilities && 'torch' in capabilities) {
            setHasTorch(true);
          }
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        // Start scanning frames
        const controls = await readerRef.current.decodeFromVideoElement(
          videoRef.current,
          (result, _err) => {
            if (!isSubscribed) return;
            if (result) {
              const text = result.getText();
              if (text) {
                handleBarcodeIdentified(text);
              }
            }
          }
        );

        if (isSubscribed) {
          controlsRef.current = controls;
          setCameraLoading(false);
        } else {
          controls.stop();
          stream.getTracks().forEach((t) => t.stop());
        }
      } catch (err: any) {
        if (!isSubscribed) return;
        console.error('[BARCODE SCANNER] Camera initialization failure:', err);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setCameraError('Camera permission was denied. Please allow camera permissions in your browser or enter the barcode manually.');
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          setCameraError('No camera found on this device. Please enter the barcode manually.');
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          setCameraError('Camera is already in use by another application. Please close other camera apps and retry.');
        } else {
          setCameraError(err.message || 'Unable to access camera.');
        }
        setCameraLoading(false);
      }
    };

    initScanner();

    return () => {
      isSubscribed = false;
      stopCamera();
    };
  }, [isOpen, activeTab, unknownBarcode, handleBarcodeIdentified, stopCamera]);

  // Handle torch toggle
  const toggleTorch = async () => {
    if (!activeTrackRef.current || !hasTorch) return;
    try {
      const nextState = !isTorchOn;
      await (activeTrackRef.current as any).applyConstraints?.({
        advanced: [{ torch: nextState }],
      });
      setIsTorchOn(nextState);
    } catch (e) {
      console.warn('[BARCODE SCANNER] Torch toggle error:', e);
    }
  };

  // Search products to attach unknown barcode to
  useEffect(() => {
    if (!unknownBarcode || !linkSearch.trim()) {
      setLinkProducts([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearchingLink(true);
      try {
        const res = await apiClient<{ success: boolean; data: ProductBarcodeRecord[] }>(
          `/api/v1/products?search=${encodeURIComponent(linkSearch.trim())}&limit=5`,
          { method: 'GET' }
        );
        setLinkProducts(res.data?.data || []);
      } catch {
        setLinkProducts([]);
      } finally {
        setIsSearchingLink(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [unknownBarcode, linkSearch]);

  const handleAttachBarcodeToProduct = async (product: ProductBarcodeRecord) => {
    if (!unknownBarcode) return;
    setIsLinking(true);
    setLinkError(null);
    try {
      const updated = await updateProductBarcode(product.id, unknownBarcode);
      setLinkSuccess(`Successfully attached barcode to "${updated.name}"!`);
      setTimeout(() => {
        if (onProductFound) {
          onProductFound(updated);
        }
        onClose();
      }, 1000);
    } catch (err: any) {
      setLinkError(err?.message || 'Failed to attach barcode to product.');
    } finally {
      setIsLinking(false);
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualInput.trim()) {
      handleBarcodeIdentified(manualInput.trim());
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scanner-modal-title"
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-[var(--khata-border)] shadow-2xl flex flex-col overflow-hidden max-h-[92vh]"
        style={{ background: 'var(--khata-surface)', color: 'var(--khata-text)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 border-b border-[var(--khata-border)]">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shadow-inner"
              style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-accent)' }}
            >
              <Scan className="w-4 h-4" />
            </div>
            <div>
              <h2 id="scanner-modal-title" className="text-sm sm:text-base font-bold">
                {title}
              </h2>
              <p className="text-[11px] text-[var(--khata-text-muted)]">
                Scan or enter a product barcode
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] hover:bg-[var(--khata-surface-inset)] transition"
            aria-label="Close scanner modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Selector */}
        {!unknownBarcode && (
          <div className="flex border-b border-[var(--khata-border)] px-4 pt-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setActiveTab('camera');
                setCameraError(null);
              }}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-t-lg transition border-b-2 ${
                activeTab === 'camera'
                  ? 'border-[var(--khata-accent)] text-[var(--khata-accent)]'
                  : 'border-transparent text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Camera Scanner</span>
            </button>
            <button
              type="button"
              onClick={() => {
                stopCamera();
                setActiveTab('manual');
              }}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-t-lg transition border-b-2 ${
                activeTab === 'manual'
                  ? 'border-[var(--khata-accent)] text-[var(--khata-accent)]'
                  : 'border-transparent text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
              }`}
            >
              <Keyboard className="w-3.5 h-3.5" />
              <span>Manual Entry</span>
            </button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1">
          {/* Unknown Barcode Resolution Dialog */}
          {unknownBarcode ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-500 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="text-sm font-bold">Unknown Barcode</h4>
                  <p className="text-xs mt-0.5 text-amber-400">
                    No active product in your catalog matches barcode:
                  </p>
                  <div className="mt-2 inline-block font-mono text-xs px-2.5 py-1 rounded bg-black/20 font-bold border border-amber-500/30">
                    {unknownBarcode}
                  </div>
                </div>
              </div>

              {linkSuccess && (
                <div className="p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-500 text-xs font-semibold flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{linkSuccess}</span>
                </div>
              )}

              {linkError && (
                <div className="p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-500 text-xs font-semibold flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{linkError}</span>
                </div>
              )}

              {/* Action 1: Create New Product with this Barcode */}
              {onCreateWithBarcode && (
                <button
                  type="button"
                  onClick={() => {
                    stopCamera();
                    onCreateWithBarcode(unknownBarcode);
                    onClose();
                  }}
                  className="w-full flex items-center justify-between p-3.5 rounded-xl border border-[var(--khata-border)] hover:border-[var(--khata-accent)] bg-[var(--khata-surface-inset)] transition text-left group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[var(--khata-accent)]/10 text-[var(--khata-accent)] flex items-center justify-center font-bold">
                      <Plus className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs sm:text-sm font-bold text-[var(--khata-text)] group-hover:text-[var(--khata-accent)] transition">
                        Create New Product
                      </div>
                      <div className="text-[11px] text-[var(--khata-text-muted)]">
                        Add a new inventory item with this barcode pre-filled
                      </div>
                    </div>
                  </div>
                  <span className="text-xs font-bold text-[var(--khata-accent)]">Create &rarr;</span>
                </button>
              )}

              {/* Action 2: Attach to existing product */}
              <div className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-[var(--khata-text)]">
                  <LinkIcon className="w-4 h-4 text-[var(--khata-accent)]" />
                  <span>Attach Barcode to an Existing Product</span>
                </div>
                <input
                  type="text"
                  placeholder="Search existing product by name..."
                  value={linkSearch}
                  onChange={(e) => setLinkSearch(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-xs bg-[var(--khata-surface)] border border-[var(--khata-border)] focus:outline-none focus:border-[var(--khata-accent)] text-[var(--khata-text)]"
                />

                {isSearchingLink && (
                  <div className="flex items-center justify-center py-2 text-xs text-[var(--khata-text-muted)] gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Searching products...</span>
                  </div>
                )}

                {linkProducts.length > 0 && (
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {linkProducts.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        disabled={isLinking}
                        onClick={() => handleAttachBarcodeToProduct(p)}
                        className="w-full flex items-center justify-between p-2 rounded-lg text-left text-xs bg-[var(--khata-surface)] hover:bg-[var(--khata-accent)]/10 border border-[var(--khata-border)] transition"
                      >
                        <div>
                          <div className="font-bold text-[var(--khata-text)]">{p.name}</div>
                          <div className="text-[10px] text-[var(--khata-text-muted)]">
                            ₹{p.buying_price} {p.barcode ? `• Barcode: ${p.barcode}` : '• No Barcode'}
                          </div>
                        </div>
                        <span className="text-[11px] font-bold text-[var(--khata-accent)]">
                          {isLinking ? 'Linking...' : 'Select'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Action 3: Cancel / Scan Again */}
              <button
                type="button"
                onClick={() => {
                  setUnknownBarcode(null);
                  setLinkSearch('');
                  setLinkProducts([]);
                  setLinkError(null);
                  setActiveTab('camera');
                }}
                className="w-full py-2.5 rounded-xl border border-[var(--khata-border)] text-xs font-bold text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] transition flex items-center justify-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Scan Another Barcode</span>
              </button>
            </div>
          ) : activeTab === 'camera' ? (
            /* Camera Scanner View */
            <div className="space-y-4">
              {cameraError ? (
                <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-500 space-y-3">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div className="text-xs">
                      <p className="font-bold">Camera Unavailable</p>
                      <p className="mt-1 leading-relaxed">{cameraError}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setCameraError(null);
                        setCameraLoading(true);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-rose-500 text-white text-xs font-bold flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Retry Camera</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        stopCamera();
                        setActiveTab('manual');
                      }}
                      className="px-3 py-1.5 rounded-lg border border-rose-500/30 text-xs font-bold"
                    >
                      Use Manual Input
                    </button>
                  </div>
                </div>
              ) : (
                <div className="relative rounded-2xl overflow-hidden bg-black aspect-[4/3] flex items-center justify-center border border-[var(--khata-border)] shadow-inner">
                  {cameraLoading && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 text-white gap-2">
                      <Loader2 className="w-8 h-8 animate-spin text-[var(--khata-accent)]" />
                      <span className="text-xs font-medium">Starting camera...</span>
                    </div>
                  )}

                  {isLookingUp && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/75 text-white gap-2">
                      <Loader2 className="w-8 h-8 animate-spin text-[var(--khata-accent)]" />
                      <span className="text-xs font-bold">Looking up barcode...</span>
                    </div>
                  )}

                  <video
                    ref={videoRef}
                    className="w-full h-full object-cover"
                    playsInline
                    muted
                  />

                  {/* Scanning Frame Reticle */}
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="relative w-3/4 max-w-[260px] aspect-square rounded-2xl border-2 border-dashed border-white/60 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
                      {/* Corner Accents */}
                      <div className="absolute -top-1 -left-1 w-5 h-5 border-t-4 border-l-4 border-[var(--khata-accent)] rounded-tl" />
                      <div className="absolute -top-1 -right-1 w-5 h-5 border-t-4 border-r-4 border-[var(--khata-accent)] rounded-tr" />
                      <div className="absolute -bottom-1 -left-1 w-5 h-5 border-b-4 border-l-4 border-[var(--khata-accent)] rounded-bl" />
                      <div className="absolute -bottom-1 -right-1 w-5 h-5 border-b-4 border-r-4 border-[var(--khata-accent)] rounded-br" />

                      {/* Animated Laser Scan Line */}
                      <div className="absolute inset-x-2 top-0 h-0.5 bg-[var(--khata-accent)] shadow-[0_0_8px_var(--khata-accent)] animate-pulse" />
                    </div>
                  </div>

                  {/* Camera Controls Bar (Torch, Info) */}
                  <div className="absolute bottom-3 inset-x-3 z-10 flex items-center justify-between">
                    <span className="text-[10px] font-mono text-white/80 bg-black/60 px-2.5 py-1 rounded-full backdrop-blur-sm">
                      Align barcode inside frame
                    </span>
                    {hasTorch && (
                      <button
                        type="button"
                        onClick={toggleTorch}
                        className={`p-2 rounded-full backdrop-blur-md transition ${
                          isTorchOn
                            ? 'bg-amber-400 text-black shadow-lg shadow-amber-400/40'
                            : 'bg-black/60 text-white hover:bg-black/80'
                        }`}
                        aria-label={isTorchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
                      >
                        {isTorchOn ? <Flashlight className="w-4 h-4" /> : <FlashlightOff className="w-4 h-4" />}
                      </button>
                    )}
                  </div>
                </div>
              )}

              <p className="text-[11px] text-center text-[var(--khata-text-muted)]">
                Supports EAN-13, EAN-8, UPC-A, UPC-E, CODE-128, and QR formats.
              </p>
            </div>
          ) : (
            /* Manual Barcode Input View */
            <form onSubmit={handleManualSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold mb-1 text-[var(--khata-text)]">
                  Barcode Number / Code
                </label>
                <input
                  type="text"
                  placeholder="e.g. 8901234567890"
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  maxLength={64}
                  autoFocus
                  className="w-full px-3.5 py-2.5 rounded-xl text-sm font-mono bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] focus:outline-none focus:border-[var(--khata-accent)] text-[var(--khata-text)]"
                />
                <p className="text-[11px] text-[var(--khata-text-muted)] mt-1">
                  Type or paste any numeric or alphanumeric barcode.
                </p>
              </div>

              <button
                type="submit"
                disabled={!manualInput.trim() || isLookingUp}
                className="w-full py-2.5 rounded-xl font-bold text-xs text-white bg-[var(--khata-accent)] hover:opacity-90 transition disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-md"
              >
                {isLookingUp ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Searching catalog...</span>
                  </>
                ) : (
                  <>
                    <Scan className="w-4 h-4" />
                    <span>Lookup Product</span>
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
