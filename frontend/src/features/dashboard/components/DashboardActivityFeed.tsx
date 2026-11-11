import React from 'react';
import { Activity, ArrowUpRight } from 'lucide-react';
import { formatCurrency } from '../../../lib/formatters.js';
import type {
  DashboardActivityItem,
  DashboardActivityType,
  DashboardTargetTab,
} from '../dashboard.types.js';
import { DashboardSection } from './DashboardSection.js';

export interface DashboardActivityFeedProps {
  items: DashboardActivityItem[];
  onNavigate: (tab: DashboardTargetTab) => void;
}

const TYPE_META: Record<DashboardActivityType, { label: string; badgeClass: string }> = {
  normal_bill: {
    label: 'Normal Bill',
    badgeClass: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
  },
  gst_invoice: {
    label: 'GST Invoice',
    badgeClass: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
  },
  khata_credit: {
    label: 'Khata Credit',
    badgeClass: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  },
  khata_payment: {
    label: 'Khata Receipt',
    badgeClass: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  },
  supplier_bill: {
    label: 'Purchase Bill',
    badgeClass: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30',
  },
  supplier_payment: {
    label: 'Supplier Payment',
    badgeClass: 'bg-teal-500/10 text-teal-700 dark:text-teal-300 border-teal-500/30',
  },
  supplier_payment_reversal: {
    label: 'Payment Reversal',
    badgeClass: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
  },
  supplier_allocation_reversal: {
    label: 'Allocation Reversal',
    badgeClass: 'bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/30',
  },
  supplier_bill_cancellation: {
    label: 'Bill Cancelled',
    badgeClass: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
  },
  expense: {
    label: 'Expense',
    badgeClass: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
  },
  expense_void: {
    label: 'Expense Voided',
    badgeClass: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
  },
  quotation: {
    label: 'Quotation',
    badgeClass: 'bg-slate-500/10 text-[var(--khata-text)] border-[var(--khata-border)]',
  },
};

export const DashboardActivityFeed: React.FC<DashboardActivityFeedProps> = React.memo(({
  items,
  onNavigate,
}) => {
  return (
    <DashboardSection
      title="Recent Business Activity"
      subtitle="Latest entries across billing, Khata ledger, suppliers, expenses & quotations."
      icon={<Activity className="w-4 h-4" />}
    >
      {items.length === 0 ? (
        <div className="p-6 rounded-xl bg-[var(--khata-surface-inset)] border border-dashed border-[var(--khata-border)] text-center text-xs text-[var(--khata-text-muted)]">
          No recent business activity found for the selected period.
        </div>
      ) : (
        <div className="divide-y divide-[var(--khata-border)]/70 rounded-xl border border-[var(--khata-border)] overflow-hidden bg-[var(--khata-surface-inset)]/50">
          {items.map((item, idx) => {
            const meta = TYPE_META[item.type] ?? {
              label: item.type,
              badgeClass: 'bg-slate-500/10 text-[var(--khata-text)] border-[var(--khata-border)]',
            };
            const isVoidedOrCancelled =
              item.status === 'voided' || item.status === 'cancelled' || item.status === 'reversed';

            return (
              <div
                key={`${item.type}-${item.reference}-${item.occurredAt}-${idx}`}
                className="p-3 sm:px-4 flex flex-wrap items-center justify-between gap-3 hover:bg-[var(--khata-surface)]/80 transition-colors"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${meta.badgeClass}`}>
                      {meta.label}
                    </span>
                    <span className="font-mono text-xs font-bold text-[var(--khata-text)] truncate">
                      {item.reference}
                    </span>
                    {item.status && (
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${
                          isVoidedOrCancelled
                            ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30'
                            : 'bg-[var(--khata-surface)] text-[var(--khata-text-muted)] border-[var(--khata-border)]'
                        }`}
                      >
                        {item.status}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--khata-text-muted)] truncate">
                    {item.party} • <span className="font-mono">{item.date}</span>
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`font-mono text-sm font-black ${
                      isVoidedOrCancelled ? 'line-through text-[var(--khata-text-muted)]' : 'text-[var(--khata-text)]'
                    }`}
                  >
                    {formatCurrency(item.amount)}
                  </span>
                  {item.targetTab !== 'home' && (
                    <button
                      type="button"
                      onClick={() => onNavigate(item.targetTab)}
                      aria-label={`Open ${meta.label} module`}
                      className="neu-btn-secondary text-[11px] px-2.5 py-1.5 min-h-[32px] font-bold inline-flex items-center gap-1"
                    >
                      <span>View</span>
                      <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </DashboardSection>
  );
});
