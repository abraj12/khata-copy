import React, { useState } from 'react';
import { X, ArrowRight, FileText, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { Quotation } from './quotation.types.js';
import { convertQuotationToBill } from './quotationApi.js';
import { formatCurrency } from '../../lib/formatters.js';
import { INDIAN_STATES } from '../../lib/indianStates.js';

export interface QuotationConvertModalProps {
  isOpen: boolean;
  quotation: Quotation | null;
  onClose: () => void;
  onConverted: (billType: 'normal' | 'gst', billId: number, billNumber: string) => void;
}

export const QuotationConvertModal: React.FC<QuotationConvertModalProps> = ({
  isOpen,
  quotation,
  onClose,
  onConverted,
}) => {
  const [billType, setBillType] = useState<'normal' | 'gst'>('normal');
  const [gstRateOverride, setGstRateOverride] = useState<number>(18);
  const [selectedStateCode, setSelectedStateCode] = useState<string>(quotation?.customer_state_code || '10');
  const [force, setForce] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !quotation) return null;

  const isAccepted = quotation.status === 'accepted';
  const todayStr = new Date().toISOString().slice(0, 10);
  const isExpired = Boolean(quotation.valid_until && quotation.valid_until < todayStr);
  const requiresForce = !isAccepted || isExpired;

  const handleConvert = async () => {
    setIsSubmitting(true);
    setError(null);

    try {
      const appliedRate = (!quotation.gst_enabled && billType === 'gst') ? gstRateOverride : undefined;
      const selectedStateObj = INDIAN_STATES.find((s) => s.code === selectedStateCode);
      const custState = quotation.customer_state || selectedStateObj?.name;
      const custStateCode = quotation.customer_state_code || selectedStateCode;
      const result = await convertQuotationToBill(quotation.id, billType, force, appliedRate, custState, custStateCode);
      onConverted(result.billType, result.billId, result.billNumber);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to convert quotation to bill.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="convert-modal-title"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[var(--khata-border)] shadow-2xl overflow-hidden p-6 space-y-5"
        style={{ background: 'var(--khata-surface)', color: 'var(--khata-text)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[var(--khata-border)]">
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shadow-inner"
              style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-accent)' }}
            >
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 id="convert-modal-title" className="text-base font-bold">
                Convert to Official Bill
              </h3>
              <p className="text-[11px] text-[var(--khata-text-muted)]">
                Quotation #{quotation.quotation_number}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] transition"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quotation Info Summary */}
        <div className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-[var(--khata-text-muted)]">Customer:</span>
            <span className="font-bold">{quotation.customer_name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--khata-text-muted)]">Grand Total:</span>
            <span className="font-bold text-[var(--khata-accent)]">₹{formatCurrency(quotation.grand_total)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--khata-text-muted)]">Status:</span>
            <span
              className={`font-bold capitalize px-2 py-0.5 rounded text-[10px] ${
                isAccepted
                  ? 'bg-emerald-500/20 text-emerald-500'
                  : 'bg-amber-500/20 text-amber-500'
              }`}
            >
              {quotation.status}
            </span>
          </div>
          {quotation.valid_until && (
            <div className="flex justify-between">
              <span className="text-[var(--khata-text-muted)]">Valid Until:</span>
              <span className={`font-medium ${isExpired ? 'text-rose-500 font-bold' : ''}`}>
                {quotation.valid_until} {isExpired ? '(Expired)' : ''}
              </span>
            </div>
          )}
        </div>

        {/* Warning if expired or not accepted */}
        {requiresForce && (
          <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-500 text-xs space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                {!isAccepted && (
                  <p>
                    Standard workflow requires quotations to be <strong>Accepted</strong> before conversion.
                  </p>
                )}
                {isExpired && (
                  <p>
                    This quotation has <strong>expired</strong> on {quotation.valid_until}.
                  </p>
                )}
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer font-bold pt-1">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="rounded accent-[var(--khata-accent)]"
              />
              <span>I confirm and authorize conversion with force=true</span>
            </label>
          </div>
        )}

        {/* Bill Type Selector */}
        <div className="space-y-2">
          <label className="block text-xs font-bold uppercase text-[var(--khata-text-muted)]">
            Select Bill Type to Generate:
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setBillType('normal')}
              className={`p-3 rounded-xl border text-left transition flex flex-col justify-between ${
                billType === 'normal'
                  ? 'border-[var(--khata-accent)] bg-[var(--khata-accent)]/10 text-[var(--khata-text)]'
                  : 'border-[var(--khata-border)] bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)]'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-xs text-[var(--khata-text)]">Normal Bill</span>
                {billType === 'normal' && <CheckCircle className="w-3.5 h-3.5 text-[var(--khata-accent)]" />}
              </div>
              <span className="text-[10px] text-[var(--khata-text-muted)]">
                Standard non-GST commercial retail bill
              </span>
            </button>

            <button
              type="button"
              onClick={() => setBillType('gst')}
              className={`p-3 rounded-xl border text-left transition flex flex-col justify-between ${
                billType === 'gst'
                  ? 'border-[var(--khata-accent)] bg-[var(--khata-accent)]/10 text-[var(--khata-text)]'
                  : 'border-[var(--khata-border)] bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)]'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-xs text-[var(--khata-text)]">GST Tax Invoice</span>
                {billType === 'gst' && <CheckCircle className="w-3.5 h-3.5 text-[var(--khata-accent)]" />}
              </div>
              <span className="text-[10px] text-[var(--khata-text-muted)]">
                Formal GST Tax Invoice with CGST/SGST/IGST breakdown
              </span>
            </button>
          </div>
        </div>

        {/* Buyer State selector for legacy quotations missing state code */}
        {billType === 'gst' && !quotation.customer_state_code && (
          <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs space-y-2">
            <div className="flex items-center gap-2 text-amber-500 font-bold">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>Legacy Quotation: Buyer State Required</span>
            </div>
            <p className="text-[11px] text-[var(--khata-text-muted)]">
              This quotation was created without recorded buyer state. Select the customer's state for accurate GST tax calculation:
            </p>
            <select
              value={selectedStateCode}
              onChange={(e) => setSelectedStateCode(e.target.value)}
              className="neu-input w-full text-xs font-medium"
            >
              {INDIAN_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} – {s.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Explicit GST Rate selector when converting GST-disabled quotation to GST Tax Invoice */}
        {billType === 'gst' && !quotation.gst_enabled && (
          <div className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-2">
            <label className="block text-xs font-bold text-[var(--khata-text)]">
              Specify Applicable GST Rate:
            </label>
            <p className="text-[11px] text-[var(--khata-text-muted)]">
              This quotation was created without GST. Select the tax rate to apply for the tax invoice:
            </p>
            <div className="grid grid-cols-4 gap-2 pt-1">
              {[0, 5, 12, 18, 28].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => setGstRateOverride(rate)}
                  className={`py-1.5 rounded-lg border text-xs font-bold transition ${
                    gstRateOverride === rate
                      ? 'border-[var(--khata-accent)] bg-[var(--khata-accent)] text-white'
                      : 'border-[var(--khata-border)] bg-[var(--khata-surface)] text-[var(--khata-text)]'
                  }`}
                >
                  {rate}%
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 text-rose-500 text-xs rounded-xl font-medium">
            {error}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="neu-btn-secondary text-xs px-4 py-2 flex-1 sm:flex-initial text-center justify-center"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSubmitting || (requiresForce && !force)}
            onClick={handleConvert}
            className="neu-btn-primary text-xs px-5 py-2 font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50 flex-1 sm:flex-initial"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Converting...</span>
              </>
            ) : (
              <>
                <span>Convert to {billType === 'normal' ? 'Normal Bill' : 'GST Invoice'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
