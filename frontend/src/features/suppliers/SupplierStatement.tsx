import React, { useEffect, useState } from 'react';
import {
  Archive,
  Download,
  FileSpreadsheet,
  Loader2,
  Printer,
  RefreshCw,
} from 'lucide-react';
import { safeDecimal } from '../../lib/formatters.js';
import {
  downloadSupplierStatementCsvApi,
  fetchSupplierStatementApi,
  formatAbsRupees,
  listAllSuppliersApi,
} from './suppliersApi.js';
import type { SupplierRecord, SupplierStatementData } from './suppliers.types.js';

export interface SupplierStatementProps {
  initialSupplierId?: string;
}

export const SupplierStatement: React.FC<SupplierStatementProps> = ({
  initialSupplierId = '',
}) => {
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState(initialSupplierId);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [statement, setStatement] = useState<SupplierStatementData | null>(null);
  const [loadingSuppliers, setLoadingSuppliers] = useState(true);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [downloadingCsv, setDownloadingCsv] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialSupplierId) {
      setSelectedSupplierId(initialSupplierId);
    }
  }, [initialSupplierId]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoadingSuppliers(true);
      try {
        // Include archived suppliers so historical statements remain accessible across all pages
        const list = await listAllSuppliersApi({ status: 'all' });
        if (!active) return;
        setSuppliers(list);
        if (!selectedSupplierId && list.length > 0) {
          setSelectedSupplierId(list[0].id);
        }
      } catch (err: any) {
        if (active) setError(err?.message || 'Failed to load suppliers list.');
      } finally {
        if (active) setLoadingSuppliers(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadStatement = async (supId = selectedSupplierId, start = fromDate, end = toDate) => {
    if (!supId) {
      setStatement(null);
      return;
    }
    if (start && end && end < start) {
      setError('End date cannot be earlier than start date.');
      return;
    }
    setLoadingStatement(true);
    setError(null);
    try {
      const res = await fetchSupplierStatementApi(supId, {
        fromDate: start || undefined,
        toDate: end || undefined,
      });
      setStatement(res);
    } catch (err: any) {
      setError(err?.message || 'Failed to load supplier statement.');
    } finally {
      setLoadingStatement(false);
    }
  };

  useEffect(() => {
    if (selectedSupplierId) {
      void loadStatement(selectedSupplierId, fromDate, toDate);
    }
  }, [selectedSupplierId]);

  const handleExportCsv = async () => {
    if (!statement) return;
    setDownloadingCsv(true);
    setError(null);
    try {
      await downloadSupplierStatementCsvApi(statement.supplier.id, statement.supplier.name, {
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to export CSV.');
    } finally {
      setDownloadingCsv(false);
    }
  };

  const formatBalanceWithSide = (val: string) => {
    const dec = safeDecimal(val);
    if (dec.greaterThan(0)) return `${formatAbsRupees(dec)} Dr (Payable)`;
    if (dec.lessThan(0)) return `${formatAbsRupees(dec)} Cr (Advance)`;
    return '₹0.00 (Settled)';
  };

  const closingDec = statement ? safeDecimal(statement.closingBalance) : safeDecimal(0);

  return (
    <div className="space-y-4">
      {/* Filter & Export Controls (Hidden in print view) */}
      <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3.5 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-extrabold text-[var(--khata-text)] flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-[var(--khata-accent)]" />
              <span>Supplier Ledger &amp; Statements</span>
            </h3>
            <p className="text-xs text-[var(--khata-text-muted)]">
              Chronological purchase bills, payments, and exact running balance (active &amp; archived suppliers)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!statement}
              onClick={() => window.print()}
              className="neu-btn-secondary text-xs px-3.5 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-40"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print Statement</span>
            </button>
            <button
              type="button"
              disabled={!statement || downloadingCsv}
              onClick={() => void handleExportCsv()}
              className="neu-btn-primary text-xs px-3.5 py-1.5 font-bold inline-flex items-center gap-1.5 disabled:opacity-40"
            >
              {downloadingCsv ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 items-end">
          <div className="sm:col-span-2">
            <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
              Supplier Account
            </label>
            <select
              disabled={loadingSuppliers}
              value={selectedSupplierId}
              onChange={(e) => setSelectedSupplierId(e.target.value)}
              className="neu-input w-full text-xs font-semibold"
            >
              <option value="">-- Select Supplier --</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.archivedAt ? ' [Archived]' : ''}
                  {s.phone ? ` (${s.phone})` : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
              Start Date
            </label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="neu-input w-full text-xs font-mono"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
              End Date
            </label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="neu-input w-full text-xs font-mono"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadStatement(selectedSupplierId, fromDate, toDate)}
              disabled={!selectedSupplierId || loadingStatement}
              className="neu-btn-secondary flex-1 text-xs px-3 py-1.5 font-bold inline-flex items-center justify-center gap-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingStatement ? 'animate-spin' : ''}`} />
              <span>Apply</span>
            </button>
            {(fromDate || toDate) && (
              <button
                type="button"
                onClick={() => {
                  setFromDate('');
                  setToDate('');
                  void loadStatement(selectedSupplierId, '', '');
                }}
                className="text-xs font-bold text-[var(--khata-accent)] hover:underline px-2"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs font-semibold">
          {error}
        </div>
      )}

      {loadingStatement ? (
        <div className="neu-card p-10 rounded-2xl flex items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
          <span>Generating statement...</span>
        </div>
      ) : !statement ? (
        <div className="neu-card p-10 rounded-2xl text-center text-xs text-[var(--khata-text-muted)]">
          Select a supplier account above to view or print its account statement.
        </div>
      ) : (
        <div className="neu-card p-4 sm:p-6 rounded-2xl space-y-5 print:shadow-none print:border print:border-slate-300 print:bg-white print:text-slate-900">
          {/* Statement Header */}
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--khata-border)] pb-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-black uppercase text-[var(--khata-text)] print:text-slate-900">
                  Supplier Account Statement
                </h2>
                {statement.supplier.archivedAt && (
                  <span className="neu-badge neu-badge-warning text-[10px]">
                    <Archive className="w-3 h-3" /> Archived Supplier
                  </span>
                )}
              </div>
              <div className="text-sm font-bold text-[var(--khata-text)] mt-1">
                {statement.supplier.name}
              </div>
              <div className="text-xs text-[var(--khata-text-muted)] space-x-3">
                {statement.supplier.phone && (
                  <span className="font-mono">{statement.supplier.phone}</span>
                )}
                {statement.supplier.gstin && (
                  <span className="font-mono">GSTIN: {statement.supplier.gstin}</span>
                )}
              </div>
            </div>

            <div className="text-right text-xs">
              <div className="font-bold text-[var(--khata-text)]">
                Period:{' '}
                <span className="font-mono">
                  {statement.filters.fromDate || 'Beginning'} to{' '}
                  {statement.filters.toDate || 'Present'}
                </span>
              </div>
              <div className="text-[11px] text-[var(--khata-text-muted)] mt-0.5">
                Unallocated Advances: {formatAbsRupees(statement.supplier.unallocatedPayments)}
              </div>
            </div>
          </div>

          {/* Unified Summary Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40 print:border print:border-slate-200">
              <span className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)] block">
                Opening Balance
              </span>
              <span className="font-mono font-bold text-sm">
                {formatBalanceWithSide(statement.openingBalance)}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40 print:border print:border-slate-200">
              <span className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)] block">
                Purchases (+)
              </span>
              <span className="font-mono font-bold text-sm">
                {formatAbsRupees(statement.periodPurchases)}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40 print:border print:border-slate-200">
              <span className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)] block">
                Payments (-)
              </span>
              <span className="font-mono font-bold text-sm text-emerald-600 dark:text-emerald-400">
                {formatAbsRupees(statement.periodPayments)}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40 print:border print:border-slate-200">
              <span className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)] block">
                Reversals (+)
              </span>
              <span className="font-mono font-bold text-sm text-amber-700 dark:text-amber-300">
                {formatAbsRupees(statement.periodReversals || '0.00')}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40 print:border print:border-slate-200">
              <span className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)] block">
                Bill Cancels (-)
              </span>
              <span className="font-mono font-bold text-sm text-emerald-600 dark:text-emerald-400">
                {formatAbsRupees(statement.periodCancellations || '0.00')}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40 print:border print:border-slate-200">
              <span className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)] block">
                Closing Balance
              </span>
              <span
                className={`font-mono font-black text-sm ${
                  closingDec.greaterThan(0)
                    ? 'text-rose-600 dark:text-rose-400'
                    : closingDec.lessThan(0)
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : ''
                }`}
              >
                {formatBalanceWithSide(statement.closingBalance)}
              </span>
            </div>
          </div>

          {/* Statement Entries */}
          {statement.entries.length === 0 ? (
            <div className="p-6 text-center text-xs text-[var(--khata-text-muted)] bg-[var(--khata-surface-inset)]/25 rounded-xl">
              No finalized purchase bills or payments found in this date range. Opening balance is strictly ₹0.00 when no prior transactions exist.
            </div>
          ) : (
            <>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[var(--khata-border)] text-[11px] uppercase tracking-wider text-[var(--khata-text-muted)]">
                      <th className="py-2.5 px-3">Date</th>
                      <th className="py-2.5 px-3">Type</th>
                      <th className="py-2.5 px-3">Reference</th>
                      <th className="py-2.5 px-3">Details</th>
                      <th className="py-2.5 px-3 text-right">Debit (+)</th>
                      <th className="py-2.5 px-3 text-right">Credit (-)</th>
                      <th className="py-2.5 px-3 text-right">Running Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--khata-border)]/60">
                    {statement.filters.fromDate && (
                      <tr className="bg-[var(--khata-surface-inset)]/30 font-semibold">
                        <td className="py-2.5 px-3 font-mono">{statement.filters.fromDate}</td>
                        <td className="py-2.5 px-3">Opening</td>
                        <td className="py-2.5 px-3">—</td>
                        <td className="py-2.5 px-3">Opening balance carried forward</td>
                        <td className="py-2.5 px-3 text-right font-mono">—</td>
                        <td className="py-2.5 px-3 text-right font-mono">—</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold">
                          {formatBalanceWithSide(statement.openingBalance)}
                        </td>
                      </tr>
                    )}

                    {statement.entries.map((entry) => (
                      <tr
                        key={`${entry.entryType}-${entry.id}`}
                        className={
                          entry.entryType === 'payment_reversal'
                            ? 'bg-amber-500/5'
                            : entry.entryType === 'purchase_bill_cancellation'
                              ? 'bg-emerald-500/5'
                              : undefined
                        }
                      >
                        <td className="py-2.5 px-3 font-mono">{entry.entryDate}</td>
                        <td className="py-2.5 px-3">
                          {entry.entryType === 'purchase_bill' ? (
                            <span className="font-bold text-[var(--khata-text)]">
                              Purchase Bill{entry.billStatus === 'cancelled' ? ' [Cancelled later]' : ''}
                            </span>
                          ) : entry.entryType === 'purchase_bill_cancellation' ? (
                            <span className="font-bold text-emerald-600 dark:text-emerald-400">
                              Bill Cancellation
                            </span>
                          ) : entry.entryType === 'payment_reversal' ? (
                            <span className="font-bold text-rose-600 dark:text-rose-400">
                              Payment Reversal
                            </span>
                          ) : (
                            <span className="font-bold text-emerald-600 dark:text-emerald-400">
                              Payment{entry.paymentStatus === 'reversed' ? ' [Reversed]' : ''}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-bold">
                          {entry.referenceNumber}
                        </td>
                        <td className="py-2.5 px-3 text-[var(--khata-text-muted)]">
                          {entry.description}
                          {entry.transactionReference ? ` · Ref: ${entry.transactionReference}` : ''}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-mono ${
                            entry.entryType === 'payment_reversal'
                              ? 'text-rose-600 dark:text-rose-400 font-semibold'
                              : ''
                          }`}
                        >
                          {safeDecimal(entry.debitAmount).greaterThan(0)
                            ? formatAbsRupees(entry.debitAmount)
                            : '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-emerald-600 dark:text-emerald-400">
                          {safeDecimal(entry.creditAmount).greaterThan(0)
                            ? formatAbsRupees(entry.creditAmount)
                            : '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold">
                          {formatBalanceWithSide(entry.runningBalance)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Statement Cards */}
              <div className="md:hidden space-y-2.5">
                {statement.entries.map((entry) => {
                  const isDebit =
                    entry.entryType === 'purchase_bill' || entry.entryType === 'payment_reversal';
                  const typeLabel =
                    entry.entryType === 'purchase_bill'
                      ? `Purchase Bill${entry.billStatus === 'cancelled' ? ' [Cancelled later]' : ''}`
                      : entry.entryType === 'purchase_bill_cancellation'
                        ? 'Bill Cancellation'
                        : entry.entryType === 'payment_reversal'
                          ? 'Payment Reversal'
                          : entry.paymentStatus === 'reversed'
                            ? 'Payment [Reversed]'
                            : 'Payment';
                  return (
                    <div
                      key={`${entry.entryType}-${entry.id}`}
                      className={`p-3 rounded-xl border border-[var(--khata-border)] space-y-1.5 text-xs ${
                        entry.entryType === 'payment_reversal'
                          ? 'bg-amber-500/5'
                          : entry.entryType === 'purchase_bill_cancellation'
                            ? 'bg-emerald-500/5'
                            : 'bg-[var(--khata-surface-inset)]/25'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className="font-mono font-bold">{entry.referenceNumber}</span>
                          <div className="text-[11px] text-[var(--khata-text-muted)]">
                            {entry.entryDate} · {typeLabel}
                          </div>
                        </div>
                        <span
                          className={`font-mono font-extrabold ${
                            entry.entryType === 'payment' ||
                            entry.entryType === 'purchase_bill_cancellation'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : entry.entryType === 'payment_reversal'
                                ? 'text-rose-600 dark:text-rose-400'
                                : ''
                          }`}
                        >
                          {isDebit
                            ? `+${formatAbsRupees(entry.debitAmount)}`
                            : `-${formatAbsRupees(entry.creditAmount)}`}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--khata-text-muted)]">
                        {entry.description}
                      </div>
                      <div className="text-[11px] font-mono font-bold text-right pt-1 border-t border-[var(--khata-border)]/50">
                        Balance: {formatBalanceWithSide(entry.runningBalance)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
