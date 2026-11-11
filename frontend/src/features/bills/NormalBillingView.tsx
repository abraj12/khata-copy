import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  FileText,
  History,
  Plus,
  Trash2,
  Printer,
  Download,
  Eye,
  CheckCircle2,
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
  downloadNormalBillDraftPdf,
  mapNormalBillToInvoiceProps,
} from './normalBillsApi.js';
import Decimal from 'decimal.js';
import { apiClient } from '../../lib/apiClient.js';
import { fetchQuotationSettings } from '../quotations/quotationApi.js';
import {
  INDIAN_STATES,
  getStateByCode,
  resolveCustomerStateSelection,
} from '../../lib/indianStates.js';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import {
  applyCatalogProductToDraftLine,
  ProductCatalogReference,
  upsertScannedProductLine,
  validateQuantityInput,
  validateSellingRateInput,
} from '../../utils/lineItemDraft.js';
import { BillingBarcodeControls } from '../barcode/BillingBarcodeControls.js';

interface ProductItem {
  id: number;
  name: string;
  hsn_code: string | null;
  buying_price: string;
  barcode?: string | null;
}

interface CustomerItem {
  id: number;
  name: string;
  phone: string;
  address?: string | null;
  state?: string | null;
  state_code?: string | null;
}

interface FormLineItem {
  id: string;
  productId: number | null;
  description: string;
  hsnCode: string;
  barcode?: string;
  buyingPriceReference?: string | null;
  quantity: string;
  unit: string;
  rate: string;
  rateUnit: string;
}

function getTodayLocalDate(): string {
  return getBusinessDateISO();
}

