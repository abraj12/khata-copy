import { Decimal } from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface PurchaseBillLineCalculationInput {
  quantity: number | string;
  purchaseRate: number | string;
}

export interface PurchaseBillLineCalculationResult {
  quantity: string;
  purchaseRate: string;
  lineTotal: string;
}

export interface PurchaseBillTotalsCalculationResult {
  items: PurchaseBillLineCalculationResult[];
  subtotalAmount: string;
  discountAmount: string;
  taxableAmount: string;
  gstRate: string;
  gstAmount: string;
  grandTotal: string;
}

export interface SupplierBalanceInputs {
  totalPurchases: number | string;
  totalPayments: number | string;
  allocatedPayments: number | string;
}

export interface SupplierBalanceSummary {
  totalPurchases: string;
  totalPayments: string;
  allocatedPayments: string;
  unallocatedPayments: string;
  outstandingPayable: string;
  advanceBalance: string;
  netBalance: string; // positive = payable to supplier, negative = advance with supplier
}

export interface StatementEntryInput {
  entryType: 'purchase_bill' | 'payment' | 'payment_reversal';
  entryDate: string; // YYYY-MM-DD
  sortOrder: number; // purchase bills (0), payments (1), payment reversals (2) on identical date, then id
  id: number;
  referenceNumber: string;
  description: string;
  amount: number | string;
  paymentMethod?: string | null;
  transactionReference?: string | null;
  paymentStatus?: 'active' | 'reversed' | null;
  reversalReason?: string | null;
  originalPaymentReceipt?: string | null;
  billStatus?: string | null;
  billPaidAmount?: number | string | null;
  billRemainingAmount?: number | string | null;
  paymentAllocatedAmount?: number | string | null;
  paymentUnallocatedAmount?: number | string | null;
}

export interface ComputedStatementEntry extends StatementEntryInput {
  debitAmount: string; // Purchase billed or payment reversed (+ payable)
  creditAmount: string; // Payment made (- payable)
  runningBalance: string; // Net balance after entry (+ payable, - advance)
}

export interface SupplierStatementComputation {
  openingBalance: string;
  periodPurchases: string;
  periodPayments: string;
  periodReversals: string;
  closingBalance: string;
  entries: ComputedStatementEntry[];
}

/**
 * Pure Decimal.js purchase bill line & totals calculator (ROUND_HALF_UP, 2dp).
 */
