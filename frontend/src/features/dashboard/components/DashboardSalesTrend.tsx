import React from 'react';
import { BarChart3 } from 'lucide-react';
import { formatCurrency, safeDecimal } from '../../../lib/formatters.js';
import type { DashboardTrendPoint } from '../dashboard.types.js';
import { DashboardSection } from './DashboardSection.js';

export interface DashboardSalesTrendProps {
  granularity: 'day' | 'month';
  effectiveFromDate?: string;
  effectiveToDate?: string;
  isSixMonthWindow?: boolean;
  points: DashboardTrendPoint[];
}

export const DashboardSalesTrend: React.FC<DashboardSalesTrendProps> = React.memo(({
  granularity,
  effectiveFromDate,
  effectiveToDate,
  isSixMonthWindow = false,
  points,
}) => {
  const maxVal = points.reduce((acc, point) => {
    const rev = safeDecimal(point.totalSalesRevenue).toNumber();
    const exp = safeDecimal(point.expenses).toNumber();
    return Math.max(acc, rev, exp);
  }, 0);

  const hasAnyActivity = points.some(
    (p) => safeDecimal(p.totalSalesRevenue).greaterThan(0) || safeDecimal(p.expenses).greaterThan(0)
  );

  const subtitle = isSixMonthWindow && effectiveFromDate && effectiveToDate
    ? `Showing trailing 6-month monthly window (${effectiveFromDate} to ${effectiveToDate}) — KPI totals above still reflect All Time; excludes GST collected.`
    : effectiveFromDate && effectiveToDate
    ? `${granularity === 'day' ? 'Daily' : 'Monthly'} sales revenue vs operating expenses (${effectiveFromDate} to ${effectiveToDate}; excludes GST collected).`
    : `${granularity === 'day' ? 'Daily' : 'Monthly'} sales revenue (Normal + GST Taxable, excluding GST collected) vs operating expenses.`;

  return (
    <DashboardSection
      title="Sales & Expense Trend"
      subtitle={subtitle}
      icon={<BarChart3 className="w-4 h-4" />}
      rightSlot={
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-bold text-[var(--khata-text-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[var(--khata-accent)] inline-block" aria-hidden="true" />
            <span>Sales Revenue</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" aria-hidden="true" />
            <span>Expenses</span>
          </span>
        </div>
      }
    >
      {points.length === 0 || !hasAnyActivity ? (
        <div className="p-6 rounded-xl bg-[var(--khata-surface-inset)] border border-dashed border-[var(--khata-border)] text-center text-xs text-[var(--khata-text-muted)]">
          No sales or operating expense activity recorded in this period yet.
        </div>
      ) : (
        <div className="space-y-3 overflow-x-auto">
          <div className="min-w-[460px] grid gap-2" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(44px, 1fr))` }}>
            {points.map((point) => {
              const revNum = safeDecimal(point.totalSalesRevenue).toNumber();
              const expNum = safeDecimal(point.expenses).toNumber();
              const revHeightPct = maxVal > 0 ? Math.max(revNum > 0 ? 6 : 0, Math.round((revNum / maxVal) * 100)) : 0;
              const expHeightPct = maxVal > 0 ? Math.max(expNum > 0 ? 6 : 0, Math.round((expNum / maxVal) * 100)) : 0;

              return (
                <div
                  key={point.bucket}
                  className="flex flex-col items-center gap-1.5 group"
                  title={`${point.label} — Sales: ${formatCurrency(point.totalSalesRevenue)} (${point.billsCount} bills), GST: ${formatCurrency(point.gstCollected)}, Expenses: ${formatCurrency(point.expenses)}`}
                >
                  <div className="w-full h-36 px-1 pt-2 rounded-lg bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]/70 flex items-end justify-center gap-1">
                    <div
                      className="w-1/2 max-w-[18px] rounded-t-md bg-[var(--khata-accent)] transition-all"
                      style={{ height: `${revHeightPct}%` }}
                      aria-label={`${point.label} sales ${formatCurrency(point.totalSalesRevenue)}`}
                    />
                    <div
                      className="w-1/2 max-w-[18px] rounded-t-md bg-amber-500/85 transition-all"
                      style={{ height: `${expHeightPct}%` }}
                      aria-label={`${point.label} expenses ${formatCurrency(point.expenses)}`}
                    />
                  </div>
                  <span className="text-[10px] font-bold text-[var(--khata-text)] text-center leading-tight truncate max-w-full">
                    {point.label}
                  </span>
                  <span className="text-[10px] font-mono text-[var(--khata-text-muted)] truncate max-w-full">
                    {formatCurrency(point.totalSalesRevenue)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </DashboardSection>
  );
});
