import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { appPool } from '../../config/database.js';
import { env } from '../../config/env.js';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import { AppError } from '../../utils/errors.js';
import { escapeLike, validateMoneyInput } from '../../utils/validation.js';
import {
  CreateExpenseInput,
  DashboardOverviewQuery,
  ExpenseCategory,
  ExpensePaymentMethod,
  ListExpensesQuery,
  UpdateExpenseInput,
  createExpenseSchema,
  expenseIdParamSchema,
  listExpensesQuerySchema,
  updateExpenseSchema,
  validateDateRangeOrder,
  voidExpenseSchema,
} from './dashboard.validation.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface DashboardSalesSummary {
  normalBillsTotal: string;
  normalBillsCount: number;
  gstTaxableSales: string;
  gstCollected: string;
  gstInvoicesGrandTotal: string;
  gstInvoicesCount: number;
  totalSalesRevenue: string;
  totalBilledAmountIncludingGst: string;
  totalBillsCount: number;
  averageBillValue: string;
}

export interface DashboardProfitabilitySummary {
  totalSalesRevenue: string;
  costedSalesRevenue: string;
  uncostedSalesRevenue: string;
  estimatedCostOfGoodsSold: string;
  estimatedGrossProfit: string;
  estimatedGrossMarginPercent: string;
  costCoveragePercent: string;
  operatingExpenses: string;
  operatingExpensesCount: number;
  voidedExpensesCount: number;
  estimatedNetOperatingResult: string;
  hasIncompleteCostData: boolean;
}

export interface DashboardCustomersKhataSummary {
  totalCustomers: number;
  activeCustomers: number;
  newCustomersCount: number;
  customersWithOutstanding: number;
  totalOutstandingReceivable: string;
  creditGiven: string;
  paymentsReceived: string;
  paymentCount: number;
}

export interface DashboardTopProductItem {
  productId: number;
  productName: string;
  totalQuantitySold: string;
  totalSalesAmount: string;
  billCount: number;
  isArchived: boolean;
}

export interface DashboardProductsSummary {
  totalProducts: number;
  activeProducts: number;
  archivedProducts: number;
  topProducts: DashboardTopProductItem[];
}

export interface DashboardSuppliersSummary {
  totalSuppliers: number;
  activeSuppliers: number;
  totalPurchases: string;
  purchaseBillsCount: number;
  cancelledBillsCount: number;
  totalPaymentsMade: string;
  paymentsCount: number;
  totalPaymentsReversed: string;
  totalOutstandingPayable: string;
  totalAdvanceCredit: string;
  totalUnallocatedPayments: string;
}

export interface DashboardQuotationsSummary {
  totalCount: number;
  draftCount: number;
  sentCount: number;
  acceptedCount: number;
  convertedCount: number;
  rejectedCount: number;
  expiredCount: number;
  conversionRatePercent: string;
  pendingPipelineValue: string;
  convertedValue: string;
}

export interface DashboardExpenseCategoryTotal {
  category: ExpenseCategory;
  count: number;
  totalAmount: string;
}

export interface DashboardTrendPoint {
  bucket: string;
  label: string;
  normalSales: string;
  gstTaxableSales: string;
  gstCollected: string;
  totalSalesRevenue: string;
  expenses: string;
  billsCount: number;
}

export type DashboardActivityType =
  | 'normal_bill'
  | 'gst_invoice'
  | 'khata_credit'
  | 'khata_payment'
  | 'supplier_bill'
  | 'supplier_payment'
  | 'expense'
  | 'quotation';

export type DashboardTargetTab =
  | 'home'
  | 'khata'
  | 'products'
  | 'suppliers'
  | 'quotations'
  | 'gst-bill'
  | 'normal-bill';

export interface DashboardActivityItem {
  type: DashboardActivityType;
  reference: string;
  party: string;
  amount: string;
  date: string;
  status: string | null;
  occurredAt: string;
  targetTab: DashboardTargetTab;
}

export interface DashboardOverviewData {
  businessDate: string;
  timeZone: string;
  dateRange: {
    fromDate: string | null;
    toDate: string | null;
  };
  sales: DashboardSalesSummary;
  profitability: DashboardProfitabilitySummary;
  expensesByCategory: DashboardExpenseCategoryTotal[];
  customersKhata: DashboardCustomersKhataSummary;
  products: DashboardProductsSummary;
  suppliers: DashboardSuppliersSummary;
  quotations: DashboardQuotationsSummary;
  salesTrend: {
    granularity: 'day' | 'month';
    points: DashboardTrendPoint[];
  };
  recentActivity: DashboardActivityItem[];
}

