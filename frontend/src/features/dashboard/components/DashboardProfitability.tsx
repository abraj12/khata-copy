import React from 'react';
import { AlertTriangle, Calculator, CheckCircle2, Info, TrendingUp } from 'lucide-react';
import { formatCurrency, safeDecimal } from '../../../lib/formatters.js';
import type { DashboardProfitabilitySummary, DashboardSalesSummary } from '../dashboard.types.js';
import { DashboardSection } from './DashboardSection.js';

export interface DashboardProfitabilityProps {
  sales: DashboardSalesSummary;
  profitability: DashboardProfitabilitySummary;
}

export const DashboardProfitability: React.FC<DashboardProfitabilityProps> = React.memo(({
  sales,
  profitability,
}) => {
  const netResultDec = safeDecimal(profitability.estimatedNetOperatingResult);
  const grossProfitDec = safeDecimal(profitability.estimatedGrossProfit);
  const isNetNegative = netResultDec.isNegative();
  const isGrossNegative = grossProfitDec.isNegative();
  const coveragePct = profitability.costCoveragePercent;
  const hasSales = safeDecimal(profitability.totalSalesRevenue).greaterThan(0);

  return (
    <DashboardSection
      title="Profitability & Margin Analysis"
      subtitle="Calculated strictly from sales revenue excluding GST collected, less snapshotted line-item COGS and operating expenses."
      icon={<Calculator className="w-4 h-4" />}
      rightSlot={
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border ${
            profitability.hasIncompleteCostData
              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'
              : hasSales
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
              : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)] border-[var(--khata-border)]'
          }`}
        >
          {profitability.hasIncompleteCostData ? (
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          <span>Cost Coverage: {coveragePct}%</span>
        </span>
      }
    >
      {profitability.hasIncompleteCostData && (
        <div
          role="note"
          className="rounded-xl p-3 border border-amber-500/30 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-200 flex flex-wrap items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-bold">Partial Cost Data Notice (Estimated Figures)</p>
            <p className="mt-0.5 opacity-90">
              {formatCurrency(profitability.uncostedSalesRevenue)} of sales revenue comes from legacy or
              manual bill items without a historical buying-price snapshot. Gross profit ({' '}
              <span className="font-mono font-bold">{formatCurrency(profitability.estimatedGrossProfit)}</span>
              ) and margin (<span className="font-mono font-bold">{profitability.estimatedGrossMarginPercent}%</span>)
              are computed strictly on the {formatCurrency(profitability.costedSalesRevenue)} cost-covered portion.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <div className="p-3.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
          <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
            Sales Revenue (Excl. GST)
          </p>
          <p className="text-lg font-black font-mono text-[var(--khata-text)] mt-1">
            {formatCurrency(profitability.totalSalesRevenue)}
          </p>
          <p className="text-[11px] text-[var(--khata-text-muted)] mt-1">
            GST collected separately: <span className="font-mono font-bold">{formatCurrency(sales.gstCollected)}</span>
          </p>
        </div>

        <div className="p-3.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
          <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
            Costed Sales Portion
          </p>
          <p className="text-lg font-black font-mono text-[var(--khata-text)] mt-1">
            {formatCurrency(profitability.costedSalesRevenue)}
          </p>
          <p className="text-[11px] text-[var(--khata-text-muted)] mt-1">
            Uncosted: <span className="font-mono font-bold">{formatCurrency(profitability.uncostedSalesRevenue)}</span>
          </p>
        </div>

        <div className="p-3.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
          <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
            Est. Cost of Goods Sold
          </p>
          <p className="text-lg font-black font-mono text-[var(--khata-text)] mt-1">
            {formatCurrency(profitability.estimatedCostOfGoodsSold)}
          </p>
          <p className="text-[11px] text-[var(--khata-text-muted)] mt-1">
            From historical buying snapshots
          </p>
        </div>

        <div className="p-3.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
          <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
            Est. Gross Profit
          </p>
          <p
            className={`text-lg font-black font-mono mt-1 ${
              isGrossNegative ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {formatCurrency(profitability.estimatedGrossProfit)}
          </p>
          <p className="text-[11px] text-[var(--khata-text-muted)] mt-1 flex items-center gap-1">
            <TrendingUp className="w-3 h-3" aria-hidden="true" />
            <span>Margin: {profitability.estimatedGrossMarginPercent}%</span>
          </p>
        </div>

        <div className="p-3.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
          <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
            Operating Expenses
          </p>
          <p className="text-lg font-black font-mono text-amber-600 dark:text-amber-400 mt-1">
            {formatCurrency(profitability.operatingExpenses)}
          </p>
          <p className="text-[11px] text-[var(--khata-text-muted)] mt-1">
            {profitability.operatingExpensesCount} active ({profitability.voidedExpensesCount} voided)
          </p>
        </div>

        <div className="p-3.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
          <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
            {profitability.hasIncompleteCostData
              ? 'Partial Est. Net Operating Result'
              : 'Est. Net Operating Result'}
          </p>
          <p
            className={`text-lg font-black font-mono mt-1 ${
              isNetNegative ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {formatCurrency(profitability.estimatedNetOperatingResult)}
          </p>
          <p className="text-[11px] text-[var(--khata-text-muted)] mt-1">
            {isNetNegative
              ? profitability.hasIncompleteCostData
                ? 'Partial operating loss (covered sales − exp)'
                : 'Net operating loss'
              : profitability.hasIncompleteCostData
              ? 'Covered gross profit − expenses'
              : 'Est. gross profit − expenses'}
          </p>
        </div>
      </div>

      <p className="text-[11px] text-[var(--khata-text-muted)] flex items-center gap-1.5">
        <Info className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
        <span>
          Non-statutory operational estimate. Excludes GST collected, customer Khata credit/collections, supplier purchase payments (balance-sheet settlements), and non-converted quotations.
        </span>
      </p>
    </DashboardSection>
  );
});
