import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  CreditCard,
  Edit2,
  FileSpreadsheet,
  Loader2,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { INDIAN_STATES, getStateByCode } from '../../lib/indianStates.js';
import { safeDecimal } from '../../lib/formatters.js';
import {
  archiveSupplierApi,
  createSupplierApi,
  deleteSupplierApi,
  formatAbsRupees,
  listSuppliersApi,
  restoreSupplierApi,
  updateSupplierApi,
} from './suppliersApi.js';
import { SupplierPaginationBar } from './SupplierPaginationBar.js';
import type { CreateSupplierPayload, SupplierRecord } from './suppliers.types.js';

const SUPPLIER_PAGE_LIMIT = 50;

export interface SuppliersViewProps {
  onOpenSupplierDetails: (supplierId: string) => void;
  onOpenStatement: (supplierId: string) => void;
  onNewPurchaseBill?: (supplierId: string) => void;
  onNewPayment?: (supplierId: string) => void;
  onDataChanged: () => void;
  openCreateModalSignal?: number;
  refreshSignal?: number;
}

const EMPTY_FORM: CreateSupplierPayload = {
  name: '',
  contactPerson: '',
  phone: '',
  email: '',
  address: '',
  state: '',
  stateCode: '',
  gstin: '',
  notes: '',
};