export interface BusinessExpenseRecord {
  id: string;
  expenseDate: string;
  category: ExpenseCategory;
  title: string;
  vendorName: string | null;
  amount: string;
  paymentMethod: ExpensePaymentMethod;
  referenceNumber: string | null;
  notes: string | null;
  status: 'active' | 'voided';
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedExpensesResult {
  items: BusinessExpenseRecord[];
  total: number;
  totalActiveAmount: string;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

function toFixedMoney(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0.00';
  return new Decimal(String(value)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function toFixedQuantity(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0';
  const d = new Decimal(String(value)).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  return d.toFixed(d.decimalPlaces() === 0 ? 0 : Math.min(2, d.decimalPlaces()));
}

function buildDateFilter(
  columnExpr: string,
  fromDate?: string,
  toDate?: string,
  startIndex = 1
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (fromDate) {
    params.push(fromDate);
    conditions.push(`${columnExpr} >= $${startIndex + params.length - 1}::date`);
  }
  if (toDate) {
    params.push(toDate);
    conditions.push(`${columnExpr} <= $${startIndex + params.length - 1}::date`);
  }

  return {
    clause: conditions.length > 0 ? conditions.join(' AND ') : 'TRUE',
    params,
  };
}

function shiftUtcDays(dateIso: string, deltaDays: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const sy = shifted.getUTCFullYear();
  const sm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const sd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${sy}-${sm}-${sd}`;
}

function shiftUtcMonthsStart(dateIso: string, deltaMonths: number): string {
  const [y, m] = dateIso.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  const sy = shifted.getUTCFullYear();
  const sm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${sy}-${sm}-01`;
}

function resolveTrendWindow(
  fromDate: string | undefined,
  toDate: string | undefined,
  todayIso: string
): { granularity: 'day' | 'month'; startIso: string; endIso: string } {
  if (fromDate && toDate) {
    const startMs = Date.parse(`${fromDate}T00:00:00Z`);
    const endMs = Date.parse(`${toDate}T00:00:00Z`);
    const daysSpan = Math.floor((endMs - startMs) / 86_400_000) + 1;
    if (daysSpan <= 45) {
      return { granularity: 'day', startIso: fromDate, endIso: toDate };
    }
    return {
      granularity: 'month',
      startIso: `${fromDate.slice(0, 7)}-01`,
      endIso: `${toDate.slice(0, 7)}-01`,
    };
  }

  if (fromDate) {
    const effectiveEnd = todayIso >= fromDate ? todayIso : fromDate;
    const startMs = Date.parse(`${fromDate}T00:00:00Z`);
    const endMs = Date.parse(`${effectiveEnd}T00:00:00Z`);
    const daysSpan = Math.floor((endMs - startMs) / 86_400_000) + 1;
    if (daysSpan <= 45) {
      return { granularity: 'day', startIso: fromDate, endIso: effectiveEnd };
    }
    return {
      granularity: 'month',
      startIso: `${fromDate.slice(0, 7)}-01`,
      endIso: `${effectiveEnd.slice(0, 7)}-01`,
    };
  }

  if (toDate) {
    return {
      granularity: 'day',
      startIso: shiftUtcDays(toDate, -29),
      endIso: toDate,
    };
  }

  // All-time default: 6-month trend ending with the current business month
  return {
    granularity: 'month',
    startIso: shiftUtcMonthsStart(todayIso, -5),
    endIso: `${todayIso.slice(0, 7)}-01`,
  };
}

function formatTrendLabel(bucket: string, granularity: 'day' | 'month'): string {
  if (granularity === 'day') {
    const [y, m, d] = bucket.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(dt.getTime())) return bucket;
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'short',
      timeZone: 'UTC',
    }).format(dt);
  }
  const [y, m] = bucket.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  if (Number.isNaN(dt.getTime())) return bucket;
  return new Intl.DateTimeFormat('en-IN', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dt);
}

const EXPENSE_RETURNING_COLS = `
  id,
  TO_CHAR(expense_date, 'YYYY-MM-DD') AS expense_date,
  category,
  title,
  vendor_name,
  amount,
  payment_method,
  reference_number,
  notes,
  status,
  voided_at,
  void_reason,
  created_at,
  updated_at
`;

function mapExpenseRow(row: Record<string, any>): BusinessExpenseRecord {
  return {
    id: String(row.id),
    expenseDate: String(row.expense_date),
    category: row.category as ExpenseCategory,
    title: String(row.title),
    vendorName: row.vendor_name ?? null,
    amount: toFixedMoney(row.amount),
    paymentMethod: row.payment_method as ExpensePaymentMethod,
    referenceNumber: row.reference_number ?? null,
    notes: row.notes ?? null,
    status: row.status as 'active' | 'voided',
    voidedAt: row.voided_at ? new Date(row.voided_at).toISOString() : null,
    voidReason: row.void_reason ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class DashboardService {
  /**
   * Computes a consistent cross-module Home / Business Overview inside a single
   * REPEATABLE READ READ ONLY database snapshot. Queries run sequentially on the
   * dedicated transaction client to guarantee atomic point-in-time consistency.
   */
  public async getOverview(query: DashboardOverviewQuery = {}): Promise<DashboardOverviewData> {
    const fromDate = query.fromDate?.trim() || undefined;
    const toDate = query.toDate?.trim() || undefined;
    validateDateRangeOrder(fromDate, toDate);

    const timeZone = env.BUSINESS_TIME_ZONE || 'Asia/Kolkata';
    const businessDate = getBusinessDateISO(timeZone);

    const client: PoolClient = await appPool.connect();
    let inTx = false;

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      inTx = true;

      // 1. Sales totals (Normal bills & GST invoices — strictly separating GST collected from revenue)
      const nbFilter = buildDateFilter('bill_date', fromDate, toDate);
      const giFilter = buildDateFilter('invoice_date', fromDate, toDate, nbFilter.params.length + 1);
      const salesRes = await client.query(
        `
        WITH nb AS (
          SELECT
            COUNT(*)::bigint AS count,
            COALESCE(SUM(total_amount), 0)::numeric AS total_amount
          FROM normal_bills
          WHERE ${nbFilter.clause}
        ),
        gi AS (
          SELECT
            COUNT(*)::bigint AS count,
            COALESCE(SUM(taxable_amount), 0)::numeric AS taxable_amount,
            COALESCE(SUM(tax_amount), 0)::numeric AS tax_amount,
            COALESCE(SUM(grand_total), 0)::numeric AS grand_total
          FROM gst_invoices
          WHERE ${giFilter.clause}
        )
        SELECT
          nb.count AS normal_bills_count,
          nb.total_amount AS normal_bills_total,
          gi.count AS gst_invoices_count,
          gi.taxable_amount AS gst_taxable_sales,
          gi.tax_amount AS gst_collected,
          gi.grand_total AS gst_invoices_grand_total
        FROM nb
        CROSS JOIN gi
        `,
        [...nbFilter.params, ...giFilter.params]
      );

      const salesRow = salesRes.rows[0] || {};
      const normalBillsCount = Number(salesRow.normal_bills_count || 0);
      const normalBillsTotalDec = new Decimal(toFixedMoney(salesRow.normal_bills_total));
      const gstInvoicesCount = Number(salesRow.gst_invoices_count || 0);
      const gstTaxableSalesDec = new Decimal(toFixedMoney(salesRow.gst_taxable_sales));
      const gstCollectedDec = new Decimal(toFixedMoney(salesRow.gst_collected));
      const gstInvoicesGrandTotalDec = new Decimal(toFixedMoney(salesRow.gst_invoices_grand_total));

      const totalSalesRevenueDec = normalBillsTotalDec
        .plus(gstTaxableSalesDec)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const totalBilledIncludingGstDec = normalBillsTotalDec
        .plus(gstInvoicesGrandTotalDec)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const totalBillsCount = normalBillsCount + gstInvoicesCount;
      const averageBillValueDec =
        totalBillsCount > 0
          ? totalSalesRevenueDec.div(totalBillsCount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          : new Decimal(0);

      // 2. Profitability & COGS (computed strictly from lines carrying cost_rate_snapshot)
      const nbProfitFilter = buildDateFilter('nb.bill_date', fromDate, toDate);
      const giProfitFilter = buildDateFilter(
        'gi.invoice_date',
        fromDate,
        toDate,
        nbProfitFilter.params.length + 1
      );
      const profitRes = await client.query(
        `
        WITH nb_lines AS (
          SELECT
            bill_id,
            COALESCE(SUM(amount), 0)::numeric AS line_subtotal,
            COALESCE(SUM(amount) FILTER (WHERE cost_rate_snapshot IS NOT NULL), 0)::numeric AS costed_line_subtotal,
            COALESCE(SUM(quantity * cost_rate_snapshot) FILTER (WHERE cost_rate_snapshot IS NOT NULL), 0)::numeric AS cogs_total
          FROM normal_bill_items
          GROUP BY bill_id
        ),
        nb_agg AS (
          SELECT
            COALESCE(SUM(
              CASE
                WHEN COALESCE(nbl.line_subtotal, 0) > 0
                  THEN ROUND(nb.total_amount * (COALESCE(nbl.costed_line_subtotal, 0) / nbl.line_subtotal), 2)
                ELSE 0
              END
            ), 0)::numeric AS costed_revenue,
            COALESCE(SUM(COALESCE(nbl.cogs_total, 0)), 0)::numeric AS cogs_total
          FROM normal_bills nb
          LEFT JOIN nb_lines nbl ON nbl.bill_id = nb.id
          WHERE ${nbProfitFilter.clause}
        ),
        gi_lines AS (
          SELECT
            invoice_id,
            COALESCE(SUM(amount), 0)::numeric AS line_subtotal,
            COALESCE(SUM(amount) FILTER (WHERE cost_rate_snapshot IS NOT NULL), 0)::numeric AS costed_line_subtotal,
            COALESCE(SUM(quantity * cost_rate_snapshot) FILTER (WHERE cost_rate_snapshot IS NOT NULL), 0)::numeric AS cogs_total
          FROM gst_invoice_items
          GROUP BY invoice_id
        ),
        gi_agg AS (
          SELECT
            COALESCE(SUM(
              CASE
                WHEN COALESCE(gil.line_subtotal, 0) > 0
                  THEN ROUND(gi.taxable_amount * (COALESCE(gil.costed_line_subtotal, 0) / gil.line_subtotal), 2)
                ELSE 0
              END
            ), 0)::numeric AS costed_revenue,
            COALESCE(SUM(COALESCE(gil.cogs_total, 0)), 0)::numeric AS cogs_total
          FROM gst_invoices gi
          LEFT JOIN gi_lines gil ON gil.invoice_id = gi.id
          WHERE ${giProfitFilter.clause}
        )
        SELECT
          (nb_agg.costed_revenue + gi_agg.costed_revenue) AS costed_sales_revenue,
          (nb_agg.cogs_total + gi_agg.cogs_total) AS estimated_cogs
        FROM nb_agg
        CROSS JOIN gi_agg
        `,
        [...nbProfitFilter.params, ...giProfitFilter.params]
      );

      const profitRow = profitRes.rows[0] || {};
      const rawCostedRevenueDec = new Decimal(toFixedMoney(profitRow.costed_sales_revenue));
      const costedSalesRevenueDec = Decimal.min(totalSalesRevenueDec, rawCostedRevenueDec);
      const uncostedSalesRevenueDec = Decimal.max(
        totalSalesRevenueDec.minus(costedSalesRevenueDec),
        0
      ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const estimatedCogsDec = new Decimal(toFixedMoney(profitRow.estimated_cogs));
      const estimatedGrossProfitDec = costedSalesRevenueDec
        .minus(estimatedCogsDec)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      const estimatedGrossMarginPercent = costedSalesRevenueDec.greaterThan(0)
        ? estimatedGrossProfitDec
            .div(costedSalesRevenueDec)
            .times(100)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .toFixed(2)
        : '0.00';

      const costCoveragePercent = totalSalesRevenueDec.greaterThan(0)
        ? costedSalesRevenueDec
            .div(totalSalesRevenueDec)
            .times(100)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .toFixed(2)
        : '0.00';

      // 3. Operating expenses summary & category breakdown (active only; voided excluded from total)
      const expFilter = buildDateFilter('expense_date', fromDate, toDate);
      const expRes = await client.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::bigint AS active_count,
          COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0)::numeric AS active_total,
          COUNT(*) FILTER (WHERE status = 'voided')::bigint AS voided_count
        FROM business_expenses
        WHERE ${expFilter.clause}
        `,
        expFilter.params
      );
      const expRow = expRes.rows[0] || {};
      const operatingExpensesDec = new Decimal(toFixedMoney(expRow.active_total));
      const operatingExpensesCount = Number(expRow.active_count || 0);
      const voidedExpensesCount = Number(expRow.voided_count || 0);

      const expCatRes = await client.query(
        `
        SELECT
          category,
          COUNT(*)::bigint AS count,
          COALESCE(SUM(amount), 0)::numeric AS total_amount
        FROM business_expenses
        WHERE status = 'active' AND ${expFilter.clause}
        GROUP BY category
        ORDER BY total_amount DESC, category ASC
        `,
        expFilter.params
      );

      const expensesByCategory: DashboardExpenseCategoryTotal[] = expCatRes.rows.map((r) => ({
        category: r.category as ExpenseCategory,
        count: Number(r.count || 0),
        totalAmount: toFixedMoney(r.total_amount),
      }));

      const estimatedNetOperatingResultDec = estimatedGrossProfitDec
        .minus(operatingExpensesDec)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      const hasIncompleteCostData =
        totalSalesRevenueDec.greaterThan(0) && uncostedSalesRevenueDec.greaterThan(0);

      // 4. Customers & Khata (live receivables + period-filtered credit & payment flow)
      const newCustFilter = buildDateFilter(`(created_at AT TIME ZONE $1)::date`, fromDate, toDate, 2);
      const custPosRes = await client.query(
        `
        WITH customer_udhar AS (
          SELECT customer_id, COALESCE(SUM(total_amount), 0)::numeric AS total_udhar
          FROM udhar_transactions
          GROUP BY customer_id
        ),
        customer_alloc AS (
          SELECT ut.customer_id, COALESCE(SUM(pa.amount), 0)::numeric AS total_allocated
          FROM payment_allocations pa
          INNER JOIN udhar_transactions ut ON ut.id = pa.transaction_id
          GROUP BY ut.customer_id
        ),
        per_customer AS (
          SELECT
            c.id,
            c.archived_at,
            GREATEST(COALESCE(cu.total_udhar, 0) - COALESCE(ca.total_allocated, 0), 0) AS outstanding
          FROM customers c
          LEFT JOIN customer_udhar cu ON cu.customer_id = c.id
          LEFT JOIN customer_alloc ca ON ca.customer_id = c.id
        )
        SELECT
          (SELECT COUNT(*)::bigint FROM per_customer) AS total_customers,
          (SELECT COUNT(*)::bigint FROM per_customer WHERE archived_at IS NULL) AS active_customers,
          (SELECT COUNT(*)::bigint FROM per_customer WHERE outstanding > 0) AS customers_with_outstanding,
          (SELECT COALESCE(SUM(outstanding), 0)::numeric FROM per_customer) AS total_outstanding_receivable,
          (SELECT COUNT(*)::bigint FROM customers WHERE ${newCustFilter.clause}) AS new_customers_count
        `,
        [timeZone, ...newCustFilter.params]
      );

      const khataUdharFilter = buildDateFilter('transaction_date', fromDate, toDate);
      const khataUdharRes = await client.query(
        `
        SELECT COALESCE(SUM(total_amount), 0)::numeric AS credit_given
        FROM udhar_transactions
        WHERE ${khataUdharFilter.clause}
        `,
        khataUdharFilter.params
      );

      const khataPayFilter = buildDateFilter(`(received_at AT TIME ZONE $1)::date`, fromDate, toDate, 2);
      const khataPayRes = await client.query(
        `
        SELECT
          COUNT(*)::bigint AS payment_count,
          COALESCE(SUM(amount), 0)::numeric AS payments_received
        FROM payments
        WHERE ${khataPayFilter.clause}
        `,
        [timeZone, ...khataPayFilter.params]
      );

      const custRow = custPosRes.rows[0] || {};
      const khataUdharRow = khataUdharRes.rows[0] || {};
      const khataPayRow = khataPayRes.rows[0] || {};

      // 5. Products catalog summary & top-selling products (zero inventory tracking)
      const prodCountRes = await client.query(`
        SELECT
          COUNT(*)::bigint AS total_products,
          COUNT(*) FILTER (WHERE archived_at IS NULL)::bigint AS active_products,
          COUNT(*) FILTER (WHERE archived_at IS NOT NULL)::bigint AS archived_products
        FROM products
      `);

      const topNbFilter = buildDateFilter('nb.bill_date', fromDate, toDate);
      const topGiFilter = buildDateFilter(
        'gi.invoice_date',
        fromDate,
        toDate,
        topNbFilter.params.length + 1
      );
      const topProductsRes = await client.query(
        `
        WITH combined_lines AS (
          SELECT
            nbi.product_id,
            nbi.quantity,
            nbi.amount,
            ('nb:' || nb.id::text) AS doc_key
          FROM normal_bill_items nbi
          INNER JOIN normal_bills nb ON nb.id = nbi.bill_id
          WHERE nbi.product_id IS NOT NULL
            AND ${topNbFilter.clause}
          UNION ALL
          SELECT
            gii.product_id,
            gii.quantity,
            gii.amount,
            ('gi:' || gi.id::text) AS doc_key
          FROM gst_invoice_items gii
          INNER JOIN gst_invoices gi ON gi.id = gii.invoice_id
          WHERE gii.product_id IS NOT NULL
            AND ${topGiFilter.clause}
        ),
        aggregated AS (
          SELECT
            product_id,
            COALESCE(SUM(quantity), 0)::numeric AS total_quantity_sold,
            COALESCE(SUM(amount), 0)::numeric AS total_sales_amount,
            COUNT(DISTINCT doc_key)::bigint AS bill_count
          FROM combined_lines
          GROUP BY product_id
        )
        SELECT
          p.id AS product_id,
          p.name AS product_name,
          (p.archived_at IS NOT NULL) AS is_archived,
          a.total_quantity_sold,
          a.total_sales_amount,
          a.bill_count
        FROM aggregated a
        INNER JOIN products p ON p.id = a.product_id
        ORDER BY a.total_sales_amount DESC, a.bill_count DESC, a.total_quantity_sold DESC, p.id ASC
        LIMIT 5
        `,
        [...topNbFilter.params, ...topGiFilter.params]
      );

      const prodRow = prodCountRes.rows[0] || {};
      const topProducts: DashboardTopProductItem[] = topProductsRes.rows.map((r) => ({
        productId: Number(r.product_id),
        productName: String(r.product_name),
        totalQuantitySold: toFixedQuantity(r.total_quantity_sold),
        totalSalesAmount: toFixedMoney(r.total_sales_amount),
        billCount: Number(r.bill_count || 0),
        isArchived: Boolean(r.is_archived),
      }));

      // 6. Suppliers & Payables (live payable/advance + period-filtered purchases/payments/reversals)
      const supPosRes = await client.query(`
        WITH bill_totals AS (
          SELECT supplier_id, COALESCE(SUM(grand_total), 0)::numeric AS total_purchases
          FROM supplier_purchase_bills
          WHERE status = 'finalized'
          GROUP BY supplier_id
        ),
        pay_totals AS (
          SELECT supplier_id, COALESCE(SUM(amount), 0)::numeric AS total_payments
          FROM supplier_payments
          WHERE status = 'active'
          GROUP BY supplier_id
        ),
        alloc_rev AS (
          SELECT allocation_id, COALESCE(SUM(reversed_amount), 0)::numeric AS reversed_amount
          FROM supplier_payment_allocation_reversals
          GROUP BY allocation_id
        ),
        alloc_totals AS (
          SELECT
            spa.supplier_id,
            COALESCE(SUM(GREATEST(spa.amount - COALESCE(ar.reversed_amount, 0), 0)), 0)::numeric AS allocated_payments
          FROM supplier_payment_allocations spa
          INNER JOIN supplier_purchase_bills spb ON spb.id = spa.purchase_bill_id
          INNER JOIN supplier_payments sp ON sp.id = spa.payment_id
          LEFT JOIN alloc_rev ar ON ar.allocation_id = spa.id
          WHERE spb.status = 'finalized'
            AND sp.status = 'active'
          GROUP BY spa.supplier_id
        ),
        per_supplier AS (
          SELECT
            s.id,
            s.archived_at,
            COALESCE(bt.total_purchases, 0)::numeric AS purchases,
            COALESCE(pt.total_payments, 0)::numeric AS payments,
            COALESCE(at.allocated_payments, 0)::numeric AS allocated
          FROM suppliers s
          LEFT JOIN bill_totals bt ON bt.supplier_id = s.id
          LEFT JOIN pay_totals pt ON pt.supplier_id = s.id
          LEFT JOIN alloc_totals at ON at.supplier_id = s.id
        )
        SELECT
          COUNT(*)::bigint AS total_suppliers,
          COUNT(*) FILTER (WHERE archived_at IS NULL)::bigint AS active_suppliers,
          COALESCE(SUM(GREATEST(purchases - payments, 0)), 0)::numeric AS total_outstanding_payable,
          COALESCE(SUM(GREATEST(payments - purchases, 0)), 0)::numeric AS total_advance_credit,
          COALESCE(SUM(GREATEST(payments - allocated, 0)), 0)::numeric AS total_unallocated_payments
        FROM per_supplier
      `);

      const supBillFilter = buildDateFilter('invoice_date', fromDate, toDate);
      const supBillRes = await client.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'finalized')::bigint AS purchase_bills_count,
          COALESCE(SUM(grand_total) FILTER (WHERE status = 'finalized'), 0)::numeric AS total_purchases,
          COUNT(*) FILTER (WHERE status = 'cancelled')::bigint AS cancelled_bills_count
        FROM supplier_purchase_bills
        WHERE ${supBillFilter.clause}
        `,
        supBillFilter.params
      );

      const supPayFilter = buildDateFilter('payment_date', fromDate, toDate);
      const supPayRes = await client.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::bigint AS payments_count,
          COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0)::numeric AS total_payments_made
        FROM supplier_payments
        WHERE ${supPayFilter.clause}
        `,
        supPayFilter.params
      );

      const supRevFilter = buildDateFilter(`(reversed_at AT TIME ZONE $1)::date`, fromDate, toDate, 2);
      const supRevRes = await client.query(
        `
        SELECT COALESCE(SUM(original_amount), 0)::numeric AS total_payments_reversed
        FROM supplier_payment_reversals
        WHERE ${supRevFilter.clause}
        `,
        [timeZone, ...supRevFilter.params]
      );

      const supPosRow = supPosRes.rows[0] || {};
      const supBillRow = supBillRes.rows[0] || {};
      const supPayRow = supPayRes.rows[0] || {};
      const supRevRow = supRevRes.rows[0] || {};

      // 7. Quotations summary (effective validity expiry relative to businessDate)
      const qFilter = buildDateFilter('quotation_date', fromDate, toDate, 2);
      const quotesRes = await client.query(
        `
        SELECT
          COUNT(*)::bigint AS total_count,
          COUNT(*) FILTER (
            WHERE status = 'draft' AND (valid_until IS NULL OR valid_until >= $1::date)
          )::bigint AS draft_count,
          COUNT(*) FILTER (
            WHERE status = 'sent' AND (valid_until IS NULL OR valid_until >= $1::date)
          )::bigint AS sent_count,
          COUNT(*) FILTER (
            WHERE status = 'accepted' AND (valid_until IS NULL OR valid_until >= $1::date)
          )::bigint AS accepted_count,
          COUNT(*) FILTER (WHERE status = 'converted')::bigint AS converted_count,
          COUNT(*) FILTER (WHERE status = 'rejected')::bigint AS rejected_count,
          COUNT(*) FILTER (
            WHERE status = 'expired'
              OR (status IN ('draft', 'sent', 'accepted') AND valid_until IS NOT NULL AND valid_until < $1::date)
          )::bigint AS expired_count,
          COALESCE(SUM(grand_total) FILTER (
            WHERE status IN ('draft', 'sent', 'accepted')
              AND (valid_until IS NULL OR valid_until >= $1::date)
          ), 0)::numeric AS pending_pipeline_value,
          COALESCE(SUM(grand_total) FILTER (WHERE status = 'converted'), 0)::numeric AS converted_value
        FROM quotations
        WHERE ${qFilter.clause}
        `,
        [businessDate, ...qFilter.params]
      );

      const qRow = quotesRes.rows[0] || {};
      const totalQuotesCount = Number(qRow.total_count || 0);
      const convertedQuotesCount = Number(qRow.converted_count || 0);
      const conversionRatePercent =
        totalQuotesCount > 0
          ? new Decimal(convertedQuotesCount)
              .div(totalQuotesCount)
              .times(100)
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
              .toFixed(2)
          : '0.00';

      // 8. Sales & Expense Trend series (daily for <= 45 days, monthly otherwise)
      const trendWin = resolveTrendWindow(fromDate, toDate, businessDate);
      const trendRangeEndInclusive =
        trendWin.granularity === 'day'
          ? trendWin.endIso
          : shiftUtcDays(shiftUtcMonthsStart(trendWin.endIso, 1), -1);

      const trendSql =
        trendWin.granularity === 'day'
          ? `
          WITH series AS (
            SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS bucket_date
          ),
          nb AS (
            SELECT bill_date AS bucket_date, COUNT(*)::bigint AS cnt, COALESCE(SUM(total_amount), 0)::numeric AS sales
            FROM normal_bills
            WHERE bill_date >= $1::date AND bill_date <= $2::date
            GROUP BY bill_date
          ),
          gi AS (
            SELECT
              invoice_date AS bucket_date,
              COUNT(*)::bigint AS cnt,
              COALESCE(SUM(taxable_amount), 0)::numeric AS taxable_sales,
              COALESCE(SUM(tax_amount), 0)::numeric AS gst_collected
            FROM gst_invoices
            WHERE invoice_date >= $1::date AND invoice_date <= $2::date
            GROUP BY invoice_date
          ),
          ex AS (
            SELECT expense_date AS bucket_date, COALESCE(SUM(amount), 0)::numeric AS total_exp
            FROM business_expenses
            WHERE status = 'active' AND expense_date >= $1::date AND expense_date <= $2::date
            GROUP BY expense_date
          )
          SELECT
            TO_CHAR(s.bucket_date, 'YYYY-MM-DD') AS bucket,
            COALESCE(nb.sales, 0)::numeric AS normal_sales,
            COALESCE(gi.taxable_sales, 0)::numeric AS gst_taxable_sales,
            COALESCE(gi.gst_collected, 0)::numeric AS gst_collected,
            COALESCE(ex.total_exp, 0)::numeric AS expenses,
            (COALESCE(nb.cnt, 0) + COALESCE(gi.cnt, 0))::bigint AS bills_count
          FROM series s
          LEFT JOIN nb ON nb.bucket_date = s.bucket_date
          LEFT JOIN gi ON gi.bucket_date = s.bucket_date
          LEFT JOIN ex ON ex.bucket_date = s.bucket_date
          ORDER BY s.bucket_date ASC
          `
          : `
          WITH series AS (
            SELECT generate_series($1::date, $2::date, '1 month'::interval)::date AS bucket_month
          ),
          nb AS (
            SELECT date_trunc('month', bill_date)::date AS bucket_month, COUNT(*)::bigint AS cnt, COALESCE(SUM(total_amount), 0)::numeric AS sales
            FROM normal_bills
            WHERE bill_date >= $1::date AND bill_date <= $3::date
            GROUP BY 1
          ),
          gi AS (
            SELECT
              date_trunc('month', invoice_date)::date AS bucket_month,
              COUNT(*)::bigint AS cnt,
              COALESCE(SUM(taxable_amount), 0)::numeric AS taxable_sales,
              COALESCE(SUM(tax_amount), 0)::numeric AS gst_collected
            FROM gst_invoices
            WHERE invoice_date >= $1::date AND invoice_date <= $3::date
            GROUP BY 1
          ),
          ex AS (
            SELECT date_trunc('month', expense_date)::date AS bucket_month, COALESCE(SUM(amount), 0)::numeric AS total_exp
            FROM business_expenses
            WHERE status = 'active' AND expense_date >= $1::date AND expense_date <= $3::date
            GROUP BY 1
          )
          SELECT
            TO_CHAR(s.bucket_month, 'YYYY-MM') AS bucket,
            COALESCE(nb.sales, 0)::numeric AS normal_sales,
            COALESCE(gi.taxable_sales, 0)::numeric AS gst_taxable_sales,
            COALESCE(gi.gst_collected, 0)::numeric AS gst_collected,
            COALESCE(ex.total_exp, 0)::numeric AS expenses,
            (COALESCE(nb.cnt, 0) + COALESCE(gi.cnt, 0))::bigint AS bills_count
          FROM series s
          LEFT JOIN nb ON nb.bucket_month = s.bucket_month
          LEFT JOIN gi ON gi.bucket_month = s.bucket_month
          LEFT JOIN ex ON ex.bucket_month = s.bucket_month
          ORDER BY s.bucket_month ASC
          `;

      const trendParams =
        trendWin.granularity === 'day'
          ? [trendWin.startIso, trendWin.endIso]
          : [trendWin.startIso, trendWin.endIso, trendRangeEndInclusive];

      const trendRes = await client.query(trendSql, trendParams);
      const trendPoints: DashboardTrendPoint[] = trendRes.rows.map((r) => {
        const normalSalesDec = new Decimal(toFixedMoney(r.normal_sales));
        const gstTaxableDec = new Decimal(toFixedMoney(r.gst_taxable_sales));
        const totalRevenue = normalSalesDec
          .plus(gstTaxableDec)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .toFixed(2);
        return {
          bucket: String(r.bucket),
          label: formatTrendLabel(String(r.bucket), trendWin.granularity),
          normalSales: normalSalesDec.toFixed(2),
          gstTaxableSales: gstTaxableDec.toFixed(2),
          gstCollected: toFixedMoney(r.gst_collected),
          totalSalesRevenue: totalRevenue,
          expenses: toFixedMoney(r.expenses),
          billsCount: Number(r.bills_count || 0),
        };
      });

      // 9. Bounded Recent Business Activity across modules ($1 = timeZone, $2 = businessDate, $3/$4 = optional dates)
      const actParams: unknown[] = [timeZone, businessDate];
      let fromIdx: number | null = null;
      let toIdx: number | null = null;
      if (fromDate) {
        actParams.push(fromDate);
        fromIdx = actParams.length;
      }
      if (toDate) {
        actParams.push(toDate);
        toIdx = actParams.length;
      }

      const bindSharedDate = (col: string): string => {
        const conds: string[] = [];
        if (fromIdx !== null) conds.push(`${col} >= $${fromIdx}::date`);
        if (toIdx !== null) conds.push(`${col} <= $${toIdx}::date`);
        return conds.length > 0 ? conds.join(' AND ') : 'TRUE';
      };

      const activityRes = await client.query(
        `
        SELECT
          type,
          reference,
          party,
          amount,
          TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date,
          status,
          occurred_at,
          target_tab
        FROM (
          (
            SELECT
              'normal_bill'::text AS type,
              nb.bill_number AS reference,
              nb.customer_name AS party,
              nb.total_amount AS amount,
              nb.bill_date AS event_date,
              NULL::text AS status,
              nb.created_at AS occurred_at,
              'normal-bill'::text AS target_tab
            FROM normal_bills nb
            WHERE ${bindSharedDate('nb.bill_date')}
            ORDER BY nb.created_at DESC, nb.id DESC
            LIMIT 12
          )
          UNION ALL
          (
            SELECT
              'gst_invoice'::text AS type,
              gi.invoice_number AS reference,
              gi.customer_name AS party,
              gi.grand_total AS amount,
              gi.invoice_date AS event_date,
              NULL::text AS status,
              gi.created_at AS occurred_at,
              'gst-bill'::text AS target_tab
            FROM gst_invoices gi
            WHERE ${bindSharedDate('gi.invoice_date')}
            ORDER BY gi.created_at DESC, gi.id DESC
            LIMIT 12
          )
          UNION ALL
          (
            SELECT
              'khata_credit'::text AS type,
              ('Khata #' || ut.id::text) AS reference,
              c.name AS party,
              ut.total_amount AS amount,
              ut.transaction_date AS event_date,
              NULL::text AS status,
              ut.created_at AS occurred_at,
              'khata'::text AS target_tab
            FROM udhar_transactions ut
            INNER JOIN customers c ON c.id = ut.customer_id
            WHERE ${bindSharedDate('ut.transaction_date')}
            ORDER BY ut.created_at DESC, ut.id DESC
            LIMIT 12
          )
          UNION ALL
          (
            SELECT
              'khata_payment'::text AS type,
              ('Receipt #' || p.id::text) AS reference,
              c.name AS party,
              p.amount AS amount,
              (p.received_at AT TIME ZONE $1)::date AS event_date,
              NULL::text AS status,
              p.received_at AS occurred_at,
              'khata'::text AS target_tab
            FROM payments p
            INNER JOIN customers c ON c.id = p.customer_id
            WHERE ${bindSharedDate('(p.received_at AT TIME ZONE $1)::date')}
            ORDER BY p.received_at DESC, p.id DESC
            LIMIT 12
          )
          UNION ALL
          (
            SELECT
              'supplier_bill'::text AS type,
              spb.invoice_number AS reference,
              s.name AS party,
              spb.grand_total AS amount,
              spb.invoice_date AS event_date,
              spb.status AS status,
              spb.created_at AS occurred_at,
              'suppliers'::text AS target_tab
            FROM supplier_purchase_bills spb
            INNER JOIN suppliers s ON s.id = spb.supplier_id
            WHERE ${bindSharedDate('spb.invoice_date')}
            ORDER BY spb.created_at DESC, spb.id DESC
            LIMIT 12
          )
          UNION ALL
          (
            SELECT
              'supplier_payment'::text AS type,
              sp.receipt_number AS reference,
              s.name AS party,
              sp.amount AS amount,
              sp.payment_date AS event_date,
              sp.status AS status,
              sp.created_at AS occurred_at,
              'suppliers'::text AS target_tab
            FROM supplier_payments sp
            INNER JOIN suppliers s ON s.id = sp.supplier_id
            WHERE ${bindSharedDate('sp.payment_date')}
            ORDER BY sp.created_at DESC, sp.id DESC
            LIMIT 12
          )
          UNION ALL
          (
            SELECT
              'expense'::text AS type,
              be.title AS reference,
              COALESCE(be.vendor_name, INITCAP(be.category)) AS party,
              be.amount AS amount,
              be.expense_date AS event_date,
              be.status AS status,
              be.created_at AS occurred_at,
              'home'::text AS target_tab
            FROM business_expenses be
            WHERE ${bindSharedDate('be.expense_date')}
            ORDER BY be.created_at DESC, be.id DESC
            LIMIT 12
          )
          UNION ALL
          (
            SELECT
              'quotation'::text AS type,
              q.quotation_number AS reference,
              q.customer_name AS party,
              q.grand_total AS amount,
              q.quotation_date AS event_date,
              CASE
                WHEN q.status IN ('draft', 'sent', 'accepted')
                  AND q.valid_until IS NOT NULL
                  AND q.valid_until < $2::date THEN 'expired'
                ELSE q.status
              END AS status,
              q.created_at AS occurred_at,
              'quotations'::text AS target_tab
            FROM quotations q
            WHERE ${bindSharedDate('q.quotation_date')}
            ORDER BY q.created_at DESC, q.id DESC
            LIMIT 12
          )
        ) combined_activity
        ORDER BY occurred_at DESC
        LIMIT 12
        `,
        actParams
      );

      const recentActivity: DashboardActivityItem[] = activityRes.rows.map((r) => ({
        type: r.type as DashboardActivityType,
        reference: String(r.reference),
        party: String(r.party),
        amount: toFixedMoney(r.amount),
        date: String(r.event_date),
        status: r.status ?? null,
        occurredAt: new Date(r.occurred_at).toISOString(),
        targetTab: r.target_tab as DashboardTargetTab,
      }));

      await client.query('COMMIT');
      inTx = false;

      return {
        businessDate,
        timeZone,
        dateRange: {
          fromDate: fromDate ?? null,
          toDate: toDate ?? null,
        },
        sales: {
          normalBillsTotal: normalBillsTotalDec.toFixed(2),
          normalBillsCount,
          gstTaxableSales: gstTaxableSalesDec.toFixed(2),
          gstCollected: gstCollectedDec.toFixed(2),
          gstInvoicesGrandTotal: gstInvoicesGrandTotalDec.toFixed(2),
          gstInvoicesCount,
          totalSalesRevenue: totalSalesRevenueDec.toFixed(2),
          totalBilledAmountIncludingGst: totalBilledIncludingGstDec.toFixed(2),
          totalBillsCount,
          averageBillValue: averageBillValueDec.toFixed(2),
        },
        profitability: {
          totalSalesRevenue: totalSalesRevenueDec.toFixed(2),
          costedSalesRevenue: costedSalesRevenueDec.toFixed(2),
          uncostedSalesRevenue: uncostedSalesRevenueDec.toFixed(2),
          estimatedCostOfGoodsSold: estimatedCogsDec.toFixed(2),
          estimatedGrossProfit: estimatedGrossProfitDec.toFixed(2),
          estimatedGrossMarginPercent,
          costCoveragePercent,
          operatingExpenses: operatingExpensesDec.toFixed(2),
          operatingExpensesCount,
          voidedExpensesCount,
          estimatedNetOperatingResult: estimatedNetOperatingResultDec.toFixed(2),
          hasIncompleteCostData,
        },
        expensesByCategory,
        customersKhata: {
          totalCustomers: Number(custRow.total_customers || 0),
          activeCustomers: Number(custRow.active_customers || 0),
          newCustomersCount: Number(custRow.new_customers_count || 0),
          customersWithOutstanding: Number(custRow.customers_with_outstanding || 0),
          totalOutstandingReceivable: toFixedMoney(custRow.total_outstanding_receivable),
          creditGiven: toFixedMoney(khataUdharRow.credit_given),
          paymentsReceived: toFixedMoney(khataPayRow.payments_received),
          paymentCount: Number(khataPayRow.payment_count || 0),
        },
        products: {
          totalProducts: Number(prodRow.total_products || 0),
          activeProducts: Number(prodRow.active_products || 0),
          archivedProducts: Number(prodRow.archived_products || 0),
          topProducts,
        },
        suppliers: {
          totalSuppliers: Number(supPosRow.total_suppliers || 0),
          activeSuppliers: Number(supPosRow.active_suppliers || 0),
          totalPurchases: toFixedMoney(supBillRow.total_purchases),
          purchaseBillsCount: Number(supBillRow.purchase_bills_count || 0),
          cancelledBillsCount: Number(supBillRow.cancelled_bills_count || 0),
          totalPaymentsMade: toFixedMoney(supPayRow.total_payments_made),
          paymentsCount: Number(supPayRow.payments_count || 0),
          totalPaymentsReversed: toFixedMoney(supRevRow.total_payments_reversed),
          totalOutstandingPayable: toFixedMoney(supPosRow.total_outstanding_payable),
          totalAdvanceCredit: toFixedMoney(supPosRow.total_advance_credit),
          totalUnallocatedPayments: toFixedMoney(supPosRow.total_unallocated_payments),
        },
        quotations: {
          totalCount: totalQuotesCount,
          draftCount: Number(qRow.draft_count || 0),
          sentCount: Number(qRow.sent_count || 0),
          acceptedCount: Number(qRow.accepted_count || 0),
          convertedCount: convertedQuotesCount,
          rejectedCount: Number(qRow.rejected_count || 0),
          expiredCount: Number(qRow.expired_count || 0),
          conversionRatePercent,
          pendingPipelineValue: toFixedMoney(qRow.pending_pipeline_value),
          convertedValue: toFixedMoney(qRow.converted_value),
        },
        salesTrend: {
          granularity: trendWin.granularity,
          points: trendPoints,
        },
        recentActivity,
      };
    } catch (err) {
      if (inTx) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Lists operating expenses with parameterized search, category, status, date range, and bounded pagination.
   */
  public async listExpenses(rawQuery: Partial<ListExpensesQuery> = {}): Promise<PaginatedExpensesResult> {
    const parsed = listExpensesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new AppError(parsed.error.errors[0]?.message || 'Invalid expense query.', 400, 'VALIDATION_ERROR');
    }
    const query = parsed.data;
    validateDateRangeOrder(query.fromDate, query.toDate);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.status !== 'all') {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.category !== 'all') {
      params.push(query.category);
      conditions.push(`category = $${params.length}`);
    }
    if (query.fromDate) {
      params.push(query.fromDate);
      conditions.push(`expense_date >= $${params.length}::date`);
    }
    if (query.toDate) {
      params.push(query.toDate);
      conditions.push(`expense_date <= $${params.length}::date`);
    }
    if (query.search && query.search.trim() !== '') {
      const pattern = `%${escapeLike(query.search.trim())}%`;
      params.push(pattern);
      const pIdx = params.length;
      conditions.push(
        `(title ILIKE $${pIdx} ESCAPE '\\' OR COALESCE(vendor_name, '') ILIKE $${pIdx} ESCAPE '\\' OR COALESCE(reference_number, '') ILIKE $${pIdx} ESCAPE '\\' OR COALESCE(notes, '') ILIKE $${pIdx} ESCAPE '\\')`
      );
    }

    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';

    const countRes = await appPool.query(
      `
      SELECT
        COUNT(*)::bigint AS total,
        COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0)::numeric AS total_active_amount
      FROM business_expenses
      WHERE ${whereClause}
      `,
      params
    );

    const total = Number(countRes.rows[0]?.total || 0);
    const totalActiveAmount = toFixedMoney(countRes.rows[0]?.total_active_amount);

    const rowsRes = await appPool.query(
      `
      SELECT ${EXPENSE_RETURNING_COLS}
      FROM business_expenses
      WHERE ${whereClause}
      ORDER BY expense_date DESC, created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, query.limit, query.offset]
    );

