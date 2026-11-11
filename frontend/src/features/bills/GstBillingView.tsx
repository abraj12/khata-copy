import React, { useState, useEffect, useMemo, useRef } from 'react';
import Decimal from 'decimal.js';
import {
  FileText,
  Plus,
  Trash2,
  Printer,
  Download,
  Eye,
  Search,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  Building2,
  User,
  Package,
  X,
} from 'lucide-react';
import MannatTaxInvoice, {
  MannatInvoiceProps,
  numberWords,
} from '../../components/MannatTaxInvoice/MannatTaxInvoice.js';
import {
  getNextInvoiceNumber,
  createGstInvoice,
  listGstInvoices,
  downloadInvoicePdf,
  downloadDraftPdf,
  mapRecordToInvoiceProps,
  GstInvoiceRecord,
} from './gstInvoicesApi.js';
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
  validateQuantityInput,
  validateSellingRateInput,
} from '../../utils/lineItemDraft.js';

interface ProductItem {
  id: number;
  name: string;
  buying_price: string;
  hsn_code?: string | null;
}

interface CustomerItem {
  id: number;
  name: string;
  phone?: string | null;
  address?: string | null;
  gstin?: string | null;
  state?: string | null;
  state_code?: string | null;
}

interface FormLineItem {
  id: string; // client temporary ID
  productId?: number | null;
  description: string;
  hsnCode: string;
  quantity: string;
  unit: string;
  rate: string;
  rateUnit: string;
}

export const getTodayLocalDate = (): string => getBusinessDateISO();

