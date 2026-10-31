import React, { useEffect, useState, useMemo } from 'react';
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
  Trash2
} from 'lucide-react';

interface SummaryData {
  totalCustomers: number;
  totalOutstanding: number;
  totalReceived: number;
}

interface CustomerListItem {
  id: number;
  name: string;
  phone: string | null;
  totalUdhar: number;
  totalReceived: number;
  outstanding: number;
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
  transaction_date: string;
  total_amount: string;
  settled_amount: string;
  remaining_amount: string;
  is_fully_settled: boolean;
  note: string | null;
  created_at: string;
  items: UdharItemDetail[];
}

interface PaymentAllocationDetail {
  id: number;
  udhar_transaction_id: number;
  allocated_amount: string;
  transaction_date: string;
  total_amount: string;
}

interface PaymentRecordDetail {
  id: number;
  amount: string;
  payment_date: string;
  note: string | null;
  created_at: string;
  allocations: PaymentAllocationDetail[];
}

interface CustomerHistoryData {
  customer: {
    id: number;
    name: string;
    phone: string | null;
    totalUdhar: number;
    totalReceived: number;
    outstanding: number;
  };
  transactions: UdharTransactionDetail[];
  payments: PaymentRecordDetail[];
}

interface UdharFormLine {
  productId: number | '';
  quantity: string;
  sellingPrice: string;
}

