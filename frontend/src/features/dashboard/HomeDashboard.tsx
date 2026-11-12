import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Building2,
  Calculator,
  Clock,
  FileText,
  IndianRupee,
  Loader2,
  Package,
  Plus,
  Receipt,
  RefreshCw,
  ShoppingBag,
  Users,
  Wallet,
} from 'lucide-react';
import { formatCurrency, safeDecimal } from '../../lib/formatters.js';
import { useOptionalThemeAccessibility } from '../../context/ThemeAccessibilityContext.js';
import { getBusinessDateISO, isValidBusinessDate } from '../../utils/businessDate.js';
import type {
  DashboardDatePreset,
  DashboardOverviewData,
  DashboardTargetTab,
} from './dashboard.types.js';
import { fetchDashboardOverview, resolveHomeDateRange } from './dashboardApi.js';
import { DashboardActivityFeed } from './components/DashboardActivityFeed.js';
import { DashboardDateFilter } from './components/DashboardDateFilter.js';
import { DashboardExpenses } from './components/DashboardExpenses.js';
import { DashboardMetricCard } from './components/DashboardMetricCard.js';
import { DashboardProfitability } from './components/DashboardProfitability.js';
import { DashboardSalesTrend } from './components/DashboardSalesTrend.js';
import { DashboardSection } from './components/DashboardSection.js';

export interface HomeDashboardProps {
  onNavigate: (tab: DashboardTargetTab) => void;
}

