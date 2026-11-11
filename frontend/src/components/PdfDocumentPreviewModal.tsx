import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  X,
  Download,
  Printer,
  Loader2,
  AlertCircle,
  FileText,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RefreshCw,
  Image as ImageIcon,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { loadPdfJs } from '../utils/pdfImageExporter.js';
import { downloadBlobSafely } from '../utils/blobDownload.js';
import { PdfImageExportModal } from './PdfImageExportModal.js';

export const MAX_ACTIVE_PREVIEW_CANVASES = 6;

export function computeActivePageWindow(
  anchorPage: number,
  totalPages: number,
  maxCanvases = MAX_ACTIVE_PREVIEW_CANVASES
): number[] {
  if (totalPages <= 0) return [];
  if (totalPages <= maxCanvases) {
    return Array.from({ length: totalPages }, (_, idx) => idx + 1);
  }
  const safeAnchor = Math.min(Math.max(1, anchorPage), totalPages);
  const halfBefore = Math.floor((maxCanvases - 1) / 2);
  let start = Math.max(1, safeAnchor - halfBefore);
  const end = Math.min(totalPages, start + maxCanvases - 1);
  start = Math.max(1, end - maxCanvases + 1);
  const pages: number[] = [];
  for (let p = start; p <= end; p++) {
    pages.push(p);
  }
  return pages;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function zeroCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  try {
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  } catch {
    // Ignore context errors during cleanup
  }
  canvas.width = 0;
  canvas.height = 0;
}

async function waitForPrintImagesReady(printWindow: Window): Promise<void> {
  const images = Array.from(printWindow.document?.images || []);
  if (images.length === 0) return;

  await Promise.all(
    images.map(async (img) => {
      try {
        if (typeof img.decode === 'function') {
          await img.decode();
          return;
        }
      } catch {
        // Fall through to complete / onload check if decode rejects
      }
      if (img.complete) return;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, 1500);
      });
    })
  );
}

export interface PdfDocumentPreviewModalProps {
  isOpen: boolean;
  title: string;
  subtitle?: string;
  fileName: string;
  documentLabel?: string;
  imageExportBaseName?: string;
  fetchPdfBlob: (signal: AbortSignal) => Promise<Blob>;
  fetchKey?: string;
  autoPrintOnLoad?: boolean;
  headerBadge?: React.ReactNode;
  onClose: () => void;
}

