import React, { useState, useEffect, useRef, useCallback } from 'react';
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
} from 'lucide-react';
import { Quotation, CreateQuotationPayload } from './quotation.types.js';
import { previewQuotationPdf, fetchSavedQuotationPdfBlob } from './quotationApi.js';
import { loadPdfJs } from '../../utils/pdfImageExporter.js';
import { downloadBlobSafely } from '../../utils/blobDownload.js';
import { PdfImageExportModal } from '../../components/PdfImageExportModal.js';

export interface QuotationPreviewProps {
  isOpen: boolean;
  quotation?: Quotation | null;
  previewPayload?: CreateQuotationPayload | null;
  onClose: () => void;
}

export const QuotationPreview: React.FC<QuotationPreviewProps> = ({
  isOpen,
  quotation,
  previewPayload,
  onClose,
}) => {
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [zoom, setZoom] = useState<number>(1);
  const [fitWidth, setFitWidth] = useState<boolean>(true);
  const [containerWidth, setContainerWidth] = useState<number>(720);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState<number>(0);
  const [isImageExportOpen, setIsImageExportOpen] = useState<boolean>(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const pdfDocRef = useRef<any>(null);
  const loadingTaskRef = useRef<any>(null);
  const renderGenerationRef = useRef<number>(0);

  const docNumber =
    quotation?.quotation_number || previewPayload?.quotationNumber || 'Preview';

  const destroyLoadedPdf = useCallback(async () => {
    renderGenerationRef.current += 1;
    canvasRefs.current.forEach((canvas) => {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
    });
    canvasRefs.current.clear();

    const doc = pdfDocRef.current;
    pdfDocRef.current = null;
    if (doc && typeof doc.cleanup === 'function') {
      await doc.cleanup().catch(() => {});
    }

    const task = loadingTaskRef.current;
    loadingTaskRef.current = null;
    if (task && typeof task.destroy === 'function') {
      await task.destroy().catch(() => {});
    }
  }, []);

  // Measure viewport width responsively for Fit Width on desktop and mobile phones
  useEffect(() => {
    if (!isOpen) return;
    const el = viewportRef.current;
    if (!el) return;

    const updateWidth = () => {
      const available = Math.max(260, el.clientWidth - 24);
      setContainerWidth(available);
    };

    updateWidth();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateWidth);
      observer.observe(el);
    } else {
      window.addEventListener('resize', updateWidth);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, [isOpen]);

  // Fetch PDF Blob and initialize PDF.js document
  useEffect(() => {
    if (!isOpen) {
      setPdfBlob(null);
      setNumPages(0);
      setCurrentPage(1);
      setError(null);
      setIsLoading(false);
      setIsImageExportOpen(false);
      void destroyLoadedPdf();
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    const loadDocument = async () => {
      await destroyLoadedPdf();
      if (cancelled || controller.signal.aborted) return;

      setIsLoading(true);
      setError(null);
      setPdfBlob(null);
      setNumPages(0);
      setCurrentPage(1);

      try {
        let blob: Blob;
        if (quotation?.id) {
          blob = await fetchSavedQuotationPdfBlob(quotation.id, controller.signal);
        } else if (previewPayload) {
          blob = await previewQuotationPdf(previewPayload, controller.signal);
        } else {
          throw new Error('No quotation data provided for preview.');
        }

        if (cancelled || controller.signal.aborted) return;

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
          await task.destroy?.().catch(() => {});
          if (loadingTaskRef.current === task) loadingTaskRef.current = null;
          return;
        }

        pdfDocRef.current = pdfDoc;
        setPdfBlob(blob);
        setNumPages(pdfDoc.numPages);
      } catch (err: any) {
        if (cancelled || controller.signal.aborted || err?.name === 'AbortError') return;
        setError(err?.message || 'Could not load quotation PDF.');
      } finally {
        if (!cancelled && !controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void loadDocument();

    return () => {
      cancelled = true;
      controller.abort();
      void destroyLoadedPdf();
    };
  }, [isOpen, quotation?.id, previewPayload, retrySeq, destroyLoadedPdf]);

  // Render all pages onto per-page canvases whenever page count, container width, or zoom changes
  useEffect(() => {
    const pdfDoc = pdfDocRef.current;
    if (!isOpen || !pdfDoc || numPages <= 0) return;

    const generation = ++renderGenerationRef.current;
    const activeRenderTasks: Array<{ cancel?: () => void }> = [];

    const renderPages = async () => {
      const pixelRatio =
        typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

      for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
        if (renderGenerationRef.current !== generation) return;

        const canvas = canvasRefs.current.get(pageNumber);
        if (!canvas) continue;

        const page = await pdfDoc.getPage(pageNumber);
        if (renderGenerationRef.current !== generation) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = Math.max(0.35, Math.min(2.0, containerWidth / Math.max(1, baseViewport.width)));
        const cssScale = fitWidth ? fitScale * zoom : zoom;
        const cssViewport = page.getViewport({ scale: cssScale });
        const outputViewport = page.getViewport({ scale: cssScale * pixelRatio });

        canvas.width = Math.max(1, Math.floor(outputViewport.width));
        canvas.height = Math.max(1, Math.floor(outputViewport.height));
        canvas.style.width = `${Math.max(1, Math.floor(cssViewport.width))}px`;
        canvas.style.height = `${Math.max(1, Math.floor(cssViewport.height))}px`;

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) continue;

        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport: outputViewport,
        });
        activeRenderTasks.push(renderTask);

        try {
          await renderTask.promise;
        } catch (renderErr: any) {
          if (renderErr?.name !== 'RenderingCancelledException') {
            console.warn(`PDF page ${pageNumber} render warning:`, renderErr);
          }
        }
      }
    };

    void renderPages();

    return () => {
      renderGenerationRef.current += 1;
      for (const task of activeRenderTasks) {
        try {
          task.cancel?.();
        } catch {
          // Ignore cancellation errors on completed tasks
        }
      }
    };
  }, [isOpen, numPages, containerWidth, fitWidth, zoom]);

  const handleViewportScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport || numPages <= 1) return;

    const midY = viewport.scrollTop + viewport.clientHeight * 0.35;
    let closestPage = 1;
    let closestDist = Infinity;

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const canvas = canvasRefs.current.get(pageNumber);
      if (!canvas || !canvas.parentElement) continue;
      const top = canvas.parentElement.offsetTop;
      const dist = Math.abs(top - midY);
      if (dist < closestDist) {
        closestDist = dist;
        closestPage = pageNumber;
      }
    }
    setCurrentPage(closestPage);
  };

  const handleDownload = () => {
    if (!pdfBlob) return;
    downloadBlobSafely(pdfBlob, `Quotation-${docNumber}.pdf`);
  };

  const handlePrint = () => {
    const renderedCanvases: HTMLCanvasElement[] = [];
    for (let pageNumber = 1; pageNumber <= numPages; pageNumber++) {
      const c = canvasRefs.current.get(pageNumber);
      if (c && c.width > 0 && c.height > 0) renderedCanvases.push(c);
    }

    if (renderedCanvases.length === 0) {
      window.print();
      return;
    }

    const printWindow = window.open('', '_blank', 'noopener,noreferrer');
    if (!printWindow) {
      handleDownload();
      return;
    }

    const imgTags = renderedCanvases
      .map((canvas, idx) => {
        const dataUrl = canvas.toDataURL('image/png');
        return `<div class="page-break"><img src="${dataUrl}" alt="Quotation Page ${idx + 1}" /></div>`;
      })
      .join('');

    printWindow.document.open();
    printWindow.document.write(
      `<!DOCTYPE html><html><head><title>Quotation ${docNumber}</title><style>@page{size:A4 portrait;margin:0;}body{margin:0;background:#fff;}.page-break{page-break-after:always;display:flex;justify-content:center;align-items:flex-start;}.page-break:last-child{page-break-after:auto;}img{width:100%;max-width:210mm;height:auto;display:block;}</style></head><body>${imgTags}</body></html>`
    );
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      try {
        printWindow.print();
      } catch {
        // Ignore print dialog close errors
      }
    }, 150);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-modal-title"
    >
      <div
        className="w-full max-w-4xl h-[92vh] rounded-2xl border border-[var(--khata-border)] shadow-2xl flex flex-col overflow-hidden"
        style={{ background: 'var(--khata-surface)', color: 'var(--khata-text)' }}
      >
        {/* Header Bar */}
        <div className="flex flex-wrap items-center justify-between px-3 sm:px-5 py-2.5 border-b border-[var(--khata-border)] gap-2">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shadow-inner flex-shrink-0"
              style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-accent)' }}
            >
              <FileText className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 id="preview-modal-title" className="text-xs sm:text-base font-bold truncate">
                Quotation Document {quotation?.quotation_number ? `#${quotation.quotation_number}` : '(Preview)'}
              </h3>
              <p className="text-[10px] sm:text-[11px] text-[var(--khata-text-muted)]">
                {numPages > 0 ? `Page ${currentPage} of ${numPages}` : 'Corporate PDF presentation'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {numPages > 0 && !isLoading && (
              <div className="flex items-center gap-1 mr-1 px-1.5 py-0.5 rounded-lg bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.max(0.6, Number((z - 0.15).toFixed(2))))}
                  className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
                  title="Zoom out"
                  aria-label="Zoom out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="text-[11px] font-mono font-bold px-1">
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
              disabled={!pdfBlob || isLoading}
              onClick={() => setIsImageExportOpen(true)}
              className="neu-btn-secondary text-xs px-2.5 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-50 text-emerald-700"
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
              disabled={!pdfBlob || isLoading || numPages === 0}
              onClick={handlePrint}
              className="neu-btn-secondary text-xs px-2.5 sm:px-3 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-50"
              title="Print PDF"
            >
              <Printer className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Print</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] inline-flex items-center justify-center transition"
              aria-label="Close preview"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* PDF.js Multi-Page Canvas Scroll Viewport */}
        <div
          ref={viewportRef}
          onScroll={handleViewportScroll}
          className="flex-1 bg-slate-800 overflow-y-auto overflow-x-auto p-3 sm:p-5 relative"
        >
          {isLoading && (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-white">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--khata-accent)]" />
              <span className="text-xs font-semibold">Loading quotation PDF...</span>
            </div>
          )}

          {!isLoading && error && (
            <div className="h-full flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto space-y-3">
              <AlertCircle className="w-8 h-8 text-rose-500 mx-auto" />
              <p className="text-sm font-bold text-white">{error}</p>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setRetrySeq((s) => s + 1)}
                  className="neu-btn-primary text-xs px-4 py-2 inline-flex items-center gap-1.5 font-bold"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="neu-btn-secondary text-xs px-4 py-2"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {!isLoading && !error && numPages > 0 && (
            <div className="flex flex-col items-center gap-4">
              {Array.from({ length: numPages }, (_, idx) => {
                const pageNumber = idx + 1;
                return (
                  <div
                    key={pageNumber}
                    className="bg-white rounded-lg shadow-xl overflow-hidden border border-slate-700/40"
                    data-testid={`pdf-page-${pageNumber}`}
                  >
                    <canvas
                      ref={(el) => {
                        if (el) {
                          canvasRefs.current.set(pageNumber, el);
                        } else {
                          canvasRefs.current.delete(pageNumber);
                        }
                      }}
                      className="block"
                      aria-label={`Quotation page ${pageNumber} of ${numPages}`}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {pdfBlob && isImageExportOpen && (
        <PdfImageExportModal
          isOpen={isImageExportOpen}
          onClose={() => setIsImageExportOpen(false)}
          title={`Quotation #${docNumber} WebP Images`}
          baseFileName={`Quotation_${docNumber}`}
          fetchPdfBlob={async () => pdfBlob}
        />
      )}
    </div>
  );
};
