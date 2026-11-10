import React, { useState, useEffect } from 'react';
import { X, Download, Printer, Loader2, AlertCircle, FileText } from 'lucide-react';
import { Quotation, CreateQuotationPayload } from './quotation.types.js';
import { previewQuotationPdf, fetchSavedQuotationPdfBlob } from './quotationApi.js';

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
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      if (pdfUrl) {
        URL.revokeObjectURL(pdfUrl);
        setPdfUrl(null);
      }
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    const loadPdf = async () => {
      try {
        let blob: Blob;
        if (quotation?.id) {
          blob = await fetchSavedQuotationPdfBlob(quotation.id);
        } else if (previewPayload) {
          blob = await previewQuotationPdf(previewPayload);
        } else {
          throw new Error('No quotation data provided for preview.');
        }

        if (isMounted) {
          const url = URL.createObjectURL(blob);
          setPdfUrl(url);
          setIsLoading(false);
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err?.message || 'Could not load quotation PDF.');
          setIsLoading(false);
        }
      }
    };

    loadPdf();

    return () => {
      isMounted = false;
    };
  }, [isOpen, quotation, previewPayload]);

  const handlePrint = () => {
    if (!pdfUrl) return;
    const printWindow = window.open(pdfUrl);
    if (printWindow) {
      printWindow.onload = () => {
        printWindow.print();
      };
    }
  };

  const handleDownload = () => {
    if (!pdfUrl) return;
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = `Quotation-${quotation?.quotation_number || 'Preview'}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-[var(--khata-border)]">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shadow-inner"
              style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-accent)' }}
            >
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h3 id="preview-modal-title" className="text-sm sm:text-base font-bold">
                Quotation Document {quotation?.quotation_number ? `#${quotation.quotation_number}` : '(Preview)'}
              </h3>
              <p className="text-[11px] text-[var(--khata-text-muted)]">
                Corporate PDF presentation
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!pdfUrl}
              onClick={handleDownload}
              className="neu-btn-secondary text-xs px-3 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-50"
              title="Download PDF"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Download</span>
            </button>
            <button
              type="button"
              disabled={!pdfUrl}
              onClick={handlePrint}
              className="neu-btn-secondary text-xs px-3 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-50"
              title="Print PDF"
            >
              <Printer className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Print</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] transition"
              aria-label="Close preview"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* PDF Viewer Body */}
        <div className="flex-1 bg-neutral-900 flex items-center justify-center p-1 sm:p-2 relative overflow-hidden">
          {isLoading && (
            <div className="flex flex-col items-center justify-center gap-2 text-white">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--khata-accent)]" />
              <span className="text-xs font-semibold">Generating quotation PDF...</span>
            </div>
          )}

          {error && (
            <div className="p-6 text-center max-w-md space-y-3">
              <AlertCircle className="w-8 h-8 text-rose-500 mx-auto" />
              <p className="text-sm font-bold text-white">{error}</p>
              <button
                type="button"
                onClick={onClose}
                className="neu-btn-secondary text-xs px-4 py-2"
              >
                Close
              </button>
            </div>
          )}

          {pdfUrl && !isLoading && (
            <iframe
              src={`${pdfUrl}#toolbar=0`}
              title="Quotation PDF"
              className="w-full h-full rounded-xl bg-white shadow-lg border-0"
            />
          )}
        </div>
      </div>
    </div>
  );
};