export const GstBillingView: React.FC = () => {
  const [activeSubTab, setActiveSubTab] = useState<'create' | 'history'>('create');

  // Form states (Pre-filled with business timezone IST today's date)
  const [companyProfile, setCompanyProfile] = useState<{
    name: string;
    address: string;
    gstin: string | null;
    phone: string | null;
    state: string;
    stateCode: string;
  } | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [isManualInvoiceNumber, setIsManualInvoiceNumber] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState<string>(() => getBusinessDateISO());
  const [state, setState] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [transportationMode, setTransportationMode] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [dateOfSupply, setDateOfSupply] = useState<string>(() => getBusinessDateISO());
  const [placeOfSupply, setPlaceOfSupply] = useState('');

  // Customer states
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerGstin, setCustomerGstin] = useState('');
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

  // GST rate setting
  const [gstRate, setGstRate] = useState<number>(18);
  const [notes, setNotes] = useState('');

  // UI feedback & modals
  const [isLoadingNextNum, setIsLoadingNextNum] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string>(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  const [successRecord, setSuccessRecord] = useState<GstInvoiceRecord | null>(null);
  const [previewInvoice, setPreviewInvoice] = useState<MannatInvoiceProps | null>(null);
  const [autoPrintAfterPreview, setAutoPrintAfterPreview] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);

  const handleDirectPrint = (inv: GstInvoiceRecord) => {
    setPreviewInvoice(mapRecordToInvoiceProps(inv, companyProfile || undefined));
    setAutoPrintAfterPreview(true);
  };

  const handleClosePreview = () => {
    setPreviewInvoice(null);
    setAutoPrintAfterPreview(false);
  };

  // Trigger print dialog as soon as preview DOM is rendered
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
  const [historyInvoices, setHistoryInvoices] = useState<GstInvoiceRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historySearch, setHistorySearch] = useState('');
  const [historyDateFrom, setHistoryDateFrom] = useState('');
  const [historyDateTo, setHistoryDateTo] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const customerDropdownRef = useRef<HTMLDivElement>(null);
  const productPickerRef = useRef<HTMLDivElement>(null);

  // Close customer & product pickers on outside click
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

  // Fetch initial data (company tax profile, next invoice number, products, customers)
  useEffect(() => {
    loadCompanyProfile();
    fetchNextNumber();
    fetchProducts();
    fetchCustomers();
  }, []);

  const loadCompanyProfile = async () => {
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
      console.warn('Could not load company tax profile:', err);
    }
  };

  const fetchNextNumber = async () => {
    try {
      setIsLoadingNextNum(true);
      const nextNum = await getNextInvoiceNumber();
      setInvoiceNumber(nextNum);
      setIsManualInvoiceNumber(false);
    } catch (err) {
      console.warn('Could not auto-fetch invoice number:', err);
    } finally {
      setIsLoadingNextNum(false);
    }
  };

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

        if (res.data?.data && Array.isArray(res.data.data)) {
          all.push(...res.data.data);
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
      console.warn('Error fetching products:', err);
    } finally {
      setIsLoadingProducts(false);
    }
  };

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
      console.warn('Error fetching customers:', err);
    }
  };

  // Load history when tab is switched
  useEffect(() => {
    if (activeSubTab === 'history') {
      loadHistory();
    }
  }, [activeSubTab, historyPage, historySearch, historyDateFrom, historyDateTo]);

  const loadHistory = async () => {
    try {
      setIsLoadingHistory(true);
      const res = await listGstInvoices({
        search: historySearch,
        dateFrom: historyDateFrom || undefined,
        dateTo: historyDateTo || undefined,
        limit: 15,
        offset: historyPage * 15,
      });
      setHistoryInvoices(res.invoices);
      setHistoryTotal(res.pagination.total);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to load invoice history.');
    } finally {
      setIsLoadingHistory(false);
    }
  };

  // Safe Financial Calculation
  const isIntraState = useMemo(() => {
    return Boolean(
      stateCode.trim() && customerStateCode.trim() && stateCode.trim() === customerStateCode.trim()
    );
  }, [stateCode, customerStateCode]);

  const calculations = useMemo(() => {
    let taxableDec = new Decimal(0);

    const computedItems = items.map((item) => {
      const q = new Decimal(item.quantity || 0);
      const r = new Decimal(item.rate || 0);
      const lineAmt = q.isPositive() && r.isFinite() ? q.times(r).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : new Decimal(0);
      taxableDec = taxableDec.plus(lineAmt);
      return {
        ...item,
        amount: lineAmt.toFixed(2),
      };
    });

    const gstRateDec = new Decimal(gstRate || 0);
    let cgstRateVal = 0;
    let sgstRateVal = 0;
    let igstRateVal = 0;
    let cgstAmountDec = new Decimal(0);
    let sgstAmountDec = new Decimal(0);
    let igstAmountDec = new Decimal(0);

    if (isIntraState) {
      // Synchronize with backend rate calculation: cgst_rate + sgst_rate = gst_rate exactly
      const halfRate = gstRateDec.dividedBy(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const cgstDec = halfRate;
      const sgstDec = gstRateDec.minus(halfRate);
      cgstRateVal = cgstDec.toNumber();
      sgstRateVal = sgstDec.toNumber();
      cgstAmountDec = taxableDec.times(cgstDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      sgstAmountDec = taxableDec.times(sgstDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else {
      igstRateVal = gstRateDec.toNumber();
      igstAmountDec = taxableDec.times(igstRateVal).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }

    const totalTaxDec = cgstAmountDec.plus(sgstAmountDec).plus(igstAmountDec);
    const grandTotalDec = taxableDec.plus(totalTaxDec);
    const words = numberWords(grandTotalDec.toFixed(2));

    return {
      taxableAmount: taxableDec.toFixed(2),
      cgstRate: cgstRateVal > 0 ? cgstRateVal : '',
      cgstAmount: cgstAmountDec.toFixed(2),
      sgstRate: sgstRateVal > 0 ? sgstRateVal : '',
      sgstAmount: sgstAmountDec.toFixed(2),
      igstRate: igstRateVal > 0 ? igstRateVal : '',
      igstAmount: igstAmountDec.toFixed(2),
      taxAmount: totalTaxDec.toFixed(2),
      grandTotal: grandTotalDec.toFixed(2),
      amountInWords: words,
      computedItems,
    };
  }, [items, gstRate, isIntraState]);

  // Current draft mapped to MannatInvoiceProps
  const currentDraftInvoice: MannatInvoiceProps = useMemo(() => {
    return {
      invoiceNumber: invoiceNumber || 'DRAFT',
      invoiceDate,
      transportationMode,
      vehicleNumber,
      dateOfSupply,
      placeOfSupply,
      company: companyProfile || { state, stateCode },
      customer: {
        name: customerName || 'Receiver Name',
        address: customerAddress || '',
        gstin: customerGstin || '',
        state: customerState,
        stateCode: customerStateCode,
      },
      items: calculations.computedItems.map((itm) => ({
        id: itm.id,
        name: itm.description || 'Description of goods',
        hsn: itm.hsnCode,
        quantity: itm.quantity,
        unit: itm.unit,
        rate: itm.rate,
        rateUnit: itm.rateUnit,
        amount: itm.amount,
      })),
      totals: {
        taxableAmount: calculations.taxableAmount,
        cgstRate: calculations.cgstRate,
        cgstAmount: calculations.cgstAmount,
        sgstRate: calculations.sgstRate,
        sgstAmount: calculations.sgstAmount,
        igstRate: calculations.igstRate,
        igstAmount: calculations.igstAmount,
        taxAmount: calculations.taxAmount,
        grandTotal: calculations.grandTotal,
      },
      amountInWords: calculations.amountInWords,
    };
  }, [
    invoiceNumber,
    invoiceDate,
    transportationMode,
    vehicleNumber,
    dateOfSupply,
    placeOfSupply,
    customerName,
    customerAddress,
    customerGstin,
    customerState,
    customerStateCode,
    companyProfile,
    state,
    stateCode,
    calculations,
  ]);

  // Add line item
  const handleAddItem = () => {
    setItems((prev) => [
      ...prev,
      {
        id: `item-${Date.now()}-${Math.random()}`,
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

  // Remove line item
  const handleRemoveItem = (id: string) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  // Update line item
  const handleItemChange = (id: string, field: keyof FormLineItem, val: string) => {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, [field]: val } : i))
    );
  };

  // Handle selecting an existing product
  const handleSelectProduct = (itemId: string, product: ProductItem) => {
    setItems((prev) =>
      prev.map((i) => {
        if (i.id === itemId) {
          const updated = applyCatalogProductToDraftLine(i, product);
          return {
            ...i,
            productId: updated.productId,
            description: updated.description,
            hsnCode: updated.hsnCode,
            rate: updated.rate,
          };
        }
        return i;
      })
    );
  };

  // Handle selecting an existing customer
  const handleSelectCustomer = (c: CustomerItem) => {
    setCustomerId(Number(c.id));
    setCustomerName(c.name);
    setCustomerAddress(c.address || '');
    setCustomerGstin(c.gstin || '');
    const resolvedState = resolveCustomerStateSelection(c);
    setCustomerState(resolvedState.state);
    setCustomerStateCode(resolvedState.stateCode);
    setIsCustomerDropdownOpen(false);
  };

  const validateGstForm = (requireCustomerName: boolean): string | null => {
    if (!state.trim() || !stateCode.trim()) {
      return 'Company tax profile is incomplete. Please configure your Seller State in Quotations Company Settings.';
    }
    if (requireCustomerName && !customerName.trim()) {
      return 'Please enter the customer / receiver name.';
    }
    if (!customerState.trim() || !customerStateCode.trim()) {
      return 'Please select the Customer State & State Code for GST calculation.';
    }
    for (let idx = 0; idx < items.length; idx++) {
      const itm = items[idx];
      if (!itm.description.trim()) {
        return `Item #${idx + 1}: Description is required.`;
      }
      const qtyErr = validateQuantityInput(itm.quantity, `Item #${idx + 1} quantity`);
      if (qtyErr) return qtyErr;
      const rateErr = validateSellingRateInput(itm.rate, `Item #${idx + 1} selling rate`);
      if (rateErr) return rateErr;
    }
    return null;
  };

  // Save Invoice
  const handleSaveInvoice = async () => {
    setErrorMessage(null);

    const validationErr = validateGstForm(true);
    if (validationErr) {
      setErrorMessage(validationErr);
      return;
    }

    try {
      setIsSaving(true);
      const created = await createGstInvoice({
        idempotencyKey: idempotencyKeyRef.current,
        invoiceNumber: isManualInvoiceNumber ? invoiceNumber.trim() || undefined : undefined,
        invoiceDate,
        state,
        stateCode,
        transportationMode: transportationMode.trim() || null,
        vehicleNumber: vehicleNumber.trim() || null,
        dateOfSupply,
        placeOfSupply,
        customerId: customerId ? Number(customerId) : null,
        customerName: customerName.trim(),
        customerAddress: customerAddress.trim() || null,
        customerGstin: customerGstin.trim() || null,
        customerState: customerState.trim(),
        customerStateCode: customerStateCode.trim(),
        gstRate,
        items: items.map((i) => ({
          productId: i.productId ? Number(i.productId) : null,
          description: i.description.trim(),
          hsnCode: i.hsnCode.trim() || null,
          quantity: i.quantity,
          unit: i.unit.trim() || null,
          rate: i.rate,
          rateUnit: i.rateUnit.trim() || null,
        })),
        notes: notes.trim() || null,
      });

      setSuccessRecord(created);
      // Auto-fetch next sequential invoice number from server for the next bill
      fetchNextNumber();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to save GST invoice.');
    } finally {
      setIsSaving(false);
    }
  };

  // Reset form after saving
  const handleResetForm = () => {
    idempotencyKeyRef.current = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    setSuccessRecord(null);
    setInvoiceDate(getBusinessDateISO());
    setDateOfSupply(getBusinessDateISO());
    setCustomerName('');
    setCustomerAddress('');
    setCustomerGstin('');
    setCustomerState('');
    setCustomerStateCode('');
    setCustomerId(null);
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
    fetchNextNumber();
  };

  // Download PDF helper
  const handleDownloadPdf = async (id: number, invNum: string) => {
    try {
      setIsDownloadingPdf(true);
      await downloadInvoicePdf(id, invNum);
    } catch (err: any) {
      alert(err.message || 'Unable to download PDF.');
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  // Download draft vector PDF helper
  const handleDownloadDraftPdf = async () => {
    const validationErr = validateGstForm(false);
    if (validationErr) {
      setErrorMessage(validationErr);
      return;
    }
    try {
      setIsDownloadingPdf(true);
      await downloadDraftPdf({
        invoiceNumber: isManualInvoiceNumber ? invoiceNumber.trim() || undefined : undefined,
        invoiceDate,
        state,
        stateCode,
        transportationMode: transportationMode.trim() || null,
        vehicleNumber: vehicleNumber.trim() || null,
        dateOfSupply,
        placeOfSupply,
        customerId: customerId ? Number(customerId) : null,
        customerName: customerName.trim() || 'Customer / Receiver',
        customerAddress: customerAddress.trim() || null,
        customerGstin: customerGstin.trim() || null,
        customerState: customerState.trim(),
        customerStateCode: customerStateCode.trim(),
        gstRate,
        items: items.map((i) => ({
          productId: i.productId ? Number(i.productId) : null,
          description: i.description.trim() || 'Item Description',
          hsnCode: i.hsnCode.trim() || null,
          quantity: i.quantity || '1',
          unit: i.unit.trim() || null,
          rate: i.rate,
          rateUnit: i.rateUnit.trim() || null,
        })),
        notes: notes.trim() || null,
      });
    } catch (err: any) {
      alert(err.message || 'Unable to download draft PDF.');
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="mhi-no-print space-y-6">
        {/* Top Banner & Tab Controls */}
      <div
        className="p-4 sm:p-6 rounded-2xl border border-[var(--khata-border)] flex flex-wrap items-center justify-between gap-4"
        style={{ background: 'var(--khata-surface)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center border border-[var(--khata-border)] shadow-sm"
            style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-accent)' }}
          >
            <FileText className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg sm:text-xl font-bold tracking-tight text-[var(--khata-text)] flex flex-wrap items-center gap-2">
              <span>GST Tax Invoices</span>
              <span
                className="text-xs px-2.5 py-0.5 rounded-md font-mono font-bold border border-[var(--khata-border)]"
                style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-accent)' }}
              >
                {companyProfile?.name || 'Company Tax Profile'}
              </span>
            </h2>
            <p className="text-xs text-[var(--khata-text-muted)] mt-0.5">
              Create, preview, print A4 tax invoices and archive official PDFs in Cloudflare R2.
            </p>
          </div>
        </div>

        {/* Sub-tab Navigation */}
        <div className="w-full sm:w-auto grid grid-cols-2 sm:flex items-center gap-1.5 sm:gap-2 bg-[var(--khata-surface-inset)] p-1 rounded-xl border border-[var(--khata-border)]">
          <button
            type="button"
            onClick={() => setActiveSubTab('create')}
            className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              activeSubTab === 'create'
                ? 'bg-[var(--khata-accent)] text-white shadow-sm'
                : 'text-[var(--khata-text)] hover:text-[var(--khata-accent)]'
            }`}
          >
            <Plus className="w-4 h-4" />
            <span>Create GST Bill</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('history')}
            className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              activeSubTab === 'history'
                ? 'bg-[var(--khata-accent)] text-white shadow-sm'
                : 'text-[var(--khata-text)] hover:text-[var(--khata-accent)]'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>Invoice History</span>
            {historyTotal > 0 && (
              <span className="ml-1 px-1.5 py-0.2 bg-white/20 rounded-full text-[10px]">
                {historyTotal}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Error alert */}
      {errorMessage && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 dark:bg-rose-950/30 dark:border-rose-900 flex items-center justify-between text-rose-700 dark:text-rose-400 text-sm">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-500 hover:text-rose-700 font-bold"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* TAB 1: CREATE GST BILL */}
      {activeSubTab === 'create' && (
        <div className="space-y-6">
          {/* Main Grid: Form Sections */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left 2 Cols: Form Inputs */}
            <div className="lg:col-span-2 space-y-6">
              {/* Section A: Invoice Information */}
              <div
                className="p-5 rounded-2xl border border-[var(--khata-border)] space-y-4"
                style={{ background: 'var(--khata-surface)' }}
              >
                <div className="flex items-center justify-between pb-2 border-b border-[var(--khata-border)]">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-[var(--khata-text-muted)] flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-[var(--khata-accent)]" />
                    <span>A. Invoice Information</span>
                  </h3>
                  <button
                    type="button"
                    onClick={fetchNextNumber}
                    disabled={isLoadingNextNum}
                    title="Get next sequential number"
                    className="text-xs font-semibold text-[var(--khata-accent)] hover:underline flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3 h-3 ${isLoadingNextNum ? 'animate-spin' : ''}`} />
                    <span>Auto-Number</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-bold text-[var(--khata-text-muted)]">
                        Invoice No. <span className="text-rose-500">*</span>
                      </label>
                      <button
                        type="button"
                        onClick={fetchNextNumber}
                        disabled={isLoadingNextNum}
                        title="Sync next sequential invoice number from database"
                        className="text-[10px] font-semibold text-[var(--khata-accent)] hover:underline flex items-center gap-1 cursor-pointer"
                      >
                        <RefreshCw className={`w-2.5 h-2.5 ${isLoadingNextNum ? 'animate-spin' : ''}`} />
                        <span>Auto-Seq</span>
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        type="text"
                        value={invoiceNumber}
                        onChange={(e) => {
                          setInvoiceNumber(e.target.value);
                          setIsManualInvoiceNumber(true);
                        }}
                        placeholder={isLoadingNextNum ? 'Fetching...' : 'e.g. 001'}
                        className="neu-input w-full font-mono font-bold text-sm tracking-wide"
                      />
                      {isLoadingNextNum && (
                        <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-bold text-[var(--khata-text-muted)]">
                        Invoice Date <span className="text-rose-500">*</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setInvoiceDate(getBusinessDateISO())}
                        className="text-[10px] font-semibold text-[var(--khata-accent)] hover:underline flex items-center gap-1 cursor-pointer"
                        title="Set to today's IST business date"
                      >
                        <span>Today</span>
                      </button>
                    </div>
                    <input
                      type="date"
                      value={invoiceDate}
                      onChange={(e) => setInvoiceDate(e.target.value)}
                      className="neu-input w-full font-medium"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-[var(--khata-text-muted)] mb-1">
                      Seller State
                    </label>
                    <input
                      type="text"
                      value={state && stateCode ? `${state} (${stateCode})` : 'Configure in Quotations Settings'}
                      readOnly
                      className="neu-input w-full font-bold cursor-default"
                      style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-text)' }}
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-[var(--khata-text-muted)] mb-1">
                      Place of Supply
                    </label>
                    <input
                      type="text"
                      value={placeOfSupply}
                      onChange={(e) => setPlaceOfSupply(e.target.value)}
                      className="neu-input w-full"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-[var(--khata-text-muted)] mb-1">
                      Transportation Mode
                    </label>
                    <input
                      type="text"
                      value={transportationMode}
                      onChange={(e) => setTransportationMode(e.target.value)}
                      placeholder="e.g. Road / Tempo"
                      className="neu-input w-full"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-[var(--khata-text-muted)] mb-1">
                      Vehicle No.
                    </label>
                    <input
                      type="text"
                      value={vehicleNumber}
                      onChange={(e) => setVehicleNumber(e.target.value)}
                      placeholder="e.g. UP-22-AB-1234"
                      className="neu-input w-full font-mono"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-bold text-[var(--khata-text-muted)]">
                        Date of Supply
                      </label>
                      <button
                        type="button"
                        onClick={() => setDateOfSupply(getBusinessDateISO())}
                        className="text-[10px] font-semibold text-[var(--khata-accent)] hover:underline flex items-center gap-1 cursor-pointer"
                        title="Set to today's local date"
                      >
                        <span>Today</span>
                      </button>
                    </div>
                    <input
                      type="date"
                      value={dateOfSupply}
                      onChange={(e) => setDateOfSupply(e.target.value)}
                      className="neu-input w-full font-medium"
                    />
                  </div>
                </div>
              </div>

              {/* Section B: Customer Details */}
              <div
                className="p-5 rounded-2xl border border-[var(--khata-border)] space-y-4"
                style={{ background: 'var(--khata-surface)' }}
              >
                <div className="flex items-center justify-between pb-2 border-b border-[var(--khata-border)]">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-[var(--khata-text-muted)] flex items-center gap-2">
                    <User className="w-4 h-4 text-[var(--khata-accent)]" />
                    <span>B. Customer / Receiver Details (Bill To Party)</span>
                  </h3>

                  {/* Customer picker dropdown */}
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
                        className="absolute right-0 top-full mt-2 w-72 max-w-[85vw] p-2 rounded-xl border border-[var(--khata-border)] shadow-xl z-20 space-y-2"
                        style={{ background: 'var(--khata-surface)' }}
                      >
                        <input
                          type="text"
                          placeholder="Search customer..."
                          value={customerSearch}
                          onChange={(e) => setCustomerSearch(e.target.value)}
                          className="neu-input w-full text-xs p-1.5"
                        />
                        <div className="max-h-48 overflow-y-auto space-y-1">
                          {availableCustomers
                            .filter((c) =>
                              c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
                              (c.phone && c.phone.includes(customerSearch))
                            )
                            .map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => handleSelectCustomer(c)}
                                className="w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--khata-surface-inset)] flex items-center justify-between"
                              >
                                <div>
                                  <span className="font-bold text-[var(--khata-text)] block truncate">{c.name}</span>
                                  {c.address && (
                                    <span className="text-[10px] text-[var(--khata-text-muted)] block truncate max-w-[180px]">
                                      {c.address}
                                    </span>
                                  )}
                                </div>
                                {c.phone && <span className="text-[10px] text-[var(--khata-text-muted)] font-mono ml-2">{c.phone}</span>}
                              </button>
                            ))}
                          {availableCustomers.length === 0 && (
                            <div className="p-2 text-center text-xs text-[var(--khata-text-muted)]">
                              No Khata customers found.
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  <div className="sm:col-span-2">
                    <div className="flex items-center justify-between mb-1">
                      <label className="block font-bold text-[var(--khata-text-muted)]">
                        Customer / Firm Name <span className="text-rose-500">*</span>
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
                    <input
                      type="text"
                      value={customerName}
                      onChange={(e) => {
                        setCustomerName(e.target.value);
                        if (customerId) {
                          setCustomerId(null);
                        }
                      }}
                      placeholder="e.g. Sharma Construction Co. / M/s ABC Enterprises"
                      className="neu-input w-full font-bold"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-[var(--khata-text-muted)] mb-1">
                      Customer GSTIN <span className="text-neutral-400 font-normal">(Optional)</span>
                    </label>
                    <input
                      type="text"
                      value={customerGstin}
                      onChange={(e) => setCustomerGstin(e.target.value.toUpperCase())}
                      placeholder="e.g. 10ABGCA8624E1Z3"
                      maxLength={15}
                      className="neu-input w-full font-mono uppercase"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block font-bold text-[var(--khata-text-muted)] mb-1">
                      Customer Address
                    </label>
                    <input
                      type="text"
                      value={customerAddress}
                      onChange={(e) => setCustomerAddress(e.target.value)}
                      placeholder="e.g. Street / Locality, City"
                      className="neu-input w-full"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="sm:col-span-2">
                      <label className="block font-bold text-[var(--khata-text-muted)] mb-1">
                        Customer State <span className="text-rose-500">*</span>
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
                        className="neu-input w-full font-medium"
                      >
                        <option value="">Select customer state</option>
                        {INDIAN_STATES.map((s) => (
                          <option key={s.code} value={s.code}>
                            {s.code} – {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-bold text-[var(--khata-text-muted)] mb-1">
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
                        className="neu-input w-full font-mono text-center font-bold"
                      />
                    </div>
                  </div>
                </div>

                {customerStateCode && stateCode && !isIntraState && (
                  <div className="text-[11px] p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 font-semibold">
                    ⚡ Inter-State transaction detected (Supplier State Code: {stateCode} ≠ Customer State Code: {customerStateCode}). IGST will be applied automatically instead of CGST + SGST.
                  </div>
                )}
              </div>

              {/* Section C: Product Selection & Line Items */}
              <div
                className="p-5 rounded-2xl border border-[var(--khata-border)] space-y-4"
                style={{ background: 'var(--khata-surface)' }}
              >
                <div className="flex items-center justify-between pb-2 border-b border-[var(--khata-border)]">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-[var(--khata-text-muted)] flex items-center gap-2">
                    <Package className="w-4 h-4 text-[var(--khata-accent)]" />
                    <span>C. Product Selection &amp; Line Items</span>
                  </h3>
                  <button
                    type="button"
                    onClick={handleAddItem}
                    className="neu-btn-primary text-xs px-3 py-1.5 flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Item</span>
                  </button>
                </div>

                {/* Items Table Form */}
                <div className="space-y-4">
                  {items.map((item, idx) => (
                    <div
                      key={item.id}
                      className="p-4 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-3 text-xs"
                    >
                      <div className="flex items-center justify-between pb-1 border-b border-[var(--khata-border)]/50">
                        <span className="font-bold text-[var(--khata-text)] text-xs flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full bg-[var(--khata-accent)] text-white flex items-center justify-center text-[10px] font-bold">
                            {idx + 1}
                          </span>
                          <span>Line Item #{idx + 1}</span>
                        </span>

                        {items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveItem(item.id)}
                            className="text-rose-500 hover:text-rose-700 p-1 rounded flex items-center gap-1 text-xs font-semibold"
                            title="Remove item"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Remove</span>
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
                            list={`product-options-${item.id}`}
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
                          <datalist id={`product-options-${item.id}`}>
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
                                      className="w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--khata-surface-inset)] flex items-center justify-between transition cursor-pointer"
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

                      {/* Row 2: 5 Spacious Numeric Columns (HSN, Qty, Unit, Rate, Amount) */}
                      <div className="grid grid-cols-2 sm:grid-cols-12 gap-3 pt-1">
                        {/* HSN Code */}
                        <div className="col-span-1 sm:col-span-2">
                          <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                            HSN Code
                          </label>
                          <input
                            type="text"
                            value={item.hsnCode}
                            onChange={(e) => handleItemChange(item.id, 'hsnCode', e.target.value)}
                            placeholder="e.g. 44119219"
                            maxLength={20}
                            className="neu-input w-full font-mono text-center sm:text-left text-xs"
                          />
                        </div>

                        {/* Quantity */}
                        <div className="col-span-1 sm:col-span-2">
                          <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                            Quantity <span className="text-rose-500">*</span>
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
                            className="neu-input w-full font-bold text-center text-sm"
                          />
                        </div>

                        {/* Unit */}
                        <div className="col-span-1 sm:col-span-2">
                          <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                            Unit
                          </label>
                          <input
                            type="text"
                            value={item.unit}
                            onChange={(e) => handleItemChange(item.id, 'unit', e.target.value)}
                            placeholder="pcs"
                            className="neu-input w-full text-center text-xs"
                          />
                        </div>

                        {/* Rate (₹) - Spacious width, easy to view & edit numbers */}
                        <div className="col-span-1 sm:col-span-3">
                          <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                            Rate (₹) <span className="text-rose-500">*</span>
                          </label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            inputMode="decimal"
                            value={item.rate}
                            onChange={(e) => handleItemChange(item.id, 'rate', e.target.value)}
                            placeholder="0.00"
                            className="neu-input w-full font-bold text-right font-mono text-sm px-3"
                          />
                        </div>

                        {/* Amount (₹) - High contrast, dedicated wide container */}
                        <div className="col-span-2 sm:col-span-3">
                          <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                            Amount (₹)
                          </label>
                          <div
                            className="neu-input w-full font-extrabold text-right font-mono text-sm flex items-center justify-end px-3 select-all"
                            style={{
                              background: 'var(--khata-surface)',
                              color: 'var(--khata-text)',
                            }}
                          >
                            ₹{calculations.computedItems[idx]?.amount || '0.00'}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right 1 Col: GST Calculation Summary & Actions */}
            <div className="space-y-6">
              {/* Section D: GST Calculation Settings */}
              <div
                className="p-5 rounded-2xl border border-[var(--khata-border)] space-y-4"
                style={{ background: 'var(--khata-surface)' }}
              >
                <h3 className="text-sm font-bold uppercase tracking-wider text-[var(--khata-text-muted)] pb-2 border-b border-[var(--khata-border)]">
                  D. GST Rates &amp; Summary
                </h3>

                {/* GST Rate Preset Buttons */}
                <div>
                  <label className="block text-xs font-bold text-[var(--khata-text-muted)] mb-1.5">
                    GST Rate Applicable
                  </label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[18, 28, 12, 5].map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setGstRate(r)}
                        className={`py-1.5 px-2 rounded-lg text-xs font-bold border transition ${
                          gstRate === r
                            ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-sm'
                            : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
                        }`}
                      >
                        {r}%
                      </button>
                    ))}
                  </div>
                </div>

                {/* Financial Summary Card */}
                <div className="p-3.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] space-y-2 text-xs">
                  <div className="flex items-center justify-between text-[var(--khata-text-muted)]">
                    <span>T. Amt. Before Tax:</span>
                    <span className="font-mono font-bold text-[var(--khata-text)]">
                      ₹{calculations.taxableAmount}
                    </span>
                  </div>

                  {!customerStateCode ? (
                    <div className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold">
                      Select Customer State above to compute CGST/SGST vs IGST.
                    </div>
                  ) : isIntraState ? (
                    <>
                      <div className="flex items-center justify-between text-[var(--khata-text-muted)]">
                        <span>CGST @ {calculations.cgstRate}%:</span>
                        <span className="font-mono font-bold text-[var(--khata-text)]">
                          ₹{calculations.cgstAmount}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[var(--khata-text-muted)]">
                        <span>SGST @ {calculations.sgstRate}%:</span>
                        <span className="font-mono font-bold text-[var(--khata-text)]">
                          ₹{calculations.sgstAmount}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-between text-[var(--khata-text-muted)]">
                      <span>IGST @ {calculations.igstRate}%:</span>
                      <span className="font-mono font-bold text-[var(--khata-text)]">
                        ₹{calculations.igstAmount}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-[var(--khata-text-muted)]">
                    <span>Total Tax Amount GST:</span>
                    <span className="font-mono font-bold text-[var(--khata-text)]">
                      ₹{calculations.taxAmount}
                    </span>
                  </div>

                  <div className="pt-2 border-t border-[var(--khata-border)] flex items-center justify-between text-sm font-extrabold text-[var(--khata-accent)]">
                    <span>Grand Total:</span>
                    <span className="font-mono text-base">₹{calculations.grandTotal}</span>
                  </div>
                </div>

                {/* Amount in words */}
                <div className="text-[11px] italic text-[var(--khata-text-muted)] leading-tight p-2 rounded-lg bg-[var(--khata-surface-inset)] border border-[var(--khata-border)]">
                  <strong className="not-italic font-bold">In Words:</strong> {calculations.amountInWords}
                </div>

                {/* Action Buttons */}
                <div className="space-y-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setPreviewInvoice(currentDraftInvoice)}
                    className="neu-btn-secondary w-full py-2.5 flex items-center justify-center gap-2 text-xs font-bold"
                  >
                    <Eye className="w-4 h-4 text-[var(--khata-accent)]" />
                    <span>Preview A4 Invoice</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleSaveInvoice}
                    disabled={isSaving}
                    className="neu-btn-primary w-full py-3 flex items-center justify-center gap-2 text-sm font-extrabold shadow-md"
                  >
                    {isSaving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Saving &amp; Archiving in R2...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Save &amp; Generate Invoice</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: INVOICE HISTORY */}
      {activeSubTab === 'history' && (
        <div
          className="p-5 rounded-2xl border border-[var(--khata-border)] space-y-4"
          style={{ background: 'var(--khata-surface)' }}
        >
          {/* Filters */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
            <div className="sm:col-span-2 relative">
              <Search className="w-4 h-4 absolute left-3 top-3 text-neutral-400" />
              <input
                type="text"
                placeholder="Search by invoice # or customer name..."
                value={historySearch}
                onChange={(e) => {
                  setHistorySearch(e.target.value);
                  setHistoryPage(0);
                }}
                className="neu-input w-full pl-9"
              />
            </div>
            <div>
              <input
                type="date"
                value={historyDateFrom}
                onChange={(e) => {
                  setHistoryDateFrom(e.target.value);
                  setHistoryPage(0);
                }}
                className="neu-input w-full text-xs"
                placeholder="From Date"
              />
            </div>
            <div>
              <input
                type="date"
                value={historyDateTo}
                onChange={(e) => {
                  setHistoryDateTo(e.target.value);
                  setHistoryPage(0);
                }}
                className="neu-input w-full text-xs"
                placeholder="To Date"
              />
            </div>
          </div>

          {/* Table */}
          {isLoadingHistory ? (
            <div className="py-16 text-center text-xs text-[var(--khata-text-muted)] flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--khata-accent)]" />
              <span>Loading invoice history...</span>
            </div>
          ) : historyInvoices.length === 0 ? (
            <div className="py-16 text-center text-xs text-[var(--khata-text-muted)] border border-dashed border-[var(--khata-border)] rounded-xl">
              No GST invoices found. Create your first GST bill using the "Create GST Bill" tab!
            </div>
          ) : (
            <>
              {/* Desktop Table View */}
              <div className="hidden md:block overflow-x-auto rounded-xl border border-[var(--khata-border)]">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)] font-bold uppercase tracking-wider border-b border-[var(--khata-border)]">
                    <tr>
                      <th className="py-3 px-4">Invoice #</th>
                      <th className="py-3 px-4">Date</th>
                      <th className="py-3 px-4">Customer</th>
                      <th className="py-3 px-4 text-right">Taxable (₹)</th>
                      <th className="py-3 px-4 text-right">Tax (₹)</th>
                      <th className="py-3 px-4 text-right">Total (₹)</th>
                      <th className="py-3 px-4 text-center">PDF</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--khata-border)] font-medium">
                    {historyInvoices.map((inv) => (
                      <tr key={inv.id} className="hover:bg-[var(--khata-surface-inset)]/50 transition">
                        <td className="py-3 px-4 font-mono font-bold text-[var(--khata-accent)]">
                          {inv.invoice_number}
                        </td>
                        <td className="py-3 px-4 text-[var(--khata-text-muted)]">
                          {inv.invoice_date}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-bold text-[var(--khata-text)]">{inv.customer_name}</div>
                          <div className="text-[10px] text-[var(--khata-text-muted)]">{inv.customer_state}</div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono">
                          ₹{inv.taxable_amount}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-[var(--khata-text-muted)]">
                          ₹{inv.tax_amount}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-[var(--khata-accent)]">
                          ₹{inv.grand_total}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              inv.pdf_status === 'uploaded'
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                                : 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                            }`}
                          >
                            {inv.pdf_status === 'uploaded' ? 'R2 Synced' : 'Ready'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setPreviewInvoice(mapRecordToInvoiceProps(inv, companyProfile || undefined))}
                              className="p-1.5 rounded-lg border border-[var(--khata-border)] hover:bg-[var(--khata-surface)] text-[var(--khata-text)] cursor-pointer"
                              title="Preview A4 Invoice"
                            >
                              <Eye className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                            </button>

                            <button
                              type="button"
                              onClick={() => handleDirectPrint(inv)}
                              className="p-1.5 rounded-lg border border-[var(--khata-border)] hover:bg-[var(--khata-surface)] text-blue-600 dark:text-blue-400 cursor-pointer"
                              title="Print A4 Invoice"
                            >
                              <Printer className="w-3.5 h-3.5 text-blue-600" />
                            </button>

                            <button
                              type="button"
                              onClick={() => handleDownloadPdf(inv.id, inv.invoice_number)}
                              disabled={isDownloadingPdf}
                              className="p-1.5 rounded-lg border border-[var(--khata-border)] hover:bg-[var(--khata-surface)] text-[var(--khata-text)] cursor-pointer"
                              title="Download PDF"
                            >
                              <Download className="w-3.5 h-3.5 text-emerald-600" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile Card View */}
              <div className="md:hidden space-y-3">
                {historyInvoices.map((inv) => (
                  <div
                    key={inv.id}
                    className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-sm text-[var(--khata-accent)]">
                          #{inv.invoice_number}
                        </span>
                        <span className="text-[11px] text-[var(--khata-text-muted)]">
                          {inv.invoice_date}
                        </span>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          inv.pdf_status === 'uploaded'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                        }`}
                      >
                        {inv.pdf_status === 'uploaded' ? 'R2 Synced' : 'Ready'}
                      </span>
                    </div>

                    <div className="pb-1 border-b border-[var(--khata-border)]/50">
                      <div className="font-bold text-[var(--khata-text)] text-sm">{inv.customer_name}</div>
                      {inv.customer_address && (
                        <div className="text-[11px] text-[var(--khata-text-muted)] truncate">{inv.customer_address}</div>
                      )}
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[10px] text-[var(--khata-text-muted)]">Grand Total (incl. GST)</div>
                        <div className="font-mono font-extrabold text-base text-[var(--khata-accent)]">
                          ₹{inv.grand_total}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          type="button"
                          onClick={() => setPreviewInvoice(mapRecordToInvoiceProps(inv, companyProfile || undefined))}
                          className="neu-btn-secondary px-2.5 py-1.5 flex items-center gap-1 text-xs font-bold"
                          title="Preview Invoice"
                        >
                          <Eye className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                          <span>View</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDirectPrint(inv)}
                          className="neu-btn-secondary px-2.5 py-1.5 flex items-center gap-1 text-xs font-bold text-blue-600 dark:text-blue-400"
                          title="Print A4 Invoice"
                        >
                          <Printer className="w-3.5 h-3.5 text-blue-600" />
                          <span>Print</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownloadPdf(inv.id, inv.invoice_number)}
                          disabled={isDownloadingPdf}
                          className="neu-btn-primary px-2.5 py-1.5 flex items-center gap-1 text-xs font-bold"
                          title="Download PDF"
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

          {/* Pagination */}
          {historyTotal > 15 && (
            <div className="flex items-center justify-between text-xs pt-2">
              <span className="text-[var(--khata-text-muted)]">
                Showing {historyPage * 15 + 1} - {Math.min((historyPage + 1) * 15, historyTotal)} of {historyTotal}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={historyPage === 0}
                  onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
                  className="neu-btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={(historyPage + 1) * 15 >= historyTotal}
                  onClick={() => setHistoryPage((p) => p + 1)}
                  className="neu-btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Success Modal */}
      {successRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div
            className="neu-card w-full max-w-md p-6 text-center space-y-4 rounded-2xl border border-[var(--khata-border)]"
            style={{ background: 'var(--khata-surface)' }}
          >
            <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400 mx-auto flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8" />
            </div>

            <div>
              <h3 className="text-lg font-extrabold text-[var(--khata-text)]">
                Invoice #{successRecord.invoice_number} Created!
              </h3>
              <p className="text-xs text-[var(--khata-text-muted)] mt-1">
                Amount: <strong className="font-mono text-[var(--khata-accent)]">₹{successRecord.grand_total}</strong>
                <br />
                {successRecord.pdf_status === 'uploaded'
                  ? 'Archived securely in Cloudflare R2 object storage.'
                  : 'Invoice saved to Neon database.'}
              </p>
            </div>

            <div className="space-y-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setPreviewInvoice(mapRecordToInvoiceProps(successRecord, companyProfile || undefined));
                }}
                className="neu-btn-primary w-full py-2.5 flex items-center justify-center gap-2 text-xs font-bold"
              >
                <Printer className="w-4 h-4" />
                <span>Preview &amp; Print A4 Invoice</span>
              </button>

              <button
                type="button"
                onClick={() => handleDownloadPdf(successRecord.id, successRecord.invoice_number)}
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
                Create Another Invoice
              </button>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Fullscreen A4 Invoice Preview Modal */}
      {previewInvoice && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm flex flex-col p-1 sm:p-4 mhi-print-modal-container">
          <div className="max-w-[220mm] mx-auto w-full flex items-center justify-between pb-2 sm:pb-3 text-white mhi-modal-header mhi-no-print">
            <span className="font-bold text-xs sm:text-sm truncate">
              Official Tax Invoice · {previewInvoice.invoiceNumber}
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
              onDownloadPdf={() => {
                if (previewInvoice?.id) {
                  handleDownloadPdf(previewInvoice.id, previewInvoice.invoiceNumber || 'Invoice');
                } else if (successRecord?.id) {
                  handleDownloadPdf(successRecord.id, successRecord.invoice_number);
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
