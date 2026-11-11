import mongoose, { Schema, type Model, type Document } from 'mongoose';

export interface ProductSearchDoc {
  productId: number;
  name: string;
  normalizedName: string;
  searchTokens: string[];
  buyingPrice: string;
  hsnCode: string | null;
  barcode: string | null;
  imageObjectKey: string | null;
  imageUrl: string | null;
  isArchived: boolean;
  archivedAt: Date | null;
  sourceUpdatedAt: Date;
  projectionUpdatedAt: Date;
}

const productSearchSchema = new Schema<ProductSearchDoc>(
  {
    productId: { type: Number, required: true },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
    searchTokens: { type: [String], default: [] },
    buyingPrice: { type: String, required: true },
    hsnCode: { type: String, default: null },
    barcode: { type: String, default: null },
    imageObjectKey: { type: String, default: null },
    imageUrl: { type: String, default: null },
    isArchived: { type: Boolean, required: true, default: false },
    archivedAt: { type: Date, default: null },
    sourceUpdatedAt: { type: Date, required: true },
    projectionUpdatedAt: { type: Date, required: true },
  },
  {
    collection: 'product_search',
    autoIndex: false,
    versionKey: false,
  }
);

productSearchSchema.index({ productId: 1 }, { unique: true, name: 'idx_product_search_id_unique' });
productSearchSchema.index(
  { isArchived: 1, normalizedName: 1, productId: 1 },
  { name: 'idx_product_search_active_name' }
);
productSearchSchema.index({ barcode: 1 }, { sparse: true, name: 'idx_product_search_barcode' });
productSearchSchema.index({ hsnCode: 1 }, { sparse: true, name: 'idx_product_search_hsn' });
productSearchSchema.index({ searchTokens: 1 }, { name: 'idx_product_search_tokens' });

export interface CustomerSummaryDoc {
  customerId: number;
  name: string;
  normalizedName: string;
  phone: string | null;
  normalizedPhone: string | null;
  address: string | null;
  state: string | null;
  stateCode: string | null;
  totalUdhar: string;
  totalReceived: string;
  outstanding: string;
  outstandingPaise: number;
  hasOutstanding: boolean;
  transactionCount: number;
  paymentCount: number;
  lastActivityAt: Date | null;
  searchTokens: string[];
  isArchived: boolean;
  createdAtPg: Date;
  sourceUpdatedAt: Date;
  projectionUpdatedAt: Date;
}

const customerSummarySchema = new Schema<CustomerSummaryDoc>(
  {
    customerId: { type: Number, required: true },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
    phone: { type: String, default: null },
    normalizedPhone: { type: String, default: null },
    address: { type: String, default: null },
    state: { type: String, default: null },
    stateCode: { type: String, default: null },
    totalUdhar: { type: String, required: true, default: '0.00' },
    totalReceived: { type: String, required: true, default: '0.00' },
    outstanding: { type: String, required: true, default: '0.00' },
    outstandingPaise: { type: Number, required: true, default: 0 },
    hasOutstanding: { type: Boolean, required: true, default: false },
    transactionCount: { type: Number, required: true, default: 0 },
    paymentCount: { type: Number, required: true, default: 0 },
    lastActivityAt: { type: Date, default: null },
    searchTokens: { type: [String], default: [] },
    isArchived: { type: Boolean, required: true, default: false },
    createdAtPg: { type: Date, required: true },
    sourceUpdatedAt: { type: Date, required: true },
    projectionUpdatedAt: { type: Date, required: true },
  },
  {
    collection: 'customer_summaries',
    autoIndex: false,
    versionKey: false,
  }
);

customerSummarySchema.index(
  { customerId: 1 },
  { unique: true, name: 'idx_customer_summaries_id_unique' }
);
customerSummarySchema.index(
  { isArchived: 1, outstandingPaise: -1, lastActivityAt: -1, customerId: 1 },
  { name: 'idx_customer_summaries_active_outstanding' }
);
customerSummarySchema.index(
  { isArchived: 1, normalizedName: 1, customerId: 1 },
  { name: 'idx_customer_summaries_active_name' }
);
customerSummarySchema.index(
  { normalizedPhone: 1 },
  { sparse: true, name: 'idx_customer_summaries_phone' }
);
customerSummarySchema.index({ searchTokens: 1 }, { name: 'idx_customer_summaries_tokens' });

export interface DashboardSnapshotGlobals {
  totalCustomers: number;
  activeCustomers: number;
  customersWithOutstanding: number;
  totalOutstandingReceivable: string;
  khataSummaryTotalCustomers: number;
  khataSummaryTotalOutstanding: string;
  khataSummaryTotalReceived: string;
  totalProducts: number;
  activeProducts: number;
  archivedProducts: number;
  totalSuppliers: number;
  activeSuppliers: number;
  supplierTotalPurchases: string;
  supplierBillsCount: number;
  supplierCancelledBillsCount: number;
  supplierTotalPaymentsMade: string;
  supplierPaymentsCount: number;
  supplierTotalPaymentsReversed: string;
  supplierTotalOutstandingPayable: string;
  supplierTotalAdvanceCredit: string;
  supplierTotalUnallocatedPayments: string;
}