    const items = rowsRes.rows.map(mapExpenseRow);
    const hasMore = query.offset + items.length < total;
    const nextOffset = hasMore ? query.offset + items.length : null;

    return {
      items,
      total,
      totalActiveAmount,
      limit: query.limit,
      offset: query.offset,
      hasMore,
      nextOffset,
    };
  }

  /**
   * Creates an operating expense and records an immutable 'created' event in business_expense_events.
   */
  public async createExpense(rawInput: CreateExpenseInput): Promise<BusinessExpenseRecord> {
    const parsed = createExpenseSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AppError(parsed.error.errors[0]?.message || 'Invalid expense data.', 400, 'VALIDATION_ERROR');
    }

    const input = parsed.data;
    const amountDec = validateMoneyInput(input.amount, 'Amount', { allowZero: false });

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      const insertRes = await client.query(
        `
        INSERT INTO business_expenses (
          expense_date,
          category,
          title,
          vendor_name,
          amount,
          payment_method,
          reference_number,
          notes
        ) VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8)
        RETURNING ${EXPENSE_RETURNING_COLS}
        `,
        [
          input.expenseDate,
          input.category,
          input.title.trim(),
          input.vendorName ?? null,
          amountDec.toFixed(2),
          input.paymentMethod,
          input.referenceNumber ?? null,
          input.notes ?? null,
        ]
      );

      const created = mapExpenseRow(insertRes.rows[0]);

      await client.query(
        `
        INSERT INTO business_expense_events (
          expense_id,
          action,
          reason,
          previous_data,
          new_data
        ) VALUES ($1::uuid, 'created', $2, NULL, $3::jsonb)
        `,
        [created.id, 'Expense recorded by owner', JSON.stringify(created)]
      );

      await client.query('COMMIT');
      return created;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Updates an active operating expense and logs before/after snapshots to business_expense_events.
   * Rejects edits to voided expenses with HTTP 409.
   */
  public async updateExpense(id: string, rawInput: UpdateExpenseInput): Promise<BusinessExpenseRecord> {
    const idCheck = expenseIdParamSchema.safeParse(id);
    if (!idCheck.success) {
      throw new AppError(idCheck.error.errors[0]?.message || 'Invalid expense ID.', 400, 'VALIDATION_ERROR');
    }

    const parsed = updateExpenseSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new AppError(parsed.error.errors[0]?.message || 'Invalid expense update data.', 400, 'VALIDATION_ERROR');
    }

    const input = parsed.data;
    const amountDec = validateMoneyInput(input.amount, 'Amount', { allowZero: false });

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        `
        SELECT ${EXPENSE_RETURNING_COLS}
        FROM business_expenses
        WHERE id = $1::uuid
        FOR UPDATE
        `,
        [id]
      );

      if (existingRes.rowCount === 0) {
        throw new AppError('Expense record not found.', 404, 'EXPENSE_NOT_FOUND');
      }

      const previous = mapExpenseRow(existingRes.rows[0]);
      if (previous.status === 'voided') {
        throw new AppError('Voided expenses cannot be modified.', 409, 'EXPENSE_VOIDED_IMMUTABLE');
      }

      const updateRes = await client.query(
        `
        UPDATE business_expenses
        SET
          expense_date = $2::date,
          category = $3,
          title = $4,
          vendor_name = $5,
          amount = $6,
          payment_method = $7,
          reference_number = $8,
          notes = $9,
          updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING ${EXPENSE_RETURNING_COLS}
        `,
        [
          id,
          input.expenseDate,
          input.category,
          input.title.trim(),
          input.vendorName ?? null,
          amountDec.toFixed(2),
          input.paymentMethod,
          input.referenceNumber ?? null,
          input.notes ?? null,
        ]
      );

      const updated = mapExpenseRow(updateRes.rows[0]);

      await client.query(
        `
        INSERT INTO business_expense_events (
          expense_id,
          action,
          reason,
          previous_data,
          new_data
        ) VALUES ($1::uuid, 'updated', $2, $3::jsonb, $4::jsonb)
        `,
        [
          updated.id,
          input.reason ?? 'Expense updated by owner',
          JSON.stringify(previous),
          JSON.stringify(updated),
        ]
      );

      await client.query('COMMIT');
      return updated;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Soft-voids an active operating expense with a mandatory reason and immutable audit entry.
   * Never deletes expense rows; rejects double-void with HTTP 409.
   */
  public async voidExpense(id: string, reason: string): Promise<BusinessExpenseRecord> {
    const idCheck = expenseIdParamSchema.safeParse(id);
    if (!idCheck.success) {
      throw new AppError(idCheck.error.errors[0]?.message || 'Invalid expense ID.', 400, 'VALIDATION_ERROR');
    }

    const parsed = voidExpenseSchema.safeParse({ reason });
    if (!parsed.success) {
      throw new AppError(parsed.error.errors[0]?.message || 'Void reason is required.', 400, 'VALIDATION_ERROR');
    }

    const trimmedReason = parsed.data.reason;
    const client = await appPool.connect();

    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        `
        SELECT ${EXPENSE_RETURNING_COLS}
        FROM business_expenses
        WHERE id = $1::uuid
        FOR UPDATE
        `,
        [id]
      );

      if (existingRes.rowCount === 0) {
        throw new AppError('Expense record not found.', 404, 'EXPENSE_NOT_FOUND');
      }

      const previous = mapExpenseRow(existingRes.rows[0]);
      if (previous.status === 'voided') {
        throw new AppError('Expense is already voided.', 409, 'EXPENSE_ALREADY_VOIDED');
      }

      const voidRes = await client.query(
        `
        UPDATE business_expenses
        SET
          status = 'voided',
          voided_at = NOW(),
          void_reason = $2,
          updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING ${EXPENSE_RETURNING_COLS}
        `,
        [id, trimmedReason]
      );

      const voided = mapExpenseRow(voidRes.rows[0]);

      await client.query(
        `
        INSERT INTO business_expense_events (
          expense_id,
          action,
          reason,
          previous_data,
          new_data
        ) VALUES ($1::uuid, 'voided', $2, $3::jsonb, $4::jsonb)
        `,
        [voided.id, trimmedReason, JSON.stringify(previous), JSON.stringify(voided)]
      );

      await client.query('COMMIT');
      return voided;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export const dashboardService = new DashboardService();
