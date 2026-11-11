import React, { useEffect, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  CreditCard,
  FileSpreadsheet,
  Loader2,
  MapPin,
  Phone,
  Plus,
  Receipt,
} from 'lucide-react';
import { safeDecimal } from '../../lib/formatters.js';
import {
  formatAbsRupees,
  getSupplierApi,
  listPurchaseBillsApi,
  listSupplierPaymentsApi,
} from './suppliersApi.js';
import type {
  PurchaseBillSummary,
  SupplierPaymentRecord,
  SupplierRecord,
} from './suppliers.types.js';

export interface SupplierDetailsProps {
  supplierId: string;
  refreshSignal?: number;
  onBack: () => void;
  onOpenStatement: (supplierId: string) => void;
  onNewPurchaseBill: (supplierId: string) => void;
  onNewPayment: (supplierId: string) => void;
  onOpenPurchaseBillsTab: (supplierId: string) => void;
  onOpenPaymentsTab: (supplierId: string) => void;
}

export const SupplierDetails: React.FC<SupplierDetailsProps> = ({
  supplierId,
  refreshSignal = 0,
  onBack,
  onOpenStatement,
  onNewPurchaseBill,
  onNewPayment,
  onOpenPurchaseBillsTab,
  onOpenPaymentsTab,
}) => {
  const [supplier, setSupplier] = useState<SupplierRecord | null>(null);
  const [bills, setBills] = useState<PurchaseBillSummary[]>([]);
  const [payments, setPayments] = useState<SupplierPaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [sup, billRes, payRes] = await Promise.all([
          getSupplierApi(supplierId),
          listPurchaseBillsApi({ supplierId, limit: 20 }),
          listSupplierPaymentsApi({ supplierId, limit: 20 }),
        ]);
        if (!active) return;
        setSupplier(sup);
        setBills(billRes.purchaseBills);
        setPayments(payRes.payments);
      } catch (err: any) {
        if (active) setError(err?.message || 'Failed to load supplier profile.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [supplierId, refreshSignal]);

  if (loading) {
    return (
      <div className="neu-card p-10 rounded-2xl flex items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
        <span>Loading supplier account...</span>
      </div>
    );
  }

  if (error || !supplier) {
    return (
      <div className="neu-card p-6 rounded-2xl space-y-3">
        <p className="text-xs text-rose-600 font-semibold">{error || 'Supplier not found.'}</p>
        <button type="button" onClick={onBack} className="neu-btn-secondary text-xs px-3 py-1.5">
          Back
        </button>
      </div>
    );
  }

  const net = safeDecimal(supplier.netBalance);

  return (
    <div className="space-y-4">
      <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 text-xs font-bold text-[var(--khata-accent)] hover:underline mb-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Suppliers</span>
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-black text-[var(--khata-text)]">{supplier.name}</h2>
              {supplier.archivedAt ? (
                <span className="neu-badge neu-badge-warning text-[10px]">
                  <Archive className="w-3 h-3" /> Archived
                </span>
              ) : (
                <span className="neu-badge neu-badge-success text-[10px]">Active</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--khata-text-muted)]">
              {supplier.contactPerson && <span>Contact: {supplier.contactPerson}</span>}
              {supplier.phone && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <Phone className="w-3 h-3" /> {supplier.phone}
                </span>
              )}
              {supplier.gstin && <span className="font-mono">GSTIN: {supplier.gstin}</span>}
              {supplier.address && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="w-3 h-3" /> {supplier.address}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenStatement(supplier.id)}
              className="neu-btn-secondary text-xs px-3.5 py-2 font-bold inline-flex items-center gap-1.5"
            >
              <FileSpreadsheet className="w-4 h-4 text-[var(--khata-accent)]" />
              <span>Full Statement</span>
            </button>
            {!supplier.archivedAt ? (
              <>
                <button
                  type="button"
                  onClick={() => onNewPurchaseBill(supplier.id)}
                  className="neu-btn-primary text-xs px-3.5 py-2 font-bold inline-flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  <span>Record Purchase Bill</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNewPayment(supplier.id)}
                  className="neu-btn-secondary text-xs px-3.5 py-2 font-bold inline-flex items-center gap-1.5"
                >
                  <CreditCard className="w-4 h-4 text-emerald-600" />
                  <span>Record Payment</span>
                </button>
              </>
            ) : (
              <>
                {safeDecimal(supplier.outstandingPayable).greaterThan(0) && (
                  <button
                    type="button"
                    onClick={() => onNewPayment(supplier.id)}
                    className="neu-btn-primary text-xs px-3.5 py-2 font-bold inline-flex items-center gap-1.5"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>Settle Outstanding Bills</span>
                  </button>
                )}
                {safeDecimal(supplier.unallocatedPayments).greaterThan(0) && (
                  <button
                    type="button"
                    onClick={() => onOpenPaymentsTab(supplier.id)}
                    className="neu-btn-secondary text-xs px-3.5 py-2 font-bold inline-flex items-center gap-1.5"
                  >
                    <Receipt className="w-4 h-4 text-[var(--khata-accent)]" />
                    <span>Allocate Advance</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {supplier.archivedAt && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-xs text-amber-800 dark:text-amber-300">
            <strong>Archived Supplier:</strong> New purchase bills and edits to existing bills are disabled. You can still settle unpaid historical bills, allocate existing advances, reverse mistaken payments, and export historical statements.
          </div>
        )}

        {/* Unified Supplier Financial Figures */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-3 border-t border-[var(--khata-border)]">
          <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40">
            <span className="text-[10px] font-bold uppercase text-[var(--khata-text-muted)] block">
              Total Purchases
            </span>
            <span className="text-lg font-black font-mono text-[var(--khata-text)]">
              {formatAbsRupees(supplier.totalPurchases)}
            </span>
          </div>
          <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40">
            <span className="text-[10px] font-bold uppercase text-[var(--khata-text-muted)] block">
              Total Payments
            </span>
            <span className="text-lg font-black font-mono text-emerald-600 dark:text-emerald-400">
              {formatAbsRupees(supplier.totalPayments)}
            </span>
          </div>
          <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40">
            <span className="text-[10px] font-bold uppercase text-[var(--khata-text-muted)] block">
              Unallocated Advance
            </span>
            <span className="text-lg font-black font-mono text-[var(--khata-text)]">
              {formatAbsRupees(supplier.unallocatedPayments)}
            </span>
          </div>
          <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/40">
            <span className="text-[10px] font-bold uppercase text-[var(--khata-text-muted)] block">
              {net.greaterThan(0)
                ? 'Outstanding Payable'
                : net.lessThan(0)
                  ? 'Advance Credit'
                  : 'Net Balance'}
            </span>
            <span
              className={`text-lg font-black font-mono ${
                net.greaterThan(0)
                  ? 'text-rose-600 dark:text-rose-400'
                  : net.lessThan(0)
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-[var(--khata-text)]'
              }`}
            >
              {formatAbsRupees(net)}
            </span>
          </div>
        </div>
      </div>

      {/* Recent Purchase Bills & Payments Side by Side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-extrabold text-[var(--khata-text)] flex items-center gap-1.5">
              <Receipt className="w-4 h-4 text-[var(--khata-accent)]" />
              <span>Recent Purchase Bills ({supplier.purchaseBillCount})</span>
            </h3>
            <button
              type="button"
              onClick={() => onOpenPurchaseBillsTab(supplier.id)}
              className="text-xs font-bold text-[var(--khata-accent)] hover:underline"
            >
              Manage All
            </button>
          </div>
          {bills.length === 0 ? (
            <p className="text-xs text-[var(--khata-text-muted)] py-4">
              No purchase bills recorded for this supplier yet.
            </p>
          ) : (
            <div className="space-y-2">
              {bills.slice(0, 8).map((b) => (
                <div
                  key={b.id}
                  className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/30 border border-[var(--khata-border)]/60 flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <div>
                    <div className="font-bold text-[var(--khata-text)]">{b.invoiceNumber}</div>
                    <div className="text-[11px] text-[var(--khata-text-muted)] font-mono">
                      {b.invoiceDate} · {b.itemCount} items
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-bold">{formatAbsRupees(b.grandTotal)}</div>
                    <div className="text-[10px] font-bold uppercase text-[var(--khata-text-muted)]">
                      {b.status === 'cancelled'
                        ? 'Cancelled'
                        : `Due: ${formatAbsRupees(b.remainingAmount)}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-extrabold text-[var(--khata-text)] flex items-center gap-1.5">
              <CreditCard className="w-4 h-4 text-emerald-600" />
              <span>Recent Payments ({supplier.paymentCount})</span>
            </h3>
            <button
              type="button"
              onClick={() => onOpenPaymentsTab(supplier.id)}
              className="text-xs font-bold text-[var(--khata-accent)] hover:underline"
            >
              Manage All
            </button>
          </div>
          {payments.length === 0 ? (
            <p className="text-xs text-[var(--khata-text-muted)] py-4">
              No payments recorded for this supplier yet.
            </p>
          ) : (
            <div className="space-y-2">
              {payments.slice(0, 8).map((p) => {
                const isReversed = p.status === 'reversed';
                return (
                  <div
                    key={p.id}
                    className="p-3 rounded-xl bg-[var(--khata-surface-inset)]/30 border border-[var(--khata-border)]/60 flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-bold font-mono text-[var(--khata-text)]">
                          {p.receiptNumber}
                        </span>
                        {isReversed && (
                          <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400 text-[9px] font-bold uppercase">
                            Reversed
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[var(--khata-text-muted)]">
                        {p.paymentDate} · {p.paymentMethod.replace('_', ' ').toUpperCase()}
                      </div>
                    </div>
                    <div className="text-right">
                      {isReversed ? (
                        <>
                          <div className="font-mono font-bold line-through text-[var(--khata-text-muted)]">
                            {formatAbsRupees(p.amount)}
                          </div>
                          <div className="text-[10px] font-bold text-rose-600 dark:text-rose-400">
                            {p.reversalNumber || 'Reversed'}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                            {formatAbsRupees(p.amount)}
                          </div>
                          <div className="text-[10px] text-[var(--khata-text-muted)]">
                            Unallocated: {formatAbsRupees(p.unallocatedAmount)}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