export interface DashboardSnapshotDoc {
  snapshotKey: string;
  globals: DashboardSnapshotGlobals;
  allTimeOverview: Record<string, unknown>;
  lastOutboxEventId: number | null;
  lastSyncedAt: Date;
  projectionUpdatedAt: Date;
}

const dashboardSnapshotSchema = new Schema<DashboardSnapshotDoc>(
  {
    snapshotKey: { type: String, required: true },
    globals: { type: Schema.Types.Mixed, required: true },
    allTimeOverview: { type: Schema.Types.Mixed, required: true },
    lastOutboxEventId: { type: Number, default: null },
    lastSyncedAt: { type: Date, required: true },
    projectionUpdatedAt: { type: Date, required: true },
  },
  {
    collection: 'dashboard_snapshots',
    autoIndex: false,
    versionKey: false,
  }
);

dashboardSnapshotSchema.index(
  { snapshotKey: 1 },
  { unique: true, name: 'idx_dashboard_snapshots_key_unique' }
);

export type RecentActivityType =
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

export type RecentActivityTargetTab =
  | 'home'
  | 'khata'
  | 'products'
  | 'suppliers'
  | 'quotations'
  | 'gst-bill'
  | 'normal-bill';

export interface RecentActivityDoc {
  activityKey: string;
  type: RecentActivityType;
  reference: string;
  party: string;
  amount: string;
  date: string;
  status: string | null;
  occurredAt: Date;
  targetTab: RecentActivityTargetTab;
  projectionUpdatedAt: Date;
}

const recentActivitySchema = new Schema<RecentActivityDoc>(
  {
    activityKey: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: [
        'normal_bill',
        'gst_invoice',
        'khata_credit',
        'khata_payment',
        'supplier_bill',
        'supplier_payment',
        'supplier_payment_reversal',
        'supplier_allocation_reversal',
        'supplier_bill_cancellation',
        'expense',
        'expense_void',
        'quotation',
      ],
    },
    reference: { type: String, required: true },
    party: { type: String, required: true },
    amount: { type: String, required: true },
    date: { type: String, required: true },
    status: { type: String, default: null },
    occurredAt: { type: Date, required: true },
    targetTab: {
      type: String,
      required: true,
      enum: ['home', 'khata', 'products', 'suppliers', 'quotations', 'gst-bill', 'normal-bill'],
    },
    projectionUpdatedAt: { type: Date, required: true },
  },
  {
    collection: 'recent_activity',
    autoIndex: false,
    versionKey: false,
  }
);

recentActivitySchema.index(
  { activityKey: 1 },
  { unique: true, name: 'idx_recent_activity_key_unique' }
);
recentActivitySchema.index(
  { date: -1, occurredAt: -1 },
  { name: 'idx_recent_activity_date_desc' }
);
recentActivitySchema.index({ occurredAt: -1 }, { name: 'idx_recent_activity_occurred_desc' });

export interface DailyAnalyticsExpenseCategoryItem {
  category: string;
  count: number;
  totalAmount: string;
}

export interface DailyAnalyticsProductSaleItem {
  productId: number;
  productName: string;
  isArchived: boolean;
  quantitySold: string;
  salesAmount: string;
  billCount: number;
}

export interface DailyAnalyticsQuotationEntry {
  status: 'draft' | 'sent' | 'accepted' | 'converted' | 'rejected' | 'expired';
  validUntil: string | null;
  grandTotal: string;
  count: number;
}

export interface DailyAnalyticsDoc {
  businessDate: string;
  yearMonth: string;
  normalBillsCount: number;
  normalBillsTotal: string;
  normalCostedRevenue: string;
  normalCogsTotal: string;
  gstInvoicesCount: number;
  gstTaxableSales: string;
  gstCollected: string;
  gstInvoicesGrandTotal: string;
  gstCostedRevenue: string;
  gstCogsTotal: string;
  expensesActiveCount: number;
  expensesActiveTotal: string;
  expensesVoidedCount: number;
  expensesByCategory: DailyAnalyticsExpenseCategoryItem[];
  newCustomersCount: number;
  khataCreditGiven: string;
  khataPaymentsReceived: string;
  khataPaymentCount: number;
  quotationsTotal: number;
  quotationsConverted: number;
  quotationsRejected: number;
  quotationsConvertedValue: string;
  quotationBuckets: DailyAnalyticsQuotationEntry[];
  supplierBillsCount: number;
  supplierCancelledBillsCount: number;
  supplierPurchases: string;
  supplierPaymentsCount: number;
  supplierPaymentsMade: string;
  supplierPaymentsReversed: string;
  productSales: DailyAnalyticsProductSaleItem[];
  projectionUpdatedAt: Date;
}