export const NormalBillingView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'create' | 'history'>('create');

  // Form Header States
  const [companyProfile, setCompanyProfile] = useState<{
    name: string;
    address: string;
    gstin: string | null;
    phone: string | null;
    state: string;
    stateCode: string;
  } | null>(null);
  const [billNumber, setBillNumber] = useState('');
  const [isManualBillNumber, setIsManualBillNumber] = useState(false);
  const [billDate, setBillDate] = useState(getTodayLocalDate);
  const [state, setState] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [transportationMode, setTransportationMode] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [dateOfSupply, setDateOfSupply] = useState(getTodayLocalDate);
  const [placeOfSupply, setPlaceOfSupply] = useState('');

  // Customer states
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerState, setCustomerState] = useState('');
  const [customerStateCode, setCustomerStateCode] = useState('');

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
  const itemsRef = useRef<FormLineItem[]>(items);

  const commitItems = useCallback(
    (updater: FormLineItem[] | ((prev: FormLineItem[]) => FormLineItem[])) => {
      const next =
        typeof updater === 'function' ? updater(itemsRef.current) : updater;
      itemsRef.current = next;
      setItems(next);
      return next;
    },
    []
  );

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
    setPreviewInvoice(mapNormalBillToInvoiceProps(bill, companyProfile || undefined));
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
  const [openProductPickerItemId, setOpenProductPickerItemId] = useState<string | null>(null);
  const [productPickerSearch, setProductPickerSearch] = useState('');

  // History list states
  const [historyBills, setHistoryBills] = useState<NormalBillRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historySearch, setHistorySearch] = useState('');
  const [historyDateFrom, setHistoryDateFrom] = useState('');
  const [historyDateTo, setHistoryDateTo] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const customerDropdownRef = useRef<HTMLDivElement>(null);
  const productPickerRef = useRef<HTMLDivElement>(null);
  const idempotencyKeyRef = useRef<string>(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));

  // 1. Fetch next sequential bill number on mount
  const fetchNextNumber = async () => {
    try {
      setIsLoadingNextNum(true);
      const nextNum = await getNextNormalBillNumber();
      setBillNumber(nextNum);
      setIsManualBillNumber(false);
    } catch (err) {
      console.warn('Could not auto-fetch next normal bill number:', err);
    } finally {
      setIsLoadingNextNum(false);
    }
  };

  useEffect(() => {
    fetchNextNumber();
    (async () => {
      try {
        const settings = await fetchQuotationSettings();
        if (settings) {
          setCompanyProfile({
            name: settings.company_name,
            address: settings.address,
            gstin: settings.gstin,
            phone: settings.phone,
            state: settings.state,
            stateCode: settings.state_code,
          });
          setState(settings.state || '');
          setStateCode(settings.state_code || '');
          setPlaceOfSupply((prev) => prev || settings.state || '');
        }
      } catch (err) {
        console.warn('Could not load company profile for normal billing:', err);
      }
    })();
  }, []);

  // 2. Load existing products from catalogue for search/selection
  const fetchProducts = async () => {
    try {
      setIsLoadingProducts(true);
      const all: ProductItem[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore && offset < 1000) {
        const res = await apiClient<{
          success: boolean;
          data: ProductItem[];
          pagination?: { hasMore: boolean; nextOffset: number | null };
        }>(`/api/v1/products?limit=50&offset=${offset}`);

        const items = res.data?.data || (res.data as any)?.products;
        if (items && Array.isArray(items)) {
          all.push(...items);
          if (res.data.pagination?.hasMore && res.data.pagination?.nextOffset) {
            offset = res.data.pagination.nextOffset;
          } else {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }
      setAvailableProducts(all);
    } catch (err) {
      console.warn('Could not load products catalogue:', err);
    } finally {
      setIsLoadingProducts(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  // 3. Load customers for autocomplete search
  const fetchCustomers = async () => {
    try {
      const all: CustomerItem[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore && offset < 1000) {
        const res = await apiClient<{
          success: boolean;
          customers: CustomerItem[];
          pagination?: { hasMore: boolean; nextOffset: number | null };
        }>(`/api/v1/khata/customers?limit=200&offset=${offset}`);

        const custs = res.data?.customers || (res.data as any)?.data;
        if (custs && Array.isArray(custs) && custs.length > 0) {
          all.push(...custs);
          if (res.data?.pagination?.hasMore && res.data.pagination.nextOffset) {
            offset = res.data.pagination.nextOffset;
          } else {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }
      setAvailableCustomers(all);
    } catch (err) {
      console.warn('Could not load customers for selection:', err);
    }
  };

  useEffect(() => {
    fetchCustomers();
  }, []);

  // Close customer & product dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (customerDropdownRef.current && !customerDropdownRef.current.contains(e.target as Node)) {
        setIsCustomerDropdownOpen(false);
      }
      if (productPickerRef.current && !productPickerRef.current.contains(e.target as Node)) {
        setOpenProductPickerItemId(null);
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

  // Filtered customer list for autocomplete & picker
  const filteredCustomers = useMemo(() => {
    if (!customerSearch.trim()) return availableCustomers;
    const query = customerSearch.toLowerCase();
    return availableCustomers.filter(
      (c) => c.name.toLowerCase().includes(query) || (c.phone && c.phone.includes(query))
    );
  }, [availableCustomers, customerSearch]);

  const handleSelectCustomer = (customer: CustomerItem) => {
    setCustomerId(Number(customer.id));
    setCustomerName(customer.name);
    setCustomerPhone(customer.phone || '');
    setCustomerAddress(customer.address || '');
    const resolvedState = resolveCustomerStateSelection(customer);
    setCustomerState(resolvedState.state);
    setCustomerStateCode(resolvedState.stateCode);
    setIsCustomerDropdownOpen(false);
  };

  // Line Items Operations
  const handleAddItem = () => {
    commitItems((prev) => [
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
    if (itemsRef.current.length <= 1) {
      return;
    }
    commitItems((prev) => (prev.length <= 1 ? prev : prev.filter((item) => item.id !== id)));
  };

  const handleItemChange = (id: string, field: keyof FormLineItem, value: any) => {
    commitItems((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          return { ...item, [field]: value };
        }
        return item;
      })
    );
  };

  const handleSelectProduct = (itemId: string, product: ProductItem) => {
    commitItems((prev) =>
      prev.map((item) => {
        if (item.id === itemId) {
          const updated = applyCatalogProductToDraftLine(item, product);
          return {
            ...item,
            productId: updated.productId,
            description: updated.description,
            hsnCode: updated.hsnCode,
            barcode: updated.barcode,
            buyingPriceReference: updated.buyingPriceReference,
            rate: updated.rate,
          };
        }
        return item;
      })
    );
  };

  const handleBarcodeResolved = useCallback(
    (product: ProductCatalogReference) => {
      const res = upsertScannedProductLine(itemsRef.current, product, () => ({
        id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        productId: null,
        description: '',
        hsnCode: '',
        barcode: '',
        buyingPriceReference: null,
        quantity: '1',
        unit: 'pcs',
        rate: '',
        rateUnit: '',
      }));
      if (!res.error) {
        commitItems(res.nextLines);
      }
      return { action: res.action, error: res.error };
    },
    [commitItems]
  );

  // Pure Decimal Math Calculations (No GST, strictly synchronized with backend Decimal.ROUND_HALF_UP)
  const calculationSummary = useMemo(() => {
    let totalAmountDec = new Decimal(0);
    let totalQtyDec = new Decimal(0);

    const lineCalculations = items.map((item) => {
      let qDec = new Decimal(0);
      let rDec = new Decimal(0);
      try {
        if (item.quantity && !isNaN(Number(item.quantity))) {
          qDec = new Decimal(item.quantity);
        }
      } catch {
        qDec = new Decimal(0);
      }
      try {
        if (item.rate && !isNaN(Number(item.rate))) {
          rDec = new Decimal(item.rate);
        }
      } catch {
        rDec = new Decimal(0);
      }

      const safeQ = qDec.isFinite() && qDec.isPositive() ? qDec : new Decimal(0);
      const safeR = rDec.isFinite() && rDec.isPositive() ? rDec : new Decimal(0);
      const lineAmtDec = safeQ.times(safeR).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      totalAmountDec = totalAmountDec.plus(lineAmtDec);
      totalQtyDec = totalQtyDec.plus(safeQ);
      return {
        ...item,
        computedAmount: lineAmtDec.toNumber(),
      };
    });

    const totalAmount = totalAmountDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    const finalAmount = totalAmount;

    return {
      lineCalculations,
      totalQty: totalQtyDec.toNumber(),
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
      company: companyProfile || { state, stateCode },
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
    companyProfile,
    state,
    stateCode,
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
      const qtyErr = validateQuantityInput(itm.quantity, `Item #${i + 1} quantity`);
      if (qtyErr) return qtyErr;
      const rateErr = validateSellingRateInput(itm.rate, `Item #${i + 1} rate`);
      if (rateErr) return rateErr;
    }
    return null;
  };

  const handleDownloadPdf = async (id: number, bNumber: string) => {
    try {
      setIsDownloadingPdf(true);
      await downloadNormalBillPdf(id, bNumber);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to download bill PDF.');
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  const handleDownloadDraftPdf = async () => {
    const err = validateForm();
    if (err) {
      setErrorMessage(err);
      return;
    }
    try {
      setIsDownloadingPdf(true);
      await downloadNormalBillDraftPdf({
        billNumber: isManualBillNumber ? billNumber.trim() || undefined : undefined,
        billDate,
        state,
        stateCode,
        transportationMode: transportationMode.trim() || null,
        vehicleNumber: vehicleNumber.trim() || null,
        dateOfSupply: dateOfSupply || null,
        placeOfSupply: placeOfSupply.trim() || null,
        customerId: customerId ? Number(customerId) : null,
        customerName: customerName.trim(),
        customerAddress: customerAddress.trim() || null,
        customerPhone: customerPhone.trim() || null,
        customerState: customerState.trim() || null,
        customerStateCode: customerStateCode.trim() || null,
        items: items.map((item) => ({
          productId: item.productId ? Number(item.productId) : null,
          description: item.description.trim(),
          hsnCode: item.hsnCode.trim() || null,
          quantity: item.quantity,
          unit: item.unit.trim() || null,
          rate: item.rate,
          rateUnit: item.rateUnit.trim() || null,
        })),
        notes: notes.trim() || null,
      });
    } catch (dErr: any) {
      setErrorMessage(dErr.message || 'Failed to download draft bill PDF.');
    } finally {
      setIsDownloadingPdf(false);
    }
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
        idempotencyKey: idempotencyKeyRef.current,
        billNumber: isManualBillNumber ? billNumber.trim() || undefined : undefined,
        billDate: billDate || undefined,
        state,
        stateCode,
        transportationMode: transportationMode.trim() || null,
        vehicleNumber: vehicleNumber.trim() || null,
        dateOfSupply: dateOfSupply || null,
        placeOfSupply: placeOfSupply.trim() || null,
        customerId: customerId ? Number(customerId) : null,
        customerName: customerName.trim(),
        customerAddress: customerAddress.trim() || null,
        customerPhone: customerPhone.trim() || null,
        customerState: customerState.trim() || null,
        customerStateCode: customerStateCode.trim() || null,
        items: items.map((item) => ({
          productId: item.productId ? Number(item.productId) : null,
          description: item.description.trim(),
          hsnCode: item.hsnCode.trim() || null,
          quantity: item.quantity,
          unit: item.unit.trim() || null,
          rate: item.rate,
          rateUnit: item.rateUnit.trim() || null,
        })),
        notes: notes.trim() || null,
      };

      const saved = await createNormalBill(payload);
      setSuccessRecord(saved);
      // Auto-fetch next sequential bill number for next bill
      fetchNextNumber();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to save normal bill. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  // Reset form to clean state
  const handleResetForm = () => {
    idempotencyKeyRef.current =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    setSuccessRecord(null);
    setCustomerName('');
    setCustomerId(null);
    setCustomerAddress('');
    setCustomerPhone('');
    setCustomerState('');
    setCustomerStateCode('');
    setTransportationMode('');
    setVehicleNumber('');
    const today = getTodayLocalDate();
    setBillDate(today);
    setDateOfSupply(today);
    commitItems([
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
    idempotencyKeyRef.current = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    setSuccessRecord(null);
    fetchNextNumber();
  };

  return (
    <div className="space-y-6">
      <div className="mhi-no-print space-y-6">
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
            Algions AI Labs Private Limited — Standard Bill &amp; Estimate Pad
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
                Company: {companyProfile?.name || 'Company Tax Profile'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Bill Number */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-[var(--khata-text-muted)] flex items-center gap-1">
                    <span>Bill Number *</span>
                  </label>
                  <button
                    type="button"
                    onClick={fetchNextNumber}
                    disabled={isLoadingNextNum}
                    className="text-[10px] font-semibold text-[var(--khata-accent)] hover:underline flex items-center gap-1 cursor-pointer"
                    title="Fetch next sequential bill number from server"
                  >
                    <RotateCcw className={`w-3 h-3 ${isLoadingNextNum ? 'animate-spin' : ''}`} />
                    <span>Auto / Refresh</span>
                  </button>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    value={billNumber}
                    onChange={(e) => {
                      setBillNumber(e.target.value);
                      setIsManualBillNumber(true);
                    }}
                    placeholder={isLoadingNextNum ? 'Fetching...' : 'e.g. 001'}
                    className="neu-input w-full font-mono font-bold text-sm tracking-wide"
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

              {/* Seller State (from Company Settings) */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  Seller State
                </label>
                <input
                  type="text"
                  value={state}
                  readOnly
                  placeholder="From Settings"
                  className="neu-input w-full text-xs cursor-default"
                  style={{ background: 'var(--khata-surface-inset)' }}
                />
              </div>

              {/* Seller State Code */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                  Seller State Code
                </label>
                <input
                  type="text"
                  value={stateCode}
                  readOnly
                  placeholder="--"
                  className="neu-input w-full text-xs font-mono cursor-default"
                  style={{ background: 'var(--khata-surface-inset)' }}
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
                  placeholder="e.g. Gopalganj"
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
              
              {/* Customer picker toggle */}
              <div className="relative" ref={customerDropdownRef}>
                <button
                  type="button"
                  onClick={() => setIsCustomerDropdownOpen(!isCustomerDropdownOpen)}
                  className="text-xs font-semibold text-[var(--khata-accent)] hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <User className="w-3.5 h-3.5" />
                  <span>Pick Khata Customer</span>
                </button>

                {isCustomerDropdownOpen && (
                  <div
                    className="absolute right-0 top-full mt-2 w-72 max-w-[85vw] p-2 rounded-xl border border-[var(--khata-border)] shadow-xl z-30 space-y-2 animate-in fade-in"
                    style={{ background: 'var(--khata-surface)' }}
                  >
                    <div className="p-1 text-[10px] font-bold text-[var(--khata-text-muted)] border-b border-[var(--khata-border)] flex items-center justify-between">
                      <span>KHATA CUSTOMERS ({availableCustomers.length})</span>
                      <span>Click to autofill</span>
                    </div>
                    <input
                      type="text"
                      placeholder="Search customer by name or phone..."
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      className="neu-input w-full text-xs p-1.5"
                      autoFocus
                    />
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {filteredCustomers.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => handleSelectCustomer(c)}
                          className="w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--khata-surface-inset)] flex items-center justify-between transition"
                        >
                          <div>
                            <span className="font-bold text-[var(--khata-text)] block truncate">{c.name}</span>
                            {c.address && (
                              <span className="text-[10px] text-[var(--khata-text-muted)] block truncate max-w-[180px]">
                                {c.address}
                              </span>
                            )}
                          </div>
                          {c.phone && (
                            <span className="text-[10px] text-[var(--khata-text-muted)] font-mono ml-2">
                              {c.phone}
                            </span>
                          )}
                        </button>
                      ))}
                      {filteredCustomers.length === 0 && (
                        <div className="p-2 text-center text-xs text-[var(--khata-text-muted)]">
                          No Khata customers found.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Customer Autocomplete Search / Manual Input */}
              <div className="relative md:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-[var(--khata-text-muted)]">
                    Customer / Receiver Name *
                  </label>
                  {customerId && (
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className="text-emerald-600 font-bold">✓ Linked Customer</span>
                      <button
                        type="button"
                        onClick={() => {
                          setCustomerId(null);
                        }}
                        className="text-rose-500 hover:underline font-bold cursor-pointer"
                        title="Unlink customer"
                      >
                        (Unlink)
                      </button>
                    </div>
                  )}
                </div>
                <div className="relative">
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => {
                      setCustomerName(e.target.value);
                      setCustomerSearch(e.target.value);
                      if (customerId) {
                        setCustomerId(null);
                      }
                    }}
                    placeholder="Search existing customer or type new name..."
                    className="neu-input w-full font-bold text-sm pl-8"
                  />
                  <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2" />
                </div>
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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                    State (Optional)
                  </label>
                  <select
                    value={customerStateCode}
                    onChange={(e) => {
                      const code = e.target.value;
                      if (!code) {
                        setCustomerStateCode('');
                        setCustomerState('');
                        return;
                      }
                      const matched = getStateByCode(code);
                      setCustomerStateCode(code);
                      setCustomerState(matched ? matched.name : '');
                    }}
                    className="neu-input w-full text-xs"
                  >
                    <option value="">None / Not specified</option>
                    {INDIAN_STATES.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.code} – {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1">
                    State Code
                  </label>
                  <input
                    type="text"
                    value={customerStateCode}
                    onChange={(e) => {
                      const code = e.target.value.replace(/\D/g, '').slice(0, 2);
                      setCustomerStateCode(code);
                      const matched = getStateByCode(code);
                      if (matched) setCustomerState(matched.name);
                      else if (!code) setCustomerState('');
                    }}
                    maxLength={2}
                    placeholder="--"
                    className="neu-input w-full text-xs font-mono text-center"
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

            <BillingBarcodeControls
              enableGlobalScanner={activeTab === 'create' && !successRecord && !previewInvoice}
              onProductResolved={handleBarcodeResolved}
              onCatalogProductCreated={(created) => {
                setAvailableProducts((prev) => [
                  {
                    id: created.id,
                    name: created.name,
                    hsn_code: created.hsn_code ?? null,
                    buying_price: created.buying_price,
                    barcode: created.barcode ?? null,
                  },
                  ...prev,
                ]);
              }}
            />

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
                                ✓ Linked: {availableProducts.find((p) => Number(p.id) === Number(item.productId))?.name || 'Catalogue Product'}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  commitItems((prev) =>
                                    prev.map((i) => (i.id === item.id ? { ...i, productId: null } : i))
                                  );
                                }}
                                className="text-rose-500 hover:underline font-bold cursor-pointer"
                                title="Unlink product"
                              >
                                (Unlink)
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenProductPickerItemId(
                                    openProductPickerItemId === item.id ? null : item.id
                                  );
                                  setProductPickerSearch('');
                                }}
                                className="text-[10px] font-semibold text-[var(--khata-accent)] hover:underline flex items-center gap-1 cursor-pointer"
                                title="Pick from store product catalogue"
                              >
                                <Package className="w-3 h-3" />
                                <span>Pick Product</span>
                              </button>
                              {isLoadingProducts ? (
                                <span className="text-[10px] text-[var(--khata-text-muted)] flex items-center gap-1">
                                  <Loader2 className="w-3 h-3 animate-spin text-[var(--khata-accent)]" />
                                  <span>Loading...</span>
                                </span>
                              ) : availableProducts.length > 0 ? (
                                <span className="text-[10px] text-[var(--khata-text-muted)]">
                                  {availableProducts.length} in catalogue
                                </span>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="relative" ref={openProductPickerItemId === item.id ? productPickerRef : undefined}>
                        <input
                          type="text"
                          list={`normal-product-options-${item.id}`}
                          value={item.description}
                          onChange={(e) => {
                            const val = e.target.value;
                            const cleanVal = val.trim().toLowerCase();
                            const matched = availableProducts.find(
                              (p) => p.name.trim().toLowerCase() === cleanVal
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
                              {p.hsn_code ? `HSN: ${p.hsn_code} | ` : ''}Ref: ₹{p.buying_price}
                            </option>
                          ))}
                        </datalist>

                        {/* Interactive Product Popover Picker */}
                        {openProductPickerItemId === item.id && (
                          <div
                            className="absolute left-0 right-0 top-full mt-1.5 p-2 rounded-xl border border-[var(--khata-border)] shadow-2xl z-30 space-y-2 animate-in fade-in"
                            style={{ background: 'var(--khata-surface)' }}
                          >
                            <div className="flex items-center justify-between text-[10px] font-bold text-[var(--khata-text-muted)] pb-1 border-b border-[var(--khata-border)]">
                              <span>SELECT PRODUCT FROM CATALOGUE ({availableProducts.length})</span>
                              <button
                                type="button"
                                onClick={() => setOpenProductPickerItemId(null)}
                                className="text-neutral-400 hover:text-neutral-600 p-0.5 cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <input
                              type="text"
                              placeholder="Search products by name or HSN..."
                              value={productPickerSearch}
                              onChange={(e) => setProductPickerSearch(e.target.value)}
                              className="neu-input w-full text-xs p-1.5"
                              autoFocus
                            />
                            <div className="max-h-48 overflow-y-auto space-y-1">
                              {availableProducts
                                .filter(
                                  (p) =>
                                    p.name.toLowerCase().includes(productPickerSearch.toLowerCase()) ||
                                    (p.hsn_code && p.hsn_code.includes(productPickerSearch))
                                )
                                .map((p) => (
                                  <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => {
                                      handleSelectProduct(item.id, p);
                                      setOpenProductPickerItemId(null);
                                      setProductPickerSearch('');
                                    }}
                                    className="w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--khata-surface-inset)] flex items-center justify-between transition"
                                  >
                                    <div>
                                      <span className="font-bold text-[var(--khata-text)] block truncate">{p.name}</span>
                                      {p.hsn_code && (
                                        <span className="text-[10px] text-[var(--khata-text-muted)] font-mono">
                                          HSN: {p.hsn_code}
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-xs font-bold text-[var(--khata-text-muted)] font-mono ml-2">
                                      Ref: ₹{p.buying_price}
                                    </span>
                                  </button>
                                ))}
                              {availableProducts.length === 0 && (
                                <div className="p-2 text-center text-xs text-[var(--khata-text-muted)]">
                                  {isLoadingProducts ? 'Loading catalogue...' : 'No products found.'}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
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
                          step="0.01"
                          min="0.01"
                          max="1000000"
                          inputMode="decimal"
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

                {/* Action Buttons: located on base at the bottom of the bill summary card (matching GST billing) */}
                <div className="space-y-2.5 pt-3 border-t border-[var(--khata-border)]/60">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleResetForm}
                      className="neu-btn-secondary flex-1 py-2.5 flex items-center justify-center gap-1.5 text-xs font-bold"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Reset</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPreviewInvoice(currentInvoiceDraft)}
                      className="neu-btn-secondary flex-1 py-2.5 flex items-center justify-center gap-1.5 text-xs font-bold"
                    >
                      <Eye className="w-4 h-4 text-[var(--khata-accent)]" />
                      <span>Preview Bill</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleSaveBill}
                    disabled={isSaving}
                    className="neu-btn-primary w-full py-3 flex items-center justify-center gap-2 text-sm font-extrabold shadow-md"
                  >
                    {isSaving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Saving Normal Bill...</span>
                      </>
                    ) : (
                      <>
                        <Check className="w-4 h-4" />
                        <span>Save Normal Bill</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
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
              <>
                <div className="hidden md:block overflow-x-auto">
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
                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => setPreviewInvoice(mapNormalBillToInvoiceProps(bill, companyProfile || undefined))}
                                className="neu-btn-secondary text-xs px-2.5 py-1 flex items-center gap-1 font-bold"
                                title="Preview bill"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>View</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDirectPrint(bill)}
                                className="neu-btn-secondary text-xs px-2.5 py-1 flex items-center gap-1 font-bold"
                                title="Print bill"
                              >
                                <Printer className="w-3.5 h-3.5" />
                                <span>Print</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => downloadNormalBillPdf(bill.id, bill.bill_number)}
                                className="neu-btn-primary text-xs px-2.5 py-1 flex items-center gap-1 font-bold"
                                title="Download PDF"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>PDF</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Card View */}
                <div className="md:hidden divide-y divide-[var(--khata-border)]">
                  {historyBills.map((bill) => (
                    <div key={bill.id} className="p-3.5 space-y-2.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-black text-sm text-[var(--khata-accent)]">
                            #{bill.bill_number}
                          </span>
                          <span className="text-[11px] text-[var(--khata-text-muted)] font-mono">
                            {bill.bill_date}
                          </span>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            bill.pdf_status === 'uploaded'
                              ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                              : 'bg-neutral-500/10 text-neutral-600 border border-neutral-500/20'
                          }`}
                        >
                          {bill.pdf_status === 'uploaded' ? 'Saved (R2)' : 'Saved (Local)'}
                        </span>
                      </div>
                      <div>
                        <div className="font-bold text-sm text-[var(--khata-text)]">{bill.customer_name}</div>
                        {bill.customer_phone && (
                          <div className="text-[11px] text-[var(--khata-text-muted)] font-mono">
                            {bill.customer_phone}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <div className="font-black text-base text-[var(--khata-text)]">
                          ₹{Number(bill.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setPreviewInvoice(mapNormalBillToInvoiceProps(bill, companyProfile || undefined))}
                            className="neu-btn-secondary text-xs px-2.5 py-1.5 flex items-center gap-1 font-bold"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDirectPrint(bill)}
                            className="neu-btn-secondary text-xs px-2.5 py-1.5 flex items-center gap-1 font-bold"
                          >
                            <Printer className="w-3.5 h-3.5" />
                            <span>Print</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadNormalBillPdf(bill.id, bill.bill_number)}
                            className="neu-btn-primary text-xs px-2.5 py-1.5 flex items-center gap-1 font-bold"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>PDF</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
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

      {/* Success Record Modal (matching GST invoice experience) */}
      {successRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm mhi-no-print">
          <div
            className="neu-card w-full max-w-md p-6 text-center space-y-4 rounded-2xl border border-[var(--khata-border)]"
            style={{ background: 'var(--khata-surface)' }}
          >
            <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400 mx-auto flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8" />
            </div>

            <div>
              <h3 className="text-lg font-extrabold text-[var(--khata-text)]">
                Normal Bill #{successRecord.bill_number} Created!
              </h3>
              <p className="text-xs text-[var(--khata-text-muted)] mt-1">
                Amount: <strong className="font-mono text-[var(--khata-accent)]">₹{successRecord.total_amount}</strong>
                <br />
                {successRecord.pdf_status === 'uploaded'
                  ? 'Archived securely in Cloudflare R2 object storage.'
                  : 'Bill saved to Neon database.'}
              </p>
            </div>

            <div className="space-y-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setPreviewInvoice(mapNormalBillToInvoiceProps(successRecord, companyProfile || undefined));
                }}
                className="neu-btn-primary w-full py-2.5 flex items-center justify-center gap-2 text-xs font-bold"
              >
                <Printer className="w-4 h-4" />
                <span>Preview &amp; Print A4 Bill</span>
              </button>

              <button
                type="button"
                onClick={() => handleDownloadPdf(successRecord.id, successRecord.bill_number)}
                className="neu-btn-secondary w-full py-2.5 flex items-center justify-center gap-2 text-xs font-bold"
              >
                <Download className="w-4 h-4 text-emerald-600" />
                <span>Download PDF File</span>
              </button>

              <button
                type="button"
                onClick={handleResetForm}
                className="w-full py-2 text-xs text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] font-semibold transition"
              >
                Create Another Bill
              </button>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* ========================================================================= */}
      {/* FULLSCREEN A4 NORMAL BILL PREVIEW MODAL                                   */}
      {/* ========================================================================= */}
      {previewInvoice && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm flex flex-col p-1 sm:p-4 mhi-print-modal-container">
          <div className="max-w-[220mm] mx-auto w-full flex items-center justify-between pb-2 sm:pb-3 text-white mhi-modal-header mhi-no-print">
            <span className="font-bold text-xs sm:text-sm truncate">
              Official Bill · #{previewInvoice.invoiceNumber || 'Draft'}
            </span>
            <button
              type="button"
              onClick={handleClosePreview}
              className="p-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white transition flex items-center gap-1 text-xs font-bold cursor-pointer"
            >
              <X className="w-4 h-4" />
              <span>Close</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <MannatTaxInvoice
              invoice={previewInvoice}
              showPrintButton={true}
              isNormalBill={true}
              billTitle="NORMAL BILL"
              onDownloadPdf={() => {
                if (previewInvoice?.id) {
                  handleDownloadPdf(previewInvoice.id, previewInvoice.invoiceNumber || 'Bill');
                } else if (successRecord?.id) {
                  handleDownloadPdf(successRecord.id, successRecord.bill_number);
                } else {
                  handleDownloadDraftPdf();
                }
              }}
              isDownloadingPdf={isDownloadingPdf}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default NormalBillingView;
