import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
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
  Loader2,
} from 'lucide-react';
import Decimal from 'decimal.js';
import { formatCurrency, formatQuantity, safeDecimal, parseStrictDecimal, parseStrictInteger } from '../../lib/formatters.js';
import { SearchablePicker } from '../../components/SearchablePicker.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';

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
  lineId: string;
  productId: number | '';
  selectedProduct: ProductReference | null;
  quantity: string;
  sellingPrice: string;
}

function generateLineId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `line_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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
  const [customerPagination, setCustomerPagination] = useState<{
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
  }>({ limit: 25, offset: 0, hasMore: false, nextOffset: null });
  const [isLoadingCustomers, setIsLoadingCustomers] = useState(true);
  const [isLoadingMoreCustomers, setIsLoadingMoreCustomers] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 280);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // New Udhar Modal state
  const [isNewUdharOpen, setIsNewUdharOpen] = useState(false);
  const [udharIdempotencyKey, setUdharIdempotencyKey] = useState<string>('');
  const [selectedExistingCustomer, setSelectedExistingCustomer] = useState<CustomerListItem | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [udharLines, setUdharLines] = useState<UdharFormLine[]>([
    { lineId: generateLineId(), productId: '', selectedProduct: null, quantity: '1', sellingPrice: '' },
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

  // Fetch initial summary & customer ledger with server-side pagination (products fetched on-demand)
  const fetchSummary = async () => {
    try {
      const sumRes = await apiClient<{ success: boolean; summary?: SummaryData; data?: SummaryData }>(
        '/api/v1/khata/summary'
      );
      const sumData = sumRes.data.summary || sumRes.data.data || {
        totalCustomers: 0,
        totalOutstanding: '0.00',
        totalReceived: '0.00',
      };
      setSummary(sumData);
    } catch (err) {
      showNotification('error', (err as Error).message || 'Failed to load Khata summary.');
    }
  };

  const fetchCustomers = async (queryText: string, offset: number = 0, append: boolean = false) => {
    try {
      if (append) {
        setIsLoadingMoreCustomers(true);
      } else {
        setIsLoadingCustomers(true);
      }

      const res = await apiClient<{
        success: boolean;
        customers?: CustomerListItem[];
        data?: CustomerListItem[];
        pagination?: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
      }>(
        `/api/v1/khata/customers?search=${encodeURIComponent(queryText)}&limit=25&offset=${offset}`
      );

      const items = res.data.customers || res.data.data || [];
      const pagination = res.data.pagination || {
        limit: 25,
        offset,
        hasMore: false,
        nextOffset: null,
      };

      if (append) {
        setCustomers((prev) => [...prev, ...items]);
      } else {
        setCustomers(items);
      }
      setCustomerPagination(pagination);
    } catch (err) {
      showNotification('error', (err as Error).message || 'Failed to load customers.');
    } finally {
      setIsLoadingCustomers(false);
      setIsLoadingMoreCustomers(false);
    }
  };

  useEffect(() => {
    fetchSummary();
  }, []);

  useEffect(() => {
    fetchCustomers(debouncedSearch, 0, false);
  }, [debouncedSearch]);

  const handleLoadMoreCustomers = () => {
    if (customerPagination.hasMore && customerPagination.nextOffset !== null && !isLoadingMoreCustomers) {
      fetchCustomers(debouncedSearch, customerPagination.nextOffset, true);
    }
  };

  // Search fetchers for SearchablePicker components
  const handleSearchCustomerPicker = useCallback(
    async (queryText: string, offset: number, limit: number, signal: AbortSignal) => {
      const res = await apiClient<{
        success: boolean;
        customers?: CustomerListItem[];
        data?: CustomerListItem[];
        pagination?: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
      }>(
        `/api/v1/khata/customers?search=${encodeURIComponent(queryText)}&limit=${limit}&offset=${offset}`,
        { signal }
      );
      const items = res.data.customers || res.data.data || [];
      const hasMore = Boolean(res.data.pagination?.hasMore);
      const nextOffset = res.data.pagination?.nextOffset ?? (hasMore ? offset + items.length : null);
      return { items, hasMore, nextOffset };
    },
    []
  );

  const handleSearchProductPicker = useCallback(
    async (queryText: string, offset: number, limit: number, signal: AbortSignal) => {
      const res = await apiClient<{
        success: boolean;
        products?: ProductReference[];
        data?: ProductReference[];
        pagination?: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
      }>(
        `/api/v1/products?search=${encodeURIComponent(queryText)}&limit=${limit}&offset=${offset}`,
        { signal }
      );
      const items = res.data.products || res.data.data || [];
      const hasMore = Boolean(res.data.pagination?.hasMore);
      const nextOffset = res.data.pagination?.nextOffset ?? (hasMore ? offset + items.length : null);
      return { items, hasMore, nextOffset };
    },
    []
  );

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
      try {
        const q = parseStrictInteger(line.quantity);
        const p = parseStrictDecimal(line.sellingPrice, { maxDecimalPlaces: 2 });
        if (q > 0 && p.greaterThanOrEqualTo(0)) {
          return new Decimal(q).times(p).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        }
        return new Decimal(0);
      } catch {
        return new Decimal(0);
      }
    });
  }, [udharLines]);

  const calculatedTotalAmount = useMemo(() => {
    return lineCalculations.reduce((acc, curr) => acc.plus(curr), new Decimal(0));
  }, [lineCalculations]);

  const calculatedRemainingUdhar = useMemo(() => {
    const initPay = safeDecimal(initialPayment);
    return Decimal.max(0, calculatedTotalAmount.minus(initPay));
  }, [calculatedTotalAmount, initialPayment]);

  // Form row actions with stable lineId
  const handleAddLine = () => {
    setUdharLines((prev) => [
      ...prev,
      { lineId: generateLineId(), productId: '', selectedProduct: null, quantity: '1', sellingPrice: '' },
    ]);
  };

  const handleRemoveLine = (lineId: string) => {
    if (udharLines.length <= 1) return;
    setUdharLines((prev) => prev.filter((line) => line.lineId !== lineId));
  };

  const handleLineFieldChange = (
    lineId: string,
    field: 'quantity' | 'sellingPrice',
    value: string
  ) => {
    setUdharLines((prev) =>
      prev.map((line) => {
        if (line.lineId === lineId) {
          return { ...line, [field]: value };
        }
        return line;
      })
    );
  };

  const handleProductSelect = (lineId: string, product: ProductReference) => {
    setUdharLines((prev) =>
      prev.map((line) => {
        if (line.lineId === lineId) {
          return {
            ...line,
            productId: product.id,
            selectedProduct: product,
            // Keep sellingPrice intact — owner specifies custom selling price
          };
        }
        return line;
      })
    );
  };

  const handleProductClear = (lineId: string) => {
    setUdharLines((prev) =>
      prev.map((line) => {
        if (line.lineId === lineId) {
          return {
            ...line,
            productId: '',
            selectedProduct: null,
          };
        }
        return line;
      })
    );
  };

  const handleSelectCustomer = (customer: CustomerListItem) => {
    setSelectedExistingCustomer(customer);
    setNewCustomerName('');
    setNewCustomerPhone('');
  };

  const handleClearCustomer = () => {
    setSelectedExistingCustomer(null);
  };

  const handleCreateCustomerFromPicker = (queryName: string) => {
    setSelectedExistingCustomer(null);
    setNewCustomerName(queryName);
  };

  // Submit New Udhar
  const handleSubmitNewUdhar = async (e: React.FormEvent) => {
    e.preventDefault();
    setUdharFormError(null);

    // Validate customer
    let customerPayload: { id: number | null; name: string; phone: string | null };
    if (selectedExistingCustomer) {
      customerPayload = {
        id: selectedExistingCustomer.id,
        name: selectedExistingCustomer.name,
        phone: selectedExistingCustomer.phone,
      };
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

    // Validate items strictly with parseStrictDecimal
    const validatedItems: { productId: number; quantity: number; sellingPrice: number }[] = [];
    for (let i = 0; i < udharLines.length; i++) {
      const line = udharLines[i];
      if (!line.productId) {
        setUdharFormError(`Please select a reference product for item line #${i + 1}.`);
        return;
      }
      try {
        const qty = parseStrictInteger(line.quantity, { fieldName: `Line #${i + 1} quantity` });
        if (qty < 1 || qty > 1000000) {
          setUdharFormError(`Line #${i + 1} quantity must be a whole number between 1 and 1,000,000.`);
          return;
        }
        const priceDec = parseStrictDecimal(line.sellingPrice, {
          maxDecimalPlaces: 2,
          fieldName: `Line #${i + 1} selling price`,
        });
        if (priceDec.lessThan(0)) {
          setUdharFormError(`Line #${i + 1} selling price cannot be negative.`);
          return;
        }
        validatedItems.push({
          productId: Number(line.productId),
          quantity: qty,
          sellingPrice: priceDec.toNumber(),
        });
      } catch (valErr) {
        setUdharFormError((valErr as Error).message);
        return;
      }
    }

    if (validatedItems.length === 0) {
      setUdharFormError('At least one product item is required.');
      return;
    }

    let initPaymentDec = new Decimal(0);
    if (initialPayment && initialPayment.trim()) {
      try {
        initPaymentDec = parseStrictDecimal(initialPayment, {
          maxDecimalPlaces: 2,
          fieldName: 'Initial payment',
        });
      } catch (valErr) {
        setUdharFormError((valErr as Error).message);
        return;
      }
    }

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
      setSelectedExistingCustomer(null);
      setNewCustomerName('');
      setNewCustomerPhone('');
      setUdharLines([
        { lineId: generateLineId(), productId: '', selectedProduct: null, quantity: '1', sellingPrice: '' },
      ]);
      setInitialPayment('');
      setTransactionNote('');

      showNotification('success', 'Udhar transaction recorded successfully.');
      await Promise.all([fetchSummary(), fetchCustomers(debouncedSearch, 0, false)]);

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

    let payDec: Decimal;
    try {
      payDec = parseStrictDecimal(paymentAmount, { maxDecimalPlaces: 2, fieldName: 'Payment amount' });
    } catch (valErr) {
      setPaymentError((valErr as Error).message);
      return;
    }

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
      await Promise.all([
        fetchCustomerHistory(activeCustomerDetailId),
        fetchSummary(),
        fetchCustomers(debouncedSearch, 0, false),
      ]);
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
      <div className="relative flex items-center">
        <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-3.5 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer by name or phone..."
          className="neu-input neu-input-with-leading-icon w-full text-sm font-medium"
        />
      </div>

      {/* Customer List Card */}
      <div className="neu-card overflow-hidden">
        {isLoadingCustomers ? (
          <div className="p-8 text-center text-sm text-[var(--khata-text-muted)] font-medium flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
            <span>Loading Khata ledger...</span>
          </div>
        ) : customers.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--khata-text-muted)]">
            {search
              ? 'No customers found matching search.'
              : 'No Udhar customers yet. Click "New Udhar" above to record customer credit.'}
          </div>
        ) : (
          <div>
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
                  {customers.map((c) => {
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

            {/* Bounded pagination "Load more" button for ledger customers */}
            {customerPagination.hasMore && (
              <div className="p-3 text-center border-t border-[var(--khata-border)] bg-[var(--khata-surface)]">
                <button
                  type="button"
                  onClick={handleLoadMoreCustomers}
                  disabled={isLoadingMoreCustomers}
                  className="neu-btn-secondary text-xs px-5 py-2 font-bold inline-flex items-center gap-1.5 min-h-[38px]"
                >
                  {isLoadingMoreCustomers ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
                      <span>Loading more customers...</span>
                    </>
                  ) : (
                    <span>Load More Customers</span>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ==============================================================================
          NEW UDHAR MODAL
          ============================================================================== */}
      {isNewUdharOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-udhar-title"
        >
          <div
            className="neu-card max-w-2xl w-full p-4 sm:p-6 my-4 sm:my-8 max-h-[90vh] flex flex-col space-y-4"
            style={{ backgroundColor: 'var(--khata-surface)' }}
          >
            <div className="flex items-start justify-between pb-3 border-b border-[var(--khata-border)] flex-shrink-0">
              <div className="min-w-0 flex-1 pr-2">
                <h3 id="new-udhar-title" className="text-base sm:text-lg font-bold text-[var(--khata-text)]">
                  Record New Udhar Transaction
                </h3>
                <p className="text-xs text-[var(--khata-text-muted)] mt-0.5">
                  Select an existing customer or enter a new customer. Add product items with custom selling prices.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsNewUdharOpen(false)}
                className="p-2 rounded-xl text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] min-h-[44px] min-w-[44px] flex items-center justify-center -mr-1 -mt-1 flex-shrink-0 transition"
                aria-label="Close new udhar modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {udharFormError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 text-[var(--khata-danger)] text-xs rounded-xl font-medium flex-shrink-0">
                {udharFormError}
              </div>
            )}

            <form onSubmit={handleSubmitNewUdhar} className="overflow-y-auto pr-1 flex-1 space-y-4">
              {/* Customer Selector / Creator */}
              <div
                className="p-4 rounded-xl border border-[var(--khata-border)] space-y-3"
                style={{ backgroundColor: 'var(--khata-surface-raised)' }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider block">
                    Customer Identification
                  </span>
                  {selectedExistingCustomer && (
                    <span className="text-[11px] font-semibold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                      Existing Customer Selected
                    </span>
                  )}
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-[var(--khata-text)] mb-1">
                      Existing Customer (Searchable)
                    </label>
                    <SearchablePicker<CustomerListItem>
                      mode="customer"
                      value={selectedExistingCustomer?.id || ''}
                      selectedOption={selectedExistingCustomer}
                      placeholder="Search existing customer by name or phone..."
                      searchPlaceholder="Type customer name or mobile number..."
                      onSearch={handleSearchCustomerPicker}
                      onSelect={handleSelectCustomer}
                      onClear={handleClearCustomer}
                      getOptionKey={(c) => c.id}
                      getOptionLabel={(c) =>
                        `${c.name}${c.phone ? ` (${c.phone})` : ''} — Due: ${formatCurrency(c.outstanding)}`
                      }
                      renderOption={(c) => (
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 w-full">
                          <div>
                            <span className="font-semibold text-[var(--khata-text)]">{c.name}</span>
                            {c.phone && (
                              <span className="text-xs text-[var(--khata-text-muted)] ml-2 font-mono">
                                {c.phone}
                              </span>
                            )}
                          </div>
                          <span className="text-xs font-bold text-[var(--khata-danger)] tabular-numbers">
                            Due: {formatCurrency(c.outstanding)}
                          </span>
                        </div>
                      )}
                      onCreateNew={handleCreateCustomerFromPicker}
                      emptyMessage="No customer found with that name or phone."
                    />
                  </div>

                  {selectedExistingCustomer ? (
                    <div
                      className="p-3 rounded-xl border border-[var(--khata-accent)]/30 flex items-center justify-between"
                      style={{ backgroundColor: 'var(--khata-surface-inset)' }}
                    >
                      <div>
                        <div className="text-xs font-bold text-[var(--khata-text)]">
                          {selectedExistingCustomer.name}
                        </div>
                        <div className="text-[11px] text-[var(--khata-text-muted)]">
                          {selectedExistingCustomer.phone ? `Phone: ${selectedExistingCustomer.phone} • ` : ''}
                          Current Outstanding:{' '}
                          <span className="font-bold text-[var(--khata-danger)]">
                            {formatCurrency(selectedExistingCustomer.outstanding)}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleClearCustomer}
                        className="text-xs text-rose-500 hover:underline font-semibold"
                      >
                        Change / Clear
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      <div>
                        <label className="block text-xs font-semibold text-[var(--khata-text)] mb-1">
                          New Customer Name <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="text"
                          required={!selectedExistingCustomer}
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
                    </div>
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
                      key={line.lineId}
                      className="grid grid-cols-12 gap-2.5 items-start p-3.5 rounded-xl border border-[var(--khata-border)] shadow-sm"
                      style={{ backgroundColor: 'var(--khata-surface-raised)' }}
                    >
                      {/* Product Selector with SearchablePicker */}
                      <div className="col-span-12 sm:col-span-5">
                        <label className="block text-[11px] font-semibold text-[var(--khata-text-muted)] mb-1">
                          Product #{idx + 1}
                        </label>
                        <SearchablePicker<ProductReference>
                          mode="product"
                          value={line.productId}
                          selectedOption={line.selectedProduct}
                          placeholder="Search reference product..."
                          searchPlaceholder="Type product name to search..."
                          onSearch={handleSearchProductPicker}
                          onSelect={(prod) => handleProductSelect(line.lineId, prod)}
                          onClear={() => handleProductClear(line.lineId)}
                          getOptionKey={(p) => p.id}
                          getOptionLabel={(p) => `${p.name} (Ref: ${formatCurrency(p.buying_price)})`}
                          renderOption={(p) => (
                            <div className="flex items-center justify-between gap-2 w-full">
                              <span className="font-semibold text-[var(--khata-text)]">{p.name}</span>
                              <span className="text-[11px] text-[var(--khata-text-muted)] font-mono">
                                Ref: {formatCurrency(p.buying_price)}
                              </span>
                            </div>
                          )}
                          emptyMessage="No product found in catalogue."
                          required
                        />
                        {line.selectedProduct && (
                          <div className="text-[11px] text-[var(--khata-text-muted)] mt-1 flex items-center gap-1">
                            <span>Ref buying price:</span>
                            <span className="font-semibold text-[var(--khata-text)] font-mono">
                              {formatCurrency(line.selectedProduct.buying_price)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Quantity (Strict Integer) */}
                      <div className="col-span-6 sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-[var(--khata-text-muted)] mb-1">
                          Quantity
                        </label>
                        <input
                          type="number"
                          step="1"
                          min="1"
                          max="1000000"
                          inputMode="numeric"
                          required
                          value={line.quantity}
                          onChange={(e) => handleLineFieldChange(line.lineId, 'quantity', e.target.value)}
                          placeholder="Qty"
                          className="neu-input w-full text-sm font-medium tabular-numbers min-h-[44px]"
                        />
                      </div>

                      {/* Custom Selling Price */}
                      <div className="col-span-6 sm:col-span-3">
                        <label className="block text-[11px] font-semibold text-[var(--khata-text-muted)] mb-1">
                          Custom Selling ₹
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          required
                          value={line.sellingPrice}
                          onChange={(e) => handleLineFieldChange(line.lineId, 'sellingPrice', e.target.value)}
                          placeholder="Selling ₹"
                          className="neu-input w-full text-sm font-medium tabular-numbers min-h-[44px]"
                        />
                      </div>

                      {/* Line Total & Remove */}
                      <div className="col-span-12 sm:col-span-2 flex items-center justify-between sm:justify-end gap-2 pt-2 sm:pt-6 border-t sm:border-t-0 border-[var(--khata-border)]/50">
                        <div className="sm:hidden text-xs text-[var(--khata-text-muted)] font-medium">Line Total:</div>
                        <span className="text-xs font-bold text-[var(--khata-text)] tabular-numbers">
                          {formatCurrency(lineCalculations[idx])}
                        </span>
                        {udharLines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveLine(line.lineId)}
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
              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 pt-3 border-t border-[var(--khata-border)] flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setIsNewUdharOpen(false)}
                  className="neu-btn-secondary text-xs px-4 py-2.5 min-h-[44px] w-full sm:w-auto font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingUdhar || calculatedTotalAmount.lessThanOrEqualTo(0)}
                  className="neu-btn-primary text-xs px-5 py-2.5 font-bold min-h-[44px] w-full sm:w-auto"
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
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="customer-detail-title"
        >
          <div
            className="neu-card max-w-3xl w-full p-4 sm:p-6 my-4 sm:my-8 max-h-[90vh] flex flex-col space-y-4"
            style={{ backgroundColor: 'var(--khata-surface)' }}
          >
            {isLoadingHistory || !customerHistory ? (
              <div className="p-12 text-center text-sm text-[var(--khata-text-muted)] font-medium">
                Loading customer ledger...
              </div>
            ) : (
              <>
                {/* Responsive Customer Header: Name + status on left, close button on top-right */}
                <div className="flex items-start justify-between gap-3 pb-3 border-b border-[var(--khata-border)] flex-shrink-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 id="customer-detail-title" className="text-lg sm:text-xl font-bold text-[var(--khata-text)] truncate">
                        {customerHistory.customer.name}
                      </h3>
                      <span
                        className={`neu-badge flex-shrink-0 ${
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

                  <button
                    type="button"
                    onClick={() => setActiveCustomerDetailId(null)}
                    className="p-2 rounded-xl text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] transition min-h-[44px] min-w-[44px] flex items-center justify-center -mr-1 -mt-1 flex-shrink-0"
                    aria-label="Close"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Single predictable scroll container for the modal body */}
                <div className="overflow-y-auto pr-1 flex-1 space-y-4 sm:space-y-5">
                  {/* Financial Summary Grid (3 responsive cards) */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="neu-card p-3.5 border border-[var(--khata-border)]" style={{ backgroundColor: 'var(--khata-surface-raised)' }}>
                      <span className="text-[11px] text-[var(--khata-text-muted)] uppercase font-semibold block">
                        Lifetime Udhar
                      </span>
                      <span className="font-bold text-[var(--khata-text)] text-base sm:text-lg tabular-numbers mt-0.5 block">
                        {formatCurrency(customerHistory.customer.totalUdhar)}
                      </span>
                    </div>

                    <div className="neu-card p-3.5 border border-[var(--khata-border)]" style={{ backgroundColor: 'var(--khata-surface-raised)' }}>
                      <span className="text-[11px] text-[var(--khata-text-muted)] uppercase font-semibold block">
                        Total Received
                      </span>
                      <span className="font-bold text-[var(--khata-success)] text-base sm:text-lg tabular-numbers mt-0.5 block">
                        {formatCurrency(customerHistory.customer.totalReceived)}
                      </span>
                    </div>

                    <div className="neu-card p-3.5 border-2 border-[var(--khata-danger)]/40" style={{ backgroundColor: 'var(--khata-surface-raised)' }}>
                      <span className="text-[11px] text-[var(--khata-danger)] uppercase font-bold block">
                        Net Balance Due
                      </span>
                      <span className="font-black text-[var(--khata-danger)] text-lg sm:text-xl tabular-numbers mt-0.5 block">
                        {formatCurrency(customerHistory.customer.outstanding)}
                      </span>
                    </div>
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
                          className="neu-btn-primary w-full text-xs font-bold py-2.5 min-h-[42px]"
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
                      <div className="space-y-2">
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
                                className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3.5 hover:bg-[var(--khata-surface-inset)] cursor-pointer transition-colors gap-2"
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
                                <div className="flex items-center gap-2.5">
                                  {isExpanded ? (
                                    <ChevronUp className="w-4 h-4 text-[var(--khata-text-muted)] flex-shrink-0" />
                                  ) : (
                                    <ChevronDown className="w-4 h-4 text-[var(--khata-text-muted)] flex-shrink-0" />
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

                                <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4 text-right pt-1 sm:pt-0 border-t sm:border-t-0 border-[var(--khata-border)]/40">
                                  <div>
                                    <span className="text-[10px] text-[var(--khata-text-muted)] uppercase font-semibold block sm:inline mr-1">
                                      Total:
                                    </span>
                                    <span className="text-xs font-bold text-[var(--khata-text)] tabular-numbers">
                                      {formatCurrency(txTotal)}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-[10px] text-[var(--khata-text-muted)] uppercase font-semibold block sm:inline mr-1">
                                      Due:
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
                                    className={`neu-badge flex-shrink-0 ${
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
                                  className="p-3 border-t border-[var(--khata-border)] space-y-2 overflow-x-auto"
                                  style={{ backgroundColor: 'var(--khata-surface-inset)' }}
                                >
                                  <span className="text-[11px] font-bold text-[var(--khata-text-muted)] uppercase tracking-wider block">
                                    Purchased Items Snapshot
                                  </span>
                                  <table className="w-full text-xs text-left border-collapse min-w-[320px]">
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
                      <div className="space-y-2">
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
                </div>

                {/* Fixed Modal Footer */}
                <div className="flex justify-end pt-3 border-t border-[var(--khata-border)] flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setActiveCustomerDetailId(null)}
                    className="neu-btn-secondary text-xs px-5 py-2.5 font-bold min-h-[44px] w-full sm:w-auto"
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