export const SuppliersView: React.FC<SuppliersViewProps> = ({
  onOpenSupplierDetails,
  onOpenStatement,
  onNewPurchaseBill,
  onNewPayment,
  onDataChanged,
  openCreateModalSignal = 0,
  refreshSignal = 0,
}) => {
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [totalSuppliers, setTotalSuppliers] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const requestIdRef = useRef(0);

  // Add/Edit Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<SupplierRecord | null>(null);
  const [form, setForm] = useState<CreateSupplierPayload>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadSuppliers = async (
    query = search,
    status = statusFilter,
    targetOffset = offset
  ) => {
    const reqId = ++requestIdRef.current;
    setLoading(true);
    try {
      const res = await listSuppliersApi({
        search: query,
        status,
        limit: SUPPLIER_PAGE_LIMIT,
        offset: targetOffset,
      });
      if (reqId !== requestIdRef.current) return;
      setSuppliers(res.suppliers);
      setTotalSuppliers(res.total);
      setHasMore(
        res.pagination?.hasMore ?? targetOffset + res.suppliers.length < res.total
      );
    } catch (err: any) {
      if (reqId !== requestIdRef.current) return;
      setNotice({ type: 'error', text: err?.message || 'Failed to load suppliers.' });
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSuppliers(search, statusFilter, offset);
    }, 200);
    return () => clearTimeout(timer);
  }, [search, statusFilter, offset, refreshSignal]);

  useEffect(() => {
    if (openCreateModalSignal > 0) {
      openCreateModal();
    }
  }, [openCreateModalSignal]);

  const openCreateModal = () => {
    setEditingSupplier(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  };

  const openEditModal = (supplier: SupplierRecord) => {
    setEditingSupplier(supplier);
    setForm({
      name: supplier.name,
      contactPerson: supplier.contactPerson || '',
      phone: supplier.phone || '',
      email: supplier.email || '',
      address: supplier.address || '',
      state: supplier.state || '',
      stateCode: supplier.stateCode || '',
      gstin: supplier.gstin || '',
      notes: supplier.notes || '',
    });
    setFormError(null);
    setModalOpen(true);
  };

  const handleStateCodeSelect = (code: string) => {
    if (!code) {
      setForm((prev) => ({ ...prev, state: '', stateCode: '' }));
      return;
    }
    const found = getStateByCode(code);
    setForm((prev) => ({
      ...prev,
      stateCode: code,
      state: found ? found.name : prev.state,
    }));
  };

  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setFormError('Supplier name is required.');
      return;
    }

    setFormError(null);
    setSubmitting(true);

    const payload: CreateSupplierPayload = {
      name: form.name.trim(),
      contactPerson: form.contactPerson?.trim() || null,
      phone: form.phone?.trim() || null,
      email: form.email?.trim() || null,
      address: form.address?.trim() || null,
      state: form.state?.trim() || null,
      stateCode: form.stateCode?.trim() || null,
      gstin: form.gstin?.trim() ? form.gstin.trim().toUpperCase() : null,
      notes: form.notes?.trim() || null,
    };

    try {
      if (editingSupplier) {
        await updateSupplierApi(editingSupplier.id, payload);
        setNotice({ type: 'success', text: `Supplier "${payload.name}" updated.` });
      } else {
        await createSupplierApi(payload);
        setNotice({ type: 'success', text: `Supplier "${payload.name}" created.` });
      }
      setModalOpen(false);
      onDataChanged();
      await loadSuppliers();
    } catch (err: any) {
      setFormError(err?.message || 'Unable to save supplier details.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleArchiveToggle = async (supplier: SupplierRecord) => {
    setNotice(null);
    try {
      if (supplier.archivedAt) {
        await restoreSupplierApi(supplier.id);
        setNotice({ type: 'success', text: `Supplier "${supplier.name}" restored.` });
      } else {
        await archiveSupplierApi(supplier.id);
        setNotice({
          type: 'success',
          text: `Supplier "${supplier.name}" archived. Historical bills & statements remain intact.`,
        });
      }
      onDataChanged();
      await loadSuppliers();
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Failed to update supplier status.' });
    }
  };

  const handlePermanentDelete = async (supplier: SupplierRecord) => {
    setNotice(null);
    if (supplier.purchaseBillCount > 0 || supplier.paymentCount > 0) {
      setNotice({
        type: 'error',
        text: `"${supplier.name}" has historical purchase bills or payments and cannot be permanently deleted. Archive instead.`,
      });
      return;
    }
    try {
      await deleteSupplierApi(supplier.id);
      setNotice({ type: 'success', text: `Supplier "${supplier.name}" deleted.` });
      onDataChanged();
      await loadSuppliers();
    } catch (err: any) {
      setNotice({ type: 'error', text: err?.message || 'Failed to delete supplier.' });
    }
  };

  return (
    <div className="space-y-4">
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

      {/* Header & Controls */}
      <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-extrabold text-[var(--khata-text)]">
              All Suppliers Directory
            </h3>
            <p className="text-xs text-[var(--khata-text-muted)]">
              Register suppliers, prevent duplicates, and archive inactive vendors without losing history
            </p>
          </div>
          <button
            type="button"
            onClick={openCreateModal}
            className="neu-btn-primary text-xs px-4 py-2 font-bold inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Add New Supplier</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[210px]">
            <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              placeholder="Search name, contact person, phone, GSTIN..."
              className="neu-input w-full pl-9 pr-3 py-1.5 text-xs font-medium"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {(['active', 'archived', 'all'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setStatusFilter(tab);
                  setOffset(0);
                }}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold capitalize transition ${
                  statusFilter === tab
                    ? 'bg-[var(--khata-accent)] text-white shadow'
                    : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Suppliers Grid */}
      {loading ? (
        <div className="neu-card p-10 rounded-2xl flex items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
          <span>Loading suppliers...</span>
        </div>
      ) : suppliers.length === 0 ? (
        <div className="neu-card p-10 rounded-2xl text-center text-xs text-[var(--khata-text-muted)]">
          No suppliers found. Click &ldquo;Add New Supplier&rdquo; to create your first supplier record.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Compact Operational Table on Desktop */}
          <div className="hidden lg:block neu-card rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[var(--khata-surface-inset)]/60 text-[10px] uppercase tracking-wider text-[var(--khata-text-muted)]">
                  <tr>
                    <th className="text-left px-4 py-3 font-bold">Supplier</th>
                    <th className="text-left px-4 py-3 font-bold">Mobile</th>
                    <th className="text-right px-4 py-3 font-bold">Outstanding / Advance</th>
                    <th className="text-left px-4 py-3 font-bold">Last Activity</th>
                    <th className="text-right px-4 py-3 font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--khata-border)]/60">
                  {suppliers.map((s) => {
                    const net = safeDecimal(s.netBalance);
                    const hasHistory = s.purchaseBillCount > 0 || s.paymentCount > 0;
                    const canPayOrSettle =
                      !s.archivedAt || safeDecimal(s.outstandingPayable).greaterThan(0);
                    return (
                      <tr key={s.id} className="hover:bg-[var(--khata-surface-inset)]/25">
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onOpenSupplierDetails(s.id)}
                              className="text-left text-xs font-extrabold text-[var(--khata-text)] hover:text-[var(--khata-accent)]"
                            >
                              {s.name}
                            </button>
                            {s.archivedAt && (
                              <span className="neu-badge neu-badge-warning text-[9px]">
                                Archived
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-[var(--khata-text-muted)]">
                            {s.gstin
                              ? `GSTIN: ${s.gstin}`
                              : s.contactPerson
                                ? `Contact: ${s.contactPerson}`
                                : `Bills: ${s.purchaseBillCount} · Payments: ${s.paymentCount}`}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[var(--khata-text)]">
                          {s.phone || '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex flex-col items-end gap-0.5">
                            {net.greaterThan(0) ? (
                              <span className="px-2 py-0.5 rounded bg-rose-500/12 text-rose-600 dark:text-rose-400 font-mono font-bold">
                                Payable {formatAbsRupees(net)}
                              </span>
                            ) : net.lessThan(0) ? (
                              <span className="px-2 py-0.5 rounded bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 font-mono font-bold">
                                Advance {formatAbsRupees(net)}
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)] font-mono font-semibold">
                                Settled ₹0.00
                              </span>
                            )}
                            {safeDecimal(s.unallocatedPayments).greaterThan(0) && (
                              <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
                                Unallocated: {formatAbsRupees(s.unallocatedPayments)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-[var(--khata-text-muted)]">
                          {s.lastActivity || 'No activity'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => onOpenSupplierDetails(s.id)}
                              className="neu-btn-secondary text-[11px] px-2.5 py-1 min-h-0 font-bold"
                            >
                              Details
                            </button>
                            <button
                              type="button"
                              onClick={() => onOpenStatement(s.id)}
                              className="neu-btn-secondary text-[11px] px-2.5 py-1 min-h-0 font-bold inline-flex items-center gap-1"
                              title="Supplier Statement"
                            >
                              <FileSpreadsheet className="w-3 h-3 text-[var(--khata-accent)]" />
                              <span>Statement</span>
                            </button>
                            {!s.archivedAt && onNewPurchaseBill && (
                              <button
                                type="button"
                                onClick={() => onNewPurchaseBill(s.id)}
                                className="neu-btn-secondary text-[11px] px-2.5 py-1 min-h-0 font-bold inline-flex items-center gap-1"
                                title="Record Purchase Bill"
                              >
                                <Receipt className="w-3 h-3 text-[var(--khata-accent)]" />
                                <span>+ Bill</span>
                              </button>
                            )}
                            {canPayOrSettle && onNewPayment && (
                              <button
                                type="button"
                                onClick={() => onNewPayment(s.id)}
                                className="neu-btn-secondary text-[11px] px-2.5 py-1 min-h-0 font-bold inline-flex items-center gap-1"
                                title={s.archivedAt ? 'Settle Outstanding Bills' : 'Record Payment'}
                              >
                                <CreditCard className="w-3 h-3 text-emerald-600" />
                                <span>{s.archivedAt ? 'Settle' : 'Pay'}</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openEditModal(s)}
                              className="p-1.5 rounded-lg bg-[var(--khata-surface-inset)] hover:bg-[var(--khata-accent)]/15 text-[var(--khata-text)] transition"
                              title="Edit Supplier"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleArchiveToggle(s)}
                              className="p-1.5 rounded-lg bg-[var(--khata-surface-inset)] hover:bg-amber-500/15 text-amber-700 dark:text-amber-300 transition"
                              title={s.archivedAt ? 'Restore Supplier' : 'Archive Supplier'}
                            >
                              {s.archivedAt ? (
                                <RotateCcw className="w-3.5 h-3.5" />
                              ) : (
                                <Archive className="w-3.5 h-3.5" />
                              )}
                            </button>
                            {!hasHistory && (
                              <button
                                type="button"
                                onClick={() => handlePermanentDelete(s)}
                                className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 transition"
                                title="Delete Unused Supplier"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile & Tablet Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:hidden gap-4">
            {suppliers.map((s) => {
              const net = safeDecimal(s.netBalance);
              const hasHistory = s.purchaseBillCount > 0 || s.paymentCount > 0;
              const canPayOrSettle =
                !s.archivedAt || safeDecimal(s.outstandingPayable).greaterThan(0);
              return (
                <div
                  key={s.id}
                  className="neu-card p-4 sm:p-5 rounded-2xl flex flex-col justify-between gap-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <button
                        type="button"
                        onClick={() => onOpenSupplierDetails(s.id)}
                        className="text-left text-base font-extrabold text-[var(--khata-text)] hover:text-[var(--khata-accent)]"
                      >
                        {s.name}
                      </button>
                      <div className="text-xs text-[var(--khata-text-muted)] mt-0.5 space-y-0.5">
                        {s.phone && <div className="font-mono">{s.phone}</div>}
                        {s.gstin && <div className="font-mono">GSTIN: {s.gstin}</div>}
                        <div>Last activity: {s.lastActivity || 'None'}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      {s.archivedAt ? (
                        <span className="neu-badge neu-badge-warning text-[10px]">
                          <Archive className="w-3 h-3" /> Archived
                        </span>
                      ) : (
                        <span className="neu-badge neu-badge-success text-[10px]">Active</span>
                      )}
                      <div className="mt-2">
                        <span className="text-[10px] uppercase text-[var(--khata-text-muted)] block">
                          {net.greaterThan(0)
                            ? 'Payable'
                            : net.lessThan(0)
                              ? 'Advance Credit'
                              : 'Settled'}
                        </span>
                        <span
                          className={`font-mono font-black text-sm ${
                            net.greaterThan(0)
                              ? 'text-rose-600 dark:text-rose-400'
                              : net.lessThan(0)
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-[var(--khata-text)]'
                          }`}
                        >
                          {formatAbsRupees(net)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--khata-border)]/60">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onOpenSupplierDetails(s.id)}
                        className="neu-btn-secondary text-xs px-2.5 py-1.5 min-h-0 font-bold"
                      >
                        Details
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenStatement(s.id)}
                        className="neu-btn-secondary text-xs px-2.5 py-1.5 min-h-0 font-bold inline-flex items-center gap-1"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                        <span>Statement</span>
                      </button>
                      {!s.archivedAt && onNewPurchaseBill && (
                        <button
                          type="button"
                          onClick={() => onNewPurchaseBill(s.id)}
                          className="neu-btn-secondary text-xs px-2.5 py-1.5 min-h-0 font-bold"
                        >
                          + Bill
                        </button>
                      )}
                      {canPayOrSettle && onNewPayment && (
                        <button
                          type="button"
                          onClick={() => onNewPayment(s.id)}
                          className="neu-btn-secondary text-xs px-2.5 py-1.5 min-h-0 font-bold"
                        >
                          {s.archivedAt ? 'Settle' : 'Pay'}
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openEditModal(s)}
                        className="p-2 rounded-lg bg-[var(--khata-surface-inset)] hover:bg-[var(--khata-accent)]/15 text-[var(--khata-text)] transition"
                        title="Edit Supplier"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleArchiveToggle(s)}
                        className="p-2 rounded-lg bg-[var(--khata-surface-inset)] hover:bg-amber-500/15 text-amber-700 dark:text-amber-300 transition"
                        title={s.archivedAt ? 'Restore Supplier' : 'Archive Supplier'}
                      >
                        {s.archivedAt ? (
                          <RotateCcw className="w-3.5 h-3.5" />
                        ) : (
                          <Archive className="w-3.5 h-3.5" />
                        )}
                      </button>
                      {!hasHistory && (
                        <button
                          type="button"
                          onClick={() => handlePermanentDelete(s)}
                          className="p-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 transition"
                          title="Delete Unused Supplier"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="neu-card p-3 sm:p-4 rounded-2xl">
            <SupplierPaginationBar
              offset={offset}
              limit={SUPPLIER_PAGE_LIMIT}
              total={totalSuppliers}
              currentCount={suppliers.length}
              hasMore={hasMore}
              loading={loading}
              itemLabel="suppliers"
              onPageChange={(nextOffset) => setOffset(nextOffset)}
            />
          </div>
        </div>
      )}

      {/* Add / Edit Supplier Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
          <div className="neu-card w-full max-w-2xl rounded-2xl p-5 sm:p-6 my-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--khata-border)] pb-3">
              <h3 className="text-base font-extrabold text-[var(--khata-text)]">
                {editingSupplier ? `Edit Supplier · ${editingSupplier.name}` : 'Register New Supplier'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
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

            <form onSubmit={handleSubmitForm} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Supplier Name <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. Shree Balaji Hardware"
                    className="neu-input w-full text-sm font-semibold"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Contact Person
                  </label>
                  <input
                    type="text"
                    value={form.contactPerson || ''}
                    onChange={(e) => setForm((p) => ({ ...p, contactPerson: e.target.value }))}
                    placeholder="Optional"
                    className="neu-input w-full text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Mobile Number
                  </label>
                  <input
                    type="tel"
                    value={form.phone || ''}
                    onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                    placeholder="e.g. 9876543210"
                    className="neu-input w-full text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    value={form.email || ''}
                    onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                    placeholder="Optional"
                    className="neu-input w-full text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    State &amp; Code
                  </label>
                  <select
                    value={form.stateCode || ''}
                    onChange={(e) => handleStateCodeSelect(e.target.value)}
                    className="neu-input w-full text-sm font-medium"
                  >
                    <option value="">-- Optional State --</option>
                    {INDIAN_STATES.map((st) => (
                      <option key={st.code} value={st.code}>
                        {st.code} - {st.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                    GSTIN (15-char)
                  </label>
                  <input
                    type="text"
                    maxLength={15}
                    value={form.gstin || ''}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, gstin: e.target.value.toUpperCase() }))
                    }
                    placeholder="e.g. 10AABCU9603R1ZM"
                    className="neu-input w-full text-sm font-mono uppercase"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                  Address
                </label>
                <textarea
                  rows={2}
                  value={form.address || ''}
                  onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                  placeholder="Optional street, city, PIN code"
                  className="neu-input w-full text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase text-[var(--khata-text-muted)] mb-1">
                  Notes
                </label>
                <input
                  type="text"
                  value={form.notes || ''}
                  onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                  placeholder="Payment terms or internal notes"
                  className="neu-input w-full text-xs"
                />
              </div>

              <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-[var(--khata-border)]">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
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
                  <span>{editingSupplier ? 'Save Changes' : 'Create Supplier'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
