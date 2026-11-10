import React, { useState, useEffect, useCallback } from 'react';
import Decimal from 'decimal.js';
import {
  FileText,
  Plus,
  Trash2,
  Scan,
  Eye,
  Save,
  Send,
  Loader2,
  AlertCircle,
  User,
} from 'lucide-react';
import {
  QuotationItem,
  CreateQuotationPayload,
  QuotationSettings,
  Quotation,
} from './quotation.types.js';
import {
  fetchNextQuotationNumber,
  fetchQuotationSettings,
  createQuotation,
  updateQuotationStatus,
} from './quotationApi.js';
import { BarcodeScannerModal } from '../barcode/BarcodeScannerModal.js';
import { useHardwareBarcodeScanner } from '../barcode/useHardwareBarcodeScanner.js';
import { fetchProductByBarcode } from '../barcode/barcodeApi.js';
import { QuotationPreview } from './QuotationPreview.js';
import { apiClient } from '../../lib/apiClient.js';
import { formatCurrency } from '../../lib/formatters.js';

export interface QuotationEditorProps {
  onCancel: () => void;
  onSaved: (quotation: Quotation) => void;
}

export const QuotationEditor: React.FC<QuotationEditorProps> = ({ onCancel, onSaved }) => {
  const [settings, setSettings] = useState<QuotationSettings | null>(null);
  const [quotationNumber, setQuotationNumber] = useState('QT-001');
  const [quotationDate, setQuotationDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [validUntil, setValidUntil] = useState('');

  // Customer
  const [customerName, setCustomerName] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerGstin, setCustomerGstin] = useState('');
  const [customerStateCode, setCustomerStateCode] = useState('10');
  const [customerSearch, setCustomerSearch] = useState('');
  const [matchedCustomers, setMatchedCustomers] = useState<any[]>([]);
  const [isSearchingCustomer, setIsSearchingCustomer] = useState(false);

  // Project
  const [projectTitle, setProjectTitle] = useState('');
  const [subject, setSubject] = useState('');

  // Items
  const [items, setItems] = useState<QuotationItem[]>([
    {
      description: '',
      hsnCode: '',
      barcode: '',
      quantity: 1,
      unit: 'pcs',
      rate: '0.00',
      rateUnit: 'pcs',
      amount: '0.00',
    },
  ]);

  // Product Autocomplete for active item row
  const [productSearchResults, setProductSearchResults] = useState<{ [rowIdx: number]: any[] }>({});

  // Discount
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed' | null>(null);
  const [discountValue, setDiscountValue] = useState<string>('0');

  // GST
  const [gstEnabled, setGstEnabled] = useState(false);
  const [gstRate, setGstRate] = useState<number>(18);
  const [isIntraState, setIsIntraState] = useState(true);

  // Terms & Notes
  const [terms, setTerms] = useState('');
  const [notes, setNotes] = useState('');

  // State
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Scanner modal state
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  // Preview modal state
  const [previewPayload, setPreviewPayload] = useState<CreateQuotationPayload | null>(null);

  // Load initial settings & next quotation number
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [nextNum, s] = await Promise.all([
          fetchNextQuotationNumber(),
          fetchQuotationSettings(),
        ]);
        if (mounted) {
          setQuotationNumber(nextNum);
          setSettings(s);

          // Calculate default valid until
          const d = new Date();
          d.setDate(d.getDate() + (s?.standard_validity_days || 30));
          setValidUntil(d.toISOString().split('T')[0]);

          // Default terms
          const defaultTerms = [
            s?.standard_payment_terms ? `Payment: ${s.standard_payment_terms}` : null,
            s?.standard_delivery_terms ? `Delivery: ${s.standard_delivery_terms}` : null,
            s?.standard_warranty_terms ? `Warranty: ${s.standard_warranty_terms}` : null,
          ].filter(Boolean).join('\n');
          setTerms(defaultTerms);
        }
      } catch (err) {
        console.warn('Could not load quotation initial settings:', err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Update intra-state check when customerStateCode changes
  useEffect(() => {
    const supplierState = settings?.state_code || '10';
    setIsIntraState(supplierState === customerStateCode);
  }, [customerStateCode, settings]);

  // Customer search helper
  useEffect(() => {
    if (!customerSearch.trim() || customerSearch.length < 2) {
      setMatchedCustomers([]);
      return;
    }
    const t = setTimeout(async () => {
      setIsSearchingCustomer(true);
      try {
        const res = await apiClient<{ success: boolean; data: any[] }>(
          `/api/v1/customers?search=${encodeURIComponent(customerSearch.trim())}&limit=5`,
          { method: 'GET' }
        );
        setMatchedCustomers(res.data?.data || []);
      } catch {
        setMatchedCustomers([]);
      } finally {
        setIsSearchingCustomer(false);
      }
    }, 250);

    return () => clearTimeout(t);
  }, [customerSearch]);

  const selectCustomer = (c: any) => {
    setCustomerName(c.name || '');
    setCustomerPhone(c.phone || '');
    setCustomerAddress(c.address || '');
    setCustomerGstin(c.gstin || '');
    if (c.state_code) {
      setCustomerStateCode(c.state_code);
    }
    setCustomerSearch('');
    setMatchedCustomers([]);
  };

  // Add line item
  const handleAddItem = () => {
    setItems((prev) => [
      ...prev,
      {
        description: '',
        hsnCode: '',
        barcode: '',
        quantity: 1,
        unit: 'pcs',
        rate: '0.00',
        rateUnit: 'pcs',
        amount: '0.00',
      },
    ]);
  };

  // Remove line item
  const handleRemoveItem = (index: number) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  // Update item field
  const handleUpdateItem = (index: number, field: keyof QuotationItem, value: any) => {
    setItems((prev) => {
      const next = [...prev];
      const target = { ...next[index], [field]: value };

      if (field === 'quantity' || field === 'rate') {
        try {
          const q = new Decimal(String(target.quantity || 0));
          const r = new Decimal(String(target.rate || 0));
          target.amount = q.times(r).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
        } catch {
          target.amount = '0.00';
        }
      }

      next[index] = target;
      return next;
    });
  };

  // Search product catalogue for autocomplete on a row
  const handleSearchRowProduct = async (rowIdx: number, text: string) => {
    handleUpdateItem(rowIdx, 'description', text);
    if (!text.trim() || text.length < 2) {
      setProductSearchResults((prev) => ({ ...prev, [rowIdx]: [] }));
      return;
    }

    try {
      const res = await apiClient<{ success: boolean; data: any[] }>(
        `/api/v1/products?search=${encodeURIComponent(text.trim())}&limit=5`,
        { method: 'GET' }
      );
      setProductSearchResults((prev) => ({ ...prev, [rowIdx]: res.data?.data || [] }));
    } catch {
      setProductSearchResults((prev) => ({ ...prev, [rowIdx]: [] }));
    }
  };

  const handleSelectRowProduct = (rowIdx: number, p: any) => {
    setItems((prev) => {
      const next = [...prev];
      const qty = new Decimal(String(next[rowIdx].quantity || 1));
      const rate = new Decimal(String(p.buying_price || 0));
      next[rowIdx] = {
        ...next[rowIdx],
        productId: p.id,
        description: p.name,
        hsnCode: p.hsn_code || '',
        barcode: p.barcode || '',
        rate: rate.toFixed(2),
        amount: qty.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      };
      return next;
    });
    setProductSearchResults((prev) => ({ ...prev, [rowIdx]: [] }));
  };

  // Barcode Scan Handler (Hardware Scanner & Camera Scanner)
  const handleBarcodeScanned = useCallback(async (code: string) => {
    try {
      const product = await fetchProductByBarcode(code);
      if (!product) {
        setError(`No active product found with barcode "${code}".`);
        return;
      }

      // Check if product is already in line items
      setItems((prev) => {
        const existingIdx = prev.findIndex(
          (it) => (it.barcode && it.barcode === product.barcode) || it.productId === product.id
        );

        if (existingIdx >= 0) {
          // Increment quantity by 1
          const next = [...prev];
          const curQty = new Decimal(String(next[existingIdx].quantity || 1));
          const newQty = curQty.plus(1);
          const rate = new Decimal(String(next[existingIdx].rate || 0));
          next[existingIdx] = {
            ...next[existingIdx],
            quantity: newQty.toFixed(2),
            amount: newQty.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
          };
          return next;
        } else {
          // Check if first row is untouched empty row
          if (prev.length === 1 && !prev[0].description.trim()) {
            const rate = new Decimal(String(product.buying_price || 0));
            return [
              {
                productId: product.id,
                description: product.name,
                hsnCode: product.hsn_code || '',
                barcode: product.barcode || '',
                quantity: 1,
                unit: 'pcs',
                rate: rate.toFixed(2),
                rateUnit: 'pcs',
                amount: rate.toFixed(2),
              },
            ];
          }

          // Append new item
          const rate = new Decimal(String(product.buying_price || 0));
          return [
            ...prev,
            {
              productId: product.id,
              description: product.name,
              hsnCode: product.hsn_code || '',
              barcode: product.barcode || '',
              quantity: 1,
              unit: 'pcs',
              rate: rate.toFixed(2),
              rateUnit: 'pcs',
              amount: rate.toFixed(2),
            },
          ];
        }
      });
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Error looking up barcode.');
    }
  }, []);

  // Hook hardware HID scanner
  useHardwareBarcodeScanner({
    onScan: handleBarcodeScanned,
  });

  // Calculate live financial summary with pure Decimal.js
  let subtotalDec = new Decimal(0);
  items.forEach((it) => {
    try {
      const q = new Decimal(String(it.quantity || 0));
      const r = new Decimal(String(it.rate || 0));
      subtotalDec = subtotalDec.plus(q.times(r).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
    } catch {
      // Ignore parse
    }
  });

  let discountAmountDec = new Decimal(0);
  const discValDec = new Decimal(String(discountValue || 0));
  if (discountType === 'percentage') {
    discountAmountDec = subtotalDec.times(discValDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else if (discountType === 'fixed') {
    discountAmountDec = Decimal.min(subtotalDec, discValDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  const taxableAmountDec = Decimal.max(0, subtotalDec.minus(discountAmountDec));

  let cgstDec = new Decimal(0);
  let sgstDec = new Decimal(0);
  let igstDec = new Decimal(0);

  if (gstEnabled && gstRate > 0) {
    if (isIntraState) {
      const halfRate = new Decimal(gstRate).dividedBy(2);
      cgstDec = taxableAmountDec.times(halfRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      sgstDec = taxableAmountDec.times(halfRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else {
      igstDec = taxableAmountDec.times(gstRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
  }

  const totalTaxDec = cgstDec.plus(sgstDec).plus(igstDec);
  const grandTotalDec = taxableAmountDec.plus(totalTaxDec);

  const buildPayload = (): CreateQuotationPayload => {
    return {
      quotationNumber: quotationNumber.trim() || undefined,
      quotationDate,
      validUntil: validUntil || null,
      customerName: customerName.trim(),
      customerAddress: customerAddress.trim() || null,
      customerPhone: customerPhone.trim() || null,
      customerGstin: customerGstin.trim() || null,
      customerStateCode,
      projectTitle: projectTitle.trim() || null,
      subject: subject.trim() || null,
      items: items.map((it) => ({
        productId: it.productId || null,
        description: it.description.trim(),
        hsnCode: it.hsnCode?.trim() || null,
        barcode: it.barcode?.trim() || null,
        quantity: it.quantity,
        unit: it.unit || 'pcs',
        rate: it.rate,
        rateUnit: it.rateUnit || 'pcs',
      })),
      discountType,
      discountValue: discountType ? discountValue : 0,
      gstEnabled,
      gstRate,
      termsAndConditions: terms || null,
      notes: notes || null,
    };
  };

  const handleSave = async (markSent: boolean = false) => {
    if (!customerName.trim()) {
      setError('Customer name is required.');
      return;
    }
    const invalidItem = items.find((it) => !it.description.trim() || Number(it.quantity) <= 0);
    if (invalidItem) {
      setError('All items must have a valid description and a quantity greater than 0.');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const payload = buildPayload();
      let created = await createQuotation(payload);
      if (markSent && created.id) {
        created = await updateQuotationStatus(created.id, 'sent');
      }
      onSaved(created);
    } catch (err: any) {
      setError(err?.message || 'Failed to save quotation.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--khata-border)]">
        <div className="flex items-center gap-2.5">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shadow-inner"
            style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-accent)' }}
          >
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold">New Commercial Quotation</h2>
            <p className="text-xs text-[var(--khata-text-muted)]">
              Draft professional proposal with live calculations & PDF export
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="neu-btn-secondary text-xs px-3.5 py-2 flex-1 sm:flex-initial text-center justify-center"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => setPreviewPayload(buildPayload())}
            className="neu-btn-secondary text-xs px-3.5 py-2 font-bold inline-flex items-center justify-center gap-1.5 flex-1 sm:flex-initial"
          >
            <Eye className="w-4 h-4 text-[var(--khata-accent)]" />
            <span>Preview PDF</span>
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => handleSave(false)}
            className="neu-btn-secondary text-xs px-4 py-2 font-bold inline-flex items-center justify-center gap-1.5 flex-1 sm:flex-initial"
          >
            <Save className="w-4 h-4" />
            <span>Save Draft</span>
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => handleSave(true)}
            className="neu-btn-primary text-xs px-5 py-2 font-bold inline-flex items-center justify-center gap-1.5 flex-1 sm:flex-initial"
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            <span>Save & Send</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 bg-rose-500/10 border border-rose-500/30 text-rose-500 text-xs rounded-xl font-medium flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Header Form Card */}
      <div className="neu-card p-5 rounded-2xl space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-bold uppercase text-[var(--khata-text-muted)] mb-1">
              Quotation Number
            </label>
            <input
              type="text"
              value={quotationNumber}
              onChange={(e) => setQuotationNumber(e.target.value)}
              className="neu-input w-full text-sm font-mono font-bold"
              placeholder="e.g. QT-001"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-[var(--khata-text-muted)] mb-1">
              Quotation Date
            </label>
            <input
              type="date"
              value={quotationDate}
              onChange={(e) => setQuotationDate(e.target.value)}
              className="neu-input w-full text-sm font-medium"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-[var(--khata-text-muted)] mb-1">
              Valid Until
            </label>
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="neu-input w-full text-sm font-medium"
            />
          </div>
        </div>

        {/* Customer Section */}
        <div className="pt-2 border-t border-[var(--khata-border)] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase text-[var(--khata-text-muted)] flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
              <span>Customer / Client Details</span>
            </span>

            {/* Customer Search Autocomplete */}
            <div className="relative w-full sm:w-64">
              <input
                type="text"
                placeholder="Search registered customers..."
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                className="neu-input text-xs w-full py-1.5"
              />
              {isSearchingCustomer && (
                <Loader2 className="w-3 h-3 animate-spin absolute right-2.5 top-2.5 text-[var(--khata-text-muted)]" />
              )}
              {matchedCustomers.length > 0 && (
                <div
                  className="absolute left-0 right-0 top-full mt-1 p-1 rounded-xl border border-[var(--khata-border)] shadow-xl z-20 space-y-1 max-h-48 overflow-y-auto"
                  style={{ background: 'var(--khata-surface)' }}
                >
                  {matchedCustomers.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => selectCustomer(c)}
                      className="w-full text-left p-2 rounded-lg text-xs hover:bg-[var(--khata-surface-inset)] transition"
                    >
                      <div className="font-bold text-[var(--khata-text)]">{c.name}</div>
                      <div className="text-[10px] text-[var(--khata-text-muted)]">{c.phone || c.address}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                Customer Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="e.g. Acme Corporation"
                className="neu-input w-full text-xs font-medium"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                Phone Number
              </label>
              <input
                type="text"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="e.g. +91 9876543210"
                className="neu-input w-full text-xs font-medium"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                GSTIN (Optional)
              </label>
              <input
                type="text"
                value={customerGstin}
                onChange={(e) => setCustomerGstin(e.target.value.toUpperCase())}
                placeholder="e.g. 10ABGCA8624E1Z3"
                className="neu-input w-full text-xs font-mono font-medium uppercase"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
                State Code
              </label>
              <input
                type="text"
                value={customerStateCode}
                onChange={(e) => setCustomerStateCode(e.target.value)}
                placeholder="e.g. 10 (Bihar)"
                maxLength={2}
                className="neu-input w-full text-xs font-mono font-medium"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
              Billing / Site Address
            </label>
            <input
              type="text"
              value={customerAddress}
              onChange={(e) => setCustomerAddress(e.target.value)}
              placeholder="e.g. Plot No 12, Industrial Area, Gopalganj, Bihar"
              className="neu-input w-full text-xs font-medium"
            />
          </div>
        </div>

        {/* Project Section */}
        <div className="pt-2 border-t border-[var(--khata-border)] grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
              Project / Commercial Title
            </label>
            <input
              type="text"
              value={projectTitle}
              onChange={(e) => setProjectTitle(e.target.value)}
              placeholder="e.g. Enterprise AI Hardware Deployment"
              className="neu-input w-full text-xs font-medium"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] mb-1">
              Scope / Subject Summary
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Supply and setup of edge inference nodes and networking"
              className="neu-input w-full text-xs font-medium"
            />
          </div>
        </div>
      </div>

      {/* Item Builder Card */}
      <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold uppercase text-[var(--khata-text)]">
              Quotation Line Items
            </h3>
            <span className="text-xs text-[var(--khata-text-muted)]">
              ({items.length} {items.length === 1 ? 'item' : 'items'})
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setIsScannerOpen(true)}
              className="neu-btn-secondary text-xs px-3 py-1.5 font-bold inline-flex items-center gap-1.5"
            >
              <Scan className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
              <span>Scan Barcode</span>
            </button>
            <button
              type="button"
              onClick={handleAddItem}
              className="neu-btn-secondary text-xs px-3 py-1.5 font-bold inline-flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
              <span>Add Item</span>
            </button>
          </div>
        </div>

        {/* 1. Mobile Phone Line Items Card Editor (sm:hidden) */}
        <div className="sm:hidden space-y-3">
          {items.map((item, idx) => (
            <div
              key={idx}
              className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/30 space-y-2.5"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-xs text-[var(--khata-accent)]">Item #{idx + 1}</span>
                <button
                  type="button"
                  disabled={items.length <= 1}
                  onClick={() => handleRemoveItem(idx)}
                  className="p-1 rounded text-[var(--khata-text-muted)] hover:text-rose-500 disabled:opacity-30 transition"
                  title="Remove item"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Description & Autocomplete */}
              <div className="relative">
                <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                  Description & Product <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={item.description}
                  onChange={(e) => handleSearchRowProduct(idx, e.target.value)}
                  placeholder="Type item description..."
                  className="neu-input w-full text-xs py-2"
                />
                {productSearchResults[idx]?.length > 0 && (
                  <div
                    className="absolute left-0 right-0 top-full mt-1 p-1 rounded-xl border border-[var(--khata-border)] shadow-xl z-20 space-y-1 max-h-40 overflow-y-auto"
                    style={{ background: 'var(--khata-surface)' }}
                  >
                    {productSearchResults[idx].map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => handleSelectRowProduct(idx, p)}
                        className="w-full text-left p-1.5 rounded-lg text-xs hover:bg-[var(--khata-surface-inset)] transition flex justify-between items-center"
                      >
                        <span className="font-bold">{p.name}</span>
                        <span className="text-[10px] text-[var(--khata-text-muted)]">₹{p.buying_price}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Qty, Unit, Rate, Amount */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Qty
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={item.quantity}
                    onChange={(e) => handleUpdateItem(idx, 'quantity', e.target.value)}
                    className="neu-input w-full text-xs py-1.5 text-center font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Unit
                  </label>
                  <input
                    type="text"
                    value={item.unit || 'pcs'}
                    onChange={(e) => handleUpdateItem(idx, 'unit', e.target.value)}
                    className="neu-input w-full text-xs py-1.5 text-center"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Rate (₹)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={item.rate}
                    onChange={(e) => handleUpdateItem(idx, 'rate', e.target.value)}
                    className="neu-input w-full text-xs py-1.5 text-right font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Amount (₹)
                  </label>
                  <div className="neu-input w-full text-xs py-1.5 text-right font-bold text-[var(--khata-accent)] bg-[var(--khata-surface)]">
                    ₹{formatCurrency(item.amount || 0)}
                  </div>
                </div>
              </div>

              {/* Optional HSN & Barcode */}
              <div className="grid grid-cols-2 gap-2 pt-1 border-t border-[var(--khata-border)]/50">
                <div>
                  <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    HSN
                  </label>
                  <input
                    type="text"
                    value={item.hsnCode || ''}
                    onChange={(e) => handleUpdateItem(idx, 'hsnCode', e.target.value)}
                    placeholder="e.g. 8471"
                    className="neu-input w-full text-xs py-1 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Barcode
                  </label>
                  <input
                    type="text"
                    value={item.barcode || ''}
                    onChange={(e) => handleUpdateItem(idx, 'barcode', e.target.value)}
                    placeholder="Barcode"
                    className="neu-input w-full text-xs py-1 font-mono"
                  />
                </div>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={handleAddItem}
            className="neu-btn-secondary text-xs px-3 py-2 font-bold w-full inline-flex items-center justify-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
            <span>Add Another Item</span>
          </button>
        </div>

        {/* 2. Desktop Items Table (hidden sm:block) */}
        <div className="hidden sm:block overflow-x-auto border border-[var(--khata-border)] rounded-xl">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[var(--khata-surface-inset)] border-b border-[var(--khata-border)] font-bold text-[var(--khata-text-muted)] uppercase">
                <th className="py-2.5 px-3 w-10 text-center">#</th>
                <th className="py-2.5 px-3 min-w-[200px]">Description & Product</th>
                <th className="py-2.5 px-3 w-28">HSN</th>
                <th className="py-2.5 px-3 w-28">Barcode</th>
                <th className="py-2.5 px-3 w-24">Qty</th>
                <th className="py-2.5 px-3 w-24">Unit</th>
                <th className="py-2.5 px-3 w-28 text-right">Rate (₹)</th>
                <th className="py-2.5 px-3 w-32 text-right">Amount (₹)</th>
                <th className="py-2.5 px-2 w-10 text-center"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--khata-border)]">
              {items.map((item, idx) => (
                <tr key={idx} className="hover:bg-[var(--khata-surface-inset)]/40 transition">
                  <td className="py-2 px-3 text-center font-bold text-[var(--khata-text-muted)]">
                    {idx + 1}
                  </td>

                  {/* Description with autocomplete */}
                  <td className="py-2 px-3 relative">
                    <input
                      type="text"
                      value={item.description}
                      onChange={(e) => handleSearchRowProduct(idx, e.target.value)}
                      placeholder="Type item description..."
                      className="neu-input w-full text-xs py-1.5"
                    />
                    {productSearchResults[idx]?.length > 0 && (
                      <div
                        className="absolute left-3 right-3 top-full mt-1 p-1 rounded-xl border border-[var(--khata-border)] shadow-xl z-20 space-y-1 max-h-40 overflow-y-auto"
                        style={{ background: 'var(--khata-surface)' }}
                      >
                        {productSearchResults[idx].map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => handleSelectRowProduct(idx, p)}
                            className="w-full text-left p-1.5 rounded-lg text-xs hover:bg-[var(--khata-surface-inset)] transition flex justify-between items-center"
                          >
                            <span className="font-bold">{p.name}</span>
                            <span className="text-[10px] text-[var(--khata-text-muted)]">₹{p.buying_price}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </td>

                  {/* HSN */}
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      value={item.hsnCode || ''}
                      onChange={(e) => handleUpdateItem(idx, 'hsnCode', e.target.value)}
                      placeholder="e.g. 8471"
                      className="neu-input w-full text-xs py-1.5 font-mono"
                    />
                  </td>

                  {/* Barcode */}
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      value={item.barcode || ''}
                      onChange={(e) => handleUpdateItem(idx, 'barcode', e.target.value)}
                      placeholder="Barcode"
                      className="neu-input w-full text-xs py-1.5 font-mono"
                    />
                  </td>

                  {/* Quantity */}
                  <td className="py-2 px-3">
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={item.quantity}
                      onChange={(e) => handleUpdateItem(idx, 'quantity', e.target.value)}
                      className="neu-input w-full text-xs py-1.5 text-center font-bold"
                    />
                  </td>

                  {/* Unit */}
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      value={item.unit || 'pcs'}
                      onChange={(e) => handleUpdateItem(idx, 'unit', e.target.value)}
                      className="neu-input w-full text-xs py-1.5 text-center"
                    />
                  </td>

                  {/* Rate (Editable quotation price) */}
                  <td className="py-2 px-3">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={item.rate}
                      onChange={(e) => handleUpdateItem(idx, 'rate', e.target.value)}
                      className="neu-input w-full text-xs py-1.5 text-right font-medium"
                    />
                  </td>

                  {/* Amount (Auto-calculated) */}
                  <td className="py-2 px-3 text-right font-bold text-xs">
                    ₹{formatCurrency(item.amount || 0)}
                  </td>

                  {/* Delete */}
                  <td className="py-2 px-2 text-center">
                    <button
                      type="button"
                      disabled={items.length <= 1}
                      onClick={() => handleRemoveItem(idx)}
                      className="p-1 rounded text-[var(--khata-text-muted)] hover:text-rose-500 disabled:opacity-30 transition"
                      title="Remove row"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Financial Summary Calculation Panel */}
        <div className="pt-4 border-t border-[var(--khata-border)] grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Commercial Discounts & GST Options */}
          <div className="space-y-4">
            {/* Discount selector */}
            <div className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-2">
              <label className="block text-xs font-bold uppercase text-[var(--khata-text-muted)]">
                Commercial Discount:
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDiscountType(null);
                    setDiscountValue('0');
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                    discountType === null
                      ? 'border-[var(--khata-accent)] bg-[var(--khata-accent)] text-white'
                      : 'border-[var(--khata-border)] bg-[var(--khata-surface)]'
                  }`}
                >
                  None
                </button>
                <button
                  type="button"
                  onClick={() => setDiscountType('percentage')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                    discountType === 'percentage'
                      ? 'border-[var(--khata-accent)] bg-[var(--khata-accent)] text-white'
                      : 'border-[var(--khata-border)] bg-[var(--khata-surface)]'
                  }`}
                >
                  Percentage (%)
                </button>
                <button
                  type="button"
                  onClick={() => setDiscountType('fixed')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                    discountType === 'fixed'
                      ? 'border-[var(--khata-accent)] bg-[var(--khata-accent)] text-white'
                      : 'border-[var(--khata-border)] bg-[var(--khata-surface)]'
                  }`}
                >
                  Fixed (₹)
                </button>
              </div>

              {discountType && (
                <div className="pt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountType === 'percentage' ? 'e.g. 10%' : 'e.g. 500'}
                    className="neu-input text-xs w-36 py-1.5 font-bold"
                  />
                  <span className="text-xs text-[var(--khata-text-muted)]">
                    {discountType === 'percentage' ? '% discount' : '₹ flat discount'}
                  </span>
                </div>
              )}
            </div>

            {/* GST Settings */}
            <div className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold uppercase text-[var(--khata-text-muted)]">
                  Include GST In Quotation:
                </label>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={gstEnabled}
                    onChange={(e) => setGstEnabled(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-neutral-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--khata-accent)]" />
                </label>
              </div>

              {gstEnabled && (
                <div className="pt-1 flex flex-wrap items-center gap-3">
                  <div>
                    <label className="block text-[10px] font-bold text-[var(--khata-text-muted)] mb-1">
                      GST Rate (%)
                    </label>
                    <select
                      value={gstRate}
                      onChange={(e) => setGstRate(Number(e.target.value))}
                      className="neu-input text-xs py-1.5 px-3 font-bold"
                    >
                      <option value={0}>0%</option>
                      <option value={5}>5%</option>
                      <option value={12}>12%</option>
                      <option value={18}>18%</option>
                      <option value={28}>28%</option>
                    </select>
                  </div>

                  <div className="flex-1 min-w-[180px]">
                    <label className="block text-[10px] font-bold text-[var(--khata-text-muted)] mb-1">
                      Supply Type
                    </label>
                    <div className="text-xs font-bold text-[var(--khata-text)] pt-1">
                      {isIntraState
                        ? `Intra-State (CGST: ${(gstRate / 2).toFixed(1)}% + SGST: ${(gstRate / 2).toFixed(1)}%)`
                        : `Inter-State (IGST: ${gstRate}%)`}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Totals Breakdown Column */}
          <div className="p-4 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-2 text-xs flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-[var(--khata-text-muted)]">Subtotal:</span>
                <span className="font-semibold">₹{formatCurrency(subtotalDec.toFixed(2))}</span>
              </div>

              {discountAmountDec.greaterThan(0) && (
                <div className="flex justify-between text-rose-500">
                  <span>
                    Discount {discountType === 'percentage' ? `(${discountValue}%)` : ''}:
                  </span>
                  <span className="font-semibold">-₹{formatCurrency(discountAmountDec.toFixed(2))}</span>
                </div>
              )}

              <div className="flex justify-between font-bold border-t border-[var(--khata-border)] pt-1.5">
                <span>Taxable Amount:</span>
                <span>₹{formatCurrency(taxableAmountDec.toFixed(2))}</span>
              </div>

              {gstEnabled && (
                <>
                  {isIntraState ? (
                    <>
                      <div className="flex justify-between text-[var(--khata-text-muted)]">
                        <span>CGST ({(gstRate / 2).toFixed(1)}%):</span>
                        <span>₹{formatCurrency(cgstDec.toFixed(2))}</span>
                      </div>
                      <div className="flex justify-between text-[var(--khata-text-muted)]">
                        <span>SGST ({(gstRate / 2).toFixed(1)}%):</span>
                        <span>₹{formatCurrency(sgstDec.toFixed(2))}</span>
                      </div>
                    </>
                  ) : (
                    <div className="flex justify-between text-[var(--khata-text-muted)]">
                      <span>IGST ({gstRate}%):</span>
                      <span>₹{formatCurrency(igstDec.toFixed(2))}</span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Grand Total */}
            <div className="p-3 rounded-xl bg-[var(--khata-accent)] text-white flex items-center justify-between shadow-lg">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider opacity-90">
                  Grand Total
                </div>
                <div className="text-lg font-black tracking-tight">
                  ₹{formatCurrency(grandTotalDec.toFixed(2))}
                </div>
              </div>
              <span className="text-xs opacity-90 font-medium">All Taxes Included</span>
            </div>
          </div>
        </div>

        {/* Commercial Terms & Notes */}
        <div className="pt-4 border-t border-[var(--khata-border)] grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] uppercase mb-1">
              Terms & Conditions
            </label>
            <textarea
              rows={3}
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              className="neu-input w-full text-xs font-medium p-2.5"
              placeholder="Delivery, payment, warranty terms..."
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-[var(--khata-text-muted)] uppercase mb-1">
              Internal / Customer Notes
            </label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="neu-input w-full text-xs font-medium p-2.5"
              placeholder="Special instructions or notes for this proposal..."
            />
          </div>
        </div>

        {/* Mobile Phone Bottom Action Bar (sm:hidden) */}
        <div className="sm:hidden flex flex-wrap items-center gap-2 pt-4 border-t border-[var(--khata-border)]">
          <button
            type="button"
            onClick={onCancel}
            className="neu-btn-secondary text-xs px-3 py-2 flex-1 text-center justify-center"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => setPreviewPayload(buildPayload())}
            className="neu-btn-secondary text-xs px-3 py-2 font-bold inline-flex items-center justify-center gap-1.5 flex-1"
          >
            <Eye className="w-4 h-4 text-[var(--khata-accent)]" />
            <span>Preview</span>
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => handleSave(false)}
            className="neu-btn-secondary text-xs px-3 py-2 font-bold inline-flex items-center justify-center gap-1.5 flex-1"
          >
            <Save className="w-4 h-4" />
            <span>Save Draft</span>
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => handleSave(true)}
            className="neu-btn-primary text-xs px-4 py-2.5 font-bold inline-flex items-center justify-center gap-1.5 w-full mt-1"
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            <span>Save & Send Quotation</span>
          </button>
        </div>
      </div>

      {/* Barcode Camera Scanner Modal */}
      <BarcodeScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onProductFound={(product) => {
          handleBarcodeScanned(product.barcode || '');
        }}
      />

      {/* PDF Live Preview Modal */}
      {previewPayload && (
        <QuotationPreview
          isOpen={Boolean(previewPayload)}
          previewPayload={previewPayload}
          onClose={() => setPreviewPayload(null)}
        />
      )}
    </div>
  );
};
