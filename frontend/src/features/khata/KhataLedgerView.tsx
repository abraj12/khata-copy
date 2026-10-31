import React, { useEffect, useState, useMemo, useRef } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import {
  Users,
  CreditCard,
  ArrowUpRight,
  ArrowDownLeft,
  Plus,
  Search,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronUp,
  X,
  AlertCircle,
  FileText,
  DollarSign,
  Trash2,
} from 'lucide-react';
import Decimal from 'decimal.js';
import { formatCurrency, formatQuantity, safeDecimal } from '../../lib/formatters.js';

interface SummaryData {
  totalCustomers: number | string;
  totalOutstanding: number | string;
  totalReceived: number | string;
}

interface CustomerListItem {
  id: number;
  name: string;
  phone: string | null;
  totalUdhar: number | string;
  totalReceived: number | string;
  outstanding: number | string;
  created_at: string;
}

interface ProductReference {
  id: number;
  name: string;
  buying_price: string;
}

interface UdharItemDetail {
  id: number;
  product_id: number | null;
  product_name_snapshot: string;
  buying_price_snapshot: string;
  quantity: string;
  selling_price: string;
  line_total: string;
}

interface UdharTransactionDetail {
  id: number;
  transaction_date?: string;
  transactionDate?: string;
  total_amount?: string;
  totalAmount?: string;
  settled_amount?: string;
  allocated_payment?: string;
  allocatedPayment?: string;
  remaining_amount?: string;
  outstanding?: string;
  is_fully_settled?: boolean;
  isSettled?: boolean;
  note: string | null;
  created_at?: string;
  createdAt?: string;
  items: UdharItemDetail[];
}

interface PaymentAllocationDetail {
  id?: number;
  transactionId?: number;
  udhar_transaction_id?: number;
  amount?: string;
  allocated_amount?: string;
  transaction_date?: string;
  total_amount?: string;
}

interface PaymentRecordDetail {
  id: number;
  amount: string;
  payment_date?: string;
  receivedAt?: string;
  received_at?: string;
  note: string | null;
  created_at?: string;
  createdAt?: string;
  allocations: PaymentAllocationDetail[];
}

interface CustomerHistoryData {
  customer: {
    id: number;
    name: string;
    phone: string | null;
    totalUdhar: number | string;
    totalReceived: number | string;
    outstanding: number | string;
  };
  transactions: UdharTransactionDetail[];
  payments: PaymentRecordDetail[];
}

interface UdharFormLine {
  productId: number | '';
  quantity: string;
  sellingPrice: string;
}

