import React from 'react';
import { X, Eye, Copy, Loader2, AlertCircle, FileText } from 'lucide-react';
import { GstInvoiceRecord } from './gstInvoicesApi.js';
import { NormalBillRecord } from './normalBillsApi.js';

type BillRecordDetailModalProps =
  | {
      variant: 'gst';
      record: GstInvoiceRecord | null;
      isLoading: boolean;
      error: string | null;
      onClose: () => void;
      onPreviewPdf: (record: GstInvoiceRecord) => void;
      onDuplicate: (record: GstInvoiceRecord) => void;
    }
  | {
      variant: 'normal';
      record: NormalBillRecord | null;
      isLoading: boolean;
      error: string | null;
      onClose: () => void;
      onPreviewPdf: (record: NormalBillRecord) => void;
      onDuplicate: (record: NormalBillRecord) => void;
    };

export const BillRecordDetailModal: React.FC<BillRecordDetailModalProps> = (props) => {
  const { isLoading, error, onClose } = props;
  if (!isLoading && !error && !props.record) return null;

  const isGst = props.variant === 'gst';
  const docNum = isGst
    ? props.record?.invoice_number || '...'
    : props.record?.bill_number || '...';
  const docDate = isGst
    ? props.record?.invoice_date || ''
    : props.record?.bill_date || '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={isGst ? 'GST Invoice Details' : 'Normal Bill Details'}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border border-[var(--khata-border)] shadow-2xl overflow-hidden"
        style={{ background: 'var(--khata-surface)', color: 'var(--khata-text)' }}
      >
        <div className="px-4 sm:px-5 py-3.5 border-b border-[var(--khata-border)] flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText className="w-4 h-4 text-[var(--khata-accent)] shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-extrabold truncate">
                {isGst ? `Tax Invoice #${docNum}` : `Normal Bill #${docNum}`}
              </h3>
              {docDate && (
                <p className="text-[11px] text-[var(--khata-text-muted)] font-mono">
                  Date: {docDate}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg border border-[var(--khata-border)] hover:bg-[var(--khata-surface-inset)]"
            aria-label="Close bill details"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4 text-xs">
          {isLoading ? (
            <div className="py-10 flex items-center justify-center gap-2 text-[var(--khata-text-muted)]">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading full record details...</span>
            </div>
          ) : error ? (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-500 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : props.record ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                <div className="space-y-1">
                  <div className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)]">
                    Customer / Receiver
                  </div>
                  <div className="font-bold text-sm">{props.record.customer_name}</div>
                  {props.record.customer_address && (
                    <div className="text-[var(--khata-text-muted)] break-words">
                      {props.record.customer_address}
                    </div>
                  )}
                  {isGst && props.record.customer_gstin && (
                    <div className="font-mono text-[11px]">
                      GSTIN: {props.record.customer_gstin}
                    </div>
                  )}
                  {!isGst && props.record.customer_phone && (
                    <div className="font-mono text-[11px]">
                      Phone: {props.record.customer_phone}
                    </div>
                  )}
                  {(props.record.customer_state || props.record.customer_state_code) && (
                    <div className="text-[11px] text-[var(--khata-text-muted)]">
                      State: {props.record.customer_state} ({props.record.customer_state_code})
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)]">
                    Dispatch &amp; Storage Status
                  </div>
                  <div>
                    Place of Supply: {props.record.place_of_supply || '—'}
                  </div>
                  {props.record.date_of_supply && (
                    <div>Supply Date: {props.record.date_of_supply}</div>
                  )}
                  {(props.record.transportation_mode || props.record.vehicle_number) && (
                    <div>
                      Transport: {[props.record.transportation_mode, props.record.vehicle_number].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  <div>
                    PDF Archive:{' '}
                    <span className="font-semibold uppercase">{props.record.pdf_status}</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase font-bold text-[var(--khata-text-muted)] mb-2">
                  Line Items ({props.record.items?.length || 0})
                </div>
                <div className="overflow-x-auto rounded-xl border border-[var(--khata-border)]">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="bg-[var(--khata-surface-inset)] text-[10px] uppercase text-[var(--khata-text-muted)]">
                      <tr>
                        <th className="py-2 px-3">#</th>
                        <th className="py-2 px-3">Description</th>
                        <th className="py-2 px-3">HSN</th>
                        <th className="py-2 px-3 text-right">Qty</th>
                        <th className="py-2 px-3 text-right">Rate</th>
                        <th className="py-2 px-3 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--khata-border)]">
                      {(props.record.items || []).map((itm, idx) => (
                        <tr key={itm.id ?? idx}>
                          <td className="py-2 px-3 font-mono text-[var(--khata-text-muted)]">{idx + 1}</td>
                          <td className="py-2 px-3 font-medium">{itm.description}</td>
                          <td className="py-2 px-3 font-mono text-[var(--khata-text-muted)]">{itm.hsn_code || '—'}</td>
                          <td className="py-2 px-3 text-right font-mono">
                            {itm.quantity} {itm.unit || ''}
                          </td>
                          <td className="py-2 px-3 text-right font-mono">₹{itm.rate}</td>
                          <td className="py-2 px-3 text-right font-mono font-bold">₹{itm.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] space-y-1.5">
                {props.record.subtotal_amount && (
                  <div className="flex flex-wrap justify-between gap-2 text-[var(--khata-text-muted)]">
                    <span>Items Subtotal:</span>
                    <span className="font-mono font-bold text-[var(--khata-text)]">
                      ₹{props.record.subtotal_amount}
                    </span>
                  </div>
                )}
                {props.record.discount_amount && Number(props.record.discount_amount) > 0 && (
                  <div className="flex flex-wrap justify-between gap-2 text-emerald-600 dark:text-emerald-400">
                    <span>
                      Commercial Discount
                      {props.record.discount_type === 'percentage' && props.record.discount_value
                        ? ` (${props.record.discount_value}%)`
                        : ''}
                      :
                    </span>
                    <span className="font-mono font-bold">-₹{props.record.discount_amount}</span>
                  </div>
                )}

                {props.variant === 'gst' ? (
                  <>
                    <div className="flex flex-wrap justify-between gap-2 text-[var(--khata-text-muted)]">
                      <span>Taxable Amount:</span>
                      <span className="font-mono font-bold text-[var(--khata-text)]">
                        ₹{props.record.taxable_amount}
                      </span>
                    </div>
                    {Number(props.record.cgst_amount) > 0 && (
                      <div className="flex flex-wrap justify-between gap-2 text-[var(--khata-text-muted)]">
                        <span>CGST ({props.record.cgst_rate}%):</span>
                        <span className="font-mono">₹{props.record.cgst_amount}</span>
                      </div>
                    )}
                    {Number(props.record.sgst_amount) > 0 && (
                      <div className="flex flex-wrap justify-between gap-2 text-[var(--khata-text-muted)]">
                        <span>SGST ({props.record.sgst_rate}%):</span>
                        <span className="font-mono">₹{props.record.sgst_amount}</span>
                      </div>
                    )}
                    {Number(props.record.igst_amount) > 0 && (
                      <div className="flex flex-wrap justify-between gap-2 text-[var(--khata-text-muted)]">
                        <span>IGST ({props.record.igst_rate}%):</span>
                        <span className="font-mono">₹{props.record.igst_amount}</span>
                      </div>
                    )}
                    <div className="pt-2 border-t border-[var(--khata-border)] flex flex-wrap justify-between gap-2 text-sm font-extrabold text-[var(--khata-accent)]">
                      <span>Grand Total:</span>
                      <span className="font-mono">₹{props.record.grand_total}</span>
                    </div>
                  </>
                ) : (
                  <div className="pt-2 border-t border-[var(--khata-border)] flex flex-wrap justify-between gap-2 text-sm font-extrabold text-[var(--khata-accent)]">
                    <span>Total Payable:</span>
                    <span className="font-mono">₹{props.record.total_amount}</span>
                  </div>
                )}

                <div className="text-[11px] italic text-[var(--khata-text-muted)] pt-1">
                  <strong>In Words:</strong> {props.record.amount_in_words}
                </div>
                {props.record.notes && (
                  <div className="text-[11px] text-[var(--khata-text-muted)] pt-1 break-words">
                    <strong>Notes:</strong> {props.record.notes}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>

        {props.record && !isLoading && (
          <div className="px-4 sm:px-5 py-3 border-t border-[var(--khata-border)] flex flex-wrap items-center justify-end gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (props.variant === 'gst' && props.record) {
                  props.onDuplicate(props.record);
                } else if (props.variant === 'normal' && props.record) {
                  props.onDuplicate(props.record);
                }
              }}
              className="neu-btn-secondary px-3 py-2 text-xs font-bold inline-flex items-center gap-1.5"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Duplicate into Form</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (props.variant === 'gst' && props.record) {
                  props.onPreviewPdf(props.record);
                } else if (props.variant === 'normal' && props.record) {
                  props.onPreviewPdf(props.record);
                }
              }}
              className="neu-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1.5"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Preview A4 PDF</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