export const KhataLedgerView: React.FC = () => {
  // Global state
  const [summary, setSummary] = useState<SummaryData>({
    totalCustomers: 0,
    totalOutstanding: 0,
    totalReceived: 0,
  });
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [activeProducts, setActiveProducts] = useState<ProductReference[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // New Udhar Modal state
  const [isNewUdharOpen, setIsNewUdharOpen] = useState(false);
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
  const [activeCustomerDetailId, setActiveCustomerDetailId] = useState<number | null>(null);
  const [customerHistory, setCustomerHistory] = useState<CustomerHistoryData | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [expandedTxIds, setExpandedTxIds] = useState<Set<number>>(new Set());

  // Record Payment Modal/State within Customer Detail
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [paymentError, setPaymentError] = useState<string | null>(null);
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
        apiClient<{ success: boolean; summary: SummaryData }>('/api/v1/khata/summary'),
        apiClient<{ success: boolean; customers: CustomerListItem[] }>('/api/v1/khata/customers'),
        apiClient<{ success: boolean; data: ProductReference[] }>('/api/v1/products'),
      ]);

      setSummary(sumRes.data.summary);
      setCustomers(custRes.data.customers || []);
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

  // Fetch individual customer history when detail modal is opened
  const fetchCustomerHistory = async (customerId: number) => {
    try {
      setIsLoadingHistory(true);
      const res = await apiClient<{ success: boolean; data: CustomerHistoryData }>(
        `/api/v1/khata/customers/${customerId}/history`
      );
      setCustomerHistory(res.data.data);
    } catch (err) {
      showNotification('error', (err as Error).message || 'Failed to load customer history.');
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleOpenCustomerDetail = (customerId: number) => {
    setActiveCustomerDetailId(customerId);
    setPaymentAmount('');
    setPaymentNote('');
    setPaymentError(null);
    setExpandedTxIds(new Set());
    fetchCustomerHistory(customerId);
  };

  // Live calculations for New Udhar Form
  const lineCalculations = useMemo(() => {
    return udharLines.map((line) => {
      const q = parseFloat(line.quantity);
      const p = parseFloat(line.sellingPrice);
      if (!isNaN(q) && q > 0 && !isNaN(p) && p >= 0) {
        return Math.round(q * p * 100) / 100;
      }
      return 0;
    });
  }, [udharLines]);

  const calculatedTotalAmount = useMemo(() => {
    const sum = lineCalculations.reduce((acc, curr) => acc + curr, 0);
    return Math.round(sum * 100) / 100;
  }, [lineCalculations]);

  const calculatedRemainingUdhar = useMemo(() => {
    const initPay = parseFloat(initialPayment) || 0;
    const diff = calculatedTotalAmount - initPay;
    return Math.max(0, Math.round(diff * 100) / 100);
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
      const qty = parseFloat(line.quantity);
      if (isNaN(qty) || qty <= 0) {
        setUdharFormError(`Line #${i + 1} has an invalid quantity.`);
        return;
      }
      const price = parseFloat(line.sellingPrice);
      if (isNaN(price) || price < 0) {
        setUdharFormError(`Line #${i + 1} has an invalid selling price.`);
        return;
      }
      validatedItems.push({
        productId: Number(line.productId),
        quantity: qty,
        sellingPrice: price,
      });
    }

    if (validatedItems.length === 0) {
      setUdharFormError('At least one product item is required.');
      return;
    }

    const initPaymentVal = initialPayment ? parseFloat(initialPayment) : 0;
    if (isNaN(initPaymentVal) || initPaymentVal < 0) {
      setUdharFormError('Initial payment must be a non-negative number.');
      return;
    }

    if (initPaymentVal > calculatedTotalAmount) {
      setUdharFormError('Initial payment cannot exceed the total transaction amount.');
      return;
    }

    setIsSubmittingUdhar(true);

    try {
      const res = await apiClient<{ success: boolean; data: { transactionId: number; customerId: number } }>(
        '/api/v1/khata/transactions',
        {
          method: 'POST',
          body: JSON.stringify({
            customer: customerPayload,
            items: validatedItems,
            initialPayment: initPaymentVal > 0 ? initPaymentVal : null,
            note: transactionNote.trim() || null,
          }),
        }
      );

      setIsNewUdharOpen(false);
      // Reset form
      setSelectedExistingCustomerId('');
      setNewCustomerName('');
      setNewCustomerPhone('');
      setUdharLines([{ productId: '', quantity: '1', sellingPrice: '' }]);
      setInitialPayment('');
      setTransactionNote('');

      showNotification('success', 'Udhar transaction created successfully.');
      await fetchOverviewData();

      // Open detail of the customer
      if (res.data?.data?.customerId) {
        handleOpenCustomerDetail(res.data.data.customerId);
      }
    } catch (err) {
      setUdharFormError((err as Error).message || 'Failed to create Udhar transaction.');
    } finally {
      setIsSubmittingUdhar(false);
    }
  };

  // Submit Payment for active customer
  const handleSubmitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCustomerDetailId || !customerHistory) return;

    const amountNum = parseFloat(paymentAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setPaymentError('Payment amount must be greater than zero.');
      return;
    }

    if (amountNum > customerHistory.customer.outstanding) {
      setPaymentError(
        `Payment amount (₹${amountNum.toFixed(2)}) exceeds customer total outstanding balance of ₹${customerHistory.customer.outstanding.toFixed(2)}.`
      );
      return;
    }

    setPaymentError(null);
    setIsSubmittingPayment(true);

    try {
      await apiClient(`/api/v1/khata/customers/${activeCustomerDetailId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: amountNum,
          note: paymentNote.trim() || null,
        }),
      });

      setPaymentAmount('');
      setPaymentNote('');
      showNotification('success', `Payment of ₹${amountNum.toFixed(2)} recorded and allocated.`);
      // Refetch history and global summary
      await Promise.all([fetchCustomerHistory(activeCustomerDetailId), fetchOverviewData()]);
    } catch (err) {
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
          className={`flex items-center justify-between p-4 rounded-xl text-sm font-semibold transition ${
            notification.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-rose-50 text-rose-800 border border-rose-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            ) : (
              <AlertCircle className="w-5 h-5 text-rose-600" />
            )}
            <span>{notification.message}</span>
          </div>
          <button
            onClick={() => setNotification(null)}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Overview KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Total Outstanding */}
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Total Amount to Receive
            </span>
            <div className="w-8 h-8 rounded-full bg-rose-50 flex items-center justify-center text-rose-600">
              <ArrowUpRight className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-black text-rose-600 font-mono">
            ₹{summary.totalOutstanding.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-slate-400 mt-1">Current uncollected Udhar balance</p>
        </div>

        {/* Total Received */}
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Payments Collected (All Time)
            </span>
            <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600">
              <ArrowDownLeft className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-black text-emerald-600 font-mono">
            ₹{summary.totalReceived.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-slate-400 mt-1">Total credit successfully settled</p>
        </div>

        {/* Total Customers */}
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Total Udhar Customers
            </span>
            <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-black text-slate-900 font-mono">
            {summary.totalCustomers}
          </p>
          <p className="text-xs text-slate-400 mt-1">Distinct customers in ledger</p>
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-indigo-600" />
            <span>Customer Khata</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Track multi-item credit transactions, custom selling prices, and deterministic payment settlements.
          </p>
        </div>

        <button
          onClick={() => {
            setIsNewUdharOpen(true);
            setUdharFormError(null);
          }}
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>New Udhar</span>
        </button>
      </div>

      {/* Customer Search Bar */}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer by name or phone..."
          className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 shadow-sm"
        />
      </div>

      {/* Customer List Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-slate-400">Loading Khata ledger...</div>
        ) : filteredCustomers.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            {search
              ? 'No customers found matching search.'
              : 'No Udhar customers yet. Click "New Udhar" above to record customer credit.'}
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
                <th className="py-3 px-4">Customer</th>
                <th className="py-3 px-4 text-right">Total Udhar</th>
                <th className="py-3 px-4 text-right">Total Received</th>
                <th className="py-3 px-4 text-right">Outstanding Balance</th>
                <th className="py-3 px-4 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredCustomers.map((c) => {
                const isSettled = c.outstanding <= 0;
                return (
                  <tr
                    key={c.id}
                    onClick={() => handleOpenCustomerDetail(c.id)}
                    className="hover:bg-indigo-50/50 cursor-pointer transition"
                  >
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900">{c.name}</div>
                      {c.phone && <div className="text-xs text-slate-400 font-mono">{c.phone}</div>}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-700">
                      ₹{c.totalUdhar.toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-emerald-600">
                      ₹{c.totalReceived.toFixed(2)}
                    </td>
                    <td
                      className={`py-3 px-4 text-right font-mono font-bold ${
                        isSettled ? 'text-slate-400' : 'text-rose-600'
                      }`}
                    >
                      ₹{c.outstanding.toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${
                          isSettled
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-rose-100 text-rose-800'
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
        )}
      </div>

      {/* NEW UDHAR MODAL */}
      {isNewUdharOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-6 my-8 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Record New Udhar Transaction</h3>
                <p className="text-xs text-slate-500">
                  Select an existing customer or enter a new customer name. Add one or more product lines with custom selling prices.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsNewUdharOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {udharFormError && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl font-medium">
                {udharFormError}
              </div>
            )}

            <form onSubmit={handleSubmitNewUdhar} className="space-y-5">
              {/* Customer Selector / Creator */}
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                <span className="text-xs font-bold text-slate-600 uppercase tracking-wider block">
                  Customer Information
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
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
                      className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                    >
                      <option value="">-- Or enter new customer below --</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.phone ? `(${c.phone})` : ''} — Bal: ₹{c.outstanding.toFixed(2)}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!selectedExistingCustomerId && (
                    <>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          New Customer Name <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="text"
                          required={!selectedExistingCustomerId}
                          value={newCustomerName}
                          onChange={(e) => setNewCustomerName(e.target.value)}
                          placeholder="e.g. Ramesh Kumar"
                          className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          Mobile Number (Optional)
                        </label>
                        <input
                          type="tel"
                          value={newCustomerPhone}
                          onChange={(e) => setNewCustomerPhone(e.target.value)}
                          placeholder="e.g. 9876543210"
                          className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Multi-line Products */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">
                    Product Items
                  </span>
                  <button
                    type="button"
                    onClick={handleAddLine}
                    className="inline-flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-lg transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Item</span>
                  </button>
                </div>

                <div className="space-y-2">
                  {udharLines.map((line, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-12 gap-2 items-center bg-slate-50/70 p-3 rounded-xl border border-slate-200"
                    >
                      {/* Product Selector */}
                      <div className="col-span-12 sm:col-span-5">
                        <label className="block text-[11px] font-semibold text-slate-500 mb-0.5">
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
                          className="w-full px-2.5 py-1.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                        >
                          <option value="">Select Product...</option>
                          {activeProducts.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} (Ref: ₹{parseFloat(p.buying_price).toFixed(2)})
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Quantity */}
                      <div className="col-span-5 sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-500 mb-0.5">
                          Quantity
                        </label>
                        <input
                          type="number"
                          step="any"
                          min="0.01"
                          required
                          value={line.quantity}
                          onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)}
                          placeholder="Qty"
                          className="w-full px-2.5 py-1.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                        />
                      </div>

                      {/* Selling Price */}
                      <div className="col-span-5 sm:col-span-3">
                        <label className="block text-[11px] font-semibold text-slate-500 mb-0.5">
                          Selling Price (₹)
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          required
                          value={line.sellingPrice}
                          onChange={(e) => handleLineChange(idx, 'sellingPrice', e.target.value)}
                          placeholder="Selling ₹"
                          className="w-full px-2.5 py-1.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                        />
                      </div>

                      {/* Line Total & Remove */}
                      <div className="col-span-2 sm:col-span-2 flex items-center justify-end gap-2 pt-4">
                        <span className="text-xs font-mono font-bold text-slate-800">
                          ₹{lineCalculations[idx].toFixed(2)}
                        </span>
                        {udharLines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveLine(idx)}
                            className="text-slate-400 hover:text-rose-600 transition"
                            title="Remove line"
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Initial Payment Received (₹) (Optional)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max={calculatedTotalAmount}
                    value={initialPayment}
                    onChange={(e) => setInitialPayment(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                  />
                  <span className="text-[11px] text-slate-400 mt-0.5 block">
                    Cash received at purchase time
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Transaction Note (Optional)
                  </label>
                  <input
                    type="text"
                    value={transactionNote}
                    onChange={(e) => setTransactionNote(e.target.value)}
                    placeholder="e.g. Bathroom fitting items"
                    className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
                  />
                </div>
              </div>

              {/* Live Preview Summary Box */}
              <div className="bg-indigo-50/70 p-4 rounded-xl border border-indigo-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-sm">
                <div>
                  <span className="text-xs text-indigo-950 font-bold block">Live Calculation Preview</span>
                  <span className="text-xs text-indigo-700">
                    Calculated by client preview; backend computes authoritative final totals.
                  </span>
                </div>
                <div className="flex items-center gap-6 text-right">
                  <div>
                    <span className="text-[11px] text-slate-500 uppercase block font-semibold">Total</span>
                    <span className="font-mono font-bold text-slate-900 text-base">
                      ₹{calculatedTotalAmount.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[11px] text-rose-600 uppercase block font-bold">New Udhar Due</span>
                    <span className="font-mono font-black text-rose-600 text-lg">
                      ₹{calculatedRemainingUdhar.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Form Buttons */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsNewUdharOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingUdhar || calculatedTotalAmount <= 0}
                  className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold px-5 py-2.5 rounded-xl shadow transition"
                >
                  {isSubmittingUdhar ? 'Recording Udhar...' : 'Save Udhar Transaction'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CUSTOMER DETAIL & HISTORY MODAL */}
      {activeCustomerDetailId && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-3xl w-full p-6 my-8 space-y-6">
            {isLoadingHistory || !customerHistory ? (
              <div className="p-12 text-center text-sm text-slate-400">Loading customer ledger...</div>
            ) : (
              <>
                {/* Customer Header */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-xl font-bold text-slate-900">
                        {customerHistory.customer.name}
                      </h3>
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${
                          customerHistory.customer.outstanding <= 0
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-rose-100 text-rose-800'
                        }`}
                      >
                        {customerHistory.customer.outstanding <= 0 ? 'Settled' : 'Outstanding'}
                      </span>
                    </div>
                    {customerHistory.customer.phone && (
                      <p className="text-xs text-slate-500 font-mono mt-0.5">
                        {customerHistory.customer.phone}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-4 text-right">
                    <div>
                      <span className="text-[11px] text-slate-400 uppercase font-semibold block">Total Udhar</span>
                      <span className="font-mono font-bold text-slate-800">
                        ₹{customerHistory.customer.totalUdhar.toFixed(2)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-slate-400 uppercase font-semibold block">Total Received</span>
                      <span className="font-mono font-bold text-emerald-600">
                        ₹{customerHistory.customer.totalReceived.toFixed(2)}
                      </span>
                    </div>
                    <div className="bg-rose-50 px-3 py-1.5 rounded-xl border border-rose-100">
                      <span className="text-[11px] text-rose-600 uppercase font-bold block">Balance Due</span>
                      <span className="font-mono font-black text-rose-600 text-base">
                        ₹{customerHistory.customer.outstanding.toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveCustomerDetailId(null)}
                    className="text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Record Payment Section */}
                <div className="bg-emerald-50/60 border border-emerald-200/70 p-4 rounded-xl space-y-3">
                  <div className="flex items-center gap-2 text-emerald-900 font-bold text-sm">
                    <DollarSign className="w-4 h-4 text-emerald-600" />
                    <span>Record Payment Received</span>
                  </div>

                  {paymentError && (
                    <div className="p-2.5 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg font-medium">
                      {paymentError}
                    </div>
                  )}

                  <form onSubmit={handleSubmitPayment} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Payment Amount (₹) <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        max={customerHistory.customer.outstanding}
                        required
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        placeholder={`Max ₹${customerHistory.customer.outstanding.toFixed(2)}`}
                        className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Note / Mode (Optional)
                      </label>
                      <input
                        type="text"
                        value={paymentNote}
                        onChange={(e) => setPaymentNote(e.target.value)}
                        placeholder="e.g. Cash / UPI"
                        className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600"
                      />
                    </div>

                    <div>
                      <button
                        type="submit"
                        disabled={
                          isSubmittingPayment ||
                          customerHistory.customer.outstanding <= 0 ||
                          !paymentAmount
                        }
                        className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold py-2.5 rounded-xl shadow transition"
                      >
                        {isSubmittingPayment ? 'Recording...' : 'Record Payment'}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Section: Historical Udhar Transactions */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-indigo-600" />
                    <span>Historical Udhar Transactions</span>
                  </h4>

                  {customerHistory.transactions.length === 0 ? (
                    <p className="text-xs text-slate-400 p-4 bg-slate-50 rounded-xl text-center">
                      No Udhar transactions recorded.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {customerHistory.transactions.map((tx) => {
                        const isExpanded = expandedTxIds.has(tx.id);
                        const isSettled = tx.is_fully_settled;
                        return (
                          <div
                            key={tx.id}
                            className="border border-slate-200 rounded-xl overflow-hidden bg-white"
                          >
                            <div
                              onClick={() => toggleExpandTx(tx.id)}
                              className="flex items-center justify-between p-3.5 hover:bg-slate-50 cursor-pointer transition"
                            >
                              <div className="flex items-center gap-3">
                                {isExpanded ? (
                                  <ChevronUp className="w-4 h-4 text-slate-400" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-slate-400" />
                                )}
                                <div>
                                  <div className="text-xs font-bold text-slate-800">
                                    Tx #{tx.id} • {tx.transaction_date}
                                  </div>
                                  {tx.note && (
                                    <div className="text-[11px] text-slate-400 italic">
                                      {tx.note}
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center gap-4 text-right">
                                <div>
                                  <span className="text-[10px] text-slate-400 uppercase font-semibold block">Total</span>
                                  <span className="text-xs font-mono font-bold text-slate-800">
                                    ₹{parseFloat(tx.total_amount).toFixed(2)}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[10px] text-slate-400 uppercase font-semibold block">Remaining</span>
                                  <span
                                    className={`text-xs font-mono font-bold ${
                                      isSettled ? 'text-emerald-600' : 'text-rose-600'
                                    }`}
                                  >
                                    ₹{parseFloat(tx.remaining_amount).toFixed(2)}
                                  </span>
                                </div>
                                <span
                                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                    isSettled
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-rose-100 text-rose-800'
                                  }`}
                                >
                                  {isSettled ? 'Settled' : 'Pending'}
                                </span>
                              </div>
                            </div>

                            {/* Expanded Item Lines */}
                            {isExpanded && (
                              <div className="bg-slate-50 p-3 border-t border-slate-200 space-y-2">
                                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                                  Purchased Items Snapshot
                                </span>
                                <table className="w-full text-xs text-left border-collapse">
                                  <thead>
                                    <tr className="text-slate-400 border-b border-slate-200">
                                      <th className="py-1">Product</th>
                                      <th className="py-1 text-right">Qty</th>
                                      <th className="py-1 text-right">Selling Price</th>
                                      <th className="py-1 text-right">Line Total</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100">
                                    {tx.items.map((item) => (
                                      <tr key={item.id}>
                                        <td className="py-1 font-medium text-slate-800">
                                          {item.product_name_snapshot}
                                        </td>
                                        <td className="py-1 text-right font-mono text-slate-600">
                                          {item.quantity}
                                        </td>
                                        <td className="py-1 text-right font-mono text-slate-600">
                                          ₹{parseFloat(item.selling_price).toFixed(2)}
                                        </td>
                                        <td className="py-1 text-right font-mono font-bold text-slate-900">
                                          ₹{parseFloat(item.line_total).toFixed(2)}
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

                {/* Section: Payment History & FIFO Allocations */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-emerald-600" />
                    <span>Payment History & FIFO Allocations</span>
                  </h4>

                  {customerHistory.payments.length === 0 ? (
                    <p className="text-xs text-slate-400 p-4 bg-slate-50 rounded-xl text-center">
                      No payments recorded yet.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-56 overflow-y-auto">
                      {customerHistory.payments.map((p) => (
                        <div
                          key={p.id}
                          className="bg-slate-50 border border-slate-200 p-3 rounded-xl space-y-1.5"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <span className="text-xs font-bold text-slate-900">
                                Payment #{p.id} • {p.payment_date}
                              </span>
                              {p.note && (
                                <span className="text-xs text-slate-500 ml-2 italic">({p.note})</span>
                              )}
                            </div>
                            <span className="text-xs font-mono font-bold text-emerald-600">
                              + ₹{parseFloat(p.amount).toFixed(2)}
                            </span>
                          </div>

                          {/* Allocation details */}
                          {p.allocations && p.allocations.length > 0 && (
                            <div className="pt-1 border-t border-slate-200/70 text-[11px] text-slate-500 space-y-0.5">
                              <span className="font-semibold text-slate-600 block">FIFO Allocation:</span>
                              {p.allocations.map((alloc) => (
                                <div key={alloc.id} className="flex justify-between pl-2">
                                  <span>
                                    Allocated to Tx #{alloc.udhar_transaction_id} ({alloc.transaction_date})
                                  </span>
                                  <span className="font-mono text-emerald-700 font-semibold">
                                    ₹{parseFloat(alloc.allocated_amount).toFixed(2)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveCustomerDetailId(null)}
                    className="px-5 py-2 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition"
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
