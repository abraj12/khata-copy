import React from 'react';
import { Quotation, CreateQuotationPayload } from './quotation.types.js';
import { previewQuotationPdf, fetchSavedQuotationPdfBlob } from './quotationApi.js';
import { PdfDocumentPreviewModal } from '../../components/PdfDocumentPreviewModal.js';

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
  const docNumber =
    quotation?.quotation_number || previewPayload?.quotationNumber || 'Preview';

  const statusBadge = quotation?.status ? (
    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)]">
      {quotation.status}
    </span>
  ) : undefined;

  const fetchPdfBlob = async (signal: AbortSignal): Promise<Blob> => {
    if (quotation?.id) {
      return fetchSavedQuotationPdfBlob(quotation.id, signal);
    }
    if (previewPayload) {
      return previewQuotationPdf(previewPayload, signal);
    }
    throw new Error('No quotation data provided for preview.');
  };

  return (
    <PdfDocumentPreviewModal
      isOpen={isOpen}
      title={`Quotation Document ${quotation?.quotation_number ? `#${quotation.quotation_number}` : '(Preview)'}`}
      subtitle="Official A4 quotation PDF"
      fileName={`Quotation-${docNumber}.pdf`}
      documentLabel="Quotation"
      imageExportBaseName={`Quotation_${docNumber}`}
      fetchPdfBlob={fetchPdfBlob}
      fetchKey={quotation?.id ? `quotation-${quotation.id}` : previewPayload ? `draft-${docNumber}` : 'none'}
      headerBadge={statusBadge}
      onClose={onClose}
    />
  );
};
