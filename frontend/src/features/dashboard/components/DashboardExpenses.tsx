import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Ban,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Loader2,
  Plus,
  Receipt,
  Search,
  X,
} from 'lucide-react';
import { formatCurrency } from '../../../lib/formatters.js';
import type {
  BusinessExpenseRecord,
  DashboardExpenseCategoryTotal,
  ExpenseCategory,
  PaginatedExpensesResult,
  SaveExpensePayload,
} from '../dashboard.types.js';
import {
  EXPENSE_CATEGORY_OPTIONS,
  createDashboardExpense,
  fetchDashboardExpenses,
  formatExpenseCategoryLabel,
  formatExpenseMethodLabel,
  updateDashboardExpense,
  voidDashboardExpense,
} from '../dashboardApi.js';
import { DashboardExpenseForm } from './DashboardExpenseForm.js';
import { DashboardSection } from './DashboardSection.js';

export interface DashboardExpensesProps {
  fromDate?: string;
  toDate?: string;
  categoryTotals: DashboardExpenseCategoryTotal[];
  externalCreateTrigger?: number;
  onExpensesMutated: () => Promise<void> | void;
}

export const DashboardExpenses: React.FC<DashboardExpensesProps> = ({
  fromDate,
  toDate,
  categoryTotals,
  externalCreateTrigger = 0,
  onExpensesMutated,
}) => {
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'active' | 'voided' | 'all'>('active');
  const [offset, setOffset] = useState(0);
  const limit = 10;

  const [listData, setListData] = useState<PaginatedExpensesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<BusinessExpenseRecord | null>(null);

  const [voidTarget, setVoidTarget] = useState<BusinessExpenseRecord | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);

  const reqIdRef = useRef(0);

  // Debounce search text
  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0);
      setDebouncedSearch(searchInput.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Reset offset when date or dropdown filters change
  useEffect(() => {
    setOffset(0);
  }, [fromDate, toDate, categoryFilter, statusFilter]);

  // Open Add Expense modal when triggered from Home hero quick actions
  useEffect(() => {
    if (externalCreateTrigger > 0) {
      setEditingExpense(null);
      setIsFormOpen(true);
    }
  }, [externalCreateTrigger]);

  const loadExpenses = async (signal?: AbortSignal) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDashboardExpenses(
        {
          search: debouncedSearch,
          category: categoryFilter,
          status: statusFilter,
          fromDate,
          toDate,
          limit,
          offset,
        },
        signal
      );
      if (reqId !== reqIdRef.current) return;
      setListData(result);
    } catch (err) {
      if ((err as { code?: string })?.code === 'REQUEST_ABORTED') return;
      if (reqId !== reqIdRef.current) return;
      setError((err as Error).message || 'Unable to load operating expenses.');
    } finally {
      if (reqId === reqIdRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadExpenses(controller.signal);
    return () => controller.abort();
  }, [debouncedSearch, categoryFilter, statusFilter, fromDate, toDate, offset]);

  const handleSaveExpense = async (payload: SaveExpensePayload, editingId?: string) => {
    if (editingId) {
      await updateDashboardExpense(editingId, payload);
    } else {
      await createDashboardExpense(payload);
    }
    await loadExpenses();
    await onExpensesMutated();
  };

  const handleConfirmVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voidTarget) return;
    const trimmed = voidReason.trim();
    if (!trimmed) {
      setVoidError('Please enter a reason before voiding this expense.');
      return;
    }

    setVoidError(null);
    setVoiding(true);
    try {
      await voidDashboardExpense(voidTarget.id, trimmed);
      setVoidTarget(null);
      setVoidReason('');
      await loadExpenses();
      await onExpensesMutated();
    } catch (err) {
      setVoidError((err as Error).message || 'Failed to void expense.');
    } finally {
      setVoiding(false);
    }
  };

  const items = listData?.items ?? [];
  const total = listData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <>
      <DashboardSection
        title="Operating Expenses"
        subtitle="Track shop rent, electricity, salaries, transport & misc expenses with full void audit history."
        icon={<Receipt className="w-4 h-4" />}
        rightSlot={
          <button
            type="button"
            onClick={() => {
              setEditingExpense(null);
              setIsFormOpen(true);
            }}
            className="neu-btn-primary text-xs px-3.5 py-2 min-h-[38px] inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Add Expense</span>
          </button>
        }
      >
        {categoryTotals.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {categoryTotals.map((cat) => (
              <div
                key={cat.category}
                className="px-3 py-1.5 rounded-xl bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] text-xs flex items-center gap-2"
              >
                <span className="font-semibold text-[var(--khata-text-muted)]">
                  {formatExpenseCategoryLabel(cat.category)} ({cat.count})
                </span>
                <span className="font-mono font-black text-[var(--khata-text)]">
                  {formatCurrency(cat.totalAmount)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
          <div className="relative sm:col-span-2">
            <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="Search operating expenses"
              placeholder="Search title, vendor, or reference..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="neu-input neu-input-with-leading-icon w-full text-xs"
            />
          </div>

          <select
            aria-label="Filter expenses by category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as ExpenseCategory | 'all')}
            className="neu-input text-xs"
          >
            <option value="all">All Categories</option>
            {EXPENSE_CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter expenses by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'active' | 'voided' | 'all')}
            className="neu-input text-xs"
          >
            <option value="active">Active Only</option>
            <option value="voided">Voided Only</option>
            <option value="all">All Statuses</option>
          </select>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-xs text-rose-600 dark:text-rose-400 flex items-center justify-between gap-2"
          >
            <div className="flex items-center gap-2 font-semibold">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => void loadExpenses()}
              className="underline font-bold"
            >
              Retry
            </button>
          </div>
        )}

        {loading && !listData ? (
          <div className="py-8 flex items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading expenses...</span>
          </div>
        ) : items.length === 0 ? (
          <div className="p-6 rounded-xl bg-[var(--khata-surface-inset)] border border-dashed border-[var(--khata-border)] text-center text-xs text-[var(--khata-text-muted)]">
            No operating expenses recorded for the current filter.
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--khata-text-muted)]">
              <span>
                Filtered Active Total:{' '}
                <strong className="font-mono text-[var(--khata-text)]">
                  {formatCurrency(listData?.totalActiveAmount || '0.00')}
                </strong>
              </span>
              <span className="font-mono">{total} matching record(s)</span>
            </div>

            <div className="divide-y divide-[var(--khata-border)]/70 rounded-xl border border-[var(--khata-border)] overflow-hidden bg-[var(--khata-surface-inset)]/50">
              {items.map((exp) => {
                const isVoided = exp.status === 'voided';
                return (
                  <div
                    key={exp.id}
                    className="p-3 sm:px-4 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-extrabold text-[var(--khata-text)]">
                          {exp.title}
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--khata-surface)] border border-[var(--khata-border)] text-[var(--khata-text-muted)]">
                          {formatExpenseCategoryLabel(exp.category)}
                        </span>
                        {isVoided && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/30">
                            Voided
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-[var(--khata-text-muted)]">
                        <span className="font-mono">{exp.expenseDate}</span> •{' '}
                        {formatExpenseMethodLabel(exp.paymentMethod)}
                        {exp.vendorName ? ` • ${exp.vendorName}` : ''}
                        {exp.referenceNumber ? ` • Ref: ${exp.referenceNumber}` : ''}
                      </p>
                      {isVoided && exp.voidReason && (
                        <p className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">
                          Void reason: {exp.voidReason}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`font-mono text-sm font-black ${
                          isVoided ? 'line-through text-[var(--khata-text-muted)]' : 'text-[var(--khata-text)]'
                        }`}
                      >
                        {formatCurrency(exp.amount)}
                      </span>

                      {!isVoided && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingExpense(exp);
                              setIsFormOpen(true);
                            }}
                            aria-label={`Edit expense ${exp.title}`}
                            className="neu-btn-secondary text-[11px] px-2.5 py-1.5 min-h-[32px] font-bold inline-flex items-center gap-1"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setVoidTarget(exp);
                              setVoidReason('');
                              setVoidError(null);
                            }}
                            aria-label={`Void expense ${exp.title}`}
                            className="neu-btn-secondary text-rose-600 dark:text-rose-400 text-[11px] px-2.5 py-1.5 min-h-[32px] font-bold inline-flex items-center gap-1"
                          >
                            <Ban className="w-3.5 h-3.5" />
                            <span>Void</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {total > limit && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-xs">
                <span className="text-[var(--khata-text-muted)]">
                  Page <span className="font-mono font-bold text-[var(--khata-text)]">{currentPage}</span> /{' '}
                  <span className="font-mono font-bold text-[var(--khata-text)]">{totalPages}</span>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={offset === 0 || loading}
                    onClick={() => setOffset(Math.max(0, offset - limit))}
                    className="neu-btn-secondary text-xs px-3 py-1.5 min-h-[34px] inline-flex items-center gap-1 disabled:opacity-40"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Previous</span>
                  </button>
                  <button
                    type="button"
                    disabled={!listData?.hasMore || loading}
                    onClick={() => setOffset(offset + limit)}
                    className="neu-btn-secondary text-xs px-3 py-1.5 min-h-[34px] inline-flex items-center gap-1 disabled:opacity-40"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </DashboardSection>

      <DashboardExpenseForm
        isOpen={isFormOpen}
        editingExpense={editingExpense}
        onClose={() => {
          setIsFormOpen(false);
          setEditingExpense(null);
        }}
        onSubmit={handleSaveExpense}
      />

      {voidTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-labelledby="void-expense-title"
          onClick={() => !voiding && setVoidTarget(null)}
        >
          <div
            className="neu-card w-full max-w-md p-5 sm:p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 id="void-expense-title" className="text-base font-extrabold text-[var(--khata-text)]">
                Void Operating Expense
              </h3>
              <button
                type="button"
                disabled={voiding}
                onClick={() => setVoidTarget(null)}
                aria-label="Close void modal"
                className="neu-btn-secondary p-1.5 min-h-[32px]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[var(--khata-text-muted)]">
              Voiding <strong className="text-[var(--khata-text)]">{voidTarget.title}</strong> ({formatCurrency(voidTarget.amount)}) keeps the audit trail intact while excluding it from active operating expenses.
            </p>

            {voidError && (
              <div
                role="alert"
                className="p-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 text-xs text-rose-600 dark:text-rose-400 font-semibold"
              >
                {voidError}
              </div>
            )}

            <form onSubmit={handleConfirmVoid} className="space-y-3">
              <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
                <span>Reason for Voiding *</span>
                <textarea
                  rows={2}
                  required
                  maxLength={500}
                  placeholder="e.g. Duplicate entry or bill cancelled"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  className="neu-input text-xs"
                />
              </label>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={voiding}
                  onClick={() => setVoidTarget(null)}
                  className="neu-btn-secondary text-xs px-4 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={voiding}
                  className="neu-btn-primary text-xs px-4 py-2 bg-rose-600 hover:bg-rose-700"
                >
                  {voiding ? 'Voiding...' : 'Confirm Void'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
