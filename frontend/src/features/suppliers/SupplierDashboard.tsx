import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Building2,
  Calendar,
  CheckCircle2,
  CreditCard,
  Loader2,
  Receipt,
  RefreshCw,
  RotateCcw,
  Wallet,
  X,
} from 'lucide-react';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import { safeDecimal } from '../../lib/formatters.js';
import {
  fetchSupplierDashboard,
  formatAbsRupees,
  getSupplierPaymentApi,
} from './suppliersApi.js';
import type {
  SupplierDashboardData,
  SupplierPaymentMethod,
  SupplierPaymentRecord,
} from './suppliers.types.js';

export type DashboardDatePreset = 'all_time' | 'today' | 'this_month' | 'custom';

export function resolveDashboardDateRange(
  preset: DashboardDatePreset,
  customFrom: string,
  customTo: string,
  todayISO: string = getBusinessDateISO()
): { fromDate?: string; toDate?: string } {
  if (preset === 'today') {
    return { fromDate: todayISO, toDate: todayISO };
  }
  if (preset === 'this_month') {
    return {
      fromDate: `${todayISO.slice(0, 7)}-01`,
      toDate: todayISO,
    };
  }
  if (preset === 'custom') {
    return {
      fromDate: customFrom.trim() || undefined,
      toDate: customTo.trim() || undefined,
    };
  }
  return {};
}

const METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
  other: 'Other',
};

export interface SupplierDashboardProps {
  refreshSignal?: number;
  onOpenAllPayments?: () => void;
}

