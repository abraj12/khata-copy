import React, { useEffect, useState } from 'react';
import Decimal from 'decimal.js';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Download,
  Edit2,
  Eye,
  FileText,
  History,
  Loader2,
  Paperclip,
  Plus,
  Printer,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import { validateQuantityInput, validateSellingRateInput } from '../../utils/lineItemDraft.js';
import { safeDecimal } from '../../lib/formatters.js';
import {
  cancelPurchaseBillApi,
  computeDraftPurchaseBillTotals,
  createPurchaseBillApi,
  deletePurchaseBillAttachmentApi,
  fetchCatalogProductsForSupplierBills,
  fetchPurchaseBillAttachmentBlob,
  formatAbsRupees,
  getPurchaseBillApi,
  listAllSuppliersApi,
  listPurchaseBillsApi,
  updatePurchaseBillApi,
  uploadPurchaseBillAttachmentApi,
} from './suppliersApi.js';
import { SupplierPaginationBar } from './SupplierPaginationBar.js';
import type {
  CatalogProductOption,
  PurchaseBillDetail,
  PurchaseBillSummary,
  SupplierRecord,
} from './suppliers.types.js';

const BILLS_PAGE_LIMIT = 50;

export interface PurchaseBillsViewProps {
  initialSupplierFilter?: string;
  openCreateSignal?: number;
  preselectedSupplierId?: string;
  onDataChanged: () => void;
}

interface DraftPurchaseLine {
  key: string;
  productId: number | null;
  description: string;
  quantity: string;
  purchaseRate: string;
  updateProductBuyingPrice: boolean;
}

