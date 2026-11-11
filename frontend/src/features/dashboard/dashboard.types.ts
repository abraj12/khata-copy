export type ExpenseCategory =
  | 'rent'
  | 'electricity'
  | 'salaries'
  | 'transport'
  | 'packaging'
  | 'maintenance'
  | 'marketing'
  | 'misc';

export type ExpensePaymentMethod =
  | 'cash'
  | 'upi'
  | 'bank_transfer'
  | 'cheque'
  | 'other';

export type DashboardDatePreset =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'this_month'
  | 'last_month'
  | 'this_fy'
  | 'previous_fy'
  | 'all_time'
  | 'custom';

export type DashboardTargetTab =
  | 'home'
  | 'khata'
  | 'products'
  | 'suppliers'
  | 'quotations'
  | 'gst-bill'
  | 'normal-bill';

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
  | 'supplier_payment_reversal'
  | 'supplier_allocation_reversal'
  | 'supplier_bill_cancellation'
  | 'expense'
  | 'expense_void'
  | 'quotation';

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

export interface DashboardSyncStatus {
  source: 'mongodb' | 'postgresql';
  syncedAt: string | null;
  ageMs: number | null;
  isStale: boolean;
}

export interface DashboardOverviewData {
  businessDate: string;
  timeZone: string;
  syncStatus?: DashboardSyncStatus;
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
    effectiveFromDate?: string;
    effectiveToDate?: string;
    isSixMonthWindow?: boolean;
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

export interface SaveExpensePayload {
  expenseDate: string;
  category: ExpenseCategory;
  title: string;
  vendorName?: string | null;
  amount: string;
  paymentMethod: ExpensePaymentMethod;
  referenceNumber?: string | null;
  notes?: string | null;
  reason?: string | null;
}

export interface BusinessExpenseEventRecord {
  id: number;
  expenseId: string;
  action: 'created' | 'updated' | 'voided';
  reason: string | null;
  previousData: Record<string, unknown> | null;
  newData: Record<string, unknown>;
  createdAt: string;
}

export interface ExpenseHistoryResult {
  expense: BusinessExpenseRecord;
  events: BusinessExpenseEventRecord[];
}
