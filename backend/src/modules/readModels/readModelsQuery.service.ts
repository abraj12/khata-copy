import Decimal from 'decimal.js';
import { env } from '../../config/env.js';
import { isMongoReady } from '../../config/mongodb.js';
import { isR2Configured } from '../../config/env.js';
import { getBusinessDateISO, isValidCalendarDate } from '../../utils/businessDate.js';
import {
  CustomerSummaryModel,
  DailyAnalyticsModel,
  DashboardSnapshotModel,
  ProductSearchModel,
  RecentActivityModel,
  type DailyAnalyticsDoc,
  type DashboardSnapshotGlobals,
} from './models.js';
import { normalizeSearchText } from './readModelSync.service.js';
import type {
  DashboardActivityItem,
  DashboardExpenseCategoryTotal,
  DashboardOverviewData,
  DashboardQuotationsSummary,
  DashboardTopProductItem,
  DashboardTrendPoint,
} from '../dashboard/dashboard.service.js';

type ExpenseCategory = DashboardExpenseCategoryTotal['category'];

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

const VALID_EXPENSE_CATEGORIES = new Set<string>([
  'rent',
  'electricity',
  'salaries',
  'transport',
  'packaging',
  'maintenance',
  'marketing',
  'misc',
]);

export interface ReadModelSyncStatus {
  source: 'mongodb';
  syncedAt: string | null;
  ageMs: number | null;
  isStale: boolean;
  projectionSyncedAt?: string | null;
  projectionAgeMs?: number | null;
  dashboardSyncedAt?: string | null;
  dashboardAgeMs?: number | null;
  deadLetterCount?: number;
  outboxDegraded?: boolean;
}

export class InvalidPaginationCursorError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'INVALID_PAGINATION_CURSOR';

  constructor(message = 'Invalid pagination cursor.') {
    super(message);
    this.name = 'InvalidPaginationCursorError';
  }
}

export class ReadModelUnavailableError extends Error {
  public readonly statusCode = 503;
  public readonly code = 'READ_MODEL_UNAVAILABLE';

  constructor(message = 'Read model projection is unavailable.') {
    super(message);
    this.name = 'ReadModelUnavailableError';
  }
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeProductCursor(rawCursor: string): { n: string; id: number } {
  try {
    const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.n !== 'string' ||
      typeof parsed.id !== 'number' ||
      !Number.isSafeInteger(parsed.id) ||
      parsed.id <= 0
    ) {
      throw new InvalidPaginationCursorError();
    }
    return { n: parsed.n, id: parsed.id };
  } catch {
    throw new InvalidPaginationCursorError();
  }
}

function decodeCustomerCursor(rawCursor: string): { o: number; l: number | null; id: number } {
  try {
    const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.o !== 'number' ||
      !Number.isFinite(parsed.o) ||
      (parsed.l !== null && (typeof parsed.l !== 'number' || !Number.isFinite(parsed.l))) ||
      typeof parsed.id !== 'number' ||
      !Number.isSafeInteger(parsed.id) ||
      parsed.id <= 0
    ) {
      throw new InvalidPaginationCursorError();
    }
    return { o: parsed.o, l: parsed.l, id: parsed.id };
  } catch {
    throw new InvalidPaginationCursorError();
  }
}

