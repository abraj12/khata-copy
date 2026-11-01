import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  FileText,
  History,
  Plus,
  Trash2,
  Printer,
  Download,
  Eye,
  CheckCircle,
  AlertCircle,
  RotateCcw,
  Search,
  User,
  Package,
  Calendar,
  Building,
  Truck,
  Loader2,
  Check,
  X,
} from 'lucide-react';
import MannatTaxInvoice, {
  MannatInvoiceProps,
  numberWords,
} from '../../components/MannatTaxInvoice/MannatTaxInvoice.js';
import {
  CreateNormalBillPayload,
  NormalBillRecord,
  getNextNormalBillNumber,
  createNormalBill,
  listNormalBills,
  downloadNormalBillPdf,
  mapNormalBillToInvoiceProps,
} from './normalBillsApi.js';
import { apiClient } from '../../lib/apiClient.js';

interface ProductItem {
  id: number;
  name: string;
  hsn_code: string | null;
  buying_price: string;
}

interface CustomerItem {
  id: number;
  name: string;
  phone: string;
  address?: string | null;
}

interface FormLineItem {
  id: string;
  productId: number | null;
  description: string;
  hsnCode: string;
  quantity: string;
  unit: string;
  rate: string;
  rateUnit: string;
}

function getTodayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const NormalBillingView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'create' | 'history'>('create');

  // Form Header States
  const [billNumber, setBillNumber] = useState('');
  const [billDate, setBillDate] = useState(getTodayLocalDate);
  const [state, setState] = useState('Uttar Pradesh');
  const [stateCode, setStateCode] = useState('09');
  const [transportationMode, setTransportationMode] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [dateOfSupply, setDateOfSupply] = useState(getTodayLocalDate);
  const [placeOfSupply, setPlaceOfSupply] = useState('Bilaspur (Rampur) U. P.');

  // Customer states
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerState, setCustomerState] = useState('Uttar Pradesh');
  const [customerStateCode, setCustomerStateCode] = useState('09');

  // Line items
  const [items, setItems] = useState<FormLineItem[]>([
    {
      id: 'item-1',
      productId: null,
      description: '',
      hsnCode: '',
      quantity: '1',
      unit: 'pcs',
      rate: '',
      rateUnit: '',
    },
  ]);

  const [notes, setNotes] = useState('');

  // UI feedback & modals
  const [isLoadingNextNum, setIsLoadingNextNum] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successRecord, setSuccessRecord] = useState<NormalBillRecord | null>(null);
  const [previewInvoice, setPreviewInvoice] = useState<MannatInvoiceProps | null>(null);
  const [autoPrintAfterPreview, setAutoPrintAfterPreview] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);

  const handleDirectPrint = (bill: NormalBillRecord) => {
    setPreviewInvoice(mapNormalBillToInvoiceProps(bill));
    setAutoPrintAfterPreview(true);
  };

  const handleClosePreview = () => {
    setPreviewInvoice(null);
    setAutoPrintAfterPreview(false);
  };

  useEffect(() => {
    if (previewInvoice && autoPrintAfterPreview) {
      const timer = setTimeout(() => {
        window.print();
        setAutoPrintAfterPreview(false);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [previewInvoice, autoPrintAfterPreview]);

  // Existing products & customers lookup
  const [availableProducts, setAvailableProducts] = useState<ProductItem[]>([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [availableCustomers, setAvailableCustomers] = useState<CustomerItem[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [isCustomerDropdownOpen, setIsCustomerDropdownOpen] = useState(false);

  // History list states
  const [historyBills, setHistoryBills] = useState<NormalBillRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historySearch, setHistorySearch] = useState('');
  const [historyDateFrom, setHistoryDateFrom] = useState('');
  const [historyDateTo, setHistoryDateTo] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const customerDropdownRef = useRef<HTMLDivElement>(null);

  // 1. Fetch next sequential bill number on mount
  const fetchNextNumber = async () => {
    try {
      setIsLoadingNextNum(true);
      const nextNum = await getNextNormalBillNumber();
      setBillNumber(nextNum);
    } catch (err) {
      console.warn('Could not auto-fetch next normal bill number:', err);
    } finally {
      setIsLoadingNextNum(false);
    }
  };

  useEffect(() => {
    fetchNextNumber();
  }, []);

  // 2. Load existing products from catalogue for search/selection
  useEffect(() => {
    const fetchProducts = async () => {
      try {
        setIsLoadingProducts(true);
        const { data } = await apiClient<{ success: boolean; products: ProductItem[] }>(
          '/api/v1/products?limit=200'
        );
        if (data?.products) {
          setAvailableProducts(data.products);
        }
      } catch (err) {
        console.warn('Could not load products catalogue:', err);
      } finally {
        setIsLoadingProducts(false);
      }
    };
    fetchProducts();
  }, []);

  // 3. Load customers for autocomplete search
  useEffect(() => {
    const fetchCustomers = async () => {
      try {
        const { data } = await apiClient<{ success: boolean; customers: CustomerItem[] }>(
          '/api/v1/khata/customers?limit=200'
        );
        if (data?.customers) {
          setAvailableCustomers(data.customers);
        }
      } catch (err) {
        console.warn('Could not load customers for selection:', err);
      }
    };
    fetchCustomers();
  }, []);

  // Close customer dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (customerDropdownRef.current && !customerDropdownRef.current.contains(e.target as Node)) {
        setIsCustomerDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 4. Load History when tab changes or filters change
  const loadHistory = async () => {
    try {
      setIsLoadingHistory(true);
      const { bills, pagination } = await listNormalBills({
        search: historySearch || undefined,
        dateFrom: historyDateFrom || undefined,
        dateTo: historyDateTo || undefined,
        limit: 25,
        offset: historyPage * 25,
      });
      setHistoryBills(bills);
      setHistoryTotal(pagination.total);
    } catch (err: any) {
      console.error('Failed to load normal bills history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    }
  }, [activeTab, historyPage, historyDateFrom, historyDateTo]);

  // Handle Search submit in history
  const handleHistorySearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setHistoryPage(0);
    loadHistory();
  };

  // Filtered customer list for autocomplete
  const filteredCustomers = useMemo(() => {
    if (!customerSearch.trim()) return availableCustomers.slice(0, 8);
    const query = customerSearch.toLowerCase();
    return availableCustomers
      .filter((c) => c.name.toLowerCase().includes(query) || (c.phone && c.phone.includes(query)))
      .slice(0, 8);
  }, [availableCustomers, customerSearch]);

  const handleSelectCustomer = (customer: CustomerItem) => {
    setCustomerId(customer.id);
    setCustomerName(customer.name);
    setCustomerPhone(customer.phone || '');
    if (customer.address) {
      setCustomerAddress(customer.address);
    }
    setIsCustomerDropdownOpen(false);
  };

  // Line Items Operations
  const handleAddItem = () => {
    setItems((prev) => [
      ...prev,
      {
        id: `item-${Date.now()}`,
        productId: null,
        description: '',
        hsnCode: '',
        quantity: '1',
        unit: 'pcs',
        rate: '',
        rateUnit: '',
      },
    ]);
  };

  const handleRemoveItem = (id: string) => {
    if (items.length === 1) {
      return;
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleItemChange = (id: string, field: keyof FormLineItem, value: any) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          return { ...item, [field]: value };
        }
        return item;
      })
    );
  };

  const handleSelectProduct = (itemId: string, product: ProductItem) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id === itemId) {
          return {
            ...item,
            productId: product.id,
            description: product.name,
            hsnCode: product.hsn_code || item.hsnCode || '',
            rate: product.buying_price ? String(product.buying_price) : item.rate,
          };
        }
        return item;
      })
    );
  };

  // Pure Decimal Math Calculations (No GST)
  const calculationSummary = useMemo(() => {
    let totalAmount = 0;
    let totalQty = 0;

    const lineCalculations = items.map((item) => {
      const q = Math.max(0, parseFloat(item.quantity) || 0);
      const r = Math.max(0, parseFloat(item.rate) || 0);
      const lineAmt = Math.round((q * r + Number.EPSILON) * 100) / 100;
      totalAmount += lineAmt;
      totalQty += q;
      return {
        ...item,
        computedAmount: lineAmt,
      };
    });

    totalAmount = Math.round((totalAmount + Number.EPSILON) * 100) / 100;
    const finalAmount = totalAmount;

    return {
      lineCalculations,
      totalQty,
      totalAmount,
      finalAmount,
      amountInWords: numberWords(finalAmount),
    };
  }, [items]);

  // Assemble full Mannat Bill props for preview
  const currentInvoiceDraft: MannatInvoiceProps = useMemo(() => {
    return {
      invoiceNumber: billNumber || 'DRAFT',
      invoiceDate: billDate,
      transportationMode,
      vehicleNumber,
      dateOfSupply,
      placeOfSupply,
      customer: {
        name: customerName,
        address: customerAddress,
        phone: customerPhone,
        state: customerState,
        stateCode: customerStateCode,
      },
      items: calculationSummary.lineCalculations.map((item) => ({
        id: item.id,
        name: item.description,
        hsn: item.hsnCode,
        quantity: item.quantity,
        unit: item.unit,
        rate: item.rate,
        rateUnit: item.rateUnit,
        amount: item.computedAmount,
      })),
      totals: {
        taxableAmount: calculationSummary.totalAmount,
        subtotal: calculationSummary.totalAmount,
        taxAmount: 0,
        grandTotal: calculationSummary.finalAmount,
      },
      amountInWords: calculationSummary.amountInWords,
    };
  }, [
    billNumber,
    billDate,
    transportationMode,
    vehicleNumber,
    dateOfSupply,
    placeOfSupply,
    customerName,
    customerAddress,
    customerPhone,
    customerState,
    customerStateCode,
    calculationSummary,
  ]);

  // Form Validation
  const validateForm = (): string | null => {
    if (!customerName.trim()) {
      return 'Customer / Receiver Name is required.';
    }
    if (items.length === 0) {
      return 'At least one product item is required.';
    }
    for (let i = 0; i < items.length; i++) {
      const itm = items[i];
      if (!itm.description.trim()) {
        return `Item #${i + 1}: Description of goods is required.`;
      }
      const q = parseFloat(itm.quantity);
      if (isNaN(q) || q <= 0) {
        return `Item #${i + 1}: Quantity must be greater than zero.`;
      }
      const r = parseFloat(itm.rate);
      if (isNaN(r) || r < 0) {
        return `Item #${i + 1}: Rate cannot be negative.`;
      }
    }
    return null;
  };

  // Submit & Save Normal Bill
  const handleSaveBill = async () => {
    setErrorMessage(null);
    setSuccessRecord(null);

    const validationError = validateForm();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    try {
      setIsSaving(true);
      const payload: CreateNormalBillPayload = {
        billNumber: billNumber.trim() || undefined,
        billDate: billDate || undefined,
        state,
        stateCode,
        transportationMode: transportationMode.trim() || null,
        vehicleNumber: vehicleNumber.trim() || null,
        dateOfSupply: dateOfSupply || null,
        placeOfSupply: placeOfSupply.trim() || null,
        customerId,
        customerName: customerName.trim(),
        customerAddress: customerAddress.trim() || null,
        customerPhone: customerPhone.trim() || null,
        customerState,
        customerStateCode,
        items: items.map((item) => ({
          productId: item.productId,
          description: item.description.trim(),
          hsnCode: item.hsnCode.trim() || null,
          quantity: parseFloat(item.quantity) || 1,
          unit: item.unit.trim() || null,
          rate: parseFloat(item.rate) || 0,
          rateUnit: item.rateUnit.trim() || null,
        })),
        notes: notes.trim() || null,
      };

      const saved = await createNormalBill(payload);
      setSuccessRecord(saved);
      // Auto open preview modal so shopkeeper can immediately print
      setPreviewInvoice(mapNormalBillToInvoiceProps(saved));
      // Refresh next bill number for next transaction
      fetchNextNumber();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to save normal bill. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  // Reset form to clean state
  const handleResetForm = () => {
    setCustomerName('');
    setCustomerId(null);
    setCustomerAddress('');
    setCustomerPhone('');
    setTransportationMode('');
    setVehicleNumber('');
    const today = getTodayLocalDate();
    setBillDate(today);
    setDateOfSupply(today);
    setItems([
      {
        id: `item-${Date.now()}`,
        productId: null,
        description: '',
        hsnCode: '',
        quantity: '1',
        unit: 'pcs',
        rate: '',
        rateUnit: '',
      },
    ]);
    setNotes('');
    setErrorMessage(null);
    setSuccessRecord(null);
    fetchNextNumber();
  };

  return (
    <div className="space-y-6">
      {/* Page Title & Subtitle Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[var(--khata-border)] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl sm:text-2xl font-black text-[var(--khata-text)] tracking-tight">
              Normal Billing · Standard Bill
            </h2>
            <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
              Non-GST
            </span>
          </div>
          <p className="text-xs sm:text-sm text-[var(--khata-text-muted)] font-medium mt-0.5">
            M/s Mannat Hardware Store — Standard Retail Bill &amp; Estimate Pad
          </p>
        </div>

        {/* View Switcher: Create Bill vs Bill History */}
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
          <button
            type="button"
            onClick={() => setActiveTab('create')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
              activeTab === 'create'
                ? 'bg-[var(--khata-accent)] text-white shadow-sm'
                : 'text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Create Normal Bill</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
              activeTab === 'history'
                ? 'bg-[var(--khata-accent)] text-white shadow-sm'
                : 'text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Bill History</span>
            {historyTotal > 0 && (
              <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-white/20 font-mono">
                {historyTotal}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ERROR BANNER */}
      {errorMessage && (
        <div className="p-3.5 rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 text-xs sm:text-sm flex items-start gap-2.5 animate-in fade-in">
          <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
          <div className="flex-1 font-semibold">{errorMessage}</div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-rose-500 hover:text-rose-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* SUCCESS BANNER */}
      {successRecord && (
        <div className="p-3.5 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 text-xs sm:text-sm flex items-center justify-between gap-3 animate-in fade-in">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
            <span>
              Normal Bill <strong>#{successRecord.bill_number}</strong> created successfully! Total: ₹
              {successRecord.total_amount}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleDirectPrint(successRecord)}
              className="neu-btn-primary text-xs px-2.5 py-1 flex items-center gap-1"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print Bill</span>
            </button>
            <button
              type="button"
              onClick={() =>
                downloadNormalBillPdf(successRecord.id, successRecord.bill_number)
              }
              className="neu-btn-secondary text-xs px-2.5 py-1 flex items-center gap-1"
            >
              <Download className="w-3.5 h-3.5" />
              <span>PDF</span>
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 1: CREATE NORMAL BILL FORM                                            */}
      {/* ========================================================================= */}
      {activeTab === 'create' && (
        <div className="space-y-6">
          {/* SECTION A: INVOICE / BILL INFORMATION */}
          <div className="neu-card p-4 sm:p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-2.5">
              <div className="flex items-center gap-2 font-black text-sm text-[var(--khata-text)] uppercase tracking-wide">
                <FileText className="w-4 h-4 text-[var(--khata-accent)]" />
                <span>Section A: Bill Information</span>
              </div>
              <span className="text-[11px] font-semibold text-[var(--khata-text-muted)]">
                Shop: M/s Mannat Hardware Store
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Bill Number */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  Bill Number *
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={billNumber}
                    onChange={(e) => setBillNumber(e.target.value)}
                    placeholder="e.g. 001"
                    className="neu-input w-full font-mono font-bold text-sm"
                  />
                  {isLoadingNextNum && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
                    </div>
                  )}
                </div>
              </div>

              {/* Bill Date */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-[var(--khata-text-muted)] flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>Bill Date *</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setBillDate(getTodayLocalDate())}
                    className="text-[10px] text-[var(--khata-accent)] hover:underline font-bold"
                  >
                    Today
                  </button>
                </div>
                <input
                  type="date"
                  value={billDate}
                  onChange={(e) => setBillDate(e.target.value)}
                  className="neu-input w-full text-xs"
                />
              </div>

              {/* State */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  State
                </label>
                <input
                  type="text"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  className="neu-input w-full text-xs"
                />
              </div>

              {/* State Code */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  State Code
                </label>
                <input
                  type="text"
                  value={stateCode}
                  onChange={(e) => setStateCode(e.target.value)}
                  className="neu-input w-full text-xs font-mono"
                />
              </div>

              {/* Transportation Mode */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1 flex items-center gap-1">
                  <Truck className="w-3.5 h-3.5" />
                  <span>Transportation Mode</span>
                </label>
                <input
                  type="text"
                  value={transportationMode}
                  onChange={(e) => setTransportationMode(e.target.value)}
                  placeholder="e.g. By Road / Tempo"
                  className="neu-input w-full text-xs"
                />
              </div>

              {/* Vehicle Number */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  Vehicle Number
                </label>
                <input
                  type="text"
                  value={vehicleNumber}
                  onChange={(e) => setVehicleNumber(e.target.value)}
                  placeholder="e.g. UP 22 T 1234"
                  className="neu-input w-full text-xs uppercase"
                />
              </div>

              {/* Date of Supply */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-[var(--khata-text-muted)]">
                    Date of Supply
                  </label>
                  <button
                    type="button"
                    onClick={() => setDateOfSupply(getTodayLocalDate())}
                    className="text-[10px] text-[var(--khata-accent)] hover:underline font-bold"
                  >
                    Today
                  </button>
                </div>
                <input
                  type="date"
                  value={dateOfSupply}
                  onChange={(e) => setDateOfSupply(e.target.value)}
                  className="neu-input w-full text-xs"
                />
              </div>

              {/* Place of Supply */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  Place of Supply
                </label>
                <input
                  type="text"
                  value={placeOfSupply}
                  onChange={(e) => setPlaceOfSupply(e.target.value)}
                  placeholder="e.g. Bilaspur (Rampur)"
                  className="neu-input w-full text-xs"
                />
              </div>
            </div>
          </div>

          {/* SECTION B: CUSTOMER / RECEIVER DETAILS */}
          <div className="neu-card p-4 sm:p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-2.5">
              <div className="flex items-center gap-2 font-black text-sm text-[var(--khata-text)] uppercase tracking-wide">
                <User className="w-4 h-4 text-[var(--khata-accent)]" />
                <span>Section B: Details of Receiver (Bill to Party)</span>
              </div>
              <span className="text-[11px] font-semibold text-[var(--khata-text-muted)]">
                Select from existing customer or enter manually
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Customer Autocomplete Search / Manual Input */}
              <div className="relative md:col-span-2" ref={customerDropdownRef}>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  Customer / Receiver Name *
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => {
                      setCustomerName(e.target.value);
                      setCustomerSearch(e.target.value);
                      setIsCustomerDropdownOpen(true);
                      setCustomerId(null);
                    }}
                    onFocus={() => setIsCustomerDropdownOpen(true)}
                    placeholder="Search existing customer or type new name..."
                    className="neu-input w-full font-bold text-sm pl-8"
                  />
                  <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2" />
                  {customerId && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                      ✓ Linked Customer
                    </span>
                  )}
                </div>

                {/* Autocomplete Dropdown */}
                {isCustomerDropdownOpen && filteredCustomers.length > 0 && (
                  <div
                    className="absolute left-0 right-0 top-full mt-1.5 p-1 rounded-xl border border-[var(--khata-border)] shadow-2xl z-50 max-h-60 overflow-y-auto animate-in fade-in"
                    style={{ background: 'var(--khata-surface)' }}
                  >
                    <div className="p-1.5 text-[10px] font-bold text-[var(--khata-text-muted)] border-b border-[var(--khata-border)] flex items-center justify-between">
                      <span>EXISTING CUSTOMERS ({availableCustomers.length})</span>
                      <span>Click to autofill</span>
                    </div>
                    {filteredCustomers.map((cust) => (
                      <button
                        key={cust.id}
                        type="button"
                        onClick={() => handleSelectCustomer(cust)}
                        className="w-full text-left p-2 rounded-lg hover:bg-[var(--khata-surface-inset)] transition flex items-center justify-between text-xs"
                      >
                        <div>
                          <div className="font-bold text-[var(--khata-text)]">{cust.name}</div>
                          {cust.address && (
                            <div className="text-[10px] text-[var(--khata-text-muted)] truncate max-w-xs">
                              {cust.address}
                            </div>
                          )}
                        </div>
                        {cust.phone && (
                          <span className="text-[11px] font-mono font-medium text-[var(--khata-accent)]">
                            {cust.phone}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Customer Phone (Optional) */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  Customer Phone / Mobile (Optional)
                </label>
                <input
                  type="text"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="e.g. 98765 43210"
                  className="neu-input w-full text-xs font-mono"
                />
              </div>

              {/* Customer Address */}
              <div className="md:col-span-2">
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  Customer Address
                </label>
                <input
                  type="text"
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                  placeholder="Street / Locality, City, District"
                  className="neu-input w-full text-xs"
                />
              </div>

              {/* Customer State & State Code */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                    State
                  </label>
                  <input
                    type="text"
                    value={customerState}
                    onChange={(e) => setCustomerState(e.target.value)}
                    className="neu-input w-full text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                    State Code
                  </label>
                  <input
                    type="text"
                    value={customerStateCode}
                    onChange={(e) => setCustomerStateCode(e.target.value)}
                    className="neu-input w-full text-xs font-mono"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* SECTION C: PRODUCT SELECTION & LINE ITEMS */}
          <div className="neu-card p-4 sm:p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-2.5">
              <div className="flex items-center gap-2 font-black text-sm text-[var(--khata-text)] uppercase tracking-wide">
                <Package className="w-4 h-4 text-[var(--khata-accent)]" />
                <span>Section C: Goods / Products Selection</span>
              </div>
              <button
                type="button"
                onClick={handleAddItem}
                className="neu-btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 font-bold"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Item</span>
              </button>
            </div>

            {/* Line Items List */}
            <div className="space-y-4">
              {items.map((item, index) => {
                const computedAmt = calculationSummary.lineCalculations[index]?.computedAmount || 0;

                return (
                  <div
                    key={item.id}
                    className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-3 relative group"
                  >
                    <div className="flex items-center justify-between border-b border-[var(--khata-border)]/60 pb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-[var(--khata-accent)] text-white text-[11px] font-black flex items-center justify-center">
                          {index + 1}
                        </span>
                        <span className="text-xs font-black text-[var(--khata-text)]">
                          Product Item #{index + 1}
                        </span>
                      </div>
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(item.id)}
                          className="text-rose-500 hover:text-rose-700 p-1 rounded hover:bg-rose-500/10 transition"
                          title="Remove line item"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    {/* Description of Goods with Integrated Catalogue Autocomplete */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-bold text-[var(--khata-text-muted)] flex items-center gap-1">
                          <Package className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                          <span>Description of Goods</span>
                          <span className="text-rose-500">*</span>
                        </label>

                        <div className="flex items-center gap-2">
                          {item.productId ? (
                            <div className="flex items-center gap-1.5 text-[10px]">
                              <span className="text-[var(--khata-accent)] font-semibold truncate max-w-[200px]">
                                ✓ Linked: {availableProducts.find((p) => p.id === item.productId)?.name || 'Catalogue Product'}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setItems((prev) =>
                                    prev.map((i) => (i.id === item.id ? { ...i, productId: null } : i))
                                  );
                                }}
                                className="text-rose-500 hover:underline font-bold cursor-pointer"
                                title="Unlink product"
                              >
                                (Unlink)
                              </button>
                            </div>
                          ) : isLoadingProducts ? (
                            <span className="text-[10px] text-[var(--khata-text-muted)] flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin text-[var(--khata-accent)]" />
                              <span>Loading catalogue...</span>
                            </span>
                          ) : availableProducts.length > 0 ? (
                            <span className="text-[10px] text-[var(--khata-text-muted)]">
                              {availableProducts.length} catalogue products available
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="relative">
                        <input
                          type="text"
                          list={`normal-product-options-${item.id}`}
                          value={item.description}
                          onChange={(e) => {
                            const val = e.target.value;
                            const matched = availableProducts.find(
                              (p) => p.name.toLowerCase() === val.toLowerCase()
                            );
                            if (matched) {
                              handleSelectProduct(item.id, matched);
                            } else {
                              handleItemChange(item.id, 'description', val);
                            }
                          }}
                          placeholder="Type to search product from catalogue or enter custom description..."
                          className="neu-input w-full font-medium text-xs"
                        />
                        <datalist id={`normal-product-options-${item.id}`}>
                          {availableProducts.map((p) => (
                            <option key={p.id} value={p.name}>
                              {p.hsn_code ? `HSN: ${p.hsn_code} | ` : ''}₹{p.buying_price}
                            </option>
                          ))}
                        </datalist>
                      </div>
                    </div>

                    {/* Numeric Columns: HSN, Quantity, Unit, Rate, Amount */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-1">
                      {/* HSN */}
                      <div>
                        <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                          HSN Code
                        </label>
                        <input
                          type="text"
                          value={item.hsnCode}
                          onChange={(e) => handleItemChange(item.id, 'hsnCode', e.target.value)}
                          placeholder="e.g. 4411"
                          className="neu-input w-full text-xs font-mono"
                        />
                      </div>

                      {/* Quantity */}
                      <div>
                        <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                          Quantity *
                        </label>
                        <input
                          type="number"
                          step="0.001"
                          min="0.001"
                          value={item.quantity}
                          onChange={(e) => handleItemChange(item.id, 'quantity', e.target.value)}
                          placeholder="1"
                          className="neu-input w-full text-xs font-bold text-center"
                        />
                      </div>

                      {/* Unit */}
                      <div>
                        <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                          Unit
                        </label>
                        <input
                          type="text"
                          value={item.unit}
                          onChange={(e) => handleItemChange(item.id, 'unit', e.target.value)}
                          placeholder="pcs / sq.ft"
                          className="neu-input w-full text-xs text-center"
                        />
                      </div>

                      {/* Rate */}
                      <div>
                        <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                          Rate (₹) *
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={item.rate}
                          onChange={(e) => handleItemChange(item.id, 'rate', e.target.value)}
                          placeholder="0.00"
                          className="neu-input w-full text-xs font-bold text-right"
                        />
                      </div>

                      {/* Line Amount (Auto calculated) */}
                      <div className="col-span-2 sm:col-span-1">
                        <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                          Amount (₹)
                        </label>
                        <div className="neu-input w-full text-xs font-black text-right bg-black/5 dark:bg-white/5 flex items-center justify-end">
                          ₹{computedAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* SECTION D: BILL SUMMARY (NO GST CALCULATION) */}
          <div className="neu-card p-4 sm:p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-2.5">
              <div className="flex items-center gap-2 font-black text-sm text-[var(--khata-text)] uppercase tracking-wide">
                <Building className="w-4 h-4 text-emerald-500" />
                <span>Section D: Bill Summary (No GST)</span>
              </div>
              <span className="text-[11px] font-semibold text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                Direct Subtotal Calculation
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              {/* Left Column: Notes & Remarks */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  Optional Notes / Remarks (Included in bill records)
                </label>
                <textarea
                  rows={4}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Paid in cash / Goods dispatched via tempo"
                  className="neu-input w-full text-xs resize-none"
                />
              </div>

              {/* Right Column: Bill Totals Breakdown */}
              <div className="p-4 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-2.5">
                <div className="flex items-center justify-between text-xs text-[var(--khata-text-muted)]">
                  <span>Total Line Items:</span>
                  <span className="font-bold text-[var(--khata-text)]">{items.length} items</span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--khata-text-muted)]">
                  <span>Total Quantity:</span>
                  <span className="font-bold text-[var(--khata-text)]">
                    {calculationSummary.totalQty.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--khata-text-muted)]">
                  <span>Subtotal / Total Amount:</span>
                  <span className="font-bold text-[var(--khata-text)]">
                    ₹{calculationSummary.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>

                <div className="border-t border-[var(--khata-border)] pt-2.5 mt-2 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-black text-[var(--khata-text)] uppercase tracking-wide">
                      Final Bill Amount
                    </div>
                    <div className="text-[10px] text-[var(--khata-text-muted)]">Net Payable</div>
                  </div>
                  <div className="text-xl sm:text-2xl font-black text-[var(--khata-accent)]">
                    ₹{calculationSummary.finalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </div>
                </div>

                {/* Amount in words */}
                <div className="pt-2 border-t border-[var(--khata-border)]/60 text-[11px] text-[var(--khata-text-muted)] italic">
                  <strong>In Words:</strong> {calculationSummary.amountInWords}
                </div>
              </div>
            </div>
          </div>

          {/* ACTION BUTTONS TOOLBAR */}
          <div className="neu-card p-4 flex flex-wrap items-center justify-between gap-3 sticky bottom-4 z-20 shadow-xl border border-[var(--khata-accent)]/30">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleResetForm}
                className="neu-btn-secondary text-xs px-3.5 py-2 flex items-center gap-1.5 font-bold"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {/* Preview Button */}
              <button
                type="button"
                onClick={() => setPreviewInvoice(currentInvoiceDraft)}
                className="neu-btn-secondary text-xs px-4 py-2 flex items-center gap-1.5 font-bold"
              >
                <Eye className="w-4 h-4 text-[var(--khata-accent)]" />
                <span>Preview Bill</span>
              </button>

              {/* Save Bill Button */}
              <button
                type="button"
                onClick={handleSaveBill}
                disabled={isSaving}
                className="neu-btn-primary text-xs px-5 py-2 flex items-center gap-2 font-black shadow-lg"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                <span>{isSaving ? 'Saving...' : 'Save Normal Bill'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: NORMAL BILL HISTORY                                                */}
      {/* ========================================================================= */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          {/* History Search & Filter Bar */}
          <div className="neu-card p-4">
            <form onSubmit={handleHistorySearchSubmit} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="sm:col-span-2 relative">
                <input
                  type="text"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search by bill number or customer name..."
                  className="neu-input w-full text-xs pl-8"
                />
                <Search className="w-3.5 h-3.5 text-[var(--khata-text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2" />
              </div>

              <div>
                <input
                  type="date"
                  value={historyDateFrom}
                  onChange={(e) => setHistoryDateFrom(e.target.value)}
                  className="neu-input w-full text-xs"
                  placeholder="From Date"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={historyDateTo}
                  onChange={(e) => setHistoryDateTo(e.target.value)}
                  className="neu-input w-full text-xs flex-1"
                  placeholder="To Date"
                />
                <button
                  type="submit"
                  className="neu-btn-primary text-xs px-3 py-2 font-bold shrink-0"
                >
                  Filter
                </button>
              </div>
            </form>
          </div>

          {/* History Table */}
          <div className="neu-card p-0 overflow-hidden">
            {isLoadingHistory ? (
              <div className="p-12 flex flex-col items-center justify-center gap-2 text-[var(--khata-text-muted)]">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--khata-accent)]" />
                <span className="text-xs font-semibold">Loading normal bills history...</span>
              </div>
            ) : historyBills.length === 0 ? (
              <div className="p-12 text-center text-[var(--khata-text-muted)] space-y-2">
                <History className="w-8 h-8 mx-auto opacity-30" />
                <div className="text-sm font-bold">No normal bills found.</div>
                <div className="text-xs">
                  Create your first bill using the "Create Normal Bill" tab!
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[var(--khata-border)] bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)] font-black uppercase text-[10px] tracking-wider">
                      <th className="p-3">Bill No.</th>
                      <th className="p-3">Date</th>
                      <th className="p-3">Customer</th>
                      <th className="p-3">Items</th>
                      <th className="p-3 text-right">Total Amount</th>
                      <th className="p-3 text-center">Status</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--khata-border)]">
                    {historyBills.map((bill) => (
                      <tr
                        key={bill.id}
                        className="hover:bg-[var(--khata-surface-inset)] transition group"
                      >
                        <td className="p-3 font-mono font-black text-[var(--khata-text)]">
                          {bill.bill_number}
                        </td>
                        <td className="p-3 text-[var(--khata-text-muted)] font-mono">
                          {bill.bill_date}
                        </td>
                        <td className="p-3">
                          <div className="font-bold text-[var(--khata-text)]">{bill.customer_name}</div>
                          {bill.customer_phone && (
                            <div className="text-[10px] text-[var(--khata-text-muted)] font-mono">
                              {bill.customer_phone}
                            </div>
                          )}
                        </td>
                        <td className="p-3 text-[var(--khata-text-muted)]">
                          {bill.items?.length || 0} items
                        </td>
                        <td className="p-3 text-right font-black text-[var(--khata-text)]">
                          ₹{Number(bill.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="p-3 text-center">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                              bill.pdf_status === 'uploaded'
                                ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                                : 'bg-neutral-500/10 text-neutral-600 border border-neutral-500/20'
                            }`}
                          >
                            {bill.pdf_status === 'uploaded' ? 'Saved (R2)' : 'Saved (Local)'}
                          </span>
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setPreviewInvoice(mapNormalBillToInvoiceProps(bill))}
                              className="neu-btn-secondary text-xs px-2.5 py-1 flex items-center gap-1 font-bold"
                              title="Preview bill"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span className="hidden sm:inline">View</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDirectPrint(bill)}
                              className="neu-btn-secondary text-xs px-2.5 py-1 flex items-center gap-1 font-bold"
                              title="Print bill"
                            >
                              <Printer className="w-3.5 h-3.5" />
                              <span className="hidden sm:inline">Print</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => downloadNormalBillPdf(bill.id, bill.bill_number)}
                              className="neu-btn-primary text-xs px-2.5 py-1 flex items-center gap-1 font-bold"
                              title="Download PDF"
                            >
                              <Download className="w-3.5 h-3.5" />
                              <span className="hidden sm:inline">PDF</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination Controls */}
            {historyTotal > 25 && (
              <div className="p-3 border-t border-[var(--khata-border)] flex items-center justify-between text-xs text-[var(--khata-text-muted)]">
                <div>
                  Showing {historyPage * 25 + 1} to{' '}
                  {Math.min((historyPage + 1) * 25, historyTotal)} of {historyTotal} bills
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={historyPage === 0}
                    onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
                    className="neu-btn-secondary px-2.5 py-1 font-bold disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={(historyPage + 1) * 25 >= historyTotal}
                    onClick={() => setHistoryPage((p) => p + 1)}
                    className="neu-btn-secondary px-2.5 py-1 font-bold disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: FULL MANNAT NORMAL BILL PREVIEW                                    */}
      {/* ========================================================================= */}
      {previewInvoice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/75 backdrop-blur-sm animate-in fade-in"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="neu-card w-full max-w-4xl max-h-[96vh] flex flex-col p-0 overflow-hidden shadow-2xl border border-[var(--khata-border)]"
            style={{ background: 'var(--khata-surface)' }}
          >
            {/* Modal Header */}
            <div className="p-3 sm:p-4 border-b border-[var(--khata-border)] flex items-center justify-between bg-[var(--khata-surface-inset)] mhi-no-print">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-emerald-500" />
                <span className="font-black text-sm text-[var(--khata-text)]">
                  Normal Bill Preview · #{previewInvoice.invoiceNumber || 'Draft'}
                </span>
              </div>
              <button
                type="button"
                onClick={handleClosePreview}
                className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body: Mannat Invoice A4 Component */}
            <div className="flex-1 overflow-y-auto p-2 sm:p-6 bg-neutral-100 dark:bg-neutral-900 flex justify-center">
              <MannatTaxInvoice
                invoice={previewInvoice}
                showPrintButton={true}
                isNormalBill={true}
                billTitle="NORMAL BILL"
                onDownloadPdf={
                  previewInvoice.id
                    ? async () => {
                        try {
                          setIsDownloadingPdf(true);
                          await downloadNormalBillPdf(
                            previewInvoice.id!,
                            previewInvoice.invoiceNumber || 'Bill'
                          );
                        } catch (err: any) {
                          alert(err.message || 'Failed to download bill PDF.');
                        } finally {
                          setIsDownloadingPdf(false);
                        }
                      }
                    : undefined
                }
                isDownloadingPdf={isDownloadingPdf}
              />
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-[var(--khata-border)] flex items-center justify-between bg-[var(--khata-surface-inset)] mhi-no-print">
              <span className="text-[11px] text-[var(--khata-text-muted)]">
                A4 Portrait Layout · Non-GST Bill
              </span>
              <button
                type="button"
                onClick={handleClosePreview}
                className="neu-btn-secondary text-xs px-4 py-1.5 font-bold"
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NormalBillingView;