export const HomeDashboard: React.FC<HomeDashboardProps> = ({ onNavigate }) => {
  const themeContext = useOptionalThemeAccessibility();
  const preferredDefaultPreset = themeContext?.workflowDefaults.defaultDatePreset ?? 'all_time';
  const [preset, setPreset] = useState<DashboardDatePreset>(preferredDefaultPreset);
  const appliedDefaultPresetRef = useRef<DashboardDatePreset>(preferredDefaultPreset);
  const userChangedPresetRef = useRef(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<DashboardOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState<string | null>(null);
  const [expenseCreateSignal, setExpenseCreateSignal] = useState(0);

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const activeRange = resolveHomeDateRange(preset, customFrom, customTo);
  const activeRangeLabel = (() => {
    if (preset === 'all_time') return 'All Time';
    if (activeRange.fromDate && activeRange.toDate) {
      return activeRange.fromDate === activeRange.toDate
        ? activeRange.fromDate
        : `${activeRange.fromDate} to ${activeRange.toDate}`;
    }
    if (activeRange.fromDate) return `From ${activeRange.fromDate}`;
    if (activeRange.toDate) return `Up to ${activeRange.toDate}`;
    return 'All Time';
  })();

  const loadOverview = async (
    targetPreset: DashboardDatePreset = preset,
    targetFrom: string = customFrom,
    targetTo: string = customTo
  ) => {
    // Always abort slower in-flight overview fetches and advance the request token BEFORE
    // returning early on invalid custom dates so stale responses cannot overwrite the error.
    abortRef.current?.abort();
    const currentReqId = ++requestIdRef.current;

    if (targetPreset === 'custom') {
      const trimmedFrom = targetFrom.trim();
      const trimmedTo = targetTo.trim();
      if (
        (trimmedFrom && !isValidBusinessDate(trimmedFrom)) ||
        (trimmedTo && !isValidBusinessDate(trimmedTo))
      ) {
        setError('Please enter valid YYYY-MM-DD dates for the custom range.');
        setLoading(false);
        return;
      }
    }

    const range = resolveHomeDateRange(targetPreset, targetFrom, targetTo);
    if (range.fromDate && range.toDate && range.toDate < range.fromDate) {
      setError('End date cannot be earlier than start date.');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    try {
      const overview = await fetchDashboardOverview(range, controller.signal);
      if (currentReqId !== requestIdRef.current) return;
      setData(overview);
      setLastUpdatedLabel(
        new Intl.DateTimeFormat('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }).format(new Date())
      );
    } catch (err) {
      if ((err as { code?: string })?.code === 'REQUEST_ABORTED') return;
      if (currentReqId !== requestIdRef.current) return;
      setError((err as Error).message || 'Unable to load business overview.');
    } finally {
      if (currentReqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadOverview(preferredDefaultPreset, '', '');
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (
      !userChangedPresetRef.current &&
      preferredDefaultPreset !== appliedDefaultPresetRef.current
    ) {
      appliedDefaultPresetRef.current = preferredDefaultPreset;
      setPreset(preferredDefaultPreset);
      void loadOverview(preferredDefaultPreset, '', '');
    }
  }, [preferredDefaultPreset]);

  const handlePresetChange = (nextPreset: DashboardDatePreset) => {
    userChangedPresetRef.current = true;
    setPreset(nextPreset);
    if (nextPreset !== 'custom') {
      void loadOverview(nextPreset, customFrom, customTo);
    }
  };

  const netOperatingDec = safeDecimal(data?.profitability.estimatedNetOperatingResult || '0');
  const netTone: 'success' | 'danger' | 'default' = data
    ? netOperatingDec.isNegative()
      ? 'danger'
      : netOperatingDec.greaterThan(0)
      ? 'success'
      : 'default'
    : 'default';

  const todayDisplay = data?.businessDate || getBusinessDateISO();

  return (
    <div className="space-y-6" data-testid="home-dashboard">
      {/* Header & Quick Shortcuts */}
      <div className="neu-card p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-black tracking-tight text-[var(--khata-text)]">
              Business Overview
            </h1>
            <p className="text-xs sm:text-sm text-[var(--khata-text-muted)] font-medium mt-0.5">
              Live financial position, profitability, receivables, payables & operating expenses across Khata ERP.
            </p>
            <div className="flex flex-wrap items-center gap-3 mt-1.5 text-[11px] font-mono text-[var(--khata-text-muted)]">
              <span>Business Date: {todayDisplay}</span>
              {lastUpdatedLabel && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" aria-hidden="true" />
                  <span>Updated {lastUpdatedLabel}</span>
                </span>
              )}
              {data?.syncStatus?.isStale && (
                <span
                  data-testid="sync-stale-badge"
                  title={
                    data.syncStatus.deadLetterCount
                      ? `${data.syncStatus.deadLetterCount} read-model event(s) require retry. Authoritative ledger writes remain safe in PostgreSQL.`
                      : data.syncStatus.projectionSyncedAt
                      ? `Last projection sync: ${new Date(data.syncStatus.projectionSyncedAt).toLocaleString()}`
                      : 'Read-model snapshot is catching up with PostgreSQL writes.'
                  }
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                >
                  {(data.syncStatus.deadLetterCount ?? 0) > 0
                    ? `Sync needs attention (${data.syncStatus.deadLetterCount} failed)`
                    : data.syncStatus.outboxDegraded
                    ? 'Sync degraded (catching up)'
                    : 'Sync catching up'}
                </span>
              )}
              {data?.syncStatus && !data.syncStatus.isStale && data.syncStatus.source === 'mongodb' && (
                <span
                  data-testid="sync-fresh-badge"
                  title={
                    data.syncStatus.projectionSyncedAt
                      ? `Projections synced: ${new Date(data.syncStatus.projectionSyncedAt).toLocaleString()}`
                      : undefined
                  }
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20"
                >
                  Read model synced
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => void loadOverview()}
            aria-label="Refresh dashboard metrics"
            className="neu-btn-secondary text-xs px-3.5 py-2 min-h-[40px] font-bold inline-flex items-center gap-1.5 shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? 'Refreshing...' : 'Refresh'}</span>
          </button>
        </div>

        {/* Quick Actions Strip */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--khata-border)]/70">
          <button
            type="button"
            onClick={() => onNavigate('gst-bill')}
            className="neu-btn-primary text-xs px-3 py-2 min-h-[38px]"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>GST Bill</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('normal-bill')}
            className="neu-btn-secondary text-xs px-3 py-2 min-h-[38px] font-bold"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Normal Bill</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('khata')}
            className="neu-btn-secondary text-xs px-3 py-2 min-h-[38px] font-bold"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Khata Entry</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('quotations')}
            className="neu-btn-secondary text-xs px-3 py-2 min-h-[38px] font-bold"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Quotation</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('suppliers')}
            className="neu-btn-secondary text-xs px-3 py-2 min-h-[38px] font-bold"
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Suppliers</span>
          </button>
          <button
            type="button"
            onClick={() => setExpenseCreateSignal((c) => c + 1)}
            className="neu-btn-secondary text-xs px-3 py-2 min-h-[38px] font-bold text-amber-600 dark:text-amber-400"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Expense</span>
          </button>
        </div>
      </div>

      {/* Period Selector */}
      <DashboardDateFilter
        preset={preset}
        customFrom={customFrom}
        customTo={customTo}
        activeRangeLabel={activeRangeLabel}
        onPresetChange={handlePresetChange}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
        onApplyCustom={() => void loadOverview('custom', customFrom, customTo)}
      />

      {/* Error Banner with Retry */}
      {error && (
        <div
          role="alert"
          className="neu-card p-4 border-rose-500/40 bg-rose-500/10 flex flex-wrap items-center justify-between gap-3 text-xs text-rose-700 dark:text-rose-300"
        >
          <div className="flex flex-wrap items-center gap-2 font-bold min-w-0">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadOverview()}
            className="neu-btn-secondary text-xs px-3 py-1.5 min-h-[34px] font-bold"
          >
            Retry
          </button>
        </div>
      )}

      {/* Skeleton Loading State on Initial Load */}
      {loading && !data ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading business overview">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="neu-card p-5 h-32 animate-pulse bg-[var(--khata-surface-inset)]" />
            ))}
          </div>
          <div className="neu-card p-6 h-44 animate-pulse bg-[var(--khata-surface-inset)] flex items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading live PostgreSQL business analytics...</span>
          </div>
        </div>
      ) : data ? (
        <>
          {/* Primary Executive KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            <DashboardMetricCard
              testId="kpi-sales-revenue"
              title="Sales Revenue (Excl. GST)"
              value={formatCurrency(data.sales.totalSalesRevenue)}
              subtitle={`${data.sales.totalBillsCount} bills • Avg ${formatCurrency(data.sales.averageBillValue)}`}
              badgeText={`GST: ${formatCurrency(data.sales.gstCollected)}`}
              tone="accent"
              icon={<IndianRupee className="w-4 h-4" />}
              onClick={() => onNavigate('gst-bill')}
              actionLabel="View billing"
            />

            <DashboardMetricCard
              testId="kpi-net-operating"
              title={
                data.profitability.hasIncompleteCostData
                  ? 'Partial Est. Net Operating Result'
                  : 'Est. Net Operating Result'
              }
              value={formatCurrency(data.profitability.estimatedNetOperatingResult)}
              subtitle={`Gross ${formatCurrency(data.profitability.estimatedGrossProfit)} − Exp ${formatCurrency(data.profitability.operatingExpenses)}`}
              badgeText={`${data.profitability.costCoveragePercent}% costed`}
              tone={netTone}
              icon={<Calculator className="w-4 h-4" />}
            />

            <DashboardMetricCard
              testId="kpi-khata-receivable"
              title="Khata Receivable (Live)"
              value={formatCurrency(data.customersKhata.totalOutstandingReceivable)}
              subtitle={`${data.customersKhata.customersWithOutstanding} customer(s) owing • All-time live balance`}
              tone="warning"
              icon={<BookOpen className="w-4 h-4" />}
              onClick={() => onNavigate('khata')}
              actionLabel="Open Khata"
            />

            <DashboardMetricCard
              testId="kpi-supplier-payable"
              title="Supplier Payable (Live)"
              value={formatCurrency(data.suppliers.totalOutstandingPayable)}
              subtitle={`Advance: ${formatCurrency(data.suppliers.totalAdvanceCredit)} • All-time live balance`}
              tone="danger"
              icon={<Building2 className="w-4 h-4" />}
              onClick={() => onNavigate('suppliers')}
              actionLabel="Open Suppliers"
            />

            <DashboardMetricCard
              testId="kpi-operating-expenses"
              title="Operating Expenses"
              value={formatCurrency(data.profitability.operatingExpenses)}
              subtitle={`${data.profitability.operatingExpensesCount} active record(s)`}
              tone="default"
              icon={<Receipt className="w-4 h-4" />}
            />
          </div>

          {/* Profitability & Margin Analytics */}
          <DashboardProfitability sales={data.sales} profitability={data.profitability} />

          {/* Sales Trend */}
          <DashboardSalesTrend
            granularity={data.salesTrend.granularity}
            effectiveFromDate={data.salesTrend.effectiveFromDate}
            effectiveToDate={data.salesTrend.effectiveToDate}
            isSixMonthWindow={data.salesTrend.isSixMonthWindow}
            points={data.salesTrend.points}
          />

          {/* Cross-Module Operational Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Sales & Billing Breakdown */}
            <DashboardSection
              title="Sales & Billing Breakdown"
              subtitle="Customer-facing invoices separated strictly from GST statutory tax collected."
              icon={<ShoppingBag className="w-4 h-4" />}
              actionLabel="Normal Bills"
              onAction={() => onNavigate('normal-bill')}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Normal Bills ({data.sales.normalBillsCount})
                  </p>
                  <p className="text-base font-black font-mono text-[var(--khata-text)] mt-1">
                    {formatCurrency(data.sales.normalBillsTotal)}
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    GST Taxable ({data.sales.gstInvoicesCount})
                  </p>
                  <p className="text-base font-black font-mono text-[var(--khata-text)] mt-1">
                    {formatCurrency(data.sales.gstTaxableSales)}
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    GST Tax Collected
                  </p>
                  <p className="text-base font-black font-mono text-indigo-600 dark:text-indigo-400 mt-1">
                    {formatCurrency(data.sales.gstCollected)}
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)] mt-0.5">
                    Excluded from sales revenue
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Total Billed (Incl. GST)
                  </p>
                  <p className="text-base font-black font-mono text-[var(--khata-accent)] mt-1">
                    {formatCurrency(data.sales.totalBilledAmountIncludingGst)}
                  </p>
                </div>
              </div>
            </DashboardSection>

            {/* Customers & Khata */}
            <DashboardSection
              title="Customers & Khata Ledger"
              subtitle="Udhar credit given and collections tracked separately from billed sales."
              icon={<Users className="w-4 h-4" />}
              actionLabel="Open Khata"
              onAction={() => onNavigate('khata')}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Total Customers
                  </p>
                  <p className="text-base font-black font-mono text-[var(--khata-text)] mt-1">
                    {data.customersKhata.totalCustomers}
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)] mt-0.5">
                    {data.customersKhata.activeCustomers} active • {data.customersKhata.newCustomersCount} new in period
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Live Receivable
                  </p>
                  <p className="text-base font-black font-mono text-amber-600 dark:text-amber-400 mt-1">
                    {formatCurrency(data.customersKhata.totalOutstandingReceivable)}
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)] mt-0.5">
                    {data.customersKhata.customersWithOutstanding} customer(s) owing
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Khata Credit Given
                  </p>
                  <p className="text-base font-black font-mono text-[var(--khata-text)] mt-1">
                    {formatCurrency(data.customersKhata.creditGiven)}
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Payments Received ({data.customersKhata.paymentCount})
                  </p>
                  <p className="text-base font-black font-mono text-emerald-600 dark:text-emerald-400 mt-1">
                    {formatCurrency(data.customersKhata.paymentsReceived)}
                  </p>
                </div>
              </div>
            </DashboardSection>

            {/* Suppliers & Purchases */}
            <DashboardSection
              title="Suppliers & Purchase Payables"
              subtitle="Finalized purchase bills & active supplier payments (cancelled bills & reversals excluded)."
              icon={<Wallet className="w-4 h-4" />}
              actionLabel="Open Suppliers"
              onAction={() => onNavigate('suppliers')}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Purchases ({data.suppliers.purchaseBillsCount} Bills)
                  </p>
                  <p className="text-base font-black font-mono text-[var(--khata-text)] mt-1">
                    {formatCurrency(data.suppliers.totalPurchases)}
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)] mt-0.5">
                    {data.suppliers.cancelledBillsCount} cancelled excluded
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Supplier Payments ({data.suppliers.paymentsCount})
                  </p>
                  <p className="text-base font-black font-mono text-teal-600 dark:text-teal-400 mt-1">
                    {formatCurrency(data.suppliers.totalPaymentsMade)}
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)] mt-0.5">
                    Reversed: {formatCurrency(data.suppliers.totalPaymentsReversed)}
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Outstanding Payable
                  </p>
                  <p className="text-base font-black font-mono text-rose-600 dark:text-rose-400 mt-1">
                    {formatCurrency(data.suppliers.totalOutstandingPayable)}
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)] mt-0.5">
                    {data.suppliers.activeSuppliers} active / {data.suppliers.totalSuppliers} suppliers
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Advance Credit / Unallocated
                  </p>
                  <p className="text-base font-black font-mono text-[var(--khata-text)] mt-1">
                    {formatCurrency(data.suppliers.totalAdvanceCredit)}
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)] mt-0.5">
                    Unallocated cash: {formatCurrency(data.suppliers.totalUnallocatedPayments)}
                  </p>
                </div>
              </div>
            </DashboardSection>

            {/* Quotations Pipeline */}
            <DashboardSection
              title="Quotations Pipeline"
              subtitle="Draft, sent, accepted, converted & expired quotes (non-converted quotes excluded from sales)."
              icon={<FileText className="w-4 h-4" />}
              actionLabel="Open Quotations"
              onAction={() => onNavigate('quotations')}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Pending Open Pipeline
                  </p>
                  <p className="text-base font-black font-mono text-[var(--khata-accent)] mt-1">
                    {formatCurrency(data.quotations.pendingPipelineValue)}
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)] mt-0.5">
                    {data.quotations.draftCount} draft • {data.quotations.sentCount} sent • {data.quotations.acceptedCount} accepted
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <p className="text-[11px] font-bold uppercase text-[var(--khata-text-muted)]">
                    Converted ({data.quotations.convertedCount} / {data.quotations.totalCount})
                  </p>
                  <p className="text-base font-black font-mono text-emerald-600 dark:text-emerald-400 mt-1">
                    {data.quotations.conversionRatePercent}%
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)] mt-0.5">
                    Value: {formatCurrency(data.quotations.convertedValue)}
                  </p>
                </div>

                <div className="col-span-2 p-3 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--khata-text-muted)]">
                    Total Quotes: <strong className="font-mono text-[var(--khata-text)]">{data.quotations.totalCount}</strong>
                  </span>
                  <span className="font-semibold text-[var(--khata-text-muted)]">
                    Rejected: <strong className="font-mono text-[var(--khata-text)]">{data.quotations.rejectedCount}</strong>
                  </span>
                  <span className="font-semibold text-[var(--khata-text-muted)]">
                    Expired: <strong className="font-mono text-[var(--khata-text)]">{data.quotations.expiredCount}</strong>
                  </span>
                </div>
              </div>
            </DashboardSection>
          </div>

          {/* Products Catalog & Top Products */}
          <DashboardSection
            title="Products & Top-Selling Catalog Items"
            subtitle={`Catalog overview: ${data.products.activeProducts} active, ${data.products.archivedProducts} archived (${data.products.totalProducts} total).`}
            icon={<Package className="w-4 h-4" />}
            actionLabel="Manage Products"
            onAction={() => onNavigate('products')}
          >
            {data.products.topProducts.length === 0 ? (
              <div className="p-5 rounded-xl bg-[var(--khata-surface-inset)] border border-dashed border-[var(--khata-border)] text-center text-xs text-[var(--khata-text-muted)]">
                No product-linked sales items recorded in this period.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                {data.products.topProducts.map((prod, idx) => (
                  <div
                    key={prod.productId}
                    className="p-3.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className="text-[10px] font-mono font-bold text-[var(--khata-accent)]">
                        #{idx + 1} Top Product
                      </span>
                      {prod.isArchived && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-500/15 text-[var(--khata-text-muted)]">
                          Archived
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-extrabold text-[var(--khata-text)] truncate" title={prod.productName}>
                      {prod.productName}
                    </p>
                    <p className="text-sm font-black font-mono text-[var(--khata-text)]">
                      {formatCurrency(prod.totalSalesAmount)}
                    </p>
                    <p className="text-[11px] text-[var(--khata-text-muted)]">
                      Qty <span className="font-mono font-bold">{prod.totalQuantitySold}</span> •{' '}
                      <span className="font-mono font-bold">{prod.billCount}</span> bill(s)
                    </p>
                  </div>
                ))}
              </div>
            )}
          </DashboardSection>

          {/* Operating Expenses Management */}
          <DashboardExpenses
            fromDate={activeRange.fromDate}
            toDate={activeRange.toDate}
            categoryTotals={data.expensesByCategory}
            externalCreateTrigger={expenseCreateSignal}
            onExpensesMutated={() => loadOverview()}
          />

          {/* Recent Business Activity */}
          <DashboardActivityFeed items={data.recentActivity} onNavigate={onNavigate} />
        </>
      ) : null}
    </div>
  );
};