export const SupplierDashboard: React.FC<SupplierDashboardProps> = ({
  refreshSignal = 0,
  onOpenAllPayments,
}) => {
  const [preset, setPreset] = useState<DashboardDatePreset>('all_time');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<SupplierDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedPayment, setSelectedPayment] = useState<SupplierPaymentRecord | null>(null);
  const [loadingPaymentDetail, setLoadingPaymentDetail] = useState(false);

  const requestIdRef = useRef(0);

  const loadDashboard = async (
    targetPreset = preset,
    targetFrom = customFrom,
    targetTo = customTo
  ) => {
    const range = resolveDashboardDateRange(targetPreset, targetFrom, targetTo);
    if (range.fromDate && range.toDate && range.toDate < range.fromDate) {
      setError('End date cannot be earlier than start date.');
      setLoading(false);
      return;
    }

    const reqId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSupplierDashboard(range);
      if (reqId !== requestIdRef.current) return;
      setData(res);
    } catch (err: any) {
      if (reqId !== requestIdRef.current) return;
      setError(err?.message || 'Failed to load supplier dashboard.');
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadDashboard(preset, customFrom, customTo);
  }, [preset, customFrom, customTo, refreshSignal]);

  const handleOpenPaymentDetail = async (payment: SupplierPaymentRecord) => {
    setSelectedPayment(payment);
    setLoadingPaymentDetail(true);
    try {
      const detail = await getSupplierPaymentApi(payment.id);
      setSelectedPayment(detail);
    } catch {
      // Fall back to summary payment row already shown
    } finally {
      setLoadingPaymentDetail(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="neu-card p-10 rounded-2xl flex items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
        <span>Loading supplier dashboard...</span>
      </div>
    );
  }

  const summary = data?.summary;
  const recentPayments = data?.recentPayments || [];
  const recentPaymentsTotal = data?.recentPaymentsTotal || 0;

  return (
    <div className="space-y-5">
      {/* Date Filter Bar */}
      <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-extrabold text-[var(--khata-text)]">
              Supplier Financial Overview
            </h3>
            <p className="text-xs text-[var(--khata-text-muted)]">
              Period purchase, payment &amp; method totals alongside current payable/advance position
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void loadDashboard(preset, customFrom, customTo)}
              disabled={loading}
              className="neu-btn-secondary text-xs px-3 py-1.5 min-h-0 font-bold inline-flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            {onOpenAllPayments && (
              <button
                type="button"
                onClick={onOpenAllPayments}
                className="neu-btn-primary text-xs px-3.5 py-1.5 min-h-0 font-bold inline-flex items-center gap-1.5"
              >
                <span>All Supplier Payments</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--khata-border)]/70">
          <span className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)] inline-flex items-center gap-1 mr-1">
            <Calendar className="w-3.5 h-3.5" />
            <span>Period:</span>
          </span>
          {(
            [
              { key: 'all_time', label: 'All Time' },
              { key: 'today', label: 'Today' },
              { key: 'this_month', label: 'This Month' },
              { key: 'custom', label: 'Custom Range' },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setPreset(item.key)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition ${
                preset === item.key
                  ? 'bg-[var(--khata-accent)] text-white shadow'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
              }`}
            >
              {item.label}
            </button>
          ))}

          {preset === 'custom' && (
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="Dashboard from date"
                className="neu-input text-xs font-mono py-1"
              />
              <span className="text-xs text-[var(--khata-text-muted)]">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="Dashboard to date"
                className="neu-input text-xs font-mono py-1"
              />
            </div>
          )}
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* 6 Summary Metric Cards */}
      {summary && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="neu-card p-4 rounded-2xl space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                  Total Purchases
                </span>
                <Receipt className="w-4 h-4 text-[var(--khata-accent)]" />
              </div>
              <div className="text-xl font-black font-mono text-[var(--khata-text)]">
                {formatAbsRupees(summary.totalPurchases)}
              </div>
              <div className="text-[11px] text-[var(--khata-text-muted)]">
                Finalized purchase bills in selected period
              </div>
            </div>

            <div className="neu-card p-4 rounded-2xl space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                  Active Payments Made
                </span>
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="text-xl font-black font-mono text-emerald-600 dark:text-emerald-400">
                {formatAbsRupees(summary.totalPaymentsMade)}
              </div>
              <div className="text-[11px] text-[var(--khata-text-muted)]">
                Non-reversed payments in selected period
              </div>
            </div>

            <div className="neu-card p-4 rounded-2xl space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                  Total Outstanding Payable
                </span>
                <Wallet className="w-4 h-4 text-rose-500" />
              </div>
              <div className="text-xl font-black font-mono text-rose-600 dark:text-rose-400">
                {formatAbsRupees(summary.totalOutstandingPayable)}
              </div>
              <div className="text-[11px] text-[var(--khata-text-muted)]">
                Current all-time net payable across suppliers
              </div>
            </div>

            <div className="neu-card p-4 rounded-2xl space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                  Advance Credit
                </span>
                <CreditCard className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="text-xl font-black font-mono text-emerald-600 dark:text-emerald-400">
                {formatAbsRupees(summary.totalAdvanceCredit)}
              </div>
              <div className="text-[11px] text-[var(--khata-text-muted)]">
                Current all-time net advance credit held
              </div>
            </div>

            <div className="neu-card p-4 rounded-2xl space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                  Unallocated Advances
                </span>
                <Wallet className="w-4 h-4 text-amber-500" />
              </div>
              <div className="text-xl font-black font-mono text-amber-700 dark:text-amber-300">
                {formatAbsRupees(summary.totalUnallocatedPayments)}
              </div>
              <div className="text-[11px] text-[var(--khata-text-muted)]">
                Current payment balances awaiting bill allocation
              </div>
            </div>

            <div className="neu-card p-4 rounded-2xl space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                  Reversed Payments
                </span>
                <RotateCcw className="w-4 h-4 text-rose-500" />
              </div>
              <div className="text-xl font-black font-mono text-[var(--khata-text)]">
                {formatAbsRupees(summary.totalPaymentsReversed)}
              </div>
              <div className="text-[11px] text-[var(--khata-text-muted)] inline-flex items-center gap-1">
                <Building2 className="w-3 h-3" />
                <span>
                  {summary.activeSuppliers} active / {summary.totalSuppliers} total suppliers
                </span>
              </div>
            </div>
          </div>

          {/* Payment Method Breakdown */}
          <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-extrabold text-[var(--khata-text)]">
                Active Payments by Method
              </h4>
              <span className="text-[11px] text-[var(--khata-text-muted)]">
                Respects selected period filter
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {summary.paymentMethodTotals.map((item) => (
                <div
                  key={item.paymentMethod}
                  className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40 border border-[var(--khata-border)]/50 space-y-0.5"
                >
                  <div className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    {METHOD_LABELS[item.paymentMethod]}
                  </div>
                  <div className="font-mono font-black text-sm text-[var(--khata-text)]">
                    {formatAbsRupees(item.amount)}
                  </div>
                  <div className="text-[11px] text-[var(--khata-text-muted)]">
                    {item.count} {item.count === 1 ? 'payment' : 'payments'}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Supplier Payments Table */}
          <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-extrabold text-[var(--khata-text)]">
                  Recent Supplier Payments
                </h4>
                <p className="text-xs text-[var(--khata-text-muted)]">
                  Showing {recentPayments.length} of {recentPaymentsTotal} payments in selected
                  period (click a row for receipt details)
                </p>
              </div>
              {onOpenAllPayments && (
                <button
                  type="button"
                  onClick={onOpenAllPayments}
                  className="text-xs font-bold text-[var(--khata-accent)] hover:underline inline-flex items-center gap-1"
                >
                  <span>Search All Payments</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {recentPayments.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--khata-text-muted)] bg-[var(--khata-surface-inset)]/25 rounded-xl">
                No supplier payments found for the selected date range.
              </div>
            ) : (
              <>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-[var(--khata-border)] text-[10px] uppercase tracking-wider text-[var(--khata-text-muted)]">
                        <th className="py-2.5 px-3">Date</th>
                        <th className="py-2.5 px-3">Receipt</th>
                        <th className="py-2.5 px-3">Supplier</th>
                        <th className="py-2.5 px-3">Method</th>
                        <th className="py-2.5 px-3">Reference</th>
                        <th className="py-2.5 px-3 text-right">Amount</th>
                        <th className="py-2.5 px-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--khata-border)]/60">
                      {recentPayments.map((p) => {
                        const isReversed = p.status === 'reversed';
                        return (
                          <tr
                            key={p.id}
                            onClick={() => void handleOpenPaymentDetail(p)}
                            className={`cursor-pointer hover:bg-[var(--khata-surface-inset)]/35 transition ${
                              isReversed ? 'opacity-80 bg-rose-500/5' : ''
                            }`}
                          >
                            <td className="py-2.5 px-3 font-mono">{p.paymentDate}</td>
                            <td className="py-2.5 px-3 font-mono font-bold text-[var(--khata-accent)]">
                              {p.receiptNumber}
                            </td>
                            <td className="py-2.5 px-3 font-semibold text-[var(--khata-text)]">
                              {p.supplierName}
                            </td>
                            <td className="py-2.5 px-3">
                              {METHOD_LABELS[p.paymentMethod]}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-[var(--khata-text-muted)]">
                              {p.transactionReference || '—'}
                            </td>
                            <td
                              className={`py-2.5 px-3 text-right font-mono font-bold ${
                                isReversed
                                  ? 'line-through text-[var(--khata-text-muted)]'
                                  : 'text-emerald-600 dark:text-emerald-400'
                              }`}
                            >
                              {formatAbsRupees(p.amount)}
                            </td>
                            <td className="py-2.5 px-3">
                              {isReversed ? (
                                <span className="px-2 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400 text-[10px] font-bold uppercase">
                                  Reversed
                                </span>
                              ) : safeDecimal(p.unallocatedAmount).greaterThan(0) ? (
                                <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-bold uppercase">
                                  Partial Adv
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold uppercase">
                                  Active
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Recent Payments Cards */}
                <div className="md:hidden space-y-2.5">
                  {recentPayments.map((p) => {
                    const isReversed = p.status === 'reversed';
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => void handleOpenPaymentDetail(p)}
                        className="w-full text-left p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/25 space-y-1.5 text-xs"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-mono font-bold text-[var(--khata-accent)]">
                              {p.receiptNumber}
                            </div>
                            <div className="font-bold text-[var(--khata-text)]">
                              {p.supplierName}
                            </div>
                            <div className="text-[11px] text-[var(--khata-text-muted)]">
                              {p.paymentDate} · {METHOD_LABELS[p.paymentMethod]}
                              {p.transactionReference ? ` · ${p.transactionReference}` : ''}
                            </div>
                          </div>
                          <div className="text-right">
                            <div
                              className={`font-mono font-black ${
                                isReversed
                                  ? 'line-through text-[var(--khata-text-muted)]'
                                  : 'text-emerald-600 dark:text-emerald-400'
                              }`}
                            >
                              {formatAbsRupees(p.amount)}
                            </div>
                            <div className="text-[10px] font-bold uppercase text-[var(--khata-text-muted)]">
                              {isReversed ? 'Reversed' : 'Active'}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* Payment Receipt Detail Modal */}
      {selectedPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto print:hidden">
          <div className="neu-card w-full max-w-lg rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-3">
              <div>
                <h3 className="text-base font-extrabold text-[var(--khata-text)]">
                  Payment Details — {selectedPayment.receiptNumber}
                </h3>
                <p className="text-xs text-[var(--khata-text-muted)]">
                  {selectedPayment.supplierName} · {selectedPayment.paymentDate}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPayment(null)}
                className="p-1.5 rounded-lg hover:bg-[var(--khata-surface-inset)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {selectedPayment.status === 'reversed' && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-700 dark:text-rose-300">
                <strong>REVERSED</strong> ({selectedPayment.reversalNumber || 'Reversal'}) —{' '}
                {selectedPayment.reversalReason || 'Reason not provided'}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40">
                <div className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)]">
                  Amount
                </div>
                <div className="font-mono font-black text-base text-[var(--khata-text)]">
                  {formatAbsRupees(selectedPayment.amount)}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40">
                <div className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)]">
                  Method &amp; Reference
                </div>
                <div className="font-bold text-[var(--khata-text)]">
                  {METHOD_LABELS[selectedPayment.paymentMethod]}
                </div>
                <div className="font-mono text-[11px] text-[var(--khata-text-muted)]">
                  {selectedPayment.transactionReference || 'No reference'}
                </div>
              </div>
            </div>

            {selectedPayment.notes && (
              <div className="text-xs text-[var(--khata-text-muted)]">
                <strong>Notes:</strong> {selectedPayment.notes}
              </div>
            )}

            <div className="space-y-2 border-t border-[var(--khata-border)] pt-3">
              <div className="text-xs font-extrabold uppercase text-[var(--khata-text)]">
                Allocated Bills ({selectedPayment.allocations.length})
              </div>
              {loadingPaymentDetail ? (
                <div className="text-xs text-[var(--khata-text-muted)] flex items-center gap-1.5 py-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Loading allocations...</span>
                </div>
              ) : selectedPayment.allocations.length === 0 ? (
                <p className="text-xs text-[var(--khata-text-muted)]">
                  Unallocated advance payment ({formatAbsRupees(selectedPayment.unallocatedAmount)}{' '}
                  available).
                </p>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {selectedPayment.allocations.map((a) => (
                    <div
                      key={a.allocationId}
                      className="p-2.5 rounded-xl bg-[var(--khata-surface-inset)]/30 border border-[var(--khata-border)]/50 flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="font-mono font-bold">{a.invoiceNumber}</div>
                        <div className="text-[11px] text-[var(--khata-text-muted)]">
                          {a.invoiceDate} · Bill: {formatAbsRupees(a.billGrandTotal)}
                        </div>
                      </div>
                      <div className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {formatAbsRupees(a.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[var(--khata-border)]">
              {onOpenAllPayments && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPayment(null);
                    onOpenAllPayments();
                  }}
                  className="neu-btn-secondary px-3.5 py-1.5 text-xs font-bold"
                >
                  Manage in Payments Tab
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedPayment(null)}
                className="neu-btn-primary px-4 py-1.5 text-xs font-bold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
