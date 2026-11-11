import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  Download,
  Share2,
  Image as ImageIcon,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import {
  ExportedPdfPageImage,
  PdfImageExportProgress,
  canUseNativeFileShare,
  cleanupExportedPageImages,
  downloadExportedPageImages,
  exportPdfBlobToWebpPages,
  shareOrDownloadPdfImages,
} from '../utils/pdfImageExporter';
import { downloadBlobSafely } from '../utils/blobDownload';

export interface PdfImageExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  baseFileName: string;
  fetchPdfBlob: (signal: AbortSignal) => Promise<Blob>;
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb >= 100 ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`;
}

export const PdfImageExportModal: React.FC<PdfImageExportModalProps> = ({
  isOpen,
  onClose,
  title,
  baseFileName,
  fetchPdfBlob,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<PdfImageExportProgress | null>(null);
  const [pages, setPages] = useState<ExportedPdfPageImage[]>([]);
  const [retryCount, setRetryCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const pagesRef = useRef<ExportedPdfPageImage[]>([]);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    if (!isOpen) {
      cleanupExportedPageImages(pagesRef.current);
      pagesRef.current = [];
      setPages([]);
      setError(null);
      setProgress(null);
      setStatusMessage(null);
      return;
    }

    const controller = new AbortController();
    let active = true;

    async function runConversion() {
      cleanupExportedPageImages(pagesRef.current);
      pagesRef.current = [];
      setPages([]);
      setLoading(true);
      setError(null);
      setProgress(null);
      setStatusMessage(null);

      try {
        const pdfBlob = await fetchPdfBlob(controller.signal);
        if (!active || controller.signal.aborted) return;

        const exported = await exportPdfBlobToWebpPages({
          blob: pdfBlob,
          baseFileName,
          quality: 0.85,
          maxWidth: 1400,
          signal: controller.signal,
          onProgress: (p) => {
            if (active) setProgress(p);
          },
        });

        if (!active || controller.signal.aborted) {
          cleanupExportedPageImages(exported);
          return;
        }
        pagesRef.current = exported;
        setPages(exported);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError' || !active) return;
        setError((err as Error)?.message || 'Failed to render document pages as images.');
      } finally {
        if (active) setLoading(false);
      }
    }

    runConversion();

    return () => {
      active = false;
      controller.abort();
      cleanupExportedPageImages(pagesRef.current);
      pagesRef.current = [];
    };
  }, [isOpen, baseFileName, fetchPdfBlob, retryCount]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const canShare = canUseNativeFileShare(pages);
  const totalKb = pages.reduce((acc, p) => acc + p.sizeBytes, 0);

  const handleShareOrDownload = async () => {
    if (pages.length === 0) return;
    const result = await shareOrDownloadPdfImages(pages, title);
    if (result.method === 'download') {
      setStatusMessage(`Downloaded ${pages.length} WebP image${pages.length === 1 ? '' : 's'}.`);
    }
  };

  const handleDownloadAll = () => {
    if (pages.length === 0) return;
    downloadExportedPageImages(pages);
    setStatusMessage(`Started download for ${pages.length} WebP image${pages.length === 1 ? '' : 's'}.`);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="px-4 sm:px-6 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50">
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
              <ImageIcon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-bold text-slate-900 truncate">{title}</h3>
              <p className="text-xs text-slate-500">
                {pages.length > 0
                  ? `${pages.length} page${pages.length === 1 ? '' : 's'} ready (.webp, ${formatKb(totalKb)} total)`
                  : 'Crisp compressed WebP export for WhatsApp & mobile'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-200 rounded-lg transition-colors"
            title="Close image exporter"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-slate-100 p-3 sm:p-5">
          {loading && (
            <div className="py-16 flex flex-col items-center justify-center text-slate-600 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
              <p className="text-sm font-medium text-slate-700">
                {progress
                  ? `Rendering page ${progress.currentPage} of ${progress.totalPages} to WebP...`
                  : 'Loading document & preparing crisp images...'}
              </p>
            </div>
          )}

          {!loading && error && (
            <div className="py-14 px-4 flex flex-col items-center justify-center text-center gap-3">
              <div className="w-11 h-11 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center">
                <AlertCircle className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-rose-700 max-w-md">{error}</p>
              <button
                type="button"
                onClick={() => setRetryCount((c) => c + 1)}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Retry Image Export
              </button>
            </div>
          )}

          {!loading && !error && pages.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {pages.map((page) => (
                <div
                  key={page.fileName}
                  className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col"
                >
                  <div className="px-3 py-2 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2 bg-slate-50">
                    <span className="text-xs font-semibold text-slate-700 truncate">
                      Page {page.pageNumber} of {page.totalPages}
                    </span>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <span className="text-[11px] text-slate-500 font-medium">
                        {formatKb(page.sizeBytes)}
                      </span>
                      <button
                        type="button"
                        onClick={() => downloadBlobSafely(page.blob, page.fileName)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-md transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Save Page
                      </button>
                    </div>
                  </div>
                  <div className="p-2 bg-slate-200/60 flex items-center justify-center">
                    <img
                      src={page.previewUrl}
                      alt={`${title} - Page ${page.pageNumber}`}
                      className="max-h-80 w-auto rounded border border-slate-300 bg-white shadow-xs object-contain"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 sm:px-6 py-3 border-t border-slate-200 bg-white flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-slate-500">
            {statusMessage ||
              (pages.length > 0 ? `${pages[0].fileName}${pages.length > 1 ? ` (+${pages.length - 1} more)` : ''}` : '')}
          </div>
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={handleDownloadAll}
              disabled={loading || pages.length === 0}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs sm:text-sm font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors"
            >
              <Download className="w-4 h-4" />
              {pages.length > 1 ? `Download All (${pages.length})` : 'Download WebP'}
            </button>

            <button
              type="button"
              onClick={handleShareOrDownload}
              disabled={loading || pages.length === 0}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              <Share2 className="w-4 h-4" />
              {canShare ? 'Share Image(s)' : 'Save for WhatsApp'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