const dailyAnalyticsSchema = new Schema<DailyAnalyticsDoc>(
  {
    businessDate: { type: String, required: true },
    yearMonth: { type: String, required: true },
    normalBillsCount: { type: Number, required: true, default: 0 },
    normalBillsTotal: { type: String, required: true, default: '0.00' },
    normalCostedRevenue: { type: String, required: true, default: '0.00' },
    normalCogsTotal: { type: String, required: true, default: '0.00' },
    gstInvoicesCount: { type: Number, required: true, default: 0 },
    gstTaxableSales: { type: String, required: true, default: '0.00' },
    gstCollected: { type: String, required: true, default: '0.00' },
    gstInvoicesGrandTotal: { type: String, required: true, default: '0.00' },
    gstCostedRevenue: { type: String, required: true, default: '0.00' },
    gstCogsTotal: { type: String, required: true, default: '0.00' },
    expensesActiveCount: { type: Number, required: true, default: 0 },
    expensesActiveTotal: { type: String, required: true, default: '0.00' },
    expensesVoidedCount: { type: Number, required: true, default: 0 },
    expensesByCategory: {
      type: [
        {
          category: { type: String, required: true },
          count: { type: Number, required: true },
          totalAmount: { type: String, required: true },
        },
      ],
      default: [],
    },
    newCustomersCount: { type: Number, required: true, default: 0 },
    khataCreditGiven: { type: String, required: true, default: '0.00' },
    khataPaymentsReceived: { type: String, required: true, default: '0.00' },
    khataPaymentCount: { type: Number, required: true, default: 0 },
    quotationsTotal: { type: Number, required: true, default: 0 },
    quotationsConverted: { type: Number, required: true, default: 0 },
    quotationsRejected: { type: Number, required: true, default: 0 },
    quotationsConvertedValue: { type: String, required: true, default: '0.00' },
    quotationBuckets: {
      type: [
        {
          status: { type: String, required: true },
          validUntil: { type: String, default: null },
          grandTotal: { type: String, required: true },
          count: { type: Number, required: true },
        },
      ],
      default: [],
    },
    supplierBillsCount: { type: Number, required: true, default: 0 },
    supplierCancelledBillsCount: { type: Number, required: true, default: 0 },
    supplierPurchases: { type: String, required: true, default: '0.00' },
    supplierPaymentsCount: { type: Number, required: true, default: 0 },
    supplierPaymentsMade: { type: String, required: true, default: '0.00' },
    supplierPaymentsReversed: { type: String, required: true, default: '0.00' },
    productSales: {
      type: [
        {
          productId: { type: Number, required: true },
          productName: { type: String, required: true },
          isArchived: { type: Boolean, required: true, default: false },
          quantitySold: { type: String, required: true },
          salesAmount: { type: String, required: true },
          billCount: { type: Number, required: true },
        },
      ],
      default: [],
    },
    projectionUpdatedAt: { type: Date, required: true },
  },
  {
    collection: 'daily_analytics',
    autoIndex: false,
    versionKey: false,
  }
);

dailyAnalyticsSchema.index(
  { businessDate: 1 },
  { unique: true, name: 'idx_daily_analytics_business_date_unique' }
);
dailyAnalyticsSchema.index(
  { yearMonth: 1, businessDate: 1 },
  { name: 'idx_daily_analytics_month_date' }
);

function getOrCreateModel<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) || mongoose.model<T>(name, schema);
}

export const ProductSearchModel = getOrCreateModel<ProductSearchDoc>(
  'ProductSearch',
  productSearchSchema
);
export const CustomerSummaryModel = getOrCreateModel<CustomerSummaryDoc>(
  'CustomerSummary',
  customerSummarySchema
);
export const DashboardSnapshotModel = getOrCreateModel<DashboardSnapshotDoc>(
  'DashboardSnapshot',
  dashboardSnapshotSchema
);
export const RecentActivityModel = getOrCreateModel<RecentActivityDoc>(
  'RecentActivity',
  recentActivitySchema
);
export const DailyAnalyticsModel = getOrCreateModel<DailyAnalyticsDoc>(
  'DailyAnalytics',
  dailyAnalyticsSchema
);

export const READ_MODEL_MODELS = [
  ProductSearchModel,
  CustomerSummaryModel,
  DashboardSnapshotModel,
  RecentActivityModel,
  DailyAnalyticsModel,
] as const;

export type _MongoReadModelDoc<T> = Document & T;