function toFixedMoney(value: Decimal.Value): string {
  return new Decimal(value || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function toFixedQuantity(value: Decimal.Value): string {
  const d = new Decimal(value || 0).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  return d.toFixed(d.decimalPlaces() === 0 ? 0 : Math.min(2, d.decimalPlaces()));
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function daysInclusive(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.floor((toMs - fromMs) / 86_400_000) + 1;
}

function addDaysIso(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function shiftYearMonth(ym: string, deltaMonths: number): string {
  const [y, m] = ym.split('-').map(Number);
  const totalMonths = y * 12 + (m - 1) + deltaMonths;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
}

function enumerateYearMonths(fromYm: string, toYm: string): string[] {
  const result: string[] = [];
  let cursor = fromYm;
  let guard = 0;
  while (cursor <= toYm && guard < 240) {
    result.push(cursor);
    cursor = shiftYearMonth(cursor, 1);
    guard += 1;
  }
  return result;
}

function formatDayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(dt);
}

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  return new Intl.DateTimeFormat('en-IN', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dt);
}

export interface SnapshotFreshnessInput {
  lastSyncedAt?: Date | string | null;
  lastProjectionSyncAt?: Date | string | null;
  lastDashboardRefreshAt?: Date | string | null;
}

export class ReadModelsQueryService {
  private outboxBacklogPending = false;
  private deadLetterCount = 0;
  private lastWorkerError: string | null = null;

  public getStaleThresholdMs(): number {
    const raw = Number(env.MONGODB_READ_STALE_THRESHOLD_MS);
    return Number.isFinite(raw) && raw >= 5_000 ? raw : 300_000;
  }

  public markOutboxBacklogPending(pending: boolean): void {
    this.outboxBacklogPending = pending;
  }

  public isOutboxBacklogPending(): boolean {
    return this.outboxBacklogPending;
  }

  public setOutboxDeadLetterCount(count: number): void {
    this.deadLetterCount = Math.max(0, Math.trunc(count || 0));
  }

  public getOutboxDeadLetterCount(): number {
    return this.deadLetterCount;
  }

  public setLastWorkerError(err: string | null): void {
    this.lastWorkerError = err;
  }

  public getLastWorkerError(): string | null {
    return this.lastWorkerError;
  }

  private assertMongoReady(): void {
    if (!isMongoReady()) {
      throw new ReadModelUnavailableError('MongoDB read-model store is not connected.');
    }
  }

  private parseTimestamp(val: Date | string | null | undefined): {
    iso: string | null;
    ageMs: number | null;
    valid: boolean;
  } {
    if (!val) return { iso: null, ageMs: null, valid: false };
    const dt = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(dt.getTime())) return { iso: null, ageMs: null, valid: false };
    return {
      iso: dt.toISOString(),
      ageMs: Math.max(0, Date.now() - dt.getTime()),
      valid: true,
    };
  }

  public buildSyncStatus(
    snapshotOrDate: SnapshotFreshnessInput | Date | string | null | undefined,
    scope: 'projection' | 'dashboard' = 'dashboard'
  ): ReadModelSyncStatus {
    const staleThresholdMs = this.getStaleThresholdMs();
    const outboxDegraded =
      this.outboxBacklogPending || this.deadLetterCount > 0 || this.lastWorkerError !== null;

    if (!snapshotOrDate) {
      return {
        source: 'mongodb',
        syncedAt: null,
        ageMs: null,
        isStale: true,
        projectionSyncedAt: null,
        projectionAgeMs: null,
        dashboardSyncedAt: null,
        dashboardAgeMs: null,
        deadLetterCount: this.deadLetterCount,
        outboxDegraded,
      };
    }

    const input: SnapshotFreshnessInput =
      snapshotOrDate instanceof Date || typeof snapshotOrDate === 'string'
        ? { lastSyncedAt: snapshotOrDate }
        : snapshotOrDate;

    const dashboardMeta = this.parseTimestamp(input.lastDashboardRefreshAt ?? input.lastSyncedAt);
    const projectionMeta = this.parseTimestamp(
      input.lastProjectionSyncAt ?? input.lastSyncedAt ?? input.lastDashboardRefreshAt
    );

    const primaryMeta = scope === 'projection' ? projectionMeta : dashboardMeta;
    const isStale =
      !primaryMeta.valid ||
      (primaryMeta.ageMs !== null && primaryMeta.ageMs > staleThresholdMs) ||
      this.outboxBacklogPending ||
      this.deadLetterCount > 0;

    return {
      source: 'mongodb',
      syncedAt: primaryMeta.iso,
      ageMs: primaryMeta.ageMs,
      isStale,
      projectionSyncedAt: projectionMeta.iso,
      projectionAgeMs: projectionMeta.ageMs,
      dashboardSyncedAt: dashboardMeta.iso,
      dashboardAgeMs: dashboardMeta.ageMs,
      deadLetterCount: this.deadLetterCount,
      outboxDegraded,
    };
  }

  /**
   * Builds a complete DashboardOverviewData payload from MongoDB daily_analytics,
   * recent_activity, and the supplied DashboardSnapshotGlobals (0 PostgreSQL queries).
   */
  public async buildOverviewFromAnalytics(
    globals: DashboardSnapshotGlobals,
    query: { fromDate?: string; toDate?: string }
  ): Promise<DashboardOverviewData> {
    this.assertMongoReady();

    const timeZone = env.BUSINESS_TIME_ZONE || 'Asia/Kolkata';
    const businessDate = getBusinessDateISO(timeZone);
    const fromDate = query.fromDate && isValidCalendarDate(query.fromDate) ? query.fromDate : undefined;
    const toDate = query.toDate && isValidCalendarDate(query.toDate) ? query.toDate : undefined;

    const dateFilter: Record<string, string> = {};
    if (fromDate) dateFilter.$gte = fromDate;
    if (toDate) dateFilter.$lte = toDate;

    const dailyQuery = Object.keys(dateFilter).length > 0 ? { businessDate: dateFilter } : {};

    const [dailyDocs, recentDocs] = await Promise.all([
      DailyAnalyticsModel.find(dailyQuery).sort({ businessDate: 1 }).lean(),
      RecentActivityModel.find({}).sort({ occurredAt: -1 }).limit(12).lean(),
    ]);

    let normalBillsCount = 0;
    let normalBillsTotal = new Decimal(0);
    let normalCostedRevenue = new Decimal(0);
    let normalCogsTotal = new Decimal(0);

    let gstInvoicesCount = 0;
    let gstTaxableSales = new Decimal(0);
    let gstCollected = new Decimal(0);
    let gstInvoicesGrandTotal = new Decimal(0);
    let gstCostedRevenue = new Decimal(0);
    let gstCogsTotal = new Decimal(0);

    let expensesActiveCount = 0;
    let expensesActiveTotal = new Decimal(0);
    let expensesVoidedCount = 0;

    let newCustomersCount = 0;
    let khataCreditGiven = new Decimal(0);
    let khataPaymentsReceived = new Decimal(0);
    let khataPaymentCount = 0;

    let quotationsTotal = 0;
    let draftCount = 0;
    let sentCount = 0;
    let acceptedCount = 0;
    let convertedCount = 0;
    let rejectedCount = 0;
    let expiredCount = 0;
    let pendingPipelineValue = new Decimal(0);
    let convertedValue = new Decimal(0);

    let supplierBillsCount = 0;
    let supplierCancelledBillsCount = 0;
    let supplierPurchases = new Decimal(0);
    let supplierPaymentsCount = 0;
    let supplierPaymentsMade = new Decimal(0);
    let supplierPaymentsReversed = new Decimal(0);

    const expenseCatMap = new Map<
      ExpenseCategory,
      { count: number; totalAmount: Decimal }
    >();
    const productSalesMap = new Map<
      number,
      {
        productId: number;
        productName: string;
        isArchived: boolean;
        quantitySold: Decimal;
        salesAmount: Decimal;
        billCount: number;
      }
    >();

    for (const doc of dailyDocs as DailyAnalyticsDoc[]) {
      normalBillsCount += Number(doc.normalBillsCount || 0);
      normalBillsTotal = normalBillsTotal.plus(doc.normalBillsTotal || '0');
      normalCostedRevenue = normalCostedRevenue.plus(doc.normalCostedRevenue || '0');
      normalCogsTotal = normalCogsTotal.plus(doc.normalCogsTotal || '0');

      gstInvoicesCount += Number(doc.gstInvoicesCount || 0);
      gstTaxableSales = gstTaxableSales.plus(doc.gstTaxableSales || '0');
      gstCollected = gstCollected.plus(doc.gstCollected || '0');
      gstInvoicesGrandTotal = gstInvoicesGrandTotal.plus(doc.gstInvoicesGrandTotal || '0');
      gstCostedRevenue = gstCostedRevenue.plus(doc.gstCostedRevenue || '0');
      gstCogsTotal = gstCogsTotal.plus(doc.gstCogsTotal || '0');

      expensesActiveCount += Number(doc.expensesActiveCount || 0);
      expensesActiveTotal = expensesActiveTotal.plus(doc.expensesActiveTotal || '0');
      expensesVoidedCount += Number(doc.expensesVoidedCount || 0);

      for (const catItem of doc.expensesByCategory || []) {
        const category: ExpenseCategory = VALID_EXPENSE_CATEGORIES.has(catItem.category)
          ? (catItem.category as ExpenseCategory)
          : 'misc';
        const existing = expenseCatMap.get(category) || {
          count: 0,
          totalAmount: new Decimal(0),
        };
        existing.count += Number(catItem.count || 0);
        existing.totalAmount = existing.totalAmount.plus(catItem.totalAmount || '0');
        expenseCatMap.set(category, existing);
      }

      newCustomersCount += Number(doc.newCustomersCount || 0);
      khataCreditGiven = khataCreditGiven.plus(doc.khataCreditGiven || '0');
      khataPaymentsReceived = khataPaymentsReceived.plus(doc.khataPaymentsReceived || '0');
      khataPaymentCount += Number(doc.khataPaymentCount || 0);

      supplierBillsCount += Number(doc.supplierBillsCount || 0);
      supplierCancelledBillsCount += Number(doc.supplierCancelledBillsCount || 0);
      supplierPurchases = supplierPurchases.plus(doc.supplierPurchases || '0');
      supplierPaymentsCount += Number(doc.supplierPaymentsCount || 0);
      supplierPaymentsMade = supplierPaymentsMade.plus(doc.supplierPaymentsMade || '0');
      supplierPaymentsReversed = supplierPaymentsReversed.plus(doc.supplierPaymentsReversed || '0');

      for (const qBucket of doc.quotationBuckets || []) {
        const cnt = Number(qBucket.count || 0);
        quotationsTotal += cnt;
        const isAutoExpired =
          (qBucket.status === 'draft' || qBucket.status === 'sent' || qBucket.status === 'accepted') &&
          Boolean(qBucket.validUntil) &&
          String(qBucket.validUntil) < businessDate;
        const effectiveStatus = isAutoExpired ? 'expired' : qBucket.status;

        if (effectiveStatus === 'draft') draftCount += cnt;
        else if (effectiveStatus === 'sent') {
          sentCount += cnt;
          pendingPipelineValue = pendingPipelineValue.plus(qBucket.grandTotal || '0');
        } else if (effectiveStatus === 'accepted') {
          acceptedCount += cnt;
          pendingPipelineValue = pendingPipelineValue.plus(qBucket.grandTotal || '0');
        } else if (effectiveStatus === 'converted') {
          convertedCount += cnt;
          convertedValue = convertedValue.plus(qBucket.grandTotal || '0');
        } else if (effectiveStatus === 'rejected') {
          rejectedCount += cnt;
        } else if (effectiveStatus === 'expired') {
          expiredCount += cnt;
        }
      }

      for (const ps of doc.productSales || []) {
        const existing = productSalesMap.get(ps.productId) || {
          productId: ps.productId,
          productName: ps.productName,
          isArchived: Boolean(ps.isArchived),
          quantitySold: new Decimal(0),
          salesAmount: new Decimal(0),
          billCount: 0,
        };
        existing.productName = ps.productName;
        existing.isArchived = Boolean(ps.isArchived);
        existing.quantitySold = existing.quantitySold.plus(ps.quantitySold || '0');
        existing.salesAmount = existing.salesAmount.plus(ps.salesAmount || '0');
        existing.billCount += Number(ps.billCount || 0);
        productSalesMap.set(ps.productId, existing);
      }
    }

    const totalSalesRevenue = normalBillsTotal.plus(gstTaxableSales);
    const totalBilledAmountIncludingGst = normalBillsTotal.plus(gstInvoicesGrandTotal);
    const totalBillsCount = normalBillsCount + gstInvoicesCount;
    const averageBillValue =
      totalBillsCount > 0 ? totalSalesRevenue.div(totalBillsCount) : new Decimal(0);

    const costedSalesRevenue = normalCostedRevenue.plus(gstCostedRevenue);
    const uncostedSalesRevenue = Decimal.max(
      new Decimal(0),
      totalSalesRevenue.minus(costedSalesRevenue)
    );
    const estimatedCogs = normalCogsTotal.plus(gstCogsTotal);
    const estimatedGrossProfit = costedSalesRevenue.minus(estimatedCogs);
    const estimatedGrossMarginPercent = costedSalesRevenue.gt(0)
      ? estimatedGrossProfit.div(costedSalesRevenue).times(100)
      : new Decimal(0);
    const costCoveragePercent = totalSalesRevenue.gt(0)
      ? costedSalesRevenue.div(totalSalesRevenue).times(100)
      : new Decimal(0);
    const estimatedNetOperatingResult = estimatedGrossProfit.minus(expensesActiveTotal);

    const expensesByCategory: DashboardExpenseCategoryTotal[] = Array.from(expenseCatMap.entries())
      .map(([category, val]) => ({
        category,
        count: val.count,
        totalAmount: toFixedMoney(val.totalAmount),
      }))
      .sort((a, b) => {
        const cmp = new Decimal(b.totalAmount).cmp(a.totalAmount);
        return cmp !== 0 ? cmp : a.category.localeCompare(b.category);
      });

    const topProducts: DashboardTopProductItem[] = Array.from(productSalesMap.values())
      .sort((a, b) => {
        const amtCmp = b.salesAmount.cmp(a.salesAmount);
        if (amtCmp !== 0) return amtCmp;
        const qtyCmp = b.quantitySold.cmp(a.quantitySold);
        if (qtyCmp !== 0) return qtyCmp;
        return a.productId - b.productId;
      })
      .slice(0, 5)
      .map((p) => ({
        productId: p.productId,
        productName: p.productName,
        totalQuantitySold: toFixedQuantity(p.quantitySold),
        totalSalesAmount: toFixedMoney(p.salesAmount),
        billCount: p.billCount,
        isArchived: p.isArchived,
      }));

    const quotations: DashboardQuotationsSummary = {
      totalCount: quotationsTotal,
      draftCount,
      sentCount,
      acceptedCount,
      convertedCount,
      rejectedCount,
      expiredCount,
      conversionRatePercent:
        quotationsTotal > 0
          ? new Decimal(convertedCount).div(quotationsTotal).times(100).toFixed(2)
          : '0.00',
      pendingPipelineValue: toFixedMoney(pendingPipelineValue),
      convertedValue: toFixedMoney(convertedValue),
    };

    const salesTrend = this.buildTrendSeries(
      dailyDocs as DailyAnalyticsDoc[],
      businessDate,
      fromDate,
      toDate
    );

    const recentActivity: DashboardActivityItem[] = (recentDocs || []).map((item) => {
      const effectiveStatus =
        item.type === 'quotation' &&
        (item.status === 'draft' || item.status === 'sent' || item.status === 'accepted')
          ? item.status
          : item.status ?? null;
      return {
        type: item.type,
        reference: item.reference,
        party: item.party,
        amount: toFixedMoney(item.amount),
        date: item.date,
        status: effectiveStatus,
        occurredAt: new Date(item.occurredAt).toISOString(),
        targetTab: item.targetTab,
      };
    });

    return {
      businessDate,
      timeZone,
      dateRange: {
        fromDate: fromDate ?? null,
        toDate: toDate ?? null,
      },
      sales: {
        normalBillsTotal: toFixedMoney(normalBillsTotal),
        normalBillsCount,
        gstTaxableSales: toFixedMoney(gstTaxableSales),
        gstCollected: toFixedMoney(gstCollected),
        gstInvoicesGrandTotal: toFixedMoney(gstInvoicesGrandTotal),
        gstInvoicesCount,
        totalSalesRevenue: toFixedMoney(totalSalesRevenue),
        totalBilledAmountIncludingGst: toFixedMoney(totalBilledAmountIncludingGst),
        totalBillsCount,
        averageBillValue: toFixedMoney(averageBillValue),
      },
      profitability: {
        totalSalesRevenue: toFixedMoney(totalSalesRevenue),
        costedSalesRevenue: toFixedMoney(costedSalesRevenue),
        uncostedSalesRevenue: toFixedMoney(uncostedSalesRevenue),
        estimatedCostOfGoodsSold: toFixedMoney(estimatedCogs),
        estimatedGrossProfit: toFixedMoney(estimatedGrossProfit),
        estimatedGrossMarginPercent: toFixedMoney(estimatedGrossMarginPercent),
        costCoveragePercent: toFixedMoney(costCoveragePercent),
        operatingExpenses: toFixedMoney(expensesActiveTotal),
        operatingExpensesCount: expensesActiveCount,
        voidedExpensesCount: expensesVoidedCount,
        estimatedNetOperatingResult: toFixedMoney(estimatedNetOperatingResult),
        hasIncompleteCostData: uncostedSalesRevenue.gt(0),
      },
      expensesByCategory,
      customersKhata: {
        totalCustomers: globals.totalCustomers,
        activeCustomers: globals.activeCustomers,
        newCustomersCount,
        customersWithOutstanding: globals.customersWithOutstanding,
        totalOutstandingReceivable: toFixedMoney(globals.totalOutstandingReceivable),
        creditGiven: toFixedMoney(khataCreditGiven),
        paymentsReceived: toFixedMoney(khataPaymentsReceived),
        paymentCount: khataPaymentCount,
      },
      products: {
        totalProducts: globals.totalProducts,
        activeProducts: globals.activeProducts,
        archivedProducts: globals.archivedProducts,
        topProducts,
      },
      suppliers: {
        totalSuppliers: globals.totalSuppliers,
        activeSuppliers: globals.activeSuppliers,
        totalPurchases: toFixedMoney(supplierPurchases),
        purchaseBillsCount: supplierBillsCount,
        cancelledBillsCount: supplierCancelledBillsCount,
        totalPaymentsMade: toFixedMoney(supplierPaymentsMade),
        paymentsCount: supplierPaymentsCount,
        totalPaymentsReversed: toFixedMoney(supplierPaymentsReversed),
        totalOutstandingPayable: toFixedMoney(globals.supplierTotalOutstandingPayable),
        totalAdvanceCredit: toFixedMoney(globals.supplierTotalAdvanceCredit),
        totalUnallocatedPayments: toFixedMoney(globals.supplierTotalUnallocatedPayments),
      },
      quotations,
      salesTrend,
      recentActivity,
    };
  }

  private buildTrendSeries(
    dailyDocs: DailyAnalyticsDoc[],
    businessDate: string,
    fromDate?: string,
    toDate?: string
  ): DashboardOverviewData['salesTrend'] {
    if (fromDate && toDate) {
      const span = daysInclusive(fromDate, toDate);
      if (span >= 1 && span <= 45) {
        const byDay = new Map<string, DailyAnalyticsDoc>();
        for (const d of dailyDocs) {
          byDay.set(d.businessDate, d);
        }

        const points: DashboardTrendPoint[] = [];
        for (let i = 0; i < span; i += 1) {
          const dayIso = addDaysIso(fromDate, i);
          const doc = byDay.get(dayIso);
          const normalSales = new Decimal(doc?.normalBillsTotal || '0');
          const gstTaxableSales = new Decimal(doc?.gstTaxableSales || '0');
          const gstCollected = new Decimal(doc?.gstCollected || '0');
          const expenses = new Decimal(doc?.expensesActiveTotal || '0');
          const billsCount = Number(doc?.normalBillsCount || 0) + Number(doc?.gstInvoicesCount || 0);

          points.push({
            bucket: dayIso,
            label: formatDayLabel(dayIso),
            normalSales: toFixedMoney(normalSales),
            gstTaxableSales: toFixedMoney(gstTaxableSales),
            gstCollected: toFixedMoney(gstCollected),
            totalSalesRevenue: toFixedMoney(normalSales.plus(gstTaxableSales)),
            expenses: toFixedMoney(expenses),
            billsCount,
          });
        }

        return {
          granularity: 'day',
          effectiveFromDate: fromDate,
          effectiveToDate: toDate,
          isSixMonthWindow: false,
          points,
        };
      }

      const months = enumerateYearMonths(fromDate.slice(0, 7), toDate.slice(0, 7));
      return {
        granularity: 'month',
        effectiveFromDate: fromDate,
        effectiveToDate: toDate,
        isSixMonthWindow: false,
        points: this.aggregateTrendByMonth(dailyDocs, months),
      };
    }

    const isSixMonthWindow = !fromDate && !toDate;
    if (isSixMonthWindow) {
      const endYm = businessDate.slice(0, 7);
      const startYm = shiftYearMonth(endYm, -5);
      const effectiveFromDate = `${startYm}-01`;
      const effectiveToDate = businessDate;
      const filteredDocs = dailyDocs.filter(
        (d) => d.businessDate >= effectiveFromDate && d.businessDate <= effectiveToDate
      );
      const months = enumerateYearMonths(startYm, endYm);
      return {
        granularity: 'month',
        effectiveFromDate,
        effectiveToDate,
        isSixMonthWindow: true,
        points: this.aggregateTrendByMonth(filteredDocs, months),
      };
    }

    const effectiveTo = toDate ?? businessDate;
    const earliestDocDate = dailyDocs[0]?.businessDate ?? effectiveTo;
    const effectiveFrom = fromDate ?? earliestDocDate;
    const fromYm = effectiveFrom <= effectiveTo ? effectiveFrom.slice(0, 7) : effectiveTo.slice(0, 7);
    const toYm = effectiveTo.slice(0, 7);
    const months = enumerateYearMonths(fromYm, toYm);

    return {
      granularity: 'month',
      effectiveFromDate: effectiveFrom,
      effectiveToDate: effectiveTo,
      isSixMonthWindow: false,
      points: this.aggregateTrendByMonth(dailyDocs, months),
    };
  }

  private aggregateTrendByMonth(
    docs: DailyAnalyticsDoc[],
    months: string[]
  ): DashboardTrendPoint[] {
    const byMonth = new Map<
      string,
      {
        normalSales: Decimal;
        gstTaxableSales: Decimal;
        gstCollected: Decimal;
        expenses: Decimal;
        billsCount: number;
      }
    >();

    for (const d of docs) {
      const ym = d.yearMonth || d.businessDate.slice(0, 7);
      const acc = byMonth.get(ym) || {
        normalSales: new Decimal(0),
        gstTaxableSales: new Decimal(0),
        gstCollected: new Decimal(0),
        expenses: new Decimal(0),
        billsCount: 0,
      };
      acc.normalSales = acc.normalSales.plus(d.normalBillsTotal || '0');
      acc.gstTaxableSales = acc.gstTaxableSales.plus(d.gstTaxableSales || '0');
      acc.gstCollected = acc.gstCollected.plus(d.gstCollected || '0');
      acc.expenses = acc.expenses.plus(d.expensesActiveTotal || '0');
      acc.billsCount += Number(d.normalBillsCount || 0) + Number(d.gstInvoicesCount || 0);
      byMonth.set(ym, acc);
    }

    return months.map((ym) => {
      const acc = byMonth.get(ym);
      const normalSales = acc?.normalSales ?? new Decimal(0);
      const gstTaxableSales = acc?.gstTaxableSales ?? new Decimal(0);
      const gstCollected = acc?.gstCollected ?? new Decimal(0);
      const expenses = acc?.expenses ?? new Decimal(0);
      const billsCount = acc?.billsCount ?? 0;

      return {
        bucket: ym,
        label: formatMonthLabel(ym),
        normalSales: toFixedMoney(normalSales),
        gstTaxableSales: toFixedMoney(gstTaxableSales),
        gstCollected: toFixedMoney(gstCollected),
        totalSalesRevenue: toFixedMoney(normalSales.plus(gstTaxableSales)),
        expenses: toFixedMoney(expenses),
        billsCount,
      };
    });
  }

  /**
   * Reads the Business Overview dashboard completely from MongoDB read models (0 PG queries).
   */
  public async getDashboardOverviewFromMongo(query: {
    fromDate?: string;
    toDate?: string;
  }): Promise<DashboardOverviewData & { syncStatus: ReadModelSyncStatus }> {
    this.assertMongoReady();

    const snapshot = await DashboardSnapshotModel.findOne({ snapshotKey: '__global__' }).lean();
    if (!snapshot) {
      throw new ReadModelUnavailableError(
        'Dashboard read-model snapshot has not been initialized yet.'
      );
    }

    const timeZone = env.BUSINESS_TIME_ZONE || 'Asia/Kolkata';
    const businessDate = getBusinessDateISO(timeZone);
    const hasFilter = Boolean(query.fromDate || query.toDate);
    const syncStatus = this.buildSyncStatus(snapshot, 'dashboard');

    if (!hasFilter && snapshot.allTimeOverview) {
      const cached = snapshot.allTimeOverview as unknown as DashboardOverviewData;
      if (cached.businessDate === businessDate) {
        return {
          ...cached,
          syncStatus,
        };
      }
    }

    const computed = await this.buildOverviewFromAnalytics(snapshot.globals, query);
    return {
      ...computed,
      syncStatus,
    };
  }

  /**
   * Searches active products from MongoDB product_search collection (0 PG queries).
   * Strictly preserves Khata single-vendor model (no quantity/stock/inventory fields).
   */
  public async searchProductsFromMongo(params: {
    search?: string;
    limit?: number;
    offset?: number;
    cursor?: string;
  }): Promise<{
    products: Array<{
      id: number;
      name: string;
      buying_price: string;
      hsn_code: string | null;
      barcode: string | null;
      image_object_key: string | null;
      image_url: string | null;
      created_at: string;
      updated_at: string;
    }>;
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
    nextCursor: string | null;
    syncStatus: ReadModelSyncStatus;
  }> {
    this.assertMongoReady();

    const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 25)), 200);
    const trimmedCursor = params.cursor?.trim();
    const decodedCursor = trimmedCursor ? decodeProductCursor(trimmedCursor) : null;
    const offset = decodedCursor ? 0 : Math.max(0, Math.trunc(params.offset ?? 0));
    const trimmedSearch = (params.search ?? '').trim();

    const baseFilter: Record<string, unknown> = { isArchived: false };
    if (trimmedSearch.length > 0) {
      const normalized = normalizeSearchText(trimmedSearch);
      const escapedNormalized = escapeRegex(normalized);
      const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8);

      const orClauses: Record<string, unknown>[] = [
        { normalizedName: { $regex: `^${escapedNormalized}` } },
        { barcode: trimmedSearch },
        { normalizedHsnCode: { $regex: `^${escapeRegex(normalized)}` } },
      ];
      if (trimmedSearch.length === 1) {
        orClauses.push({ barcode: { $regex: `^${escapeRegex(trimmedSearch)}` } });
      }
      if (tokens.length > 0) {
        const longTokens = tokens.filter((t) => t.length >= 2);
        const tokenMatchers = (longTokens.length > 0 ? longTokens : tokens).map((tok) =>
          tok.length >= 2 && tok.length <= 12 ? tok : new RegExp(`^${escapeRegex(tok)}`)
        );
        if (longTokens.length > 0) {
          orClauses.push({
            searchTokens: tokenMatchers.length === 1 ? tokenMatchers[0] : { $all: tokenMatchers },
          });
        }
      }
      baseFilter.$or = orClauses;
    }

    const queryFilter: Record<string, unknown> = decodedCursor
      ? {
          $and: [
            baseFilter,
            {
              $or: [
                { normalizedName: { $gt: decodedCursor.n } },
                { normalizedName: decodedCursor.n, productId: { $gt: decodedCursor.id } },
              ],
            },
          ],
        }
      : baseFilter;

    const findQuery = ProductSearchModel.find(queryFilter).sort({ normalizedName: 1, productId: 1 });
    if (decodedCursor) {
      findQuery.limit(limit + 1);
    } else {
      findQuery.skip(offset).limit(limit + 1);
    }

    const [rawDocs, snapshot, filteredCount] = await Promise.all([
      findQuery.lean(),
      DashboardSnapshotModel.findOne({ snapshotKey: '__global__' })
        .select({
          lastSyncedAt: 1,
          lastProjectionSyncAt: 1,
          lastDashboardRefreshAt: 1,
          'globals.activeProducts': 1,
        })
        .lean(),
      trimmedSearch.length > 0
        ? ProductSearchModel.countDocuments(baseFilter)
        : Promise.resolve(null),
    ]);

    const hasMore = rawDocs.length > limit;
    const docs = hasMore ? rawDocs.slice(0, limit) : rawDocs;

    const total =
      filteredCount !== null
        ? filteredCount
        : typeof snapshot?.globals?.activeProducts === 'number'
          ? snapshot.globals.activeProducts
          : await ProductSearchModel.countDocuments(baseFilter);

    const r2Enabled = isR2Configured();
    const products = docs.map((doc) => ({
      id: doc.productId,
      name: doc.name,
      buying_price: toFixedMoney(doc.buyingPrice),
      hsn_code: doc.hsnCode ?? null,
      barcode: doc.barcode ?? null,
      image_object_key: doc.imageObjectKey ?? null,
      image_url:
        doc.imageObjectKey && r2Enabled
          ? doc.imageUrl || `/api/v1/products/${doc.productId}/image`
          : null,
      created_at: new Date(doc.createdAtPg || doc.sourceUpdatedAt || doc.projectionUpdatedAt).toISOString(),
      updated_at: new Date(doc.sourceUpdatedAt || doc.projectionUpdatedAt).toISOString(),
    }));

    const lastDoc = docs.length > 0 ? docs[docs.length - 1] : null;
    const nextCursor =
      hasMore && lastDoc
        ? encodeCursor({ n: lastDoc.normalizedName, id: lastDoc.productId })
        : null;

    return {
      products,
      total,
      limit,
      offset,
      hasMore,
      nextOffset: !decodedCursor && hasMore ? offset + products.length : null,
      nextCursor,
      syncStatus: this.buildSyncStatus(snapshot, 'projection'),
    };
  }

  /**
   * Finds an active product by exact barcode in MongoDB product_search (0 PG queries).
   */
  public async findProductByBarcodeFromMongo(barcode: string): Promise<{
    id: number;
    name: string;
    buying_price: string;
    hsn_code: string | null;
    barcode: string | null;
    image_object_key: string | null;
    image_url: string | null;
    created_at: string;
    updated_at: string;
  } | null> {
    this.assertMongoReady();

    const trimmed = barcode.trim();
    if (!trimmed) return null;

    const doc = await ProductSearchModel.findOne({
      barcode: trimmed,
      isArchived: false,
    }).lean();

    if (!doc) return null;

    return {
      id: doc.productId,
      name: doc.name,
      buying_price: toFixedMoney(doc.buyingPrice),
      hsn_code: doc.hsnCode ?? null,
      barcode: doc.barcode ?? null,
      image_object_key: doc.imageObjectKey ?? null,
      image_url:
        doc.imageObjectKey && isR2Configured()
          ? doc.imageUrl || `/api/v1/products/${doc.productId}/image`
          : null,
      created_at: new Date(doc.createdAtPg || doc.sourceUpdatedAt || doc.projectionUpdatedAt).toISOString(),
      updated_at: new Date(doc.sourceUpdatedAt || doc.projectionUpdatedAt).toISOString(),
    };
  }

  /**
   * Fetches product image key metadata from MongoDB for proxy streaming without waking PostgreSQL.
   */
  public async getProductImageMetaFromMongo(
    productId: number
  ): Promise<{ id: number; imageObjectKey: string | null; isArchived: boolean } | null> {
    this.assertMongoReady();

    const doc = await ProductSearchModel.findOne({ productId })
      .select({ productId: 1, imageObjectKey: 1, isArchived: 1 })
      .lean();
    if (!doc) return null;
    return {
      id: doc.productId,
      imageObjectKey: doc.imageObjectKey ?? null,
      isArchived: Boolean(doc.isArchived),
    };
  }

  /**
   * Reads global Khata receivable summary from MongoDB dashboard_snapshots (0 PG queries).
   */
  public async getKhataSummaryFromMongo(): Promise<{
    totalCustomers: number;
    totalOutstanding: string;
    totalReceived: string;
    syncStatus: ReadModelSyncStatus;
  }> {
    this.assertMongoReady();

    const snapshot = await DashboardSnapshotModel.findOne({ snapshotKey: '__global__' }).lean();
    if (!snapshot) {
      throw new ReadModelUnavailableError(
        'Khata read-model snapshot has not been initialized yet.'
      );
    }

    return {
      totalCustomers: snapshot.globals.khataSummaryTotalCustomers,
      totalOutstanding: toFixedMoney(snapshot.globals.khataSummaryTotalOutstanding),
      totalReceived: toFixedMoney(snapshot.globals.khataSummaryTotalReceived),
      syncStatus: this.buildSyncStatus(snapshot, 'dashboard'),
    };
  }

  /**
   * Lists and searches active Khata customers from MongoDB customer_summaries (0 PG queries).
   */
  public async listCustomersFromMongo(params: {
    search?: string;
    limit?: number;
    offset?: number;
    cursor?: string;
  }): Promise<{
    customers: Array<{
      id: number;
      name: string;
      phone: string | null;
      address: string | null;
      state: string | null;
      state_code: string | null;
      totalUdhar: string;
      totalReceived: string;
      outstanding: string;
      created_at: string;
    }>;
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
    nextCursor: string | null;
    syncStatus: ReadModelSyncStatus;
  }> {
    this.assertMongoReady();

    const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 25)), 200);
    const trimmedCursor = params.cursor?.trim();
    const decodedCursor = trimmedCursor ? decodeCustomerCursor(trimmedCursor) : null;
    const offset = decodedCursor ? 0 : Math.max(0, Math.trunc(params.offset ?? 0));
    const trimmedSearch = (params.search ?? '').trim();

    const baseFilter: Record<string, unknown> = { isArchived: false };
    if (trimmedSearch.length > 0) {
      const normalized = normalizeSearchText(trimmedSearch);
      const digitsOnly = trimmedSearch.replace(/\D/g, '');
      const escapedNormalized = escapeRegex(normalized);
      const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8);

      const orClauses: Record<string, unknown>[] = [
        { normalizedName: { $regex: `^${escapedNormalized}` } },
      ];
      if (digitsOnly.length > 0) {
        orClauses.push({ normalizedPhone: { $regex: `^${escapeRegex(digitsOnly)}` } });
        if (digitsOnly.length >= 3) {
          orClauses.push({
            searchTokens:
              digitsOnly.length <= 15
                ? digitsOnly
                : new RegExp(`^${escapeRegex(digitsOnly)}`),
          });
        }
      }
      if (tokens.length > 0) {
        const longTokens = tokens.filter((t) => t.length >= 2);
        if (longTokens.length > 0) {
          const matchers = longTokens.map((tok) =>
            tok.length <= 12 ? tok : new RegExp(`^${escapeRegex(tok)}`)
          );
          orClauses.push({
            searchTokens: matchers.length === 1 ? matchers[0] : { $all: matchers },
          });
        }
      }
      baseFilter.$or = orClauses;
    }

    let queryFilter: Record<string, unknown> = baseFilter;
    if (decodedCursor) {
      const cursorLastActivity = decodedCursor.l !== null ? new Date(decodedCursor.l) : null;
      const seekClauses: Record<string, unknown>[] = [{ outstandingPaise: { $lt: decodedCursor.o } }];
      if (cursorLastActivity) {
        seekClauses.push({
          outstandingPaise: decodedCursor.o,
          lastActivityAt: { $lt: cursorLastActivity },
        });
        seekClauses.push({
          outstandingPaise: decodedCursor.o,
          lastActivityAt: null,
        });
        seekClauses.push({
          outstandingPaise: decodedCursor.o,
          lastActivityAt: cursorLastActivity,
          customerId: { $gt: decodedCursor.id },
        });
      } else {
        seekClauses.push({
          outstandingPaise: decodedCursor.o,
          lastActivityAt: null,
          customerId: { $gt: decodedCursor.id },
        });
      }
      queryFilter = { $and: [baseFilter, { $or: seekClauses }] };
    }

    const findQuery = CustomerSummaryModel.find(queryFilter).sort({
      outstandingPaise: -1,
      lastActivityAt: -1,
      customerId: 1,
    });
    if (decodedCursor) {
      findQuery.limit(limit + 1);
    } else {
      findQuery.skip(offset).limit(limit + 1);
    }

    const [rawDocs, snapshot, filteredCount] = await Promise.all([
      findQuery.lean(),
      DashboardSnapshotModel.findOne({ snapshotKey: '__global__' })
        .select({
          lastSyncedAt: 1,
          lastProjectionSyncAt: 1,
          lastDashboardRefreshAt: 1,
          'globals.activeCustomers': 1,
        })
        .lean(),
      trimmedSearch.length > 0
        ? CustomerSummaryModel.countDocuments(baseFilter)
        : Promise.resolve(null),
    ]);

    const hasMore = rawDocs.length > limit;
    const docs = hasMore ? rawDocs.slice(0, limit) : rawDocs;

    const total =
      filteredCount !== null
        ? filteredCount
        : typeof snapshot?.globals?.activeCustomers === 'number'
          ? snapshot.globals.activeCustomers
          : await CustomerSummaryModel.countDocuments(baseFilter);

    const customers = docs.map((doc) => ({
      id: doc.customerId,
      name: doc.name,
      phone: doc.phone ?? null,
      address: doc.address ?? null,
      state: doc.state ?? null,
      state_code: doc.stateCode ?? null,
      totalUdhar: toFixedMoney(doc.totalUdhar),
      totalReceived: toFixedMoney(doc.totalReceived),
      outstanding: toFixedMoney(doc.outstanding),
      created_at: new Date(doc.createdAtPg || doc.sourceUpdatedAt).toISOString(),
    }));

    const lastDoc = docs.length > 0 ? docs[docs.length - 1] : null;
    const nextCursor =
      hasMore && lastDoc
        ? encodeCursor({
            o: Number(lastDoc.outstandingPaise || 0),
            l: lastDoc.lastActivityAt ? new Date(lastDoc.lastActivityAt).getTime() : null,
            id: lastDoc.customerId,
          })
        : null;

    return {
      customers,
      total,
      limit,
      offset,
      hasMore,
      nextOffset: !decodedCursor && hasMore ? offset + customers.length : null,
      nextCursor,
      syncStatus: this.buildSyncStatus(snapshot, 'projection'),
    };
  }
}

export const readModelsQueryService = new ReadModelsQueryService();