export const PdfDocumentPreviewModal: React.FC<PdfDocumentPreviewModalProps> = ({
  isOpen,
  title,
  subtitle,
  fileName,
  documentLabel = 'Document',
  imageExportBaseName,
  fetchPdfBlob,
  fetchKey,
  autoPrintOnLoad = false,
  headerBadge,
  onClose,
}) => {
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [zoom, setZoom] = useState<number>(1);
  const [fitWidth, setFitWidth] = useState<boolean>(true);
  const [containerWidth, setContainerWidth] = useState<number>(720);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isPrinting, setIsPrinting] = useState<boolean>(false);
  const [printNotice, setPrintNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState<number>(0);
  const [isImageExportOpen, setIsImageExportOpen] = useState<boolean>(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const pageContainerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const pdfDocRef = useRef<any>(null);
  const loadingTaskRef = useRef<any>(null);
  const activeRenderTasksRef = useRef<Array<{ cancel?: () => void }>>([]);
  const fetchPdfBlobRef = useRef(fetchPdfBlob);
  fetchPdfBlobRef.current = fetchPdfBlob;
  const didAutoPrintRef = useRef<boolean>(false);

  const activePages = useMemo(
    () => computeActivePageWindow(currentPage, numPages, MAX_ACTIVE_PREVIEW_CANVASES),
    [currentPage, numPages]
  );
  const activePageSet = useMemo(() => new Set(activePages), [activePages]);

  const cancelActiveRenders = useCallback(() => {
    const tasks = activeRenderTasksRef.current;
    activeRenderTasksRef.current = [];
    for (const task of tasks) {
      try {
        task?.cancel?.();
      } catch {
        // Ignore cancellation errors
      }
    }
  }, []);

  const destroyLoadedPdf = useCallback(async () => {
    cancelActiveRenders();

    for (const canvas of canvasRefs.current.values()) {
      zeroCanvas(canvas);
    }
    canvasRefs.current.clear();
    pageContainerRefs.current.clear();

    const doc = pdfDocRef.current;
    pdfDocRef.current = null;
    if (doc && typeof doc.cleanup === 'function') {
      await doc.cleanup().catch(() => {});
    }
    if (doc && typeof doc.destroy === 'function') {
      await doc.destroy().catch(() => {});
    }

    const task = loadingTaskRef.current;
    loadingTaskRef.current = null;
    if (task && typeof task.destroy === 'function') {
      await task.destroy().catch(() => {});
    }
  }, [cancelActiveRenders]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isImageExportOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isImageExportOpen, onClose]);

  // Track responsive container width
  useEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      if (viewportRef.current) {
        const w = viewportRef.current.clientWidth;
        if (w > 120) setContainerWidth(w - 32);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isOpen]);

  // Fetch PDF blob and parse via PDF.js
  useEffect(() => {
    if (!isOpen) {
      didAutoPrintRef.current = false;
      setPrintNotice(null);
      void destroyLoadedPdf();
      setPdfBlob(null);
      setNumPages(0);
      setCurrentPage(1);
      setError(null);
      setIsImageExportOpen(false);
      return;
    }

    didAutoPrintRef.current = false;
    setPrintNotice(null);
    const controller = new AbortController();
    let cancelled = false;

    const loadPdf = async () => {
      setIsLoading(true);
      setError(null);
      setNumPages(0);
      setCurrentPage(1);
      await destroyLoadedPdf();

      try {
        const blob = await fetchPdfBlobRef.current(controller.signal);
        if (cancelled || controller.signal.aborted) return;

        setPdfBlob(blob);

        const pdfjsLib = await loadPdfJs();
        if (cancelled || controller.signal.aborted) return;

        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (cancelled || controller.signal.aborted) return;

        const task = pdfjsLib.getDocument({
          data: bytes,
          verbosity: 0,
        });
        loadingTaskRef.current = task;

        const pdfDoc = await task.promise;
        if (cancelled || controller.signal.aborted) {
          await pdfDoc.cleanup?.().catch(() => {});
          await (pdfDoc as { destroy?: () => Promise<void> }).destroy?.().catch(() => {});
          await task.destroy?.().catch(() => {});
          return;
        }

        pdfDocRef.current = pdfDoc;
        setNumPages(pdfDoc.numPages);
      } catch (err: any) {
        if (cancelled || controller.signal.aborted) return;
        setError(err?.message || `Failed to load ${documentLabel.toLowerCase()} preview.`);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadPdf();

    return () => {
      cancelled = true;
      controller.abort();
      void destroyLoadedPdf();
    };
  }, [isOpen, fetchKey, retrySeq, documentLabel, destroyLoadedPdf]);

  // Evict canvases outside active page window to strictly cap memory
  useEffect(() => {
    if (!isOpen || numPages <= 0) return;
    for (const [pageNo, canvas] of Array.from(canvasRefs.current.entries())) {
      if (!activePageSet.has(pageNo)) {
        zeroCanvas(canvas);
        canvasRefs.current.delete(pageNo);
      }
    }
  }, [isOpen, numPages, activePageSet]);

  // Render active window pages onto per-page canvases
  useEffect(() => {
    const pdfDoc = pdfDocRef.current;
    if (!isOpen || !pdfDoc || numPages <= 0 || activePages.length === 0) return;

    let cancelled = false;

    const renderActivePages = async () => {
      cancelActiveRenders();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

      for (const pageNumber of activePages) {
        if (cancelled) break;
        const canvas = canvasRefs.current.get(pageNumber);
        if (!canvas) continue;

        let page: any = null;
        try {
          page = await pdfDoc.getPage(pageNumber);
          if (cancelled) {
            page.cleanup?.();
            break;
          }

          const unscaledViewport = page.getViewport({ scale: 1 });
          const targetCssWidth = Math.max(280, Math.min(containerWidth, 920));
          const fitScale = targetCssWidth / Math.max(1, unscaledViewport.width);
          const cssScale = fitWidth ? fitScale * zoom : zoom;
          const cssViewport = page.getViewport({ scale: cssScale });
          const outputViewport = page.getViewport({ scale: cssScale * pixelRatio });

          canvas.width = Math.max(1, Math.floor(outputViewport.width));
          canvas.height = Math.max(1, Math.floor(outputViewport.height));
          canvas.style.width = `${Math.floor(cssViewport.width)}px`;
          canvas.style.height = `${Math.floor(cssViewport.height)}px`;

          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) {
            page.cleanup?.();
            continue;
          }

          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const renderTask = page.render({
            canvas,
            canvasContext: ctx,
            viewport: outputViewport,
          });
          activeRenderTasksRef.current.push(renderTask);
          await renderTask.promise;
        } catch (renderErr: any) {
          if (renderErr?.name === 'RenderingCancelledException' || cancelled) {
            continue;
          }
          console.error(`[PDF PREVIEW] Page ${pageNumber} render warning:`, renderErr);
        } finally {
          page?.cleanup?.();
        }
      }
    };

    void renderActivePages();

    return () => {
      cancelled = true;
      cancelActiveRenders();
    };
  }, [isOpen, numPages, activePages, containerWidth, fitWidth, zoom, cancelActiveRenders]);

  // IntersectionObserver updates currentPage on scroll for lazy windowing
  useEffect(() => {
    if (!isOpen || numPages <= 1 || typeof IntersectionObserver === 'undefined') return;
    const rootEl = viewportRef.current;
    if (!rootEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let bestPage = 0;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= bestRatio) {
            const pAttr = Number((entry.target as HTMLElement).dataset.pageNumber || '0');
            if (pAttr >= 1) {
              bestRatio = entry.intersectionRatio;
              bestPage = pAttr;
            }
          }
        }
        if (bestPage >= 1) {
          setCurrentPage(bestPage);
        }
      },
      { root: rootEl, threshold: [0.25, 0.5, 0.75] }
    );

    for (const el of pageContainerRefs.current.values()) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [isOpen, numPages]);

  const handleViewportScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport || numPages <= 1) return;
    const maxScroll = Math.max(1, viewport.scrollHeight - viewport.clientHeight);
    const ratio = viewport.scrollTop / maxScroll;
    const estimatedPage = Math.min(numPages, Math.max(1, Math.round(ratio * (numPages - 1)) + 1));
    setCurrentPage(estimatedPage);
  };

  const scrollToPage = (targetPage: number) => {
    const clamped = Math.min(Math.max(1, targetPage), Math.max(1, numPages));
    setCurrentPage(clamped);
    const pageEl = pageContainerRefs.current.get(clamped);
    if (pageEl && typeof pageEl.scrollIntoView === 'function') {
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleDownload = useCallback(() => {
    if (!pdfBlob) return;
    downloadBlobSafely(pdfBlob, fileName);
  }, [pdfBlob, fileName]);

  const handlePrint = useCallback(async () => {
    const pdfDoc = pdfDocRef.current;
    if (!pdfDoc || numPages <= 0) return;

    setPrintNotice(null);
    // Do NOT pass noopener,noreferrer in window.open features — Chromium/Android returns null!
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      try {
        printWindow.opener = null;
      } catch {
        // Ignore read-only opener implementations
      }
    }

    if (!printWindow) {
      handleDownload();
      setPrintNotice('Pop-up blocked by browser — downloaded canonical PDF instead.');
      return;
    }

    setIsPrinting(true);
    const safeTitle = escapeHtml(title || documentLabel);

    try {
      printWindow.document.open();
      printWindow.document.write(
        `<!DOCTYPE html><html><head><title>${safeTitle}</title><style>body{font-family:system-ui,sans-serif;margin:2rem;color:#334155;}</style></head><body><p>Preparing ${numPages} page(s) for printing...</p></body></html>`
      );
      printWindow.document.close();
    } catch {
      // Ignore write failures if window closed early
    }

    const offscreenCanvas = document.createElement('canvas');
    const pageDataUrls: string[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
        let page: any = null;
        try {
          page = await pdfDoc.getPage(pageNumber);
          const unscaled = page.getViewport({ scale: 1 });
          const targetScale = Math.max(1, Math.min(2, 1650 / Math.max(1, unscaled.width)));
          const viewport = page.getViewport({ scale: targetScale });

          offscreenCanvas.width = Math.max(1, Math.floor(viewport.width));
          offscreenCanvas.height = Math.max(1, Math.floor(viewport.height));

          const ctx = offscreenCanvas.getContext('2d', { alpha: false });
          if (!ctx) {
            throw new Error('Canvas 2D context unavailable for printing.');
          }
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

          const task = page.render({
            canvas: offscreenCanvas,
            canvasContext: ctx,
            viewport,
          });
          await task.promise;
          pageDataUrls.push(offscreenCanvas.toDataURL('image/png'));
        } finally {
          page?.cleanup?.();
        }
      }
    } catch (err: any) {
      zeroCanvas(offscreenCanvas);
      setIsPrinting(false);
      try {
        printWindow.close();
      } catch {
        // Ignore close error
      }
      setPrintNotice(err?.message || 'Unable to prepare pages for printing. Use Download instead.');
      return;
    } finally {
      zeroCanvas(offscreenCanvas);
    }

    if (pageDataUrls.length === 0) {
      setIsPrinting(false);
      return;
    }

    const imgTags = pageDataUrls
      .map(
        (src, idx) =>
          `<div class="page-break"><img src="${src}" alt="${escapeHtml(documentLabel)} page ${idx + 1}" /></div>`
      )
      .join('');

    try {
      printWindow.document.open();
      printWindow.document.write(
        `<!DOCTYPE html><html><head><title>${safeTitle}</title><style>@page{size:A4 portrait;margin:0;}body{margin:0;background:#fff;}.page-break{page-break-after:always;display:flex;justify-content:center;align-items:flex-start;}.page-break:last-child{page-break-after:auto;}img{width:100%;max-width:210mm;height:auto;display:block;}</style></head><body>${imgTags}</body></html>`
      );
      printWindow.document.close();
      await waitForPrintImagesReady(printWindow);
      printWindow.focus();
      printWindow.print();
    } catch {
      handleDownload();
      setPrintNotice('Print dialog could not open — downloaded canonical PDF instead.');
    } finally {
      setIsPrinting(false);
    }
  }, [numPages, title, documentLabel, handleDownload]);

  // Optional auto-print trigger once official PDF finishes loading
  useEffect(() => {
    if (!isOpen || !autoPrintOnLoad || isLoading || error || numPages <= 0 || !pdfBlob) return;
    if (didAutoPrintRef.current) return;
    didAutoPrintRef.current = true;
    void handlePrint();
  }, [isOpen, autoPrintOnLoad, isLoading, error, numPages, pdfBlob, handlePrint]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/90 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Top Toolbar */}
      <div className="bg-[var(--khata-surface)] border-b border-[var(--khata-border)] px-3 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2 shadow-md">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[var(--khata-surface-inset)] flex items-center justify-center shrink-0">
            <FileText className="w-4 h-4 text-[var(--khata-accent)]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm sm:text-base font-extrabold text-[var(--khata-text)] truncate">
                {title}
              </h3>
              {headerBadge}
            </div>
            <p className="text-[11px] text-[var(--khata-text-muted)]">
              {numPages > 0 ? `Page ${currentPage} of ${numPages} · ` : ''}
              {subtitle || 'Official canonical A4 PDF'}
            </p>
          </div>
        </div>

        {/* Zoom + Page + Action Controls */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {numPages > 1 && (
            <div className="flex items-center gap-1 bg-[var(--khata-surface-inset)] rounded-lg p-1 border border-[var(--khata-border)]">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => scrollToPage(currentPage - 1)}
                className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] disabled:opacity-40"
                title="Previous page"
                aria-label="Previous page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11px] font-mono font-semibold text-[var(--khata-text)] px-1">
                {currentPage}/{numPages}
              </span>
              <button
                type="button"
                disabled={currentPage >= numPages}
                onClick={() => scrollToPage(currentPage + 1)}
                className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] disabled:opacity-40"
                title="Next page"
                aria-label="Next page"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {numPages > 0 && (
            <div className="flex items-center gap-1 bg-[var(--khata-surface-inset)] rounded-lg p-1 border border-[var(--khata-border)]">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.15).toFixed(2))))}
                className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
                title="Zoom out"
                aria-label="Zoom out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11px] font-mono font-semibold text-[var(--khata-text)] min-w-[42px] text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(2.0, Number((z + 0.15).toFixed(2))))}
                className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
                title="Zoom in"
                aria-label="Zoom in"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setFitWidth((prev) => !prev);
                  setZoom(1);
                }}
                className="p-1 text-[10px] font-semibold text-[var(--khata-accent)] hover:underline inline-flex items-center gap-0.5"
                title={fitWidth ? 'Actual 100% size' : 'Fit to container width'}
              >
                <Maximize2 className="w-3 h-3" />
                <span className="hidden md:inline">{fitWidth ? 'Fit' : '1:1'}</span>
              </button>
            </div>
          )}

          <button
            type="button"
            disabled={!pdfBlob || isLoading || numPages === 0}
            onClick={() => setIsImageExportOpen(true)}
            className="neu-btn-secondary text-xs px-2.5 sm:px-3 py-1.5 font-bold inline-flex items-center gap-1.5 text-emerald-700 disabled:opacity-50"
            title="Export compressed WebP images"
          >
            <ImageIcon className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Images (.webp)</span>
          </button>

          <button
            type="button"
            disabled={!pdfBlob || isLoading}
            onClick={handleDownload}
            className="neu-btn-secondary text-xs px-2.5 sm:px-3 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-50"
            title="Download PDF"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Download</span>
          </button>

          <button
            type="button"
            disabled={!pdfBlob || isLoading || numPages === 0 || isPrinting}
            onClick={() => void handlePrint()}
            className="neu-btn-secondary text-xs px-2.5 sm:px-3 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-50"
            title="Print PDF"
          >
            {isPrinting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{isPrinting ? 'Printing...' : 'Print'}</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-[var(--khata-text-muted)] hover:bg-rose-500/10 hover:text-rose-600 transition"
            aria-label={`Close ${documentLabel.toLowerCase()} preview`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {printNotice && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-800 flex items-center justify-between gap-2">
          <span>{printNotice}</span>
          <button
            type="button"
            onClick={() => setPrintNotice(null)}
            className="font-semibold underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* PDF Viewport Area */}
      <div
        ref={viewportRef}
        onScroll={handleViewportScroll}
        className="flex-1 overflow-y-auto overflow-x-auto py-4 sm:py-6 px-2 sm:px-6 flex flex-col items-center gap-4"
      >
        {isLoading && (
          <div className="my-auto flex flex-col items-center gap-3 text-slate-200 py-16">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--khata-accent)]" />
            <p className="text-sm font-medium">Rendering official {documentLabel.toLowerCase()} PDF...</p>
          </div>
        )}

        {error && !isLoading && (
          <div className="my-auto max-w-md w-full bg-[var(--khata-surface)] border border-rose-500/30 rounded-2xl p-6 text-center space-y-3 shadow-lg">
            <AlertCircle className="w-8 h-8 text-rose-500 mx-auto" />
            <h4 className="text-sm font-bold text-[var(--khata-text)]">Unable to render preview</h4>
            <p className="text-xs text-[var(--khata-text-muted)]">{error}</p>
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRetrySeq((s) => s + 1)}
                className="neu-btn-primary text-xs px-4 py-2 font-bold inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry
              </button>
              <button
                type="button"
                onClick={onClose}
                className="neu-btn-secondary text-xs px-4 py-2 font-bold"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {!isLoading &&
          !error &&
          numPages > 0 &&
          Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => {
            const isActive = activePageSet.has(pageNumber);
            return (
              <div
                key={pageNumber}
                data-testid={`pdf-page-${pageNumber}`}
                data-page-number={pageNumber}
                ref={(el) => {
                  if (el) pageContainerRefs.current.set(pageNumber, el);
                  else pageContainerRefs.current.delete(pageNumber);
                }}
                className="bg-white rounded-sm shadow-2xl border border-slate-700/20 overflow-hidden shrink-0"
              >
                {isActive ? (
                  <canvas
                    ref={(el) => {
                      if (el) {
                        canvasRefs.current.set(pageNumber, el);
                      } else {
                        const existing = canvasRefs.current.get(pageNumber);
                        if (existing) zeroCanvas(existing);
                        canvasRefs.current.delete(pageNumber);
                      }
                    }}
                    className="block max-w-full"
                    aria-label={`${documentLabel} page ${pageNumber} of ${numPages}`}
                  />
                ) : (
                  <div
                    data-testid={`pdf-page-${pageNumber}-placeholder`}
                    style={{
                      width: `${Math.max(280, Math.min(containerWidth, 920))}px`,
                      minHeight: '420px',
                    }}
                    className="flex flex-col items-center justify-center gap-2 bg-slate-50 text-slate-500 text-xs font-medium p-6"
                  >
                    <span>
                      {documentLabel} Page {pageNumber} of {numPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => scrollToPage(pageNumber)}
                      className="text-[11px] font-bold text-[var(--khata-accent)] underline hover:no-underline"
                    >
                      Jump to Page {pageNumber}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>

      {isImageExportOpen && pdfBlob && (
        <PdfImageExportModal
          isOpen={isImageExportOpen}
          onClose={() => setIsImageExportOpen(false)}
          title={`${title} WebP Images`}
          baseFileName={imageExportBaseName || fileName.replace(/\.pdf$/i, '')}
          fetchPdfBlob={async () => pdfBlob}
        />
      )}
    </div>
  );
};