function makeEmptyLine(): DraftPurchaseLine {
  return {
    key: `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    productId: null,
    description: '',
    quantity: '1',
    purchaseRate: '',
    updateProductBuyingPrice: false, // Explicitly OFF by default
  };
}

export const PurchaseBillsView: React.FC<PurchaseBillsViewProps> = ({
  initialSupplierFilter = '',
  openCreateSignal = 0,
  preselectedSupplierId = '',
  onDataChanged,
}) => {
  const [bills, setBills] = useState<PurchaseBillSummary[]>([]);
  const [totalBills, setTotalBills] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [allSuppliers, setAllSuppliers] = useState<SupplierRecord[]>([]);
  const [catalogProducts, setCatalogProducts] = useState<CatalogProductOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [supplierFilter, setSupplierFilter] = useState(initialSupplierFilter);
  const [statusFilter, setStatusFilter] = useState<'all' | 'finalized' | 'cancelled'>('all');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Create / Edit Modal State
  const [formOpen, setFormOpen] = useState(false);
  const [editingBillId, setEditingBillId] = useState<number | null>(null);
  const [formSupplierId, setFormSupplierId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(() => getBusinessDateISO());
  const [dueDate, setDueDate] = useState('');
  const [items, setItems] = useState<DraftPurchaseLine[]>([makeEmptyLine()]);
  const [discountAmount, setDiscountAmount] = useState('0');
  const [gstRate, setGstRate] = useState('0');
  const [notes, setNotes] = useState('');
  const [editReason, setEditReason] = useState('');
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Detail / Print / Audit History Modal State
  const [detailBill, setDetailBill] = useState<PurchaseBillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancelBox, setShowCancelBox] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    setSupplierFilter(initialSupplierFilter);
    setOffset(0);
  }, [initialSupplierFilter]);

  const loadReferenceData = async () => {
    try {
      const [supList, prods] = await Promise.all([
        listAllSuppliersApi({ status: 'all' }),
        fetchCatalogProductsForSupplierBills(),
      ]);
      setAllSuppliers(supList);
      setCatalogProducts(prods);
    } catch {
      // Handled when loading main list
    }
  };

  const loadBills = async (targetOffset = offset) => {
    setLoading(true);
    try {
      const res = await listPurchaseBillsApi({
        supplierId: supplierFilter || undefined,
        status: statusFilter,
        search: search || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        limit: BILLS_PAGE_LIMIT,
        offset: targetOffset,
      });
      setBills(res.purchaseBills);
      setTotalBills(res.total);
      setHasMore(
        res.pagination?.hasMore ?? targetOffset + res.purchaseBills.length < res.total
      );
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Failed to load purchase bills.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadReferenceData();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadBills(offset);
    }, 180);
    return () => clearTimeout(timer);
  }, [supplierFilter, statusFilter, search, fromDate, toDate, offset]);

  useEffect(() => {
    if (openCreateSignal > 0) {
      openCreateModal(preselectedSupplierId || supplierFilter);
    }
  }, [openCreateSignal]);

  useEffect(() => {
    return () => {
      if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
    };
  }, [attachmentPreviewUrl]);

  const activeSuppliers = allSuppliers.filter((s) => !s.archivedAt);

  const openCreateModal = (defaultSupId = '') => {
    setEditingBillId(null);
    setFormSupplierId(defaultSupId || activeSuppliers[0]?.id || '');
    setInvoiceNumber('');
    setInvoiceDate(getBusinessDateISO());
    setDueDate('');
    setItems([makeEmptyLine()]);
    setDiscountAmount('0');
    setGstRate('0');
    setNotes('');
    setEditReason('');
    setAttachmentFile(null);
    setFormError(null);
    setFormOpen(true);
  };

  const openEditModal = async (billId: number) => {
    setFormError(null);
    try {
      const detail = await getPurchaseBillApi(billId);
      setEditingBillId(detail.id);
      setFormSupplierId(detail.supplierId);
      setInvoiceNumber(detail.invoiceNumber);
      setInvoiceDate(detail.invoiceDate);
      setDueDate(detail.dueDate || '');
      setItems(
        detail.items.map((it) => ({
          key: `edit-${it.id}`,
          productId: it.productId,
          description: it.description,
          quantity: String(it.quantity),
          purchaseRate: String(it.purchaseRate),
          updateProductBuyingPrice: false, // Always opt-in explicitly per save
        }))
      );
      setDiscountAmount(detail.discountAmount);
      setGstRate(detail.gstRate);
      setNotes(detail.notes || '');
      setEditReason('');
      setAttachmentFile(null);
      setDetailBill(null);
      setFormOpen(true);
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Unable to load purchase bill for editing.' });
    }
  };

  const openDetailModal = async (billId: number) => {
    if (attachmentPreviewUrl) {
      URL.revokeObjectURL(attachmentPreviewUrl);
      setAttachmentPreviewUrl(null);
    }
    setLoadingDetail(true);
    setShowCancelBox(false);
    setCancelReason('');
    try {
      const detail = await getPurchaseBillApi(billId);
      setDetailBill(detail);
      if (detail.hasAttachment && detail.attachmentContentType?.startsWith('image/')) {
        try {
          const blob = await fetchPurchaseBillAttachmentBlob(detail.id, false);
          setAttachmentPreviewUrl(URL.createObjectURL(blob));
        } catch {
          // Preview fallback handled smoothly in UI
        }
      }
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Failed to load purchase bill.' });
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleSelectCatalogProduct = (lineKey: string, productIdStr: string) => {
    const pid = productIdStr ? Number(productIdStr) : null;
    const found = pid ? catalogProducts.find((p) => p.id === pid) : null;
    setItems((prev) =>
      prev.map((line) => {
        if (line.key !== lineKey) return line;
        if (!found) {
          return { ...line, productId: null, updateProductBuyingPrice: false };
        }
        return {
          ...line,
          productId: found.id,
          description: found.name,
          purchaseRate: line.purchaseRate || found.buying_price || '',
          updateProductBuyingPrice: false, // Never silently checked
        };
      })
    );
  };

  const draftTotals = computeDraftPurchaseBillTotals(items, discountAmount, gstRate);

  const handleSaveBill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formSupplierId) {
      setFormError('Please select a supplier.');
      return;
    }
    if (!invoiceNumber.trim()) {
      setFormError('Supplier invoice number is required.');
      return;
    }
    if (!invoiceDate) {
      setFormError('Invoice date is required.');
      return;
    }
    if (dueDate && dueDate < invoiceDate) {
      setFormError('Due date cannot be earlier than invoice date.');
      return;
    }
    if (items.length === 0) {
      setFormError('At least one line item is required.');
      return;
    }

    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (!it.description.trim()) {
        setFormError(`Row #${i + 1}: Item description is required.`);
        return;
      }
      const qErr = validateQuantityInput(it.quantity, `Row #${i + 1} quantity`);
      if (qErr) {
        setFormError(qErr);
        return;
      }
      const rErr = validateSellingRateInput(it.purchaseRate, `Row #${i + 1} purchase rate`);
      if (rErr) {
        setFormError(rErr);
        return;
      }
    }

    if (new Decimal(draftTotals.discountAmount).greaterThan(new Decimal(draftTotals.subtotalAmount))) {
      setFormError('Discount amount cannot exceed subtotal amount.');
      return;
    }

    setFormError(null);
    setSubmitting(true);

    try {
      const payloadItems = items.map((it) => ({
        productId: it.productId,
        description: it.description.trim(),
        quantity: it.quantity,
        purchaseRate: it.purchaseRate,
        updateProductBuyingPrice: Boolean(it.productId && it.updateProductBuyingPrice),
      }));

      let savedBill: PurchaseBillDetail;
      if (editingBillId) {
        savedBill = await updatePurchaseBillApi(editingBillId, {
          invoiceNumber: invoiceNumber.trim(),
          invoiceDate,
          dueDate: dueDate || null,
          items: payloadItems,
          discountAmount: discountAmount || '0',
          gstRate: gstRate || '0',
          notes: notes.trim() || null,
          reason: editReason.trim() || undefined,
        });
      } else {
        savedBill = await createPurchaseBillApi({
          supplierId: formSupplierId,
          invoiceNumber: invoiceNumber.trim(),
          invoiceDate,
          dueDate: dueDate || null,
          items: payloadItems,
          discountAmount: discountAmount || '0',
          gstRate: gstRate || '0',
          notes: notes.trim() || null,
        });
      }

      if (attachmentFile) {
        try {
          await uploadPurchaseBillAttachmentApi(savedBill.id, attachmentFile);
        } catch (attErr: any) {
          setNotice({
            type: 'error',
            text: `Purchase bill saved, but file attachment upload failed: ${attErr?.message || 'Storage error'}. You can retry from Bill Details.`,
          });
          setFormOpen(false);
          onDataChanged();
          await Promise.all([loadBills(), loadReferenceData()]);
          return;
        }
      }

      setFormOpen(false);
      setNotice({
        type: 'success',
        text: editingBillId
          ? `Purchase bill "${savedBill.invoiceNumber}" updated.`
          : `Purchase bill "${savedBill.invoiceNumber}" saved.`,
      });
      onDataChanged();
      await Promise.all([loadBills(), loadReferenceData()]);
    } catch (err: any) {
      setFormError(err?.message || 'Failed to save purchase bill.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUploadAttachmentInDetail = async (file: File | undefined) => {
    if (!file || !detailBill) return;
    setAttachmentBusy(true);
    try {
      const updated = await uploadPurchaseBillAttachmentApi(detailBill.id, file);
      setDetailBill(updated);
      if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
      if (updated.attachmentContentType?.startsWith('image/')) {
        const blob = await fetchPurchaseBillAttachmentBlob(updated.id, false);
        setAttachmentPreviewUrl(URL.createObjectURL(blob));
      } else {
        setAttachmentPreviewUrl(null);
      }
      await loadBills();
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Attachment upload failed.' });
    } finally {
      setAttachmentBusy(false);
    }
  };

  const handleDownloadAttachment = async (bill: PurchaseBillDetail) => {
    try {
      const blob = await fetchPurchaseBillAttachmentBlob(bill.id, true);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = bill.attachmentFilename || `purchase-bill-${bill.invoiceNumber}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Unable to download attachment.' });
    }
  };

  const handleRemoveAttachment = async (billId: number) => {
    setAttachmentBusy(true);
    try {
      const updated = await deletePurchaseBillAttachmentApi(billId);
      setDetailBill(updated);
      if (attachmentPreviewUrl) {
        URL.revokeObjectURL(attachmentPreviewUrl);
        setAttachmentPreviewUrl(null);
      }
      await loadBills();
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Failed to remove attachment.' });
    } finally {
      setAttachmentBusy(false);
    }
  };

  const handleConfirmCancelBill = async () => {
    if (!detailBill || !cancelReason.trim()) return;
    setCancelling(true);
    try {
      const updated = await cancelPurchaseBillApi(detailBill.id, cancelReason.trim());
      setDetailBill(updated);
      setShowCancelBox(false);
      setCancelReason('');
      setNotice({ type: 'success', text: `Purchase bill "${updated.invoiceNumber}" cancelled.` });
      onDataChanged();
      await loadBills();
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Failed to cancel purchase bill.' });
    } finally {
      setCancelling(false);
    }
  };

  const renderStatusBadge = (bill: PurchaseBillSummary) => {
    if (bill.status === 'cancelled') {
      return <span className="neu-badge neu-badge-danger text-[10px]">Cancelled</span>;
    }
    if (bill.paymentStatus === 'paid') {
      return <span className="neu-badge neu-badge-success text-[10px]">Paid</span>;
    }
    if (bill.paymentStatus === 'partial') {
      return <span className="neu-badge neu-badge-warning text-[10px]">Partial</span>;
    }
    return (
      <span className="neu-badge text-[10px] bg-rose-500/10 text-rose-600 border border-rose-500/30">
        Unpaid
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className={detailBill ? 'print:hidden space-y-4' : 'space-y-4'}>
        {notice && (
          <div
            className={`p-3 rounded-xl text-xs font-semibold flex items-center justify-between gap-2 ${
              notice.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                : 'bg-rose-500/10 border border-rose-500/30 text-rose-700 dark:text-rose-300'
            }`}
          >
            <div className="flex items-center gap-2">
              {notice.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
              )}
              <span>{notice.text}</span>
            </div>
            <button type="button" onClick={() => setNotice(null)} className="p-0.5">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Header & Filter Card */}
        <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-extrabold text-[var(--khata-text)]">
                Supplier Purchase Bills
              </h3>
              <p className="text-xs text-[var(--khata-text-muted)]">
                Record vendor invoices, upload bill copies, and maintain auditable purchase history
              </p>
            </div>
            <button
              type="button"
              onClick={() => openCreateModal(supplierFilter)}
              className="neu-btn-primary text-xs px-4 py-2 font-bold inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Record Purchase Bill</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
            <select
              value={supplierFilter}
              onChange={(e) => {
                setSupplierFilter(e.target.value);
                setOffset(0);
              }}
              className="neu-input text-xs font-semibold"
            >
              <option value="">All Suppliers</option>
              {allSuppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.archivedAt ? ' [Archived]' : ''}
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as any);
                setOffset(0);
              }}
              className="neu-input text-xs font-semibold"
            >
              <option value="all">All Statuses</option>
              <option value="finalized">Finalized</option>
              <option value="cancelled">Cancelled</option>
            </select>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--khata-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOffset(0);
                }}
                placeholder="Search invoice # or supplier..."
                className="neu-input w-full pl-8 pr-2 py-1.5 text-xs"
              />
            </div>

            <input
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setOffset(0);
              }}
              className="neu-input text-xs font-mono"
              aria-label="Filter from date"
            />
            <input
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setOffset(0);
              }}
              className="neu-input text-xs font-mono"
              aria-label="Filter to date"
            />
          </div>
        </div>

        {/* Purchase Bills List */}
        {loading ? (
          <div className="neu-card p-10 rounded-2xl flex items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
            <span>Loading purchase bills...</span>
          </div>
        ) : bills.length === 0 ? (
          <div className="neu-card p-10 rounded-2xl text-center text-xs text-[var(--khata-text-muted)]">
            No purchase bills recorded for the selected filters.
          </div>
        ) : (
          <div className="neu-card p-4 rounded-2xl space-y-3">
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[var(--khata-border)] text-[11px] uppercase tracking-wider text-[var(--khata-text-muted)]">
                    <th className="py-2.5 px-3">Invoice #</th>
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">Supplier</th>
                    <th className="py-2.5 px-3 text-right">Grand Total</th>
                    <th className="py-2.5 px-3 text-right">Paid</th>
                    <th className="py-2.5 px-3 text-right">Remaining</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--khata-border)]/60">
                  {bills.map((b) => (
                    <tr key={b.id} className="hover:bg-[var(--khata-surface-inset)]/35">
                      <td className="py-3 px-3 font-bold font-mono text-[var(--khata-text)]">
                        <div className="flex items-center gap-1.5">
                          <span>{b.invoiceNumber}</span>
                          {b.hasAttachment && (
                            <span title="Has document attachment">
                              <Paperclip className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                            </span>
                          )}
                        </div>
                        {b.version > 1 && (
                          <span className="text-[10px] text-[var(--khata-text-muted)]">
                            v{b.version}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 font-mono text-[var(--khata-text-muted)]">
                        {b.invoiceDate}
                      </td>
                      <td className="py-3 px-3 font-semibold text-[var(--khata-text)]">
                        {b.supplierName}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-bold">
                        {formatAbsRupees(b.grandTotal)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-emerald-600 dark:text-emerald-400">
                        {formatAbsRupees(b.allocatedAmount)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-bold text-rose-600 dark:text-rose-400">
                        {formatAbsRupees(b.remainingAmount)}
                      </td>
                      <td className="py-3 px-3">{renderStatusBadge(b)}</td>
                      <td className="py-3 px-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openDetailModal(b.id)}
                            className="neu-btn-secondary text-[11px] px-2.5 py-1 min-h-0 inline-flex items-center gap-1"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>View / Print</span>
                          </button>
                          {b.status === 'finalized' && (
                            <button
                              type="button"
                              onClick={() => openEditModal(b.id)}
                              className="p-1.5 rounded-lg bg-[var(--khata-surface-inset)] hover:bg-[var(--khata-accent)]/15"
                              title="Edit Purchase Bill"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden space-y-2.5">
              {bills.map((b) => (
                <div
                  key={b.id}
                  className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/25 space-y-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold font-mono text-sm text-[var(--khata-text)] flex items-center gap-1.5">
                        <span>{b.invoiceNumber}</span>
                        {b.hasAttachment && (
                          <Paperclip className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                        )}
                      </div>
                      <div className="font-semibold text-[var(--khata-text)]">{b.supplierName}</div>
                      <div className="text-[11px] text-[var(--khata-text-muted)] font-mono">
                        {b.invoiceDate} · {b.itemCount} items
                      </div>
                    </div>
                    {renderStatusBadge(b)}
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[var(--khata-border)]/60">
                    <div>
                      <span className="text-[10px] text-[var(--khata-text-muted)] block">Total</span>
                      <span className="font-mono font-bold">{formatAbsRupees(b.grandTotal)}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-[var(--khata-text-muted)] block">Paid</span>
                      <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {formatAbsRupees(b.allocatedAmount)}
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-[var(--khata-text-muted)] block">Due</span>
                      <span className="font-mono font-bold text-rose-600 dark:text-rose-400">
                        {formatAbsRupees(b.remainingAmount)}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => openDetailModal(b.id)}
                      className="neu-btn-secondary text-[11px] px-3 py-1.5 min-h-0"
                    >
                      View / Print
                    </button>
                    {b.status === 'finalized' && (
                      <button
                        type="button"
                        onClick={() => openEditModal(b.id)}
                        className="neu-btn-secondary text-[11px] px-3 py-1.5 min-h-0"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <SupplierPaginationBar
              offset={offset}
              limit={BILLS_PAGE_LIMIT}
              total={totalBills}
              currentCount={bills.length}
              hasMore={hasMore}
              loading={loading}
              itemLabel="purchase bills"
              onPageChange={(nextOffset) => setOffset(nextOffset)}
            />
          </div>
        )}
      </div>

      {/* Create / Edit Purchase Bill Modal */}
      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto print:hidden">
          <div className="neu-card w-full max-w-4xl rounded-2xl p-4 sm:p-6 my-4 space-y-4 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-3">
              <h3 className="text-base font-extrabold text-[var(--khata-text)]">
                {editingBillId ? 'Edit Purchase Bill' : 'Record New Purchase Bill'}
              </h3>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs font-semibold">
                {formError}
              </div>
            )}

            <form onSubmit={handleSaveBill} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Supplier <span className="text-rose-500">*</span>
                  </label>
                  <select
                    required
                    disabled={Boolean(editingBillId)}
                    value={formSupplierId}
                    onChange={(e) => setFormSupplierId(e.target.value)}
                    className="neu-input w-full text-xs font-semibold disabled:opacity-70"
                  >
                    <option value="">-- Select Supplier --</option>
                    {(editingBillId ? allSuppliers : activeSuppliers).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.phone ? ` (${s.phone})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Supplier Invoice # <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    placeholder="e.g. SUP-2026-014"
                    className="neu-input w-full text-xs font-mono font-bold"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                      Bill Date <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="date"
                      required
                      value={invoiceDate}
                      onChange={(e) => setInvoiceDate(e.target.value)}
                      className="neu-input w-full text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                      Due Date
                    </label>
                    <input
                      type="date"
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      className="neu-input w-full text-xs font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* Line Items Section */}
              <div className="space-y-2.5 border-t border-[var(--khata-border)] pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-extrabold uppercase text-[var(--khata-text)]">
                    Purchased Items ({items.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => setItems((prev) => [...prev, makeEmptyLine()])}
                    className="neu-btn-secondary text-xs px-3 py-1.5 min-h-0 font-bold inline-flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Item Row</span>
                  </button>
                </div>

                <div className="space-y-3">
                  {items.map((line, idx) => {
                    const matchedProduct = line.productId
                      ? catalogProducts.find((p) => p.id === line.productId)
                      : null;
                    return (
                      <div
                        key={line.key}
                        className="p-3 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/25 space-y-2.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-extrabold text-[var(--khata-accent)]">
                            Line #{idx + 1}
                          </span>
                          <button
                            type="button"
                            disabled={items.length <= 1}
                            onClick={() =>
                              setItems((prev) => prev.filter((item) => item.key !== line.key))
                            }
                            className="p-1 text-[var(--khata-text-muted)] hover:text-rose-500 disabled:opacity-30"
                            title="Remove row"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                          <div className="sm:col-span-4">
                            <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                              Link Product (Optional)
                            </label>
                            <select
                              value={line.productId || ''}
                              onChange={(e) =>
                                handleSelectCatalogProduct(line.key, e.target.value)
                              }
                              className="neu-input w-full text-xs"
                            >
                              <option value="">-- Free-text / Custom Item --</option>
                              {catalogProducts.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} (Master: ₹{p.buying_price})
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="sm:col-span-3">
                            <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                              Description <span className="text-rose-500">*</span>
                            </label>
                            <input
                              type="text"
                              required
                              value={line.description}
                              onChange={(e) =>
                                setItems((prev) =>
                                  prev.map((it) =>
                                    it.key === line.key ? { ...it, description: e.target.value } : it
                                  )
                                )
                              }
                              placeholder="Item description"
                              className="neu-input w-full text-xs"
                            />
                          </div>

                          <div className="sm:col-span-2">
                            <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                              Qty (2dp) <span className="text-rose-500">*</span>
                            </label>
                            <input
                              type="text"
                              inputMode="decimal"
                              required
                              value={line.quantity}
                              onChange={(e) =>
                                setItems((prev) =>
                                  prev.map((it) =>
                                    it.key === line.key ? { ...it, quantity: e.target.value } : it
                                  )
                                )
                              }
                              className="neu-input w-full text-xs font-mono font-bold"
                            />
                          </div>

                          <div className="sm:col-span-2">
                            <label className="block text-[10px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                              Purchase Rate (₹) <span className="text-rose-500">*</span>
                            </label>
                            <input
                              type="text"
                              inputMode="decimal"
                              required
                              value={line.purchaseRate}
                              onChange={(e) =>
                                setItems((prev) =>
                                  prev.map((it) =>
                                    it.key === line.key
                                      ? { ...it, purchaseRate: e.target.value }
                                      : it
                                  )
                                )
                              }
                              placeholder="0.00"
                              className="neu-input w-full text-xs font-mono font-bold"
                            />
                          </div>

                          <div className="sm:col-span-1 text-right">
                            <span className="block text-[10px] uppercase text-[var(--khata-text-muted)]">
                              Total
                            </span>
                            <span className="font-mono font-bold text-xs">
                              {formatAbsRupees(draftTotals.lineTotals[idx])}
                            </span>
                          </div>
                        </div>

                        {/* Opt-in only buying price update checkbox — OFF by default */}
                        {line.productId && (
                          <label className="flex items-start gap-2 p-2 rounded-lg bg-[var(--khata-surface)] border border-[var(--khata-border)]/70 text-[11px] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={Boolean(line.updateProductBuyingPrice)}
                              onChange={(e) =>
                                setItems((prev) =>
                                  prev.map((it) =>
                                    it.key === line.key
                                      ? { ...it, updateProductBuyingPrice: e.target.checked }
                                      : it
                                  )
                                )
                              }
                              className="mt-0.5 rounded border-[var(--khata-border)] text-[var(--khata-accent)]"
                            />
                            <span className="text-[var(--khata-text)]">
                              Update this product&apos;s buying price to the purchase rate?
                              {matchedProduct && (
                                <span className="text-[var(--khata-text-muted)] ml-1.5 font-mono">
                                  (Current master: ₹{matchedProduct.buying_price})
                                </span>
                              )}
                            </span>
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Totals, Tax, Attachment & Notes */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-[var(--khata-border)] pt-3">
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                        Discount (₹)
                      </label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={discountAmount}
                        onChange={(e) => setDiscountAmount(e.target.value)}
                        className="neu-input w-full text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                        GST Rate (%)
                      </label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={gstRate}
                        onChange={(e) => setGstRate(e.target.value)}
                        className="neu-input w-full text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                      Bill Attachment (Image or PDF, max 10 MB)
                    </label>
                    <input
                      type="file"
                      accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                      onChange={(e) => setAttachmentFile(e.target.files?.[0] || null)}
                      className="neu-input w-full text-xs py-1.5"
                    />
                  </div>

                  {editingBillId && (
                    <div>
                      <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                        Edit Audit Reason
                      </label>
                      <input
                        type="text"
                        value={editReason}
                        onChange={(e) => setEditReason(e.target.value)}
                        placeholder="e.g. Corrected supplier bill rate / GST"
                        className="neu-input w-full text-xs"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                      Notes
                    </label>
                    <input
                      type="text"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Optional purchase notes"
                      className="neu-input w-full text-xs"
                    />
                  </div>
                </div>

                {/* Totals Preview Card */}
                <div className="p-4 rounded-xl bg-[var(--khata-surface-inset)]/40 border border-[var(--khata-border)] space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--khata-text-muted)]">Subtotal</span>
                    <span className="font-mono font-bold">
                      {formatAbsRupees(draftTotals.subtotalAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--khata-text-muted)]">Discount</span>
                    <span className="font-mono">
                      -{formatAbsRupees(draftTotals.discountAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--khata-text-muted)]">Taxable Amount</span>
                    <span className="font-mono font-semibold">
                      {formatAbsRupees(draftTotals.taxableAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--khata-text-muted)]">
                      GST ({safeDecimal(gstRate).toFixed(2)}%)
                    </span>
                    <span className="font-mono">{formatAbsRupees(draftTotals.gstAmount)}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-[var(--khata-border)] text-sm font-black">
                    <span>Grand Total</span>
                    <span className="font-mono text-[var(--khata-accent)]">
                      {formatAbsRupees(draftTotals.grandTotal)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-[var(--khata-border)]">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="neu-btn-secondary px-4 py-2 text-xs font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="neu-btn-primary px-5 py-2 text-xs font-bold inline-flex items-center gap-1.5"
                >
                  {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{editingBillId ? 'Save Bill Changes' : 'Save Purchase Bill'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Detail / Printable Voucher / Audit History Modal */}
      {(detailBill || loadingDetail) && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm p-2 sm:p-4 mhi-print-modal-container">
          <div className="max-w-4xl mx-auto space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-white mhi-no-print print:hidden">
              <span className="text-xs sm:text-sm font-bold">
                Purchase Bill Voucher · {detailBill?.invoiceNumber || 'Loading...'}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {detailBill && (
                  <>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="px-3 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span>Print Bill</span>
                    </button>
                    {detailBill.status === 'finalized' && (
                      <button
                        type="button"
                        onClick={() => openEditModal(detailBill.id)}
                        className="px-3 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white text-xs font-bold inline-flex items-center gap-1.5"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        <span>Edit</span>
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setDetailBill(null)}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/80 hover:bg-rose-600 text-white text-xs font-bold inline-flex items-center gap-1"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Close</span>
                </button>
              </div>
            </div>

            {loadingDetail || !detailBill ? (
              <div className="neu-card p-10 rounded-2xl flex items-center justify-center gap-2 text-xs">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
                <span>Loading purchase bill details...</span>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Printable Purchase Voucher Sheet */}
                <div className="bg-white text-slate-900 rounded-2xl p-6 sm:p-8 shadow-xl space-y-5 border border-slate-200">
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-4">
                    <div>
                      <h2 className="text-xl font-black tracking-tight uppercase">
                        Purchase Bill Voucher
                      </h2>
                      <p className="text-xs text-slate-600 font-semibold mt-0.5">
                        Invoice No: <span className="font-mono font-bold">{detailBill.invoiceNumber}</span> · Version v{detailBill.version}
                      </p>
                      <p className="text-xs text-slate-600">
                        Bill Date: <span className="font-mono">{detailBill.invoiceDate}</span>
                        {detailBill.dueDate && (
                          <> · Due: <span className="font-mono">{detailBill.dueDate}</span></>
                        )}
                      </p>
                    </div>
                    <div className="text-right text-xs space-y-0.5">
                      <div className="font-black text-sm">{detailBill.supplierName}</div>
                      {detailBill.supplierPhone && (
                        <div className="font-mono text-slate-600">{detailBill.supplierPhone}</div>
                      )}
                      {detailBill.supplierGstin && (
                        <div className="font-mono text-slate-600">
                          GSTIN: {detailBill.supplierGstin}
                        </div>
                      )}
                      {detailBill.supplierAddress && (
                        <div className="text-slate-600 max-w-xs">{detailBill.supplierAddress}</div>
                      )}
                      <div className="text-[10px] text-slate-500 print:hidden">
                        {detailBill.supplierSnapshotSource === 'snapshot'
                          ? 'Supplier snapshot locked at bill creation'
                          : 'Legacy bill (live supplier details fallback)'}
                      </div>
                      {detailBill.status === 'cancelled' && (
                        <div className="inline-block mt-1 px-2 py-0.5 rounded bg-rose-100 text-rose-700 font-bold uppercase text-[10px]">
                          CANCELLED: {detailBill.cancellationReason}
                        </div>
                      )}
                    </div>
                  </div>

                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b-2 border-slate-300 text-[11px] uppercase text-slate-600">
                        <th className="py-2 pr-2">#</th>
                        <th className="py-2 pr-2">Description</th>
                        <th className="py-2 px-2 text-right">Qty</th>
                        <th className="py-2 px-2 text-right">Purchase Rate</th>
                        <th className="py-2 pl-2 text-right">Line Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {detailBill.items.map((it, idx) => (
                        <tr key={it.id}>
                          <td className="py-2 pr-2 font-mono text-slate-500">{idx + 1}</td>
                          <td className="py-2 pr-2">
                            <div className="font-semibold text-slate-900">{it.description}</div>
                            {it.productName && (
                              <div className="text-[10px] text-slate-500">
                                Linked Product: {it.productName}
                                {it.updatedProductBuyingPrice
                                  ? ' (Updated product buying price)'
                                  : ''}
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-2 text-right font-mono">{it.quantity}</td>
                          <td className="py-2 px-2 text-right font-mono">
                            {formatAbsRupees(it.purchaseRate)}
                          </td>
                          <td className="py-2 pl-2 text-right font-mono font-bold">
                            {formatAbsRupees(it.lineTotal)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="flex flex-wrap justify-between gap-4 border-t border-slate-300 pt-4 text-xs">
                    <div className="max-w-sm space-y-1 text-slate-600">
                      {detailBill.notes && (
                        <div>
                          <span className="font-bold text-slate-800">Notes: </span>
                          {detailBill.notes}
                        </div>
                      )}
                      {detailBill.allocations.length > 0 && (
                        <div className="pt-1">
                          <div className="font-bold text-slate-800 mb-1">
                            Payment Allocations:
                          </div>
                          {detailBill.allocations.map((a) => {
                            const hasReversal = safeDecimal(a.reversedAllocationAmount).greaterThan(0);
                            return (
                              <div key={a.allocationId} className="font-mono text-[11px]">
                                {a.receiptNumber} ({a.paymentDate}, {a.paymentMethod}):{' '}
                                <span
                                  className={
                                    a.paymentStatus === 'reversed' ? 'line-through text-slate-400' : 'font-bold'
                                  }
                                >
                                  {formatAbsRupees(a.allocatedAmount)}
                                </span>
                                {a.paymentStatus === 'reversed' && (
                                  <span className="ml-1 text-rose-600 font-sans font-bold">
                                    [Payment Reversed]
                                  </span>
                                )}
                                {a.paymentStatus !== 'reversed' && hasReversal && (
                                  <span className="ml-1 text-slate-500 font-sans">
                                    (Orig: {formatAbsRupees(a.originalAllocatedAmount)}, Rev:{' '}
                                    {formatAbsRupees(a.reversedAllocationAmount)})
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="w-64 space-y-1.5">
                      <div className="flex justify-between">
                        <span className="text-slate-600">Subtotal</span>
                        <span className="font-mono font-semibold">
                          {formatAbsRupees(detailBill.subtotalAmount)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">Discount</span>
                        <span className="font-mono">
                          -{formatAbsRupees(detailBill.discountAmount)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">GST ({detailBill.gstRate}%)</span>
                        <span className="font-mono">
                          {formatAbsRupees(detailBill.gstAmount)}
                        </span>
                      </div>
                      <div className="flex justify-between pt-1.5 border-t border-slate-300 text-sm font-black">
                        <span>Grand Total</span>
                        <span className="font-mono">{formatAbsRupees(detailBill.grandTotal)}</span>
                      </div>
                      <div className="flex justify-between text-emerald-700 font-semibold">
                        <span>Paid / Allocated</span>
                        <span className="font-mono">
                          {formatAbsRupees(detailBill.allocatedAmount)}
                        </span>
                      </div>
                      <div className="flex justify-between text-rose-700 font-bold">
                        <span>Balance Due</span>
                        <span className="font-mono">
                          {formatAbsRupees(detailBill.remainingAmount)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Non-Printable Attachment & Audit Management Panel */}
                <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-4 mhi-no-print print:hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="text-xs font-extrabold uppercase text-[var(--khata-text)] flex items-center gap-1.5">
                        <FileText className="w-4 h-4 text-[var(--khata-accent)]" />
                        <span>Bill Attachment (Image / PDF)</span>
                      </h4>
                      <p className="text-[11px] text-[var(--khata-text-muted)]">
                        {detailBill.hasAttachment
                          ? detailBill.attachmentFilename || 'Attached file'
                          : 'No invoice file attached yet.'}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="neu-btn-secondary text-xs px-3 py-1.5 min-h-0 font-bold inline-flex items-center gap-1.5 cursor-pointer">
                        {attachmentBusy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Upload className="w-3.5 h-3.5" />
                        )}
                        <span>{detailBill.hasAttachment ? 'Replace File' : 'Upload File'}</span>
                        <input
                          type="file"
                          className="hidden"
                          accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                          disabled={attachmentBusy}
                          onChange={(e) => void handleUploadAttachmentInDetail(e.target.files?.[0])}
                        />
                      </label>
                      {detailBill.hasAttachment && (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleDownloadAttachment(detailBill)}
                            className="neu-btn-secondary text-xs px-3 py-1.5 min-h-0 font-bold inline-flex items-center gap-1"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Download</span>
                          </button>
                          <button
                            type="button"
                            disabled={attachmentBusy}
                            onClick={() => void handleRemoveAttachment(detailBill.id)}
                            className="neu-btn-danger text-xs px-3 py-1.5 min-h-0 font-bold"
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {attachmentPreviewUrl && (
                    <div className="p-2 rounded-xl border border-[var(--khata-border)] bg-black/5 max-h-80 overflow-hidden flex justify-center">
                      <img
                        src={attachmentPreviewUrl}
                        alt="Supplier invoice attachment"
                        className="max-h-72 object-contain rounded-lg"
                      />
                    </div>
                  )}

                  {/* Audit History Timeline */}
                  <div className="border-t border-[var(--khata-border)] pt-3 space-y-2">
                    <h4 className="text-xs font-extrabold uppercase text-[var(--khata-text)] flex items-center gap-1.5">
                      <History className="w-4 h-4 text-[var(--khata-accent)]" />
                      <span>Purchase Bill Audit History</span>
                    </h4>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {detailBill.history.map((h) => (
                        <div
                          key={h.id}
                          className="p-2.5 rounded-lg bg-[var(--khata-surface-inset)]/40 text-[11px] flex flex-wrap items-center justify-between gap-2"
                        >
                          <div>
                            <span className="font-bold uppercase text-[var(--khata-accent)]">
                              v{h.version} · {h.action}
                            </span>
                            {h.reason && (
                              <span className="ml-2 text-[var(--khata-text)]">{h.reason}</span>
                            )}
                          </div>
                          <span className="font-mono text-[var(--khata-text-muted)]">
                            {new Date(h.createdAt).toLocaleString('en-IN')}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Cancel Bill Section */}
                  {detailBill.status === 'finalized' && (
                    <div className="border-t border-[var(--khata-border)] pt-3">
                      {safeDecimal(detailBill.allocatedAmount).greaterThan(0) ? (
                        <p className="text-[11px] text-[var(--khata-text-muted)]">
                          This bill has active allocated payments ({formatAbsRupees(detailBill.allocatedAmount)}). Reverse the payment or allocation in Supplier Payments before cancelling this bill.
                        </p>
                      ) : !showCancelBox ? (
                        <button
                          type="button"
                          onClick={() => setShowCancelBox(true)}
                          className="neu-btn-danger text-xs px-3.5 py-1.5 min-h-0 inline-flex items-center gap-1.5"
                        >
                          <Ban className="w-3.5 h-3.5" />
                          <span>Cancel Purchase Bill</span>
                        </button>
                      ) : (
                        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-2">
                          <label className="block text-xs font-bold text-rose-700 dark:text-rose-300">
                            Cancellation Reason (Required for Audit Trail)
                          </label>
                          <input
                            type="text"
                            value={cancelReason}
                            onChange={(e) => setCancelReason(e.target.value)}
                            placeholder="e.g. Duplicate supplier entry"
                            className="neu-input w-full text-xs"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={cancelling || !cancelReason.trim()}
                              onClick={handleConfirmCancelBill}
                              className="neu-btn-danger text-xs px-3 py-1.5 min-h-0"
                            >
                              {cancelling ? 'Cancelling...' : 'Confirm Cancel Bill'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowCancelBox(false)}
                              className="neu-btn-secondary text-xs px-3 py-1.5 min-h-0"
                            >
                              Keep Bill
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