function generateIdempotencyKey(prefix: string): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export const KhataLedgerView: React.FC = () => {
  // Global state
  const [summary, setSummary] = useState<SummaryData>({
    totalCustomers: 0,
    totalOutstanding: '0.00',
    totalReceived: '0.00',
  });
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [activeProducts, setActiveProducts] = useState<ProductReference[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // New Udhar Modal state
  const [isNewUdharOpen, setIsNewUdharOpen] = useState(false);
  const [udharIdempotencyKey, setUdharIdempotencyKey] = useState<string>('');
  const [selectedExistingCustomerId, setSelectedExistingCustomerId] = useState<number | ''>('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [udharLines, setUdharLines] = useState<UdharFormLine[]>([
    { productId: '', quantity: '1', sellingPrice: '' },
  ]);
  const [initialPayment, setInitialPayment] = useState('');
  const [transactionNote, setTransactionNote] = useState('');
  const [udharFormError, setUdharFormError] = useState<string | null>(null);
  const [isSubmittingUdhar, setIsSubmittingUdhar] = useState(false);

  // Customer Detail & History Modal state
  const activeRequestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [activeCustomerDetailId, setActiveCustomerDetailId] = useState<number | null>(null);
  const [customerHistory, setCustomerHistory] = useState<CustomerHistoryData | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [expandedTxIds, setExpandedTxIds] = useState<Set<number>>(new Set());

  // Record Payment state
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentIdempotencyKey, setPaymentIdempotencyKey] = useState<string>('');
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // Fetch initial summary & customer list
  const fetchOverviewData = async () => {
    try {
      setIsLoading(true);
      const [sumRes, custRes, prodRes] = await Promise.all([
        apiClient<{ success: boolean; summary?: SummaryData; data?: SummaryData }>('/api/v1/khata/summary'),
        apiClient<{ success: boolean; customers?: CustomerListItem[]; data?: CustomerListItem[] }>('/api/v1/khata/customers'),
        apiClient<{ success: boolean; data?: ProductReference[] }>('/api/v1/products'),
      ]);

      const sumData = sumRes.data.summary || sumRes.data.data || {
        totalCustomers: 0,
        totalOutstanding: '0.00',
        totalReceived: '0.00',
      };
      setSummary(sumData);
      setCustomers(custRes.data.customers || custRes.data.data || []);
      setActiveProducts(prodRes.data.data || []);
    } catch (err) {
      showNotification('error', (err as Error).message || 'Failed to load Khata data.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchOverviewData();
  }, []);

  // Fetch individual customer history with race-condition prevention & AbortController
  const fetchCustomerHistory = async (customerId: number) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const currentRequestId = ++activeRequestIdRef.current;

    try {
      setIsLoadingHistory(true);
      const res = await apiClient<{
        success: boolean;
        data?: CustomerHistoryData;
        customer?: CustomerHistoryData['customer'];
        transactions?: UdharTransactionDetail[];
        payments?: PaymentRecordDetail[];
      }>(`/api/v1/khata/customers/${customerId}/history`, {
        signal: controller.signal,
      });

      // Stale check: discard response if user already selected a different customer
      if (currentRequestId !== activeRequestIdRef.current) return;

      const payload = res.data.data || {
        customer: res.data.customer!,
        transactions: res.data.transactions || [],
        payments: res.data.payments || [],
      };

      // Verify customer ID matches
      if (payload.customer && payload.customer.id === customerId) {
        setCustomerHistory(payload);
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') return;
      showNotification('error', (err as Error).message || 'Failed to load customer history.');
    } finally {
      if (currentRequestId === activeRequestIdRef.current) {
        setIsLoadingHistory(false);
      }
    }
  };

  const handleOpenCustomerDetail = (customerId: number) => {
    setActiveCustomerDetailId(customerId);
    setCustomerHistory(null); // Clear immediately so stale customer data is never rendered
    setPaymentAmount('');
    setPaymentNote('');
    setPaymentError(null);
    setPaymentIdempotencyKey(generateIdempotencyKey('pay'));
    setExpandedTxIds(new Set());
    fetchCustomerHistory(customerId);
  };

  const handleOpenNewUdharModal = () => {
    setIsNewUdharOpen(true);
    setUdharFormError(null);
    setUdharIdempotencyKey(generateIdempotencyKey('tx'));
  };

  // Precise Decimal arithmetic for line totals
  const lineCalculations = useMemo(() => {
    return udharLines.map((line) => {
      const q = safeDecimal(line.quantity);
      const p = safeDecimal(line.sellingPrice);
      if (q.greaterThan(0) && p.greaterThanOrEqualTo(0)) {
        return q.times(p).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      }
      return new Decimal(0);
    });
  }, [udharLines]);

  const calculatedTotalAmount = useMemo(() => {
    return lineCalculations.reduce((acc, curr) => acc.plus(curr), new Decimal(0));
  }, [lineCalculations]);

  const calculatedRemainingUdhar = useMemo(() => {
    const initPay = safeDecimal(initialPayment);
    return Decimal.max(0, calculatedTotalAmount.minus(initPay));
  }, [calculatedTotalAmount, initialPayment]);

  // Form row actions
  const handleAddLine = () => {
    setUdharLines((prev) => [...prev, { productId: '', quantity: '1', sellingPrice: '' }]);
  };

  const handleRemoveLine = (index: number) => {
    if (udharLines.length <= 1) return;
    setUdharLines((prev) => prev.filter((_, i) => i !== index));
  };

  const handleLineChange = (index: number, field: keyof UdharFormLine, value: string | number) => {
    setUdharLines((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  // Submit New Udhar
  const handleSubmitNewUdhar = async (e: React.FormEvent) => {
    e.preventDefault();
    setUdharFormError(null);

    // Validate customer
    let customerPayload: { id: number | null; name: string; phone: string | null };
    if (selectedExistingCustomerId) {
      const cust = customers.find((c) => c.id === selectedExistingCustomerId);
      if (!cust) {
        setUdharFormError('Selected customer not found.');
        return;
      }
      customerPayload = { id: cust.id, name: cust.name, phone: cust.phone };
    } else {
      if (!newCustomerName.trim()) {
        setUdharFormError('Customer name is required for new customers.');
        return;
      }
      customerPayload = {
        id: null,
        name: newCustomerName.trim(),
        phone: newCustomerPhone.trim() || null,
      };
    }

    // Validate items
    const validatedItems: { productId: number; quantity: number; sellingPrice: number }[] = [];
    for (let i = 0; i < udharLines.length; i++) {
      const line = udharLines[i];
      if (!line.productId) {
        setUdharFormError(`Please select a product for line #${i + 1}.`);
        return;
      }
      const qtyDec = safeDecimal(line.quantity);
      if (qtyDec.lessThanOrEqualTo(0)) {
        setUdharFormError(`Line #${i + 1} has an invalid quantity.`);
        return;
      }
      const priceDec = safeDecimal(line.sellingPrice);
      if (priceDec.lessThan(0)) {
        setUdharFormError(`Line #${i + 1} has an invalid selling price.`);
        return;
      }
      validatedItems.push({
        productId: Number(line.productId),
        quantity: qtyDec.toNumber(),
        sellingPrice: priceDec.toNumber(),
      });
    }

    if (validatedItems.length === 0) {
      setUdharFormError('At least one product item is required.');
      return;
    }

    const initPaymentDec = safeDecimal(initialPayment);
    if (initPaymentDec.lessThan(0)) {
      setUdharFormError('Initial payment must be a non-negative number.');
      return;
    }

    if (initPaymentDec.greaterThan(calculatedTotalAmount)) {
      setUdharFormError('Initial payment cannot exceed the total transaction amount.');
      return;
    }

    setIsSubmittingUdhar(true);

    try {
      const activeKey = udharIdempotencyKey || generateIdempotencyKey('tx');
      const res = await apiClient<{
        success: boolean;
        data?: { transactionId: number; customerId: number };
        transactionId?: number;
        customerId?: number;
      }>('/api/v1/khata/transactions', {
        method: 'POST',
        headers: {
          'Idempotency-Key': activeKey,
        },
        body: JSON.stringify({
          customer: customerPayload,
          items: validatedItems,
          initialPayment: initPaymentDec.greaterThan(0) ? initPaymentDec.toNumber() : null,
          note: transactionNote.trim() || null,
          idempotencyKey: activeKey,
        }),
      });

      // Clear pending operation state on confirmed success
      setIsNewUdharOpen(false);
      setUdharIdempotencyKey('');
      setSelectedExistingCustomerId('');
      setNewCustomerName('');
      setNewCustomerPhone('');
      setUdharLines([{ productId: '', quantity: '1', sellingPrice: '' }]);
      setInitialPayment('');
      setTransactionNote('');

      showNotification('success', 'Udhar transaction recorded successfully.');
      await fetchOverviewData();

      const createdCustId = res.data?.data?.customerId || res.data?.customerId;
      if (createdCustId) {
        handleOpenCustomerDetail(createdCustId);
      }
    } catch (err) {
      // Retain the idempotency key for retry!
      setUdharFormError((err as Error).message || 'Failed to create Udhar transaction.');
    } finally {
      setIsSubmittingUdhar(false);
    }
  };

  // Submit Payment for active customer
  const handleSubmitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCustomerDetailId || !customerHistory) return;

    const payDec = safeDecimal(paymentAmount);
    if (payDec.lessThanOrEqualTo(0)) {
      setPaymentError('Payment amount must be greater than zero.');
      return;
    }

    const outstandingDec = safeDecimal(customerHistory.customer.outstanding);
    if (payDec.greaterThan(outstandingDec)) {
      setPaymentError(
        `Payment amount (${formatCurrency(payDec)}) exceeds customer total balance of ${formatCurrency(outstandingDec)}.`
      );
      return;
    }

    setPaymentError(null);
    setIsSubmittingPayment(true);

    try {
      const activeKey = paymentIdempotencyKey || generateIdempotencyKey('pay');
      await apiClient(`/api/v1/khata/customers/${activeCustomerDetailId}/payments`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': activeKey,
        },
        body: JSON.stringify({
          amount: payDec.toNumber(),
          note: paymentNote.trim() || null,
          idempotencyKey: activeKey,
        }),
      });

      // Clear pending state on confirmed success
      setPaymentAmount('');
      setPaymentNote('');
      setPaymentIdempotencyKey(generateIdempotencyKey('pay'));
      showNotification('success', `Payment of ${formatCurrency(payDec)} recorded and allocated.`);
      await Promise.all([fetchCustomerHistory(activeCustomerDetailId), fetchOverviewData()]);
    } catch (err) {
      // Retain the idempotency key for safe retry!
      setPaymentError((err as Error).message || 'Failed to record payment.');
    } finally {
      setIsSubmittingPayment(false);
    }
  };

  const toggleExpandTx = (txId: number) => {
    setExpandedTxIds((prev) => {
      const next = new Set(prev);
      if (next.has(txId)) {
        next.delete(txId);
      } else {
        next.add(txId);
      }
      return next;
    });
  };

  // Filter customers by name or phone
  const filteredCustomers = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.phone && c.phone.includes(search))
  );

  return (
    <div className="space-y-6">
      {/* Notification banner */}
      {notification && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-center justify-between p-4 rounded-xl text-xs sm:text-sm font-semibold border ${
            notification.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-[var(--khata-success)]'
              : 'bg-red-500/10 border-red-500/30 text-[var(--khata-danger)]'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{notification.message}</span>
          </div>
          <button
            onClick={() => setNotification(null)}
            className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] transition"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Overview KPI Cards with Neumorphic Elevation */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Total Outstanding */}
        <div className="neu-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider">
              Total Amount to Receive
            </span>
            <div className="w-8 h-8 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-[var(--khata-danger)]">
              <ArrowUpRight className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-black text-[var(--khata-danger)] tabular-numbers">
            {formatCurrency(summary.totalOutstanding)}
          </p>
          <p className="text-xs text-[var(--khata-text-muted)] mt-1">Current uncollected Udhar balance</p>
        </div>

        {/* Total Received */}
        <div className="neu-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider">
              Payments Collected
            </span>
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-[var(--khata-success)]">
              <ArrowDownLeft className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-black text-[var(--khata-success)] tabular-numbers">
            {formatCurrency(summary.totalReceived)}
          </p>
          <p className="text-xs text-[var(--khata-text-muted)] mt-1">Total credit settled across all time</p>
        </div>

        {/* Total Customers */}
        <div className="neu-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider">
              Total Udhar Customers
            </span>
            <div className="w-8 h-8 rounded-xl bg-[var(--khata-accent)]/10 border border-[var(--khata-accent)]/20 flex items-center justify-center text-[var(--khata-accent)]">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-black text-[var(--khata-text)] tabular-numbers">
            {summary.totalCustomers}
          </p>
          <p className="text-xs text-[var(--khata-text-muted)] mt-1">Distinct customers recorded in ledger</p>
        </div>
      </div>

      {/* Action Bar */}
      <div className="neu-card p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-[var(--khata-text)] flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-[var(--khata-accent)]" />
            <span>Customer Khata Ledger</span>
          </h2>
          <p className="text-xs text-[var(--khata-text-muted)] mt-1">
            Deterministic Udhar tracking, custom per-item selling prices, and FIFO payment allocations.
          </p>
        </div>

        <button
          onClick={handleOpenNewUdharModal}
          className="neu-btn-primary text-xs sm:text-sm font-bold px-4 py-2.5 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>New Udhar</span>
        </button>
      </div>

      {/* Customer Inset Search Bar */}
      <div className="relative">
        <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-3.5 top-3.5" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer by name or phone..."
          className="neu-input w-full pl-10 pr-4 py-3 text-sm font-medium"
        />
      </div>

      {/* Customer List Card */}
      <div className="neu-card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-[var(--khata-text-muted)] font-medium">
            Loading Khata ledger...
          </div>
        ) : filteredCustomers.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--khata-text-muted)]">
            {search
              ? 'No customers found matching search.'
              : 'No Udhar customers yet. Click "New Udhar" above to record customer credit.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[var(--khata-border)] bg-[var(--khata-surface-inset)] text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider">
                  <th className="py-3.5 px-4 sm:px-6">Customer</th>
                  <th className="py-3.5 px-4 sm:px-6 text-right">Total Udhar</th>
                  <th className="py-3.5 px-4 sm:px-6 text-right">Total Received</th>
                  <th className="py-3.5 px-4 sm:px-6 text-right">Outstanding Due</th>
                  <th className="py-3.5 px-4 sm:px-6 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--khata-border)] text-sm">
                {filteredCustomers.map((c) => {
                  const outDec = safeDecimal(c.outstanding);
                  const isSettled = outDec.lessThanOrEqualTo(0);
                  return (
                    <tr
                      key={c.id}
                      onClick={() => handleOpenCustomerDetail(c.id)}
                      className="hover:bg-[var(--khata-surface-inset)]/70 cursor-pointer transition-colors"
                      tabIndex={0}
                      role="button"
                      aria-label={`View ledger for ${c.name}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleOpenCustomerDetail(c.id);
                        }
                      }}
                    >
                      <td className="py-3.5 px-4 sm:px-6">
                        <div className="font-semibold text-[var(--khata-text)]">{c.name}</div>
                        {c.phone && (
                          <div className="text-xs text-[var(--khata-text-muted)] font-mono">{c.phone}</div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 sm:px-6 text-right tabular-numbers font-medium text-[var(--khata-text)]">
                        {formatCurrency(c.totalUdhar)}
                      </td>
                      <td className="py-3.5 px-4 sm:px-6 text-right tabular-numbers font-medium text-[var(--khata-success)]">
                        {formatCurrency(c.totalReceived)}
                      </td>
                      <td
                        className={`py-3.5 px-4 sm:px-6 text-right tabular-numbers font-bold ${
                          isSettled ? 'text-[var(--khata-text-muted)]' : 'text-[var(--khata-danger)]'
                        }`}
                      >
                        {formatCurrency(c.outstanding)}
                      </td>
                      <td className="py-3.5 px-4 sm:px-6 text-center">
                        <span
                          className={`neu-badge ${
                            isSettled ? 'neu-badge-success' : 'neu-badge-danger'
                          }`}
                        >
                          {isSettled ? 'Settled' : 'Pending'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ==============================================================================
          NEW UDHAR MODAL
          ============================================================================== */}
      {isNewUdharOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-udhar-title"
        >
          <div
            className="neu-card max-w-2xl w-full p-6 my-8 space-y-5"
            style={{ backgroundColor: 'var(--khata-surface)' }}
          >
            <div className="flex items-center justify-between pb-3 border-b border-[var(--khata-border)]">
              <div>
                <h3 id="new-udhar-title" className="text-lg font-bold text-[var(--khata-text)]">
                  Record New Udhar Transaction
                </h3>
                <p className="text-xs text-[var(--khata-text-muted)]">
                  Select an existing customer or enter a new customer. Add product items with custom selling prices.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsNewUdharOpen(false)}
                className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {udharFormError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 text-[var(--khata-danger)] text-xs rounded-xl font-medium">
                {udharFormError}
              </div>
            )}

            <form onSubmit={handleSubmitNewUdhar} className="space-y-5">
              {/* Customer Selector / Creator */}
              <div
                className="p-4 rounded-xl border border-[var(--khata-border)] space-y-3"
                style={{ backgroundColor: 'var(--khata-surface-raised)' }}
              >
                <span className="text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider block">
                  Customer Identification
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[var(--khata-text)] mb-1">
                      Existing Customer
                    </label>
                    <select
                      value={selectedExistingCustomerId}
                      onChange={(e) => {
                        const val = e.target.value ? Number(e.target.value) : '';
                        setSelectedExistingCustomerId(val);
                        if (val) {
                          setNewCustomerName('');
                          setNewCustomerPhone('');
                        }
                      }}
                      className="neu-input w-full text-sm font-medium"
                    >
                      <option value="">-- Or enter new customer below --</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.phone ? `(${c.phone})` : ''} — Due: {formatCurrency(c.outstanding)}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!selectedExistingCustomerId && (
                    <>
                      <div>
                        <label className="block text-xs font-semibold text-[var(--khata-text)] mb-1">
                          New Customer Name <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="text"
                          required={!selectedExistingCustomerId}
                          value={newCustomerName}
                          onChange={(e) => setNewCustomerName(e.target.value)}
                          placeholder="e.g. Ramesh Kumar"
                          className="neu-input w-full text-sm font-medium"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-[var(--khata-text)] mb-1">
                          Mobile Number (Optional)
                        </label>
                        <input
                          type="tel"
                          value={newCustomerPhone}
                          onChange={(e) => setNewCustomerPhone(e.target.value)}
                          placeholder="e.g. 9876543210"
                          className="neu-input w-full text-sm font-medium"
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Multi-line Products */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider">
                    Purchased Item Lines
                  </span>
                  <button
                    type="button"
                    onClick={handleAddLine}
                    className="neu-btn-secondary text-xs px-3 py-1 flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                    <span>Add Item</span>
                  </button>
                </div>

                <div className="space-y-2.5">
                  {udharLines.map((line, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-12 gap-2.5 items-center p-3.5 rounded-xl border border-[var(--khata-border)] shadow-sm"
                      style={{ backgroundColor: 'var(--khata-surface-raised)' }}
                    >
                      {/* Product Selector */}
                      <div className="col-span-12 sm:col-span-5">
                        <label className="block text-[11px] font-semibold text-[var(--khata-text-muted)] mb-0.5">
                          Product #{idx + 1}
                        </label>
                        <select
                          required
                          value={line.productId}
                          onChange={(e) =>
                            handleLineChange(
                              idx,
                              'productId',
                              e.target.value ? Number(e.target.value) : ''
                            )
                          }
                          className="neu-input w-full text-sm font-medium"
                        >
                          <option value="">Select Reference Product...</option>
                          {activeProducts.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} (Ref: {formatCurrency(p.buying_price)})
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Quantity */}
                      <div className="col-span-6 sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-[var(--khata-text-muted)] mb-0.5">
                          Quantity
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          required
                          value={line.quantity}
                          onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)}
                          placeholder="Qty"
                          className="neu-input w-full text-sm font-medium tabular-numbers"
                        />
                      </div>

                      {/* Custom Selling Price */}
                      <div className="col-span-6 sm:col-span-3">
                        <label className="block text-[11px] font-semibold text-[var(--khata-text-muted)] mb-0.5">
                          Custom Selling ₹
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          required
                          value={line.sellingPrice}
                          onChange={(e) => handleLineChange(idx, 'sellingPrice', e.target.value)}
                          placeholder="Selling ₹"
                          className="neu-input w-full text-sm font-medium tabular-numbers"
                        />
                      </div>

                      {/* Line Total & Remove */}
                      <div className="col-span-12 sm:col-span-2 flex items-center justify-between sm:justify-end gap-2 pt-2 sm:pt-4 border-t sm:border-t-0 border-[var(--khata-border)]/50">
                        <div className="sm:hidden text-xs text-[var(--khata-text-muted)] font-medium">Line Total:</div>
                        <span className="text-xs font-bold text-[var(--khata-text)] tabular-numbers">
                          {formatCurrency(lineCalculations[idx])}
                        </span>
                        {udharLines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveLine(idx)}
                            className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-danger)] transition min-h-[36px]"
                            title="Remove line"
                            aria-label={`Remove line ${idx + 1}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Initial Payment & Note */}
              <div
                className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-xl border border-[var(--khata-border)]"
                style={{ backgroundColor: 'var(--khata-surface-raised)' }}
              >
                <div>
                  <label className="block text-xs font-semibold text-[var(--khata-text)] mb-1">
                    Initial Payment Received (₹) (Optional)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={initialPayment}
                    onChange={(e) => setInitialPayment(e.target.value)}
                    placeholder="0.00"
                    className="neu-input w-full text-sm font-medium tabular-numbers"
                  />
                  <span className="text-[11px] text-[var(--khata-text-muted)] mt-1 block">
                    Cash received at purchase time
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--khata-text)] mb-1">
                    Transaction Note (Optional)
                  </label>
                  <input
                    type="text"
                    value={transactionNote}
                    onChange={(e) => setTransactionNote(e.target.value)}
                    placeholder="e.g. Construction hardware items"
                    className="neu-input w-full text-sm font-medium"
                  />
                </div>
              </div>

              {/* Live Preview Summary Box */}
              <div
                className="p-4 rounded-xl border border-[var(--khata-border)] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-sm"
                style={{ backgroundColor: 'var(--khata-surface-inset)' }}
              >
                <div>
                  <span className="text-xs font-bold text-[var(--khata-text)] block">
                    Live Calculation Preview
                  </span>
                  <span className="text-xs text-[var(--khata-text-muted)]">
                    Accurate Decimal arithmetic matching backend validation.
                  </span>
                </div>
                <div className="flex items-center gap-6 text-right">
                  <div>
                    <span className="text-[11px] text-[var(--khata-text-muted)] uppercase block font-semibold">
                      Total
                    </span>
                    <span className="font-bold text-[var(--khata-text)] text-base tabular-numbers">
                      {formatCurrency(calculatedTotalAmount)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[11px] text-[var(--khata-danger)] uppercase block font-bold">
                      New Udhar Due
                    </span>
                    <span className="font-black text-[var(--khata-danger)] text-lg tabular-numbers">
                      {formatCurrency(calculatedRemainingUdhar)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Form Buttons */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsNewUdharOpen(false)}
                  className="neu-btn-secondary text-xs px-4 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingUdhar || calculatedTotalAmount.lessThanOrEqualTo(0)}
                  className="neu-btn-primary text-xs px-5 py-2.5 font-bold"
                >
                  {isSubmittingUdhar ? 'Recording Udhar...' : 'Save Udhar Transaction'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==============================================================================
          CUSTOMER DETAIL & HISTORY MODAL
          ============================================================================== */}
      {activeCustomerDetailId && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="customer-detail-title"
        >
          <div
            className="neu-card max-w-3xl w-full p-6 my-8 space-y-6"
            style={{ backgroundColor: 'var(--khata-surface)' }}
          >
            {isLoadingHistory || !customerHistory ? (
              <div className="p-12 text-center text-sm text-[var(--khata-text-muted)] font-medium">
                Loading customer ledger...
              </div>
            ) : (
              <>
                {/* Customer Header */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[var(--khata-border)]">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 id="customer-detail-title" className="text-xl font-bold text-[var(--khata-text)]">
                        {customerHistory.customer.name}
                      </h3>
                      <span
                        className={`neu-badge ${
                          safeDecimal(customerHistory.customer.outstanding).lessThanOrEqualTo(0)
                            ? 'neu-badge-success'
                            : 'neu-badge-danger'
                        }`}
                      >
                        {safeDecimal(customerHistory.customer.outstanding).lessThanOrEqualTo(0)
                          ? 'Settled'
                          : 'Outstanding'}
                      </span>
                    </div>
                    {customerHistory.customer.phone && (
                      <p className="text-xs text-[var(--khata-text-muted)] font-mono mt-0.5">
                        {customerHistory.customer.phone}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-4 text-right">
                    <div>
                      <span className="text-[11px] text-[var(--khata-text-muted)] uppercase font-semibold block">
                        Total Udhar
                      </span>
                      <span className="font-bold text-[var(--khata-text)] tabular-numbers">
                        {formatCurrency(customerHistory.customer.totalUdhar)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-[var(--khata-text-muted)] uppercase font-semibold block">
                        Total Received
                      </span>
                      <span className="font-bold text-[var(--khata-success)] tabular-numbers">
                        {formatCurrency(customerHistory.customer.totalReceived)}
                      </span>
                    </div>
                    <div className="p-2 px-3 rounded-xl border border-[var(--khata-border)]" style={{ backgroundColor: 'var(--khata-surface-raised)' }}>
                      <span className="text-[11px] text-[var(--khata-danger)] uppercase font-bold block">
                        Balance Due
                      </span>
                      <span className="font-black text-[var(--khata-danger)] text-base tabular-numbers">
                        {formatCurrency(customerHistory.customer.outstanding)}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveCustomerDetailId(null)}
                    className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
                    aria-label="Close"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Record Payment Section */}
                <div
                  className="p-4 rounded-xl border border-[var(--khata-border)] space-y-3"
                  style={{ backgroundColor: 'var(--khata-surface-raised)' }}
                >
                  <div className="flex items-center gap-2 text-[var(--khata-text)] font-bold text-sm">
                    <DollarSign className="w-4 h-4 text-[var(--khata-success)]" />
                    <span>Record Payment Received</span>
                  </div>

                  {paymentError && (
                    <div className="p-2.5 bg-red-500/10 border border-red-500/30 text-[var(--khata-danger)] text-xs rounded-lg font-medium">
                      {paymentError}
                    </div>
                  )}

                  <form onSubmit={handleSubmitPayment} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                    <div>
                      <label className="block text-xs font-semibold text-[var(--khata-text-muted)] mb-1">
                        Payment Amount (₹) <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="text"
                        inputMode="decimal"
                        required
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        placeholder={`Max ${formatCurrency(customerHistory.customer.outstanding)}`}
                        className="neu-input w-full text-sm font-medium tabular-numbers"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-[var(--khata-text-muted)] mb-1">
                        Note / Mode (Optional)
                      </label>
                      <input
                        type="text"
                        value={paymentNote}
                        onChange={(e) => setPaymentNote(e.target.value)}
                        placeholder="e.g. Cash / UPI"
                        className="neu-input w-full text-sm font-medium"
                      />
                    </div>

                    <div>
                      <button
                        type="submit"
                        disabled={
                          isSubmittingPayment ||
                          safeDecimal(customerHistory.customer.outstanding).lessThanOrEqualTo(0) ||
                          !paymentAmount
                        }
                        className="neu-btn-primary w-full text-xs font-bold py-2.5"
                      >
                        {isSubmittingPayment ? 'Recording...' : 'Record Payment'}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Historical Udhar Transactions */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-[var(--khata-accent)]" />
                    <span>Historical Udhar Transactions</span>
                  </h4>

                  {customerHistory.transactions.length === 0 ? (
                    <p className="text-xs text-[var(--khata-text-muted)] p-4 rounded-xl text-center border border-[var(--khata-border)]">
                      No Udhar transactions recorded.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                      {customerHistory.transactions.map((tx) => {
                        const isExpanded = expandedTxIds.has(tx.id);
                        const isSettled = tx.isSettled ?? tx.is_fully_settled ?? false;
                        const txDate = tx.transactionDate || tx.transaction_date;
                        const txTotal = tx.totalAmount || tx.total_amount;
                        const txRemaining = tx.outstanding || tx.remaining_amount;

                        return (
                          <div
                            key={tx.id}
                            className="border border-[var(--khata-border)] rounded-xl overflow-hidden"
                            style={{ backgroundColor: 'var(--khata-surface-raised)' }}
                          >
                            <div
                              onClick={() => toggleExpandTx(tx.id)}
                              className="flex items-center justify-between p-3.5 hover:bg-[var(--khata-surface-inset)] cursor-pointer transition-colors"
                              tabIndex={0}
                              role="button"
                              aria-expanded={isExpanded}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  toggleExpandTx(tx.id);
                                }
                              }}
                            >
                              <div className="flex items-center gap-3">
                                {isExpanded ? (
                                  <ChevronUp className="w-4 h-4 text-[var(--khata-text-muted)]" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-[var(--khata-text-muted)]" />
                                )}
                                <div>
                                  <div className="text-xs font-bold text-[var(--khata-text)]">
                                    Tx #{tx.id} • {txDate}
                                  </div>
                                  {tx.note && (
                                    <div className="text-[11px] text-[var(--khata-text-muted)] italic">
                                      {tx.note}
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center gap-4 text-right">
                                <div>
                                  <span className="text-[10px] text-[var(--khata-text-muted)] uppercase font-semibold block">
                                    Total
                                  </span>
                                  <span className="text-xs font-bold text-[var(--khata-text)] tabular-numbers">
                                    {formatCurrency(txTotal)}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[10px] text-[var(--khata-text-muted)] uppercase font-semibold block">
                                    Remaining
                                  </span>
                                  <span
                                    className={`text-xs tabular-numbers font-bold ${
                                      isSettled ? 'text-[var(--khata-success)]' : 'text-[var(--khata-danger)]'
                                    }`}
                                  >
                                    {formatCurrency(txRemaining)}
                                  </span>
                                </div>
                                <span
                                  className={`neu-badge ${
                                    isSettled ? 'neu-badge-success' : 'neu-badge-danger'
                                  }`}
                                >
                                  {isSettled ? 'Settled' : 'Pending'}
                                </span>
                              </div>
                            </div>

                            {/* Expanded Item Lines */}
                            {isExpanded && (
                              <div
                                className="p-3 border-t border-[var(--khata-border)] space-y-2"
                                style={{ backgroundColor: 'var(--khata-surface-inset)' }}
                              >
                                <span className="text-[11px] font-bold text-[var(--khata-text-muted)] uppercase tracking-wider block">
                                  Purchased Items Snapshot
                                </span>
                                <table className="w-full text-xs text-left border-collapse">
                                  <thead>
                                    <tr className="text-[var(--khata-text-muted)] border-b border-[var(--khata-border)]">
                                      <th className="py-1">Product</th>
                                      <th className="py-1 text-right">Qty</th>
                                      <th className="py-1 text-right">Selling Price</th>
                                      <th className="py-1 text-right">Line Total</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-[var(--khata-border)]">
                                    {tx.items.map((item) => (
                                      <tr key={item.id}>
                                        <td className="py-1 font-medium text-[var(--khata-text)]">
                                          {item.product_name_snapshot}
                                        </td>
                                        <td className="py-1 text-right tabular-numbers text-[var(--khata-text-muted)]">
                                          {formatQuantity(item.quantity)}
                                        </td>
                                        <td className="py-1 text-right tabular-numbers text-[var(--khata-text-muted)]">
                                          {formatCurrency(item.selling_price)}
                                        </td>
                                        <td className="py-1 text-right tabular-numbers font-bold text-[var(--khata-text)]">
                                          {formatCurrency(item.line_total)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Payment History & FIFO Allocations */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-[var(--khata-success)]" />
                    <span>Payment History & FIFO Allocations</span>
                  </h4>

                  {customerHistory.payments.length === 0 ? (
                    <p className="text-xs text-[var(--khata-text-muted)] p-4 rounded-xl text-center border border-[var(--khata-border)]">
                      No payments recorded yet.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                      {customerHistory.payments.map((p) => {
                        const payDate = p.receivedAt || p.received_at || p.payment_date;
                        return (
                          <div
                            key={p.id}
                            className="p-3 rounded-xl border border-[var(--khata-border)] space-y-1.5"
                            style={{ backgroundColor: 'var(--khata-surface-raised)' }}
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="text-xs font-bold text-[var(--khata-text)]">
                                  Payment #{p.id} • {payDate}
                                </span>
                                {p.note && (
                                  <span className="text-xs text-[var(--khata-text-muted)] ml-2 italic">
                                    ({p.note})
                                  </span>
                                )}
                              </div>
                              <span className="text-xs font-bold text-[var(--khata-success)] tabular-numbers">
                                + {formatCurrency(p.amount)}
                              </span>
                            </div>

                            {/* Allocation details */}
                            {p.allocations && p.allocations.length > 0 && (
                              <div className="pt-1 border-t border-[var(--khata-border)] text-[11px] text-[var(--khata-text-muted)] space-y-0.5">
                                <span className="font-semibold block">FIFO Allocations:</span>
                                {p.allocations.map((alloc, aIdx) => {
                                  const allocTxId = alloc.transactionId || alloc.udhar_transaction_id;
                                  const allocAmt = alloc.amount || alloc.allocated_amount;
                                  return (
                                    <div key={alloc.id || aIdx} className="flex justify-between pl-2">
                                      <span>Allocated to Tx #{allocTxId}</span>
                                      <span className="tabular-numbers text-[var(--khata-success)] font-semibold">
                                        {formatCurrency(allocAmt)}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Modal Footer */}
                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveCustomerDetailId(null)}
                    className="neu-btn-secondary text-xs px-5 py-2 font-bold"
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
