import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  CreditCard,
  FileSpreadsheet,
  Loader2,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Users,
  Wallet,
} from 'lucide-react';
import { safeDecimal } from '../../lib/formatters.js';
import { fetchSupplierDashboard, formatAbsRupees } from './suppliersApi.js';
import type { SupplierDashboardData, SupplierRecord } from './suppliers.types.js';

export interface SupplierDashboardProps {
  onOpenSupplierDetails: (supplierId: string) => void;
  onOpenStatement: (supplierId: string) => void;
  onNewPurchaseBill: (supplierId: string) => void;
  onNewPayment: (supplierId: string) => void;
  onAddSupplier: () => void;
  refreshSignal?: number;
}

export const SupplierDashboard: React.FC<SupplierDashboardProps> = ({
  onOpenSupplierDetails,
  onOpenStatement,
  onNewPurchaseBill,
  onNewPayment,
  onAddSupplier,
  refreshSignal = 0,
}) => {
  const [data, setData] = useState<SupplierDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState<'active' | 'all' | 'with_balance'>('all');

  const loadDashboard = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSupplierDashboard();
      setData(res);
    } catch (err: any) {
      setError(err?.message || 'Failed to load supplier dashboard.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, [refreshSignal]);

  const filteredSuppliers = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.suppliers.filter((s) => {
      if (showArchived === 'active' && s.archivedAt) return false;
      if (showArchived === 'with_balance' && safeDecimal(s.outstandingPayable).lessThanOrEqualTo(0)) {
        return false;
      }
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.phone || '').toLowerCase().includes(q) ||
        (s.gstin || '').toLowerCase().includes(q) ||
        (s.contactPerson || '').toLowerCase().includes(q)
      );
    });
  }, [data, search, showArchived]);

  const renderNetBalanceBadge = (s: SupplierRecord) => {
    const net = safeDecimal(s.netBalance);
    if (net.greaterThan(0)) {
      return (
        <div className="text-right">
          <div className="font-mono font-extrabold text-sm text-rose-600 dark:text-rose-400">
            {formatAbsRupees(net)}
          </div>
          <span className="inline-block text-[10px] font-bold uppercase tracking-wide text-rose-600 dark:text-rose-400">
            Payable
          </span>
        </div>
      );
    }
    if (net.lessThan(0)) {
      return (
        <div className="text-right">
          <div className="font-mono font-extrabold text-sm text-emerald-600 dark:text-emerald-400">
            {formatAbsRupees(net)}
          </div>
          <span className="inline-block text-[10px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
            Advance Credit
          </span>
        </div>
      );
    }
    return (
      <div className="text-right">
        <div className="font-mono font-bold text-sm text-[var(--khata-text-muted)]">₹0.00</div>
        <span className="inline-block text-[10px] font-bold uppercase tracking-wide text-[var(--khata-text-muted)]">
          Settled
        </span>
      </div>
    );
  };

  if (loading && !data) {
    return (
      <div className="neu-card p-10 rounded-2xl flex items-center justify-center gap-3 text-sm font-semibold text-[var(--khata-text-muted)]">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--khata-accent)]" />
        <span>Loading supplier dashboard...</span>
      </div>
    );
  }

  const kpis = data?.kpis;

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs font-semibold flex flex-wrap items-center justify-between gap-2">
          <span>{error}</span>
          <button type="button" onClick={loadDashboard} className="underline font-bold">
            Retry
          </button>
        </div>
      )}

      {/* 6 Live Financial & Operational KPIs */}
      {kpis && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          <div className="neu-card p-4 rounded-2xl flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                Total Suppliers
              </p>
              <p className="text-2xl font-black text-[var(--khata-text)] mt-1">
                {kpis.totalSuppliers}
              </p>
              <p className="text-[11px] text-[var(--khata-text-muted)] mt-0.5">
                Including {kpis.totalSuppliers - kpis.activeSuppliers} archived
              </p>
            </div>
            <div className="p-3 rounded-xl bg-[var(--khata-accent)]/10 text-[var(--khata-accent)]">
              <Users className="w-6 h-6" />
            </div>
          </div>

          <div className="neu-card p-4 rounded-2xl flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                Active Suppliers
              </p>
              <p className="text-2xl font-black text-[var(--khata-text)] mt-1">
                {kpis.activeSuppliers}
              </p>
              <p className="text-[11px] text-[var(--khata-text-muted)] mt-0.5">
                Ready for purchases &amp; payments
              </p>
            </div>
            <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-6 h-6" />
            </div>
          </div>

          <div className="neu-card p-4 rounded-2xl flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                Total Purchases
              </p>
              <p className="text-2xl font-black font-mono text-[var(--khata-text)] mt-1">
                {formatAbsRupees(kpis.totalPurchases)}
              </p>
              <p className="text-[11px] text-[var(--khata-text-muted)] mt-0.5">
                Finalized purchase bills
              </p>
            </div>
            <div className="p-3 rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
              <Receipt className="w-6 h-6" />
            </div>
          </div>

          <div className="neu-card p-4 rounded-2xl flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                Total Payments Made
              </p>
              <p className="text-2xl font-black font-mono text-emerald-600 dark:text-emerald-400 mt-1">
                {formatAbsRupees(kpis.totalPaymentsMade)}
              </p>
              <p className="text-[11px] text-[var(--khata-text-muted)] mt-0.5">
                Unallocated advances: {formatAbsRupees(kpis.totalUnallocatedPayments)}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CreditCard className="w-6 h-6" />
            </div>
          </div>

          <div className="neu-card p-4 rounded-2xl flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                Total Outstanding Payable
              </p>
              <p className="text-2xl font-black font-mono text-rose-600 dark:text-rose-400 mt-1">
                {formatAbsRupees(kpis.totalOutstandingPayable)}
              </p>
              <p className="text-[11px] text-[var(--khata-text-muted)] mt-0.5">
                {safeDecimal(kpis.totalAdvanceCredit).greaterThan(0)
                  ? `Net supplier advances: ${formatAbsRupees(kpis.totalAdvanceCredit)}`
                  : 'Across all supplier accounts'}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400">
              <Wallet className="w-6 h-6" />
            </div>
          </div>

          <div className="neu-card p-4 rounded-2xl flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
                Suppliers with Balance
              </p>
              <p className="text-2xl font-black text-[var(--khata-text)] mt-1">
                {kpis.suppliersWithBalanceCount}
              </p>
              <p className="text-[11px] text-[var(--khata-text-muted)] mt-0.5">
                Accounts with payable &gt; ₹0.00
              </p>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Building2 className="w-6 h-6" />
            </div>
          </div>
        </div>
      )}

      {/* Supplier-Wise Summary Table Card */}
      <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-extrabold text-[var(--khata-text)]">
              Supplier Account Summary
            </h3>
            <p className="text-xs text-[var(--khata-text-muted)]">
              Live figures synchronized across dashboard, supplier details, and account statements
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={loadDashboard}
              disabled={loading}
              className="neu-btn-secondary text-xs px-3 py-1.5 font-bold inline-flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={onAddSupplier}
              className="neu-btn-primary text-xs px-3.5 py-1.5 font-bold inline-flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Supplier</span>
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search supplier by name, mobile, GSTIN..."
              className="neu-input w-full pl-9 pr-3 py-1.5 text-xs font-medium"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['all', 'All'],
                ['active', 'Active Only'],
                ['with_balance', 'Payable Due'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setShowArchived(key)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition ${
                  showArchived === key
                    ? 'bg-[var(--khata-accent)] text-white shadow'
                    : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filteredSuppliers.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--khata-text-muted)] bg-[var(--khata-surface-inset)]/30 rounded-xl">
            No supplier accounts match your current filter.
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--khata-border)] text-[11px] uppercase tracking-wider text-[var(--khata-text-muted)]">
                    <th className="py-2.5 px-3">Supplier Name</th>
                    <th className="py-2.5 px-3">Contact</th>
                    <th className="py-2.5 px-3 text-right">Total Purchases</th>
                    <th className="py-2.5 px-3 text-right">Total Payments</th>
                    <th className="py-2.5 px-3 text-right">Net Balance</th>
                    <th className="py-2.5 px-3">Last Activity</th>
                    <th className="py-2.5 px-3 text-right">Quick Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--khata-border)]/60 text-xs">
                  {filteredSuppliers.map((s) => (
                    <tr
                      key={s.id}
                      className="hover:bg-[var(--khata-surface-inset)]/40 transition-colors"
                    >
                      <td className="py-3 px-3">
                        <button
                          type="button"
                          onClick={() => onOpenSupplierDetails(s.id)}
                          className="text-left group inline-flex items-center gap-1.5 font-bold text-[var(--khata-text)] hover:text-[var(--khata-accent)]"
                        >
                          <span>{s.name}</span>
                          <ArrowUpRight className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100" />
                        </button>
                        <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                          {s.gstin && (
                            <span className="font-mono text-[10px] text-[var(--khata-text-muted)]">
                              GSTIN: {s.gstin}
                            </span>
                          )}
                          {s.archivedAt && (
                            <span className="neu-badge neu-badge-warning text-[10px] py-0.5 px-2 inline-flex items-center gap-1">
                              <Archive className="w-2.5 h-2.5" />
                              Archived
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-[var(--khata-text-muted)]">
                        <div>{s.phone || '—'}</div>
                        {s.contactPerson && (
                          <div className="text-[11px]">{s.contactPerson}</div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-bold text-[var(--khata-text)]">
                        {formatAbsRupees(s.totalPurchases)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {formatAbsRupees(s.totalPayments)}
                      </td>
                      <td className="py-3 px-3">{renderNetBalanceBadge(s)}</td>
                      <td className="py-3 px-3 font-mono text-[var(--khata-text-muted)]">
                        {s.lastActivity || '—'}
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {!s.archivedAt && (
                            <>
                              <button
                                type="button"
                                onClick={() => onNewPurchaseBill(s.id)}
                                className="px-2 py-1 rounded-lg bg-[var(--khata-surface-inset)] hover:bg-[var(--khata-accent)]/15 text-[11px] font-bold text-[var(--khata-text)] transition"
                                title="Record Purchase Bill"
                              >
                                + Bill
                              </button>
                              <button
                                type="button"
                                onClick={() => onNewPayment(s.id)}
                                className="px-2 py-1 rounded-lg bg-[var(--khata-surface-inset)] hover:bg-emerald-500/15 text-[11px] font-bold text-emerald-700 dark:text-emerald-300 transition"
                                title="Record Supplier Payment"
                              >
                                + Pay
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => onOpenStatement(s.id)}
                            className="p-1.5 rounded-lg bg-[var(--khata-surface-inset)] hover:bg-[var(--khata-accent)]/15 text-[var(--khata-text)] transition"
                            title="View Statement"
                          >
                            <FileSpreadsheet className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden space-y-3">
              {filteredSuppliers.map((s) => (
                <div
                  key={s.id}
                  className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/25 space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <button
                        type="button"
                        onClick={() => onOpenSupplierDetails(s.id)}
                        className="font-bold text-sm text-[var(--khata-text)] hover:text-[var(--khata-accent)] text-left"
                      >
                        {s.name}
                      </button>
                      <div className="text-[11px] text-[var(--khata-text-muted)] mt-0.5">
                        {s.phone || 'No mobile'} {s.lastActivity ? `· Last: ${s.lastActivity}` : ''}
                      </div>
                      {s.archivedAt && (
                        <span className="mt-1 inline-flex items-center gap-1 neu-badge neu-badge-warning text-[10px]">
                          <Archive className="w-2.5 h-2.5" /> Archived
                        </span>
                      )}
                    </div>
                    {renderNetBalanceBadge(s)}
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[var(--khata-border)]/60 text-xs">
                    <div>
                      <span className="text-[10px] uppercase text-[var(--khata-text-muted)] block">
                        Purchases
                      </span>
                      <span className="font-mono font-bold">{formatAbsRupees(s.totalPurchases)}</span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-[var(--khata-text-muted)] block">
                        Payments
                      </span>
                      <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {formatAbsRupees(s.totalPayments)}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => onOpenSupplierDetails(s.id)}
                      className="neu-btn-secondary text-[11px] px-2.5 py-1 min-h-0"
                    >
                      Details
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenStatement(s.id)}
                      className="neu-btn-secondary text-[11px] px-2.5 py-1 min-h-0"
                    >
                      Statement
                    </button>
                    {!s.archivedAt && (
                      <>
                        <button
                          type="button"
                          onClick={() => onNewPurchaseBill(s.id)}
                          className="neu-btn-primary text-[11px] px-2.5 py-1 min-h-0"
                        >
                          + Purchase Bill
                        </button>
                        <button
                          type="button"
                          onClick={() => onNewPayment(s.id)}
                          className="neu-btn-secondary text-[11px] px-2.5 py-1 min-h-0"
                        >
                          + Pay
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
