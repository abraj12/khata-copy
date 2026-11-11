import React, { useEffect, useState } from 'react';
import Decimal from 'decimal.js';
import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  Loader2,
  Plus,
  Printer,
  Wand2,
  X,
} from 'lucide-react';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import { validateSellingRateInput } from '../../utils/lineItemDraft.js';
import { safeDecimal } from '../../lib/formatters.js';
import {
  allocateSupplierAdvanceApi,
  computeAutoFifoBillAllocations,
  createSupplierPaymentApi,
  formatAbsRupees,
  getSupplierPaymentApi,
  listPurchaseBillsApi,
  listSupplierPaymentsApi,
  listSuppliersApi,
} from './suppliersApi.js';
import type {
  PurchaseBillSummary,
  SupplierPaymentMethod,
  SupplierPaymentRecord,
  SupplierRecord,
} from './suppliers.types.js';

export interface SupplierPaymentsViewProps {
  initialSupplierFilter?: string;
  openCreateSignal?: number;
  preselectedSupplierId?: string;
  onDataChanged: () => void;
}

const PAYMENT_METHODS: Array<{ value: SupplierPaymentMethod; label: string }> = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank Transfer (NEFT/IMPS/RTGS)' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
];

export const SupplierPaymentsView: React.FC<SupplierPaymentsViewProps> = ({
  initialSupplierFilter = '',
  openCreateSignal = 0,
  preselectedSupplierId = '',
  onDataChanged,
}) => {
  const [payments, setPayments] = useState<SupplierPaymentRecord[]>([]);
  const [allSuppliers, setAllSuppliers] = useState<SupplierRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [supplierFilter, setSupplierFilter] = useState(initialSupplierFilter);
  const [methodFilter, setMethodFilter] = useState<SupplierPaymentMethod | ''>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Create Payment Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [formSupplierId, setFormSupplierId] = useState('');
  const [paymentDate, setPaymentDate] = useState(() => getBusinessDateISO());
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<SupplierPaymentMethod>('bank_transfer');
  const [transactionReference, setTransactionReference] = useState('');
  const [notes, setNotes] = useState('');
  const [openBills, setOpenBills] = useState<PurchaseBillSummary[]>([]);
  const [loadingOpenBills, setLoadingOpenBills] = useState(false);
  const [allocMap, setAllocMap] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Allocate Later Modal (for Unallocated Advance Payments)
  const [advancePayment, setAdvancePayment] = useState<SupplierPaymentRecord | null>(null);
  const [advanceOpenBills, setAdvanceOpenBills] = useState<PurchaseBillSummary[]>([]);
  const [advanceAllocMap, setAdvanceAllocMap] = useState<Record<number, string>>({});
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [submittingAdvance, setSubmittingAdvance] = useState(false);

  // Printable Receipt Modal
  const [receiptPayment, setReceiptPayment] = useState<SupplierPaymentRecord | null>(null);
  const [loadingReceipt, setLoadingReceipt] = useState(false);

  useEffect(() => {
    setSupplierFilter(initialSupplierFilter);
  }, [initialSupplierFilter]);

  const loadSuppliers = async () => {
    try {
      const res = await listSuppliersApi({ status: 'all', limit: 200 });
      setAllSuppliers(res.suppliers);
    } catch {
      // Handled cleanly
    }
  };

  const loadPayments = async () => {
    setLoading(true);
    try {
      const res = await listSupplierPaymentsApi({
        supplierId: supplierFilter || undefined,
        paymentMethod: methodFilter || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        limit: 200,
      });
      setPayments(res.payments);
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Failed to load supplier payments.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSuppliers();
  }, []);

  useEffect(() => {
    void loadPayments();
  }, [supplierFilter, methodFilter, fromDate, toDate]);

  useEffect(() => {
    if (openCreateSignal > 0) {
      void openCreateModal(preselectedSupplierId || supplierFilter);
    }
  }, [openCreateSignal]);

  const activeSuppliers = allSuppliers.filter((s) => !s.archivedAt);

  const loadOpenBillsForSupplier = async (supId: string) => {
    if (!supId) {
      setOpenBills([]);
      return;
    }
    setLoadingOpenBills(true);
    try {
      const res = await listPurchaseBillsApi({ supplierId: supId, openOnly: true, limit: 200 });
      setOpenBills(res.purchaseBills);
    } catch {
      setOpenBills([]);
    } finally {
      setLoadingOpenBills(false);
    }
  };

  const openCreateModal = async (defaultSupId = '') => {
    const initialSup = defaultSupId || activeSuppliers[0]?.id || '';
    setFormSupplierId(initialSup);
    setPaymentDate(getBusinessDateISO());
    setAmount('');
    setPaymentMethod('bank_transfer');
    setTransactionReference('');
    setNotes('');
    setAllocMap({});
    setFormError(null);
    setCreateOpen(true);
    if (initialSup) {
      await loadOpenBillsForSupplier(initialSup);
    }
  };

  const handleCreateSupplierChange = async (supId: string) => {
    setFormSupplierId(supId);
    setAllocMap({});
    await loadOpenBillsForSupplier(supId);
  };

  const handleAutoFifoAllocate = () => {
    const computed = computeAutoFifoBillAllocations(amount, openBills);
    setAllocMap(computed);
  };

  const totalAllocatedInput = Object.values(allocMap).reduce(
    (sum, val) => sum.plus(safeDecimal(val)),
    new Decimal(0)
  );
  const parsedPayAmount = safeDecimal(amount);
  const projectedUnallocated = Decimal.max(
    parsedPayAmount.minus(totalAllocatedInput),
    new Decimal(0)
  );

  const handleSavePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formSupplierId) {
      setFormError('Please select a supplier.');
      return;
    }
    const amtErr = validateSellingRateInput(amount, 'Payment amount');
    if (amtErr || safeDecimal(amount).lessThanOrEqualTo(0)) {
      setFormError('Payment amount must be greater than 0 (max 2 decimal places).');
      return;
    }

    const allocationsPayload: Array<{ purchaseBillId: number; amount: string }> = [];
    for (const bill of openBills) {
      const raw = (allocMap[bill.id] || '').trim();
      if (!raw || safeDecimal(raw).isZero()) continue;
      const err = validateSellingRateInput(raw, `Allocation for ${bill.invoiceNumber}`);
      if (err) {
        setFormError(err);
        return;
      }
      const d = safeDecimal(raw);
      if (d.greaterThan(safeDecimal(bill.remainingAmount))) {
        setFormError(
          `Allocation for ${bill.invoiceNumber} (${formatAbsRupees(d)}) exceeds bill due (${formatAbsRupees(bill.remainingAmount)}).`
        );
        return;
      }
      allocationsPayload.push({ purchaseBillId: bill.id, amount: d.toFixed(2) });
    }

    if (totalAllocatedInput.greaterThan(parsedPayAmount)) {
      setFormError('Total allocated amount cannot exceed total payment amount.');
      return;
    }

    setFormError(null);
    setSubmitting(true);
    try {
      const created = await createSupplierPaymentApi({
        supplierId: formSupplierId,
        paymentDate,
        amount: parsedPayAmount.toFixed(2),
        paymentMethod,
        transactionReference: transactionReference.trim() || null,
        notes: notes.trim() || null,
        allocations: allocationsPayload,
      });
      setCreateOpen(false);
      setReceiptPayment(created);
      setNotice({
        type: 'success',
        text: `Payment ${created.receiptNumber} (${formatAbsRupees(created.amount)}) recorded.`,
      });
      onDataChanged();
      await loadPayments();
    } catch (err: any) {
      setFormError(err?.message || 'Failed to record supplier payment.');
    } finally {
      setSubmitting(false);
    }
  };

  const openAllocateAdvanceModal = async (payment: SupplierPaymentRecord) => {
    setAdvancePayment(payment);
    setAdvanceAllocMap({});
    setAdvanceError(null);
    try {
      const res = await listPurchaseBillsApi({
        supplierId: payment.supplierId,
        openOnly: true,
        limit: 200,
      });
      setAdvanceOpenBills(res.purchaseBills);
    } catch {
      setAdvanceOpenBills([]);
    }
  };

  const handleConfirmAdvanceAllocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!advancePayment) return;

    const payload: Array<{ purchaseBillId: number; amount: string }> = [];
    let totalReq = new Decimal(0);
    for (const bill of advanceOpenBills) {
      const raw = (advanceAllocMap[bill.id] || '').trim();
      if (!raw || safeDecimal(raw).isZero()) continue;
      const err = validateSellingRateInput(raw, `Allocation for ${bill.invoiceNumber}`);
      if (err) {
        setAdvanceError(err);
        return;
      }
      const dec = safeDecimal(raw);
      if (dec.greaterThan(safeDecimal(bill.remainingAmount))) {
        setAdvanceError(
          `Allocation for ${bill.invoiceNumber} exceeds remaining bill due (${formatAbsRupees(bill.remainingAmount)}).`
        );
        return;
      }
      totalReq = totalReq.plus(dec);
      payload.push({ purchaseBillId: bill.id, amount: dec.toFixed(2) });
    }

    if (payload.length === 0) {
      setAdvanceError('Enter at least one allocation amount.');
      return;
    }
    if (totalReq.greaterThan(safeDecimal(advancePayment.unallocatedAmount))) {
      setAdvanceError(
        `Total allocated (${formatAbsRupees(totalReq)}) exceeds available advance (${formatAbsRupees(advancePayment.unallocatedAmount)}).`
      );
      return;
    }

    setAdvanceError(null);
    setSubmittingAdvance(true);
    try {
      await allocateSupplierAdvanceApi(advancePayment.id, payload);
      setAdvancePayment(null);
      setNotice({
        type: 'success',
        text: `Allocated ${formatAbsRupees(totalReq)} from ${advancePayment.receiptNumber}.`,
      });
      onDataChanged();
      await loadPayments();
    } catch (err: any) {
      setAdvanceError(err?.message || 'Failed to allocate advance.');
    } finally {
      setSubmittingAdvance(false);
    }
  };

  const handleViewReceipt = async (paymentId: number) => {
    setLoadingReceipt(true);
    try {
      const full = await getSupplierPaymentApi(paymentId);
      setReceiptPayment(full);
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Unable to load payment receipt.' });
    } finally {
      setLoadingReceipt(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className={receiptPayment ? 'print:hidden space-y-4' : 'space-y-4'}>
        {notice && (
          <div
            className={`p-3 rounded-xl text-xs font-semibold flex items-center justify-between gap-2 ${
              notice.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                : 'bg-rose-500/10 border border-rose-500/30 text-rose-700 dark:text-rose-300'
            }`}
          >
            <div className="flex items-center gap-2">
              {notice.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
              )}
              <span>{notice.text}</span>
            </div>
            <button type="button" onClick={() => setNotice(null)} className="p-0.5">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Header & Filters */}
        <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-extrabold text-[var(--khata-text)]">
                Supplier Payments &amp; Receipts
              </h3>
              <p className="text-xs text-[var(--khata-text-muted)]">
                Record full, partial, multi-bill payments, or unallocated advances with atomic receipts
              </p>
            </div>
            <button
              type="button"
              onClick={() => void openCreateModal(supplierFilter)}
              className="neu-btn-primary text-xs px-4 py-2 font-bold inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Record Payment</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <select
              value={supplierFilter}
              onChange={(e) => setSupplierFilter(e.target.value)}
              className="neu-input text-xs font-semibold"
            >
              <option value="">All Suppliers</option>
              {allSuppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.archivedAt ? ' [Archived]' : ''}
                </option>
              ))}
            </select>

            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value as SupplierPaymentMethod | '')}
              className="neu-input text-xs font-semibold"
            >
              <option value="">All Payment Methods</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>

            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="neu-input text-xs font-mono"
            />
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="neu-input text-xs font-mono"
            />
          </div>
        </div>

        {/* Payments Table / Cards */}
        {loading ? (
          <div className="neu-card p-10 rounded-2xl flex items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
            <span>Loading supplier payments...</span>
          </div>
        ) : payments.length === 0 ? (
          <div className="neu-card p-10 rounded-2xl text-center text-xs text-[var(--khata-text-muted)]">
            No supplier payments found.
          </div>
        ) : (
          <div className="neu-card p-4 rounded-2xl space-y-3">
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[var(--khata-border)] text-[11px] uppercase tracking-wider text-[var(--khata-text-muted)]">
                    <th className="py-2.5 px-3">Receipt #</th>
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">Supplier</th>
                    <th className="py-2.5 px-3">Method &amp; Ref</th>
                    <th className="py-2.5 px-3 text-right">Amount</th>
                    <th className="py-2.5 px-3 text-right">Allocated</th>
                    <th className="py-2.5 px-3 text-right">Advance</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--khata-border)]/60">
                  {payments.map((p) => (
                    <tr key={p.id} className="hover:bg-[var(--khata-surface-inset)]/35">
                      <td className="py-3 px-3 font-mono font-bold text-[var(--khata-text)]">
                        {p.receiptNumber}
                      </td>
                      <td className="py-3 px-3 font-mono text-[var(--khata-text-muted)]">
                        {p.paymentDate}
                      </td>
                      <td className="py-3 px-3 font-semibold text-[var(--khata-text)]">
                        {p.supplierName}
                      </td>
                      <td className="py-3 px-3">
                        <span className="uppercase font-bold text-[11px]">
                          {p.paymentMethod.replace('_', ' ')}
                        </span>
                        {p.transactionReference && (
                          <div className="text-[10px] font-mono text-[var(--khata-text-muted)]">
                            Ref: {p.transactionReference}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {formatAbsRupees(p.amount)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono">
                        {formatAbsRupees(p.allocatedAmount)}
                        {p.allocations.length > 0 && (
                          <div className="text-[10px] text-[var(--khata-text-muted)]">
                            {p.allocations.map((a) => a.invoiceNumber).join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-semibold text-amber-600 dark:text-amber-400">
                        {formatAbsRupees(p.unallocatedAmount)}
                      </td>
                      <td className="py-3 px-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void handleViewReceipt(p.id)}
                            className="neu-btn-secondary text-[11px] px-2.5 py-1 min-h-0 inline-flex items-center gap-1"
                          >
                            <Printer className="w-3.5 h-3.5" />
                            <span>Receipt</span>
                          </button>
                          {safeDecimal(p.unallocatedAmount).greaterThan(0) && !p.supplierArchivedAt && (
                            <button
                              type="button"
                              onClick={() => void openAllocateAdvanceModal(p)}
                              className="neu-btn-primary text-[11px] px-2.5 py-1 min-h-0"
                            >
                              Allocate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden space-y-2.5">
              {payments.map((p) => (
                <div
                  key={p.id}
                  className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/25 space-y-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono font-bold text-sm text-[var(--khata-text)]">
                        {p.receiptNumber}
                      </div>
                      <div className="font-semibold text-[var(--khata-text)]">{p.supplierName}</div>
                      <div className="text-[11px] text-[var(--khata-text-muted)]">
                        {p.paymentDate} · {p.paymentMethod.replace('_', ' ').toUpperCase()}
                      </div>
                    </div>
                    <div className="font-mono font-black text-sm text-emerald-600 dark:text-emerald-400">
                      {formatAbsRupees(p.amount)}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-between text-[11px] pt-2 border-t border-[var(--khata-border)]/60">
                    <span>Allocated: {formatAbsRupees(p.allocatedAmount)}</span>
                    <span>Advance: {formatAbsRupees(p.unallocatedAmount)}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleViewReceipt(p.id)}
                      className="neu-btn-secondary text-[11px] px-3 py-1.5 min-h-0"
                    >
                      View / Print Receipt
                    </button>
                    {safeDecimal(p.unallocatedAmount).greaterThan(0) && !p.supplierArchivedAt && (
                      <button
                        type="button"
                        onClick={() => void openAllocateAdvanceModal(p)}
                        className="neu-btn-primary text-[11px] px-3 py-1.5 min-h-0"
                      >
                        Allocate Advance
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Record Supplier Payment Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto print:hidden">
          <div className="neu-card w-full max-w-3xl rounded-2xl p-4 sm:p-6 my-4 space-y-4 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-3">
              <div className="flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-emerald-600" />
                <h3 className="text-base font-extrabold text-[var(--khata-text)]">
                  Record Supplier Payment
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs font-semibold">
                {formError}
              </div>
            )}

            <form onSubmit={handleSavePayment} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Supplier <span className="text-rose-500">*</span>
                  </label>
                  <select
                    required
                    value={formSupplierId}
                    onChange={(e) => void handleCreateSupplierChange(e.target.value)}
                    className="neu-input w-full text-xs font-semibold"
                  >
                    <option value="">-- Select Supplier --</option>
                    {activeSuppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} (Payable: {formatAbsRupees(s.outstandingPayable)})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Payment Date <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="neu-input w-full text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Amount Paid (₹) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="neu-input w-full text-sm font-mono font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Payment Method
                  </label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as SupplierPaymentMethod)}
                    className="neu-input w-full text-xs font-semibold"
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Reference / UTR / Cheque #
                  </label>
                  <input
                    type="text"
                    value={transactionReference}
                    onChange={(e) => setTransactionReference(e.target.value)}
                    placeholder="Optional"
                    className="neu-input w-full text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                  Notes
                </label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional payment memo or remarks"
                  className="neu-input w-full text-xs"
                />
              </div>

              {/* Multi-Bill Allocation Table */}
              <div className="border-t border-[var(--khata-border)] pt-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-extrabold uppercase text-[var(--khata-text)]">
                      Allocate to Purchase Bills (Optional — Leave blank for Advance)
                    </h4>
                    <p className="text-[11px] text-[var(--khata-text-muted)]">
                      Allocated: {formatAbsRupees(totalAllocatedInput)} · Unallocated Advance:{' '}
                      <span className="font-mono font-bold">
                        {formatAbsRupees(projectedUnallocated)}
                      </span>
                    </p>
                  </div>
                  {openBills.length > 0 && (
                    <button
                      type="button"
                      onClick={handleAutoFifoAllocate}
                      disabled={parsedPayAmount.lessThanOrEqualTo(0)}
                      className="neu-btn-secondary text-xs px-3 py-1.5 min-h-0 font-bold inline-flex items-center gap-1.5 disabled:opacity-40"
                    >
                      <Wand2 className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                      <span>Auto-Allocate FIFO</span>
                    </button>
                  )}
                </div>

                {loadingOpenBills ? (
                  <div className="py-4 text-center text-xs text-[var(--khata-text-muted)]">
                    Loading unpaid bills for this supplier...
                  </div>
                ) : openBills.length === 0 ? (
                  <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/30 text-xs text-[var(--khata-text-muted)]">
                    No open purchase bills for this supplier. This payment will be recorded as an unallocated advance.
                  </div>
                ) : (
                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {openBills.map((b) => (
                      <div
                        key={b.id}
                        className="p-2.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/25 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div>
                          <div className="font-mono font-bold">{b.invoiceNumber}</div>
                          <div className="text-[11px] text-[var(--khata-text-muted)]">
                            {b.invoiceDate} · Bill: {formatAbsRupees(b.grandTotal)} · Remaining Due:{' '}
                            <span className="font-mono font-bold text-rose-600 dark:text-rose-400">
                              {formatAbsRupees(b.remainingAmount)}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={allocMap[b.id] || ''}
                            onChange={(e) =>
                              setAllocMap((prev) => ({ ...prev, [b.id]: e.target.value }))
                            }
                            placeholder="0.00"
                            className="neu-input w-28 text-xs font-mono font-bold text-right py-1"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setAllocMap((prev) => ({
                                ...prev,
                                [b.id]: b.remainingAmount,
                              }))
                            }
                            className="px-2 py-1 rounded-lg bg-[var(--khata-surface-inset)] text-[10px] font-bold hover:bg-[var(--khata-accent)]/15"
                          >
                            Full
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-[var(--khata-border)]">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="neu-btn-secondary px-4 py-2 text-xs font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="neu-btn-primary px-5 py-2 text-xs font-bold inline-flex items-center gap-1.5"
                >
                  {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Save Payment &amp; Generate Receipt</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Allocate Unallocated Advance Modal */}
      {advancePayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto print:hidden">
          <div className="neu-card w-full max-w-2xl rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-3">
              <div>
                <h3 className="text-base font-extrabold text-[var(--khata-text)]">
                  Allocate Advance · {advancePayment.receiptNumber}
                </h3>
                <p className="text-xs text-[var(--khata-text-muted)]">
                  Available unallocated advance:{' '}
                  <span className="font-mono font-bold text-amber-600 dark:text-amber-400">
                    {formatAbsRupees(advancePayment.unallocatedAmount)}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAdvancePayment(null)}
                className="p-1.5 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {advanceError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 text-xs font-semibold">
                {advanceError}
              </div>
            )}

            <form onSubmit={handleConfirmAdvanceAllocation} className="space-y-3">
              {advanceOpenBills.length === 0 ? (
                <p className="text-xs text-[var(--khata-text-muted)] py-4">
                  This supplier currently has no open purchase bills to allocate against.
                </p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {advanceOpenBills.map((b) => (
                    <div
                      key={b.id}
                      className="p-3 rounded-xl border border-[var(--khata-border)] flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div>
                        <div className="font-mono font-bold">{b.invoiceNumber}</div>
                        <div className="text-[11px] text-[var(--khata-text-muted)]">
                          {b.invoiceDate} · Due: {formatAbsRupees(b.remainingAmount)}
                        </div>
                      </div>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={advanceAllocMap[b.id] || ''}
                        onChange={(e) =>
                          setAdvanceAllocMap((prev) => ({ ...prev, [b.id]: e.target.value }))
                        }
                        placeholder="0.00"
                        className="neu-input w-28 text-xs font-mono font-bold text-right"
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-[var(--khata-border)]">
                <button
                  type="button"
                  onClick={() => setAdvancePayment(null)}
                  className="neu-btn-secondary px-4 py-2 text-xs font-bold"
                >
                  Close
                </button>
                {advanceOpenBills.length > 0 && (
                  <button
                    type="submit"
                    disabled={submittingAdvance}
                    className="neu-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1.5"
                  >
                    {submittingAdvance && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>Apply Allocation</span>
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Printable Payment Receipt Modal */}
      {(receiptPayment || loadingReceipt) && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm p-2 sm:p-4 mhi-print-modal-container">
          <div className="max-w-2xl mx-auto space-y-3">
            <div className="flex items-center justify-between text-white mhi-no-print print:hidden">
              <span className="text-xs sm:text-sm font-bold">
                Supplier Payment Receipt · {receiptPayment?.receiptNumber || 'Loading...'}
              </span>
              <div className="flex items-center gap-2">
                {receiptPayment && (
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="px-3 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white text-xs font-bold inline-flex items-center gap-1.5"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>Print Receipt</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setReceiptPayment(null)}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/80 hover:bg-rose-600 text-white text-xs font-bold inline-flex items-center gap-1"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Close</span>
                </button>
              </div>
            </div>

            {loadingReceipt || !receiptPayment ? (
              <div className="neu-card p-10 rounded-2xl flex items-center justify-center gap-2 text-xs">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
                <span>Loading payment receipt...</span>
              </div>
            ) : (
              <div className="bg-white text-slate-900 rounded-2xl p-6 sm:p-8 shadow-xl border border-slate-200 space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-4">
                  <div>
                    <h2 className="text-lg font-black uppercase tracking-tight">
                      Supplier Payment Receipt
                    </h2>
                    <div className="text-xs font-mono font-bold text-slate-700 mt-1">
                      Receipt No: {receiptPayment.receiptNumber}
                    </div>
                    <div className="text-xs text-slate-600">
                      Payment Date: <span className="font-mono">{receiptPayment.paymentDate}</span>
                    </div>
                  </div>
                  <div className="text-right text-xs space-y-0.5">
                    <div className="font-black text-sm">{receiptPayment.supplierName}</div>
                    {receiptPayment.supplierPhone && (
                      <div className="font-mono text-slate-600">{receiptPayment.supplierPhone}</div>
                    )}
                    {receiptPayment.supplierGstin && (
                      <div className="font-mono text-slate-600">
                        GSTIN: {receiptPayment.supplierGstin}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs">
                  <div>
                    <span className="text-[10px] uppercase text-slate-500 block">Amount Paid</span>
                    <span className="text-base font-black font-mono text-emerald-700">
                      {formatAbsRupees(receiptPayment.amount)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-slate-500 block">Method</span>
                    <span className="font-bold uppercase">
                      {receiptPayment.paymentMethod.replace('_', ' ')}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-slate-500 block">Reference #</span>
                    <span className="font-mono">{receiptPayment.transactionReference || '—'}</span>
                  </div>
                </div>

                {receiptPayment.allocations.length > 0 ? (
                  <div className="space-y-2 text-xs">
                    <h4 className="font-bold uppercase text-[11px] text-slate-600">
                      Applied to Purchase Bills
                    </h4>
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-300 text-[10px] uppercase text-slate-500">
                          <th className="py-1.5">Invoice #</th>
                          <th className="py-1.5">Bill Date</th>
                          <th className="py-1.5 text-right">Bill Total</th>
                          <th className="py-1.5 text-right">Allocated</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {receiptPayment.allocations.map((a) => (
                          <tr key={a.allocationId}>
                            <td className="py-2 font-mono font-bold">{a.invoiceNumber}</td>
                            <td className="py-2 font-mono text-slate-600">{a.invoiceDate}</td>
                            <td className="py-2 text-right font-mono">
                              {formatAbsRupees(a.billGrandTotal)}
                            </td>
                            <td className="py-2 text-right font-mono font-bold">
                              {formatAbsRupees(a.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-slate-600 italic">
                    Recorded as unallocated advance credit ({formatAbsRupees(receiptPayment.unallocatedAmount)}).
                  </p>
                )}

                {safeDecimal(receiptPayment.unallocatedAmount).greaterThan(0) &&
                  receiptPayment.allocations.length > 0 && (
                    <div className="text-xs font-semibold text-amber-800">
                      Remaining Unallocated Advance: {formatAbsRupees(receiptPayment.unallocatedAmount)}
                    </div>
                  )}

                {receiptPayment.notes && (
                  <div className="text-xs text-slate-600">
                    <span className="font-bold text-slate-800">Notes:</span> {receiptPayment.notes}
                  </div>
                )}

                {receiptPayment.supplierSummary && (
                  <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-300 text-xs">
                    <div>
                      <span className="text-[10px] uppercase text-slate-500 block">
                        Lifetime Purchases
                      </span>
                      <span className="font-mono font-bold">
                        {formatAbsRupees(receiptPayment.supplierSummary.totalPurchases)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-slate-500 block">
                        Lifetime Payments
                      </span>
                      <span className="font-mono font-bold">
                        {formatAbsRupees(receiptPayment.supplierSummary.totalPayments)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-slate-500 block">
                        Net Account Balance
                      </span>
                      <span className="font-mono font-black">
                        {safeDecimal(receiptPayment.supplierSummary.netBalance).greaterThan(0)
                          ? `${formatAbsRupees(receiptPayment.supplierSummary.netBalance)} Payable`
                          : safeDecimal(receiptPayment.supplierSummary.netBalance).lessThan(0)
                            ? `${formatAbsRupees(receiptPayment.supplierSummary.netBalance)} Advance`
                            : '₹0.00 Settled'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
