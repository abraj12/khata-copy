import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Save, X } from 'lucide-react';
import { validateStrictDecimal } from '../../../lib/formatters.js';
import { getBusinessDateISO, isValidBusinessDate } from '../../../utils/businessDate.js';
import type {
  BusinessExpenseRecord,
  ExpenseCategory,
  ExpensePaymentMethod,
  SaveExpensePayload,
} from '../dashboard.types.js';
import {
  EXPENSE_CATEGORY_OPTIONS,
  EXPENSE_PAYMENT_METHOD_OPTIONS,
} from '../dashboardApi.js';

export interface DashboardExpenseFormProps {
  isOpen: boolean;
  editingExpense: BusinessExpenseRecord | null;
  onClose: () => void;
  onSubmit: (payload: SaveExpensePayload, editingId?: string) => Promise<void>;
}

export const DashboardExpenseForm: React.FC<DashboardExpenseFormProps> = ({
  isOpen,
  editingExpense,
  onClose,
  onSubmit,
}) => {
  const [expenseDate, setExpenseDate] = useState(() => getBusinessDateISO());
  const [category, setCategory] = useState<ExpenseCategory>('rent');
  const [title, setTitle] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<ExpensePaymentMethod>('cash');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setSubmitting(false);

    if (editingExpense) {
      setExpenseDate(editingExpense.expenseDate);
      setCategory(editingExpense.category);
      setTitle(editingExpense.title);
      setVendorName(editingExpense.vendorName || '');
      setAmount(editingExpense.amount);
      setPaymentMethod(editingExpense.paymentMethod);
      setReferenceNumber(editingExpense.referenceNumber || '');
      setNotes(editingExpense.notes || '');
      setReason('');
    } else {
      setExpenseDate(getBusinessDateISO());
      setCategory('rent');
      setTitle('');
      setVendorName('');
      setAmount('');
      setPaymentMethod('cash');
      setReferenceNumber('');
      setNotes('');
      setReason('');
    }
  }, [isOpen, editingExpense]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, submitting, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('Expense title is required.');
      return;
    }
    if (!isValidBusinessDate(expenseDate)) {
      setError('Please enter a valid expense date.');
      return;
    }

    const amountErr = validateStrictDecimal(amount, {
      allowNegative: false,
      maxDecimalPlaces: 2,
      fieldName: 'Expense amount',
    });
    if (amountErr) {
      setError(amountErr);
      return;
    }
    if (Number(amount) <= 0) {
      setError('Expense amount must be greater than zero.');
      return;
    }

    const payload: SaveExpensePayload = {
      expenseDate: expenseDate.trim(),
      category,
      title: trimmedTitle,
      vendorName: vendorName.trim() || null,
      amount: amount.trim(),
      paymentMethod,
      referenceNumber: referenceNumber.trim() || null,
      notes: notes.trim() || null,
      ...(editingExpense && reason.trim() ? { reason: reason.trim() } : {}),
    };

    setSubmitting(true);
    try {
      await onSubmit(payload, editingExpense?.id);
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to save operating expense.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="expense-form-title"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="neu-card w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 sm:p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 id="expense-form-title" className="text-lg font-extrabold text-[var(--khata-text)]">
              {editingExpense ? 'Edit Operating Expense' : 'Record Operating Expense'}
            </h3>
            <p className="text-xs text-[var(--khata-text-muted)]">
              Overhead costs such as rent, power bills, salaries & transport (separate from supplier purchase bills).
            </p>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            aria-label="Close expense dialog"
            className="neu-btn-secondary p-2 min-h-[36px]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-xs text-rose-600 dark:text-rose-400 flex items-center gap-2 font-semibold"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
              <span>Expense Date *</span>
              <input
                type="date"
                required
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                className="neu-input text-xs"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
              <span>Category *</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
                className="neu-input text-xs"
              >
                {EXPENSE_CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
            <span>Expense Title / Description *</span>
            <input
              type="text"
              required
              maxLength={200}
              placeholder="e.g. Shop Monthly Rent, Electricity Bill"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="neu-input text-xs"
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
              <span>Amount (₹) *</span>
              <input
                type="text"
                inputMode="decimal"
                required
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="neu-input text-xs font-mono"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
              <span>Payment Method *</span>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as ExpensePaymentMethod)}
                className="neu-input text-xs"
              >
                {EXPENSE_PAYMENT_METHOD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
              <span>Paid To / Vendor (Optional)</span>
              <input
                type="text"
                maxLength={160}
                placeholder="e.g. Landlord / NBPDCL"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                className="neu-input text-xs"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
              <span>UTR / Bill Ref (Optional)</span>
              <input
                type="text"
                maxLength={120}
                placeholder="e.g. UPI-409281"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                className="neu-input text-xs font-mono"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
            <span>Notes (Optional)</span>
            <textarea
              rows={2}
              maxLength={2000}
              placeholder="Optional remarks..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="neu-input text-xs"
            />
          </label>

          {editingExpense && (
            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
              <span>Audit Update Reason (Optional)</span>
              <input
                type="text"
                maxLength={500}
                placeholder="Reason for correcting amount/category..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="neu-input text-xs"
              />
            </label>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="neu-btn-secondary text-xs px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="neu-btn-primary text-xs px-4 py-2 inline-flex items-center gap-1.5"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              <span>{submitting ? 'Saving...' : editingExpense ? 'Update Expense' : 'Save Expense'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
