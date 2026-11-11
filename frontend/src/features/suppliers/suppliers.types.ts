export interface SupplierBalanceSummary {
  totalPurchases: string;
  totalPayments: string;
  allocatedPayments: string;
  unallocatedPayments: string;
  outstandingPayable: string;
  advanceBalance: string;
  netBalance: string;
}

export interface SupplierRecord extends SupplierBalanceSummary {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  stateCode: string | null;
  gstin: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivity: string | null;
  purchaseBillCount: number;
  paymentCount: number;
}

export interface SupplierDashboardKPIs {
  totalSuppliers: number;
  activeSuppliers: number;
  totalPurchases: string;
  totalPaymentsMade: string;
  totalOutstandingPayable: string;
  suppliersWithBalanceCount: number;
  totalAdvanceCredit: string;
  totalUnallocatedPayments: string;
}

export interface SupplierDashboardData {
  kpis: SupplierDashboardKPIs;
  suppliers: SupplierRecord[];
}

export interface CreateSupplierPayload {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  state?: string | null;
  stateCode?: string | null;
  gstin?: string | null;
  notes?: string | null;
}

export interface PurchaseBillItemPayload {
  productId?: number | null;
  description: string;
  quantity: string | number;
  purchaseRate: string | number;
  updateProductBuyingPrice?: boolean;
}

export interface CreatePurchaseBillPayload {
  supplierId: string;
  invoiceNumber: string;
  invoiceDate?: string;
  dueDate?: string | null;
  items: PurchaseBillItemPayload[];
  discountAmount?: string | number;
  gstRate?: string | number;
  notes?: string | null;
}

export interface UpdatePurchaseBillPayload {
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string | null;
  items: PurchaseBillItemPayload[];
  discountAmount?: string | number;
  gstRate?: string | number;
  notes?: string | null;
  reason?: string;
}

export interface PurchaseBillItemRecord {
  id: number;
  purchaseBillId: number;
  itemIndex: number;
  productId: number | null;
  productName: string | null;
  productBarcode: string | null;
  productCurrentBuyingPrice: string | null;
  description: string;
  quantity: string;
  purchaseRate: string;
  lineTotal: string;
  updatedProductBuyingPrice: boolean;
}

export interface PurchaseBillHistoryRecord {
  id: number;
  version: number;
  action: 'created' | 'edited' | 'cancelled';
  reason: string | null;
  previousData: Record<string, unknown> | null;
  newData: Record<string, unknown>;
  createdAt: string;
}

export interface PurchaseBillSummary {
  id: number;
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  supplierGstin: string | null;
  supplierArchivedAt: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  subtotalAmount: string;
  discountAmount: string;
  taxableAmount: string;
  gstRate: string;
  gstAmount: string;
  grandTotal: string;
  allocatedAmount: string;
  remainingAmount: string;
  paymentStatus: 'paid' | 'partial' | 'unpaid' | 'cancelled';
  status: 'finalized' | 'cancelled';
  notes: string | null;
  hasAttachment: boolean;
  attachmentFilename: string | null;
  attachmentContentType: string | null;
  attachmentSizeBytes: number | null;
  version: number;
  cancelledAt: string | null;
  cancellationReason: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseBillDetail extends PurchaseBillSummary {
  supplierAddress: string | null;
  supplierState: string | null;
  supplierStateCode: string | null;
  items: PurchaseBillItemRecord[];
  allocations: Array<{
    allocationId: number;
    paymentId: number;
    receiptNumber: string;
    paymentDate: string;
    paymentMethod: string;
    transactionReference: string | null;
    allocatedAmount: string;
  }>;
  history: PurchaseBillHistoryRecord[];
}

export type SupplierPaymentMethod = 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'other';

export interface SupplierPaymentAllocationRecord {
  allocationId: number;
  purchaseBillId: number;
  invoiceNumber: string;
  invoiceDate: string;
  billGrandTotal: string;
  amount: string;
}

export interface SupplierPaymentRecord {
  id: number;
  receiptNumber: string;
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  supplierGstin: string | null;
  supplierAddress: string | null;
  supplierArchivedAt: string | null;
  paymentDate: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  paymentMethod: SupplierPaymentMethod;
  transactionReference: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  allocations: SupplierPaymentAllocationRecord[];
  supplierSummary?: SupplierBalanceSummary;
}

export interface CreateSupplierPaymentPayload {
  supplierId: string;
  paymentDate?: string;
  amount: string | number;
  paymentMethod: SupplierPaymentMethod;
  transactionReference?: string | null;
  notes?: string | null;
  allocations?: Array<{
    purchaseBillId: number;
    amount: string | number;
  }>;
}

export interface SupplierStatementEntry {
  entryType: 'purchase_bill' | 'payment';
  entryDate: string;
  sortOrder: number;
  id: number;
  referenceNumber: string;
  description: string;
  amount: string;
  paymentMethod?: string | null;
  transactionReference?: string | null;
  billStatus?: string | null;
  billPaidAmount?: string | null;
  billRemainingAmount?: string | null;
  paymentAllocatedAmount?: string | null;
  paymentUnallocatedAmount?: string | null;
  debitAmount: string;
  creditAmount: string;
  runningBalance: string;
}

export interface SupplierStatementData {
  supplier: SupplierRecord;
  filters: {
    fromDate: string | null;
    toDate: string | null;
  };
  openingBalance: string;
  periodPurchases: string;
  periodPayments: string;
  closingBalance: string;
  entries: SupplierStatementEntry[];
}

export interface CatalogProductOption {
  id: number;
  name: string;
  buying_price: string;
  hsn_code?: string | null;
  barcode?: string | null;
}
