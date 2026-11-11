import React, { useState, useEffect, useCallback } from 'react';
import { INDIAN_STATES, getStateByCode } from '../../lib/indianStates.js';
import {
  FileText,
  Plus,
  Search,
  Download,
  Eye,
  Settings,
  ArrowRight,
  CheckCircle,
  Clock,
  Send,
  XCircle,
  RefreshCw,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import {
  Quotation,
  QuotationStatus,
  QuotationSummaryCounts,
  QuotationSettings,
} from './quotation.types.js';
import {
  fetchQuotations,
  updateQuotationStatus,
  fetchQuotationSettings,
  updateQuotationSettings,
  fetchSavedQuotationPdfBlob,
} from './quotationApi.js';
import { QuotationEditor } from './QuotationEditor.js';
import { QuotationPreview } from './QuotationPreview.js';
import { QuotationConvertModal } from './QuotationConvertModal.js';
import { formatCurrency } from '../../lib/formatters.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';

export const QuotationsView: React.FC = () => {
  const [viewMode, setViewMode] = useState<'list' | 'create'>('list');
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [summaryCounts, setSummaryCounts] = useState<QuotationSummaryCounts>({
    total: 0,
    draft: 0,
    sent: 0,
    accepted: 0,
    converted: 0,
    rejectedOrExpired: 0,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;
  const [pagination, setPagination] = useState<{ limit: number; offset: number; hasMore: boolean; nextOffset: number | null }>({
    limit: PAGE_SIZE,
    offset: 0,
    hasMore: false,
    nextOffset: null,
  });

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, statusFilter]);

  // Modals
  const [previewQuotation, setPreviewQuotation] = useState<Quotation | null>(null);
  const [convertQuotation, setConvertQuotation] = useState<Quotation | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<QuotationSettings | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // Notifications
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  const loadQuotations = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetchQuotations({
        search: debouncedSearch || undefined,
        status: statusFilter || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setQuotations(res.quotations);
      setPagination(res.pagination);
      setSummaryCounts(res.summaryCounts);
    } catch (err: any) {
      showNotification('error', err?.message || 'Failed to load quotations.');
    } finally {
      setIsLoading(false);
    }
  }, [debouncedSearch, statusFilter, page]);

  useEffect(() => {
    loadQuotations();
  }, [loadQuotations]);

  // Load settings
  useEffect(() => {
    (async () => {
      try {
        const s = await fetchQuotationSettings();
        setSettings(s);
      } catch {
        // Non-fatal
      }
    })();
  }, []);

  const handleStatusChange = async (id: number, newStatus: QuotationStatus) => {
    try {
      const updated = await updateQuotationStatus(id, newStatus);
      setQuotations((prev) => prev.map((q) => (q.id === id ? updated : q)));
      showNotification('success', `Quotation #${updated.quotation_number} status updated to ${newStatus}.`);
      loadQuotations();
    } catch (err: any) {
      showNotification('error', err?.message || 'Could not update status.');
    }
  };

  const handleDownloadPdf = async (quotation: Quotation) => {
    try {
      const blob = await fetchSavedQuotationPdfBlob(quotation.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Quotation-${quotation.quotation_number}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      showNotification('error', err?.message || 'Failed to download PDF.');
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setIsSavingSettings(true);
    try {
      const updated = await updateQuotationSettings(settings);
      setSettings(updated);
      setIsSettingsOpen(false);
      showNotification('success', 'Quotation company settings updated.');
    } catch (err: any) {
      showNotification('error', err?.message || 'Failed to update settings.');
    } finally {
      setIsSavingSettings(false);
    }
  };

  if (viewMode === 'create') {
    return (
      <QuotationEditor
        onCancel={() => setViewMode('list')}
        onSaved={(newQuotation) => {
          setViewMode('list');
          showNotification('success', `Quotation #${newQuotation.quotation_number} saved successfully!`);
          loadQuotations();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--khata-border)]">
        <div className="flex items-center gap-2.5">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shadow-inner"
            style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-accent)' }}
          >
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold">Quotations & Proposals</h2>
            <p className="text-xs text-[var(--khata-text-muted)]">
              Algions AI Labs Private Limited commercial offers & estimations
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="neu-btn-secondary text-xs px-3.5 py-2 font-bold inline-flex items-center gap-1.5"
            title="Quotation Profile & Settings"
          >
            <Settings className="w-4 h-4 text-[var(--khata-accent)]" />
            <span className="hidden sm:inline">Settings</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('create')}
            className="neu-btn-primary text-xs px-4 py-2 font-bold inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Create Quotation</span>
          </button>
        </div>
      </div>

      {notification && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs font-semibold flex items-center justify-between ${
            notification.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-500'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? (
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{notification.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotification(null)}
            className="p-1 rounded hover:bg-black/5"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Summary Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Total */}
        <button
          type="button"
          onClick={() => setStatusFilter('')}
          className={`neu-card p-3 rounded-xl text-left transition border ${
            statusFilter === ''
              ? 'border-[var(--khata-accent)] bg-[var(--khata-surface-inset)] shadow-md'
              : 'border-transparent'
          }`}
        >
          <div className="text-[10px] font-bold uppercase text-[var(--khata-text-muted)]">
            Total
          </div>
          <div className="text-lg font-black text-[var(--khata-text)] mt-0.5">
            {summaryCounts.total}
          </div>
        </button>

        {/* Draft */}
        <button
          type="button"
          onClick={() => setStatusFilter('draft')}
          className={`neu-card p-3 rounded-xl text-left transition border ${
            statusFilter === 'draft'
              ? 'border-amber-500 bg-amber-500/10 shadow-md'
              : 'border-transparent'
          }`}
        >
          <div className="text-[10px] font-bold uppercase text-amber-500 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span>Draft</span>
          </div>
          <div className="text-lg font-black text-[var(--khata-text)] mt-0.5">
            {summaryCounts.draft}
          </div>
        </button>

        {/* Sent */}
        <button
          type="button"
          onClick={() => setStatusFilter('sent')}
          className={`neu-card p-3 rounded-xl text-left transition border ${
            statusFilter === 'sent'
              ? 'border-blue-500 bg-blue-500/10 shadow-md'
              : 'border-transparent'
          }`}
        >
          <div className="text-[10px] font-bold uppercase text-blue-500 flex items-center gap-1">
            <Send className="w-3 h-3" />
            <span>Sent</span>
          </div>
          <div className="text-lg font-black text-[var(--khata-text)] mt-0.5">
            {summaryCounts.sent}
          </div>
        </button>

        {/* Accepted */}
        <button
          type="button"
          onClick={() => setStatusFilter('accepted')}
          className={`neu-card p-3 rounded-xl text-left transition border ${
            statusFilter === 'accepted'
              ? 'border-emerald-500 bg-emerald-500/10 shadow-md'
              : 'border-transparent'
          }`}
        >
          <div className="text-[10px] font-bold uppercase text-emerald-500 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />
            <span>Accepted</span>
          </div>
          <div className="text-lg font-black text-[var(--khata-text)] mt-0.5">
            {summaryCounts.accepted}
          </div>
        </button>

        {/* Converted */}
        <button
          type="button"
          onClick={() => setStatusFilter('converted')}
          className={`neu-card p-3 rounded-xl text-left transition border ${
            statusFilter === 'converted'
              ? 'border-purple-500 bg-purple-500/10 shadow-md'
              : 'border-transparent'
          }`}
        >
          <div className="text-[10px] font-bold uppercase text-purple-500 flex items-center gap-1">
            <ArrowRight className="w-3 h-3" />
            <span>Converted</span>
          </div>
          <div className="text-lg font-black text-[var(--khata-text)] mt-0.5">
            {summaryCounts.converted}
          </div>
        </button>

        {/* Rejected / Expired */}
        <button
          type="button"
          onClick={() => setStatusFilter('rejected_or_expired')}
          className={`neu-card p-3 rounded-xl text-left transition border ${
            statusFilter === 'rejected_or_expired'
              ? 'border-rose-500 bg-rose-500/10 shadow-md'
              : 'border-transparent'
          }`}
        >
          <div className="text-[10px] font-bold uppercase text-rose-500 flex items-center gap-1">
            <XCircle className="w-3 h-3" />
            <span>Rejected / Expired</span>
          </div>
          <div className="text-lg font-black text-[var(--khata-text)] mt-0.5">
            {summaryCounts.rejectedOrExpired}
          </div>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-3.5 top-3 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search quotations by number, customer, or project..."
            className="neu-input neu-input-with-leading-icon w-full text-xs font-medium py-2.5"
          />
        </div>

        <button
          type="button"
          onClick={loadQuotations}
          className="neu-btn-secondary text-xs px-3.5 py-2.5 inline-flex items-center gap-1.5"
          title="Refresh List"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Quotations List: Mobile Card View (sm:hidden) and Desktop Table View (hidden sm:block) */}
      <div className="neu-card overflow-hidden rounded-2xl">
        {isLoading ? (
          <div className="p-12 text-center text-xs text-[var(--khata-text-muted)] flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
            <span>Loading quotations...</span>
          </div>
        ) : quotations.length === 0 ? (
          <div className="p-12 text-center text-xs text-[var(--khata-text-muted)] space-y-2">
            <FileText className="w-8 h-8 mx-auto opacity-30" />
            <p>No quotations found matching your criteria.</p>
            <button
              type="button"
              onClick={() => setViewMode('create')}
              className="neu-btn-primary text-xs px-4 py-1.5 font-bold inline-flex items-center gap-1 mt-2"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create First Quotation</span>
            </button>
          </div>
        ) : (
          <>
            {/* 1. Mobile Phone Card View (sm:hidden) */}
            <div className="block sm:hidden divide-y divide-[var(--khata-border)]">
              {quotations.map((q) => {
                const statusColors: Record<string, string> = {
                  draft: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
                  sent: 'bg-blue-500/10 text-blue-500 border-blue-500/30',
                  accepted: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
                  converted: 'bg-purple-500/10 text-purple-500 border-purple-500/30',
                  rejected: 'bg-rose-500/10 text-rose-500 border-rose-500/30',
                  expired: 'bg-neutral-500/10 text-neutral-400 border-neutral-500/30',
                };

                return (
                  <div key={q.id} className="p-4 space-y-2.5 hover:bg-[var(--khata-surface-inset)]/30 transition">
                    {/* Top Row: Quotation Number + Status + Date */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-sm text-[var(--khata-accent)]">
                          {q.quotation_number}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                            statusColors[q.status] || 'bg-neutral-500/10 text-neutral-400'
                          }`}
                        >
                          {q.status}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--khata-text-muted)] font-medium">
                        {q.quotation_date}
                        {q.valid_until && <span className="opacity-75"> (Exp: {q.valid_until})</span>}
                      </div>
                    </div>

                    {/* Middle: Customer & Project Details */}
                    <div className="text-xs space-y-0.5">
                      <div className="font-bold text-[var(--khata-text)] text-sm">{q.customer_name}</div>
                      {q.customer_phone && (
                        <div className="text-[11px] text-[var(--khata-text-muted)] font-mono">{q.customer_phone}</div>
                      )}
                      {(q.project_title || q.subject) && (
                        <div className="text-[11px] text-[var(--khata-text-muted)] truncate max-w-full">
                          {q.project_title || q.subject}
                        </div>
                      )}
                    </div>

                    {/* Bottom Row: Total & Action Buttons */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--khata-border)]/60">
                      <div>
                        <div className="text-[10px] uppercase font-bold text-[var(--khata-text-muted)]">Grand Total</div>
                        <div className="text-base font-black text-[var(--khata-text)]">₹{formatCurrency(q.grand_total)}</div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setPreviewQuotation(q)}
                          className="p-1.5 rounded-lg neu-btn-secondary text-xs inline-flex items-center gap-1"
                          title="Preview PDF"
                        >
                          <Eye className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                          <span>PDF</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDownloadPdf(q)}
                          className="p-1.5 rounded-lg neu-btn-secondary text-xs inline-flex items-center"
                          title="Download PDF"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>

                        {q.status !== 'converted' ? (
                          <>
                            <select
                              value={q.status}
                              onChange={(e) => handleStatusChange(q.id, e.target.value as QuotationStatus)}
                              className="text-[11px] font-bold rounded-lg border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] text-[var(--khata-text)] px-1.5 py-1 focus:outline-none"
                            >
                              <option value="draft">Draft</option>
                              <option value="sent">Sent</option>
                              <option value="accepted">Accepted</option>
                              <option value="rejected">Rejected</option>
                              <option value="expired">Expired</option>
                            </select>
                            <button
                              type="button"
                              onClick={() => setConvertQuotation(q)}
                              className="px-2.5 py-1 rounded-lg text-xs font-bold bg-[var(--khata-accent)] text-white hover:opacity-90 transition inline-flex items-center gap-1 shadow-sm"
                              title="Convert quotation to bill"
                            >
                              <span>Convert</span>
                              <ArrowRight className="w-3 h-3" />
                            </button>
                          </>
                        ) : (
                          <span className="text-[10px] font-bold text-purple-400 bg-purple-500/10 px-2 py-1 rounded">
                            {q.converted_normal_bill_id
                              ? `Bill #${q.converted_normal_bill_id}`
                              : `Invoice #${q.converted_gst_invoice_id}`}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 2. Desktop Table View (hidden sm:block) */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-[var(--khata-surface-inset)] border-b border-[var(--khata-border)] font-bold text-[var(--khata-text-muted)] uppercase">
                    <th className="py-3 px-4 sm:px-6">Quotation No</th>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Customer</th>
                    <th className="py-3 px-4">Project</th>
                    <th className="py-3 px-4 text-right">Grand Total</th>
                    <th className="py-3 px-4 text-center">Status</th>
                    <th className="py-3 px-4 sm:px-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--khata-border)]">
                  {quotations.map((q) => {
                    const statusColors: Record<string, string> = {
                      draft: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
                      sent: 'bg-blue-500/10 text-blue-500 border-blue-500/30',
                      accepted: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
                      converted: 'bg-purple-500/10 text-purple-500 border-purple-500/30',
                      rejected: 'bg-rose-500/10 text-rose-500 border-rose-500/30',
                      expired: 'bg-neutral-500/10 text-neutral-400 border-neutral-500/30',
                    };

                    return (
                      <tr key={q.id} className="hover:bg-[var(--khata-surface-inset)]/40 transition">
                        {/* Quotation No */}
                        <td className="py-3.5 px-4 sm:px-6 font-mono font-bold text-[var(--khata-accent)]">
                          {q.quotation_number}
                        </td>

                        {/* Date */}
                        <td className="py-3.5 px-4">
                          <div className="font-medium text-[var(--khata-text)]">{q.quotation_date}</div>
                          {q.valid_until && (
                            <div className="text-[10px] text-[var(--khata-text-muted)]">
                              Valid: {q.valid_until}
                            </div>
                          )}
                        </td>

                        {/* Customer */}
                        <td className="py-3.5 px-4">
                          <div className="font-bold text-[var(--khata-text)]">{q.customer_name}</div>
                          {q.customer_phone && (
                            <div className="text-[10px] text-[var(--khata-text-muted)] font-mono">{q.customer_phone}</div>
                          )}
                        </td>

                        {/* Project */}
                        <td className="py-3.5 px-4">
                          <div className="font-medium truncate max-w-[180px]">
                            {q.project_title || q.subject || '—'}
                          </div>
                        </td>

                        {/* Total */}
                        <td className="py-3.5 px-4 text-right font-bold text-sm">
                          ₹{formatCurrency(q.grand_total)}
                        </td>

                        {/* Status */}
                        <td className="py-3.5 px-4 text-center">
                          <div className="inline-flex items-center gap-1.5">
                            <span
                              className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                                statusColors[q.status] || 'bg-neutral-500/10 text-neutral-400'
                              }`}
                            >
                              {q.status}
                            </span>
                          </div>
                        </td>

                        {/* Actions */}
                        <td className="py-3.5 px-4 sm:px-6 text-right">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {/* View PDF */}
                            <button
                              type="button"
                              onClick={() => setPreviewQuotation(q)}
                              className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-accent)] hover:bg-[var(--khata-surface-inset)] transition"
                              title="Preview / Print PDF"
                            >
                              <Eye className="w-4 h-4" />
                            </button>

                            {/* Download PDF */}
                            <button
                              type="button"
                              onClick={() => handleDownloadPdf(q)}
                              className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-accent)] hover:bg-[var(--khata-surface-inset)] transition"
                              title="Download PDF Document"
                            >
                              <Download className="w-4 h-4" />
                            </button>

                            {/* Status Dropdown */}
                            {q.status !== 'converted' && (
                              <select
                                value={q.status}
                                onChange={(e) => handleStatusChange(q.id, e.target.value as QuotationStatus)}
                                className="text-[10px] font-bold rounded-lg border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] text-[var(--khata-text)] px-1.5 py-1 focus:outline-none"
                              >
                                <option value="draft">Draft</option>
                                <option value="sent">Sent</option>
                                <option value="accepted">Accepted</option>
                                <option value="rejected">Rejected</option>
                                <option value="expired">Expired</option>
                              </select>
                            )}

                            {/* Convert to Bill button */}
                            {q.status !== 'converted' ? (
                              <button
                                type="button"
                                onClick={() => setConvertQuotation(q)}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[var(--khata-accent)] text-white hover:opacity-90 transition flex items-center gap-1 shadow-sm"
                                title="Convert quotation to an official bill"
                              >
                                <span>Convert</span>
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            ) : (
                              <span className="text-[10px] font-bold text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">
                                {q.converted_normal_bill_id
                                  ? `Bill #${q.converted_normal_bill_id}`
                                  : `Invoice #${q.converted_gst_invoice_id}`}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-t border-[var(--khata-border)] text-xs bg-[var(--khata-surface-inset)]/50">
              <span className="text-[var(--khata-text-muted)] font-medium">
                Showing {quotations.length > 0 ? page * PAGE_SIZE + 1 : 0}–{page * PAGE_SIZE + quotations.length} of {summaryCounts.total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page === 0 || isLoading}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="px-3 py-1.5 rounded-lg border border-[var(--khata-border)] bg-[var(--khata-surface)] font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:border-[var(--khata-accent)] transition"
                >
                  Previous
                </button>
                <span className="font-bold px-2 text-[var(--khata-text)]">
                  Page {page + 1}
                </span>
                <button
                  type="button"
                  disabled={!pagination.hasMore || isLoading}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-3 py-1.5 rounded-lg border border-[var(--khata-border)] bg-[var(--khata-surface)] font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:border-[var(--khata-accent)] transition"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* PDF Preview Modal */}
      {previewQuotation && (
        <QuotationPreview
          isOpen={Boolean(previewQuotation)}
          quotation={previewQuotation}
          onClose={() => setPreviewQuotation(null)}
        />
      )}

      {/* Convert to Bill Modal */}
      {convertQuotation && (
        <QuotationConvertModal
          isOpen={Boolean(convertQuotation)}
          quotation={convertQuotation}
          onClose={() => setConvertQuotation(null)}
          onConverted={(billType, _billId, billNumber) => {
            showNotification(
              'success',
              `Successfully converted quotation to ${
                billType === 'normal' ? 'Normal Bill' : 'GST Tax Invoice'
              } #${billNumber}!`
            );
            loadQuotations();
          }}
        />
      )}

      {/* Settings Modal */}
      {isSettingsOpen && settings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-[var(--khata-border)] shadow-2xl overflow-hidden p-6 space-y-4 max-h-[90vh] overflow-y-auto"
            style={{ background: 'var(--khata-surface)', color: 'var(--khata-text)' }}
          >
            <div className="flex items-center justify-between pb-2 border-b border-[var(--khata-border)]">
              <h3 className="text-base font-bold flex items-center gap-2">
                <Settings className="w-4 h-4 text-[var(--khata-accent)]" />
                <span>Quotation Company Settings & Defaults</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="p-1 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveSettings} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Company Legal Name</label>
                  <input
                    type="text"
                    value={settings.company_name}
                    onChange={(e) => setSettings({ ...settings, company_name: e.target.value })}
                    className="neu-input w-full text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">CIN</label>
                  <input
                    type="text"
                    value={settings.cin || ''}
                    onChange={(e) => setSettings({ ...settings, cin: e.target.value })}
                    className="neu-input w-full text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Registered Address</label>
                <textarea
                  rows={2}
                  value={settings.address}
                  onChange={(e) => setSettings({ ...settings, address: e.target.value })}
                  className="neu-input w-full text-xs"
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">GSTIN</label>
                  <input
                    type="text"
                    value={settings.gstin || ''}
                    onChange={(e) => setSettings({ ...settings, gstin: e.target.value.toUpperCase() })}
                    className="neu-input w-full text-xs font-mono uppercase"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Phone</label>
                  <input
                    type="text"
                    value={settings.phone || ''}
                    onChange={(e) => setSettings({ ...settings, phone: e.target.value })}
                    className="neu-input w-full text-xs"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Email</label>
                  <input
                    type="email"
                    value={settings.email || ''}
                    onChange={(e) => setSettings({ ...settings, email: e.target.value })}
                    className="neu-input w-full text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Website</label>
                  <input
                    type="text"
                    value={settings.website || ''}
                    onChange={(e) => setSettings({ ...settings, website: e.target.value })}
                    className="neu-input w-full text-xs"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Seller State & Code</label>
                  <select
                    value={settings.state_code || ''}
                    onChange={(e) => {
                      const matched = getStateByCode(e.target.value);
                      setSettings({
                        ...settings,
                        state_code: e.target.value,
                        state: matched ? matched.name : settings.state,
                      });
                    }}
                    className="neu-input w-full text-xs"
                    required
                  >
                    <option value="">Select Seller State</option>
                    {INDIAN_STATES.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.code} – {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Standard Validity (Days)</label>
                  <input
                    type="number"
                    value={settings.standard_validity_days}
                    onChange={(e) => setSettings({ ...settings, standard_validity_days: Number(e.target.value) })}
                    className="neu-input w-full text-xs"
                    min={1}
                    max={365}
                  />
                </div>
              </div>

              {/* Bank details */}
              <div className="pt-2 border-t border-[var(--khata-border)] space-y-2">
                <span className="font-bold text-[var(--khata-text-muted)] uppercase text-[10px]">Bank Settlement Info</span>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Bank Name</label>
                    <input
                      type="text"
                      value={settings.bank_name || ''}
                      onChange={(e) => setSettings({ ...settings, bank_name: e.target.value })}
                      className="neu-input w-full text-xs"
                    />
                  </div>
                  <div>
                    <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Account Number</label>
                    <input
                      type="text"
                      value={settings.bank_account_number || ''}
                      onChange={(e) => setSettings({ ...settings, bank_account_number: e.target.value })}
                      className="neu-input w-full text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-bold text-[var(--khata-text-muted)] mb-1">IFSC Code</label>
                    <input
                      type="text"
                      value={settings.bank_ifsc || ''}
                      onChange={(e) => setSettings({ ...settings, bank_ifsc: e.target.value.toUpperCase() })}
                      className="neu-input w-full text-xs font-mono uppercase"
                    />
                  </div>
                </div>
              </div>

              {/* Standard terms */}
              <div className="pt-2 border-t border-[var(--khata-border)] space-y-2">
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Standard Payment Terms</label>
                  <input
                    type="text"
                    value={settings.standard_payment_terms || ''}
                    onChange={(e) => setSettings({ ...settings, standard_payment_terms: e.target.value })}
                    className="neu-input w-full text-xs"
                  />
                </div>
                <div>
                  <label className="block font-bold text-[var(--khata-text-muted)] mb-1">Standard Delivery Terms</label>
                  <input
                    type="text"
                    value={settings.standard_delivery_terms || ''}
                    onChange={(e) => setSettings({ ...settings, standard_delivery_terms: e.target.value })}
                    className="neu-input w-full text-xs"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 pt-3 border-t border-[var(--khata-border)]">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(false)}
                  className="neu-btn-secondary text-xs px-4 py-2 flex-1 sm:flex-initial text-center justify-center"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingSettings}
                  className="neu-btn-primary text-xs px-5 py-2 font-bold inline-flex items-center justify-center gap-2 flex-1 sm:flex-initial"
                >
                  {isSavingSettings ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  <span>Save Settings</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