export function computePurchaseBillTotals(
  items: PurchaseBillLineCalculationInput[],
  discountAmountInput: number | string = 0,
  gstRateInput: number | string = 0
): PurchaseBillTotalsCalculationResult {
  let subtotal = new Decimal(0);

  const computedItems: PurchaseBillLineCalculationResult[] = items.map((item) => {
    const qty = new Decimal(item.quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const rate = new Decimal(item.purchaseRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const lineTotal = qty.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    subtotal = subtotal.plus(lineTotal);

    return {
      quantity: qty.toFixed(2),
      purchaseRate: rate.toFixed(2),
      lineTotal: lineTotal.toFixed(2),
    };
  });

  subtotal = subtotal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const discount = new Decimal(discountAmountInput || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const taxable = subtotal.minus(discount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const gstRate = new Decimal(gstRateInput || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const gstAmount = taxable.times(gstRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const grandTotal = taxable.plus(gstAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    items: computedItems,
    subtotalAmount: subtotal.toFixed(2),
    discountAmount: discount.toFixed(2),
    taxableAmount: taxable.toFixed(2),
    gstRate: gstRate.toFixed(2),
    gstAmount: gstAmount.toFixed(2),
    grandTotal: grandTotal.toFixed(2),
  };
}

/**
 * Single authoritative accounting formula shared across Supplier Dashboard,
 * Supplier Details, Supplier List, and Supplier Statements.
 */
export function computeSupplierAccountSummary(
  input: SupplierBalanceInputs
): SupplierBalanceSummary {
  const purchases = new Decimal(input.totalPurchases || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const payments = new Decimal(input.totalPayments || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const allocated = new Decimal(input.allocatedPayments || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const unallocated = Decimal.max(payments.minus(allocated), new Decimal(0)).toDecimalPlaces(
    2,
    Decimal.ROUND_HALF_UP
  );
  const netBalance = purchases.minus(payments).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const outstandingPayable = netBalance.greaterThan(0) ? netBalance : new Decimal(0);
  const advanceBalance = netBalance.lessThan(0) ? netBalance.abs() : new Decimal(0);

  return {
    totalPurchases: purchases.toFixed(2),
    totalPayments: payments.toFixed(2),
    allocatedPayments: allocated.toFixed(2),
    unallocatedPayments: unallocated.toFixed(2),
    outstandingPayable: outstandingPayable.toFixed(2),
    advanceBalance: advanceBalance.toFixed(2),
    netBalance: netBalance.toFixed(2),
  };
}

/**
 * Builds chronological statement ledger entries with running balance.
 * Opening balance is calculated strictly from prior transactions (0.00 when none exist).
 */
export function buildSupplierStatementLedger(
  priorPurchases: number | string,
  priorPayments: number | string,
  rawEntries: StatementEntryInput[],
  priorReversals: number | string = 0
): SupplierStatementComputation {
  const opening = new Decimal(priorPurchases || 0)
    .minus(new Decimal(priorPayments || 0))
    .plus(new Decimal(priorReversals || 0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const sorted = [...rawEntries].sort((a, b) => {
    if (a.entryDate !== b.entryDate) {
      return a.entryDate < b.entryDate ? -1 : 1;
    }
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return a.id - b.id;
  });

  let running = opening;
  let periodPurchases = new Decimal(0);
  let periodPayments = new Decimal(0);
  let periodReversals = new Decimal(0);

  const entries: ComputedStatementEntry[] = sorted.map((entry) => {
    const amt = new Decimal(entry.amount || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (entry.entryType === 'purchase_bill') {
      periodPurchases = periodPurchases.plus(amt);
      running = running.plus(amt).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      return {
        ...entry,
        debitAmount: amt.toFixed(2),
        creditAmount: '0.00',
        runningBalance: running.toFixed(2),
      };
    }

    if (entry.entryType === 'payment_reversal') {
      periodReversals = periodReversals.plus(amt);
      running = running.plus(amt).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      return {
        ...entry,
        debitAmount: amt.toFixed(2),
        creditAmount: '0.00',
        runningBalance: running.toFixed(2),
      };
    }

    periodPayments = periodPayments.plus(amt);
    running = running.minus(amt).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return {
      ...entry,
      debitAmount: '0.00',
      creditAmount: amt.toFixed(2),
      runningBalance: running.toFixed(2),
    };
  });

  return {
    openingBalance: opening.toFixed(2),
    periodPurchases: periodPurchases.toFixed(2),
    periodPayments: periodPayments.toFixed(2),
    periodReversals: periodReversals.toFixed(2),
    closingBalance: running.toFixed(2),
    entries,
  };
}

/**
 * Aggregates individual supplier account summaries into Dashboard overview metrics.
 */
export function aggregateSupplierDashboardKPIs(
  suppliers: Array<{ archivedAt: string | null } & SupplierBalanceSummary>
): {
  totalSuppliers: number;
  activeSuppliers: number;
  totalPurchases: string;
  totalPaymentsMade: string;
  totalOutstandingPayable: string;
  suppliersWithBalanceCount: number;
  totalAdvanceCredit: string;
  totalUnallocatedPayments: string;
} {
  let totalPurchases = new Decimal(0);
  let totalPaymentsMade = new Decimal(0);
  let totalOutstandingPayable = new Decimal(0);
  let totalAdvanceCredit = new Decimal(0);
  let totalUnallocatedPayments = new Decimal(0);
  let activeSuppliers = 0;
  let suppliersWithBalanceCount = 0;

  for (const s of suppliers) {
    if (!s.archivedAt) activeSuppliers += 1;
    totalPurchases = totalPurchases.plus(s.totalPurchases);
    totalPaymentsMade = totalPaymentsMade.plus(s.totalPayments);
    const outstanding = new Decimal(s.outstandingPayable);
    if (outstanding.greaterThan(0)) {
      suppliersWithBalanceCount += 1;
      totalOutstandingPayable = totalOutstandingPayable.plus(outstanding);
    }
    totalAdvanceCredit = totalAdvanceCredit.plus(s.advanceBalance);
    totalUnallocatedPayments = totalUnallocatedPayments.plus(s.unallocatedPayments);
  }

  return {
    totalSuppliers: suppliers.length,
    activeSuppliers,
    totalPurchases: totalPurchases.toFixed(2),
    totalPaymentsMade: totalPaymentsMade.toFixed(2),
    totalOutstandingPayable: totalOutstandingPayable.toFixed(2),
    suppliersWithBalanceCount,
    totalAdvanceCredit: totalAdvanceCredit.toFixed(2),
    totalUnallocatedPayments: totalUnallocatedPayments.toFixed(2),
  };
}
