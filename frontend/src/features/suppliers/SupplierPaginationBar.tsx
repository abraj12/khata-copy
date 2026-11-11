import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface SupplierPaginationBarProps {
  offset: number;
  limit: number;
  total: number;
  currentCount: number;
  hasMore: boolean;
  loading?: boolean;
  itemLabel?: string;
  onPageChange: (nextOffset: number) => void;
}

export const SupplierPaginationBar: React.FC<SupplierPaginationBarProps> = ({
  offset,
  limit,
  total,
  currentCount,
  hasMore,
  loading = false,
  itemLabel = 'records',
  onPageChange,
}) => {
  if (total === 0) return null;

  const start = offset + 1;
  const end = Math.min(offset + currentCount, total);
  const currentPage = Math.floor(offset / Math.max(1, limit)) + 1;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  const canGoPrev = offset > 0 && !loading;
  const canGoNext = (hasMore || end < total) && !loading;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 pt-3 border-t border-[var(--khata-border)]/70 text-xs">
      <div className="text-[var(--khata-text-muted)] font-medium">
        Showing <span className="font-mono font-bold text-[var(--khata-text)]">{start}</span>–
        <span className="font-mono font-bold text-[var(--khata-text)]">{end}</span> of{' '}
        <span className="font-mono font-bold text-[var(--khata-text)]">{total}</span> {itemLabel}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canGoPrev}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
          className="neu-btn-secondary text-xs px-3 py-1.5 min-h-0 font-bold inline-flex items-center gap-1 disabled:opacity-40"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          <span>Previous</span>
        </button>

        <span className="text-[11px] font-mono font-bold text-[var(--khata-text-muted)] px-1">
          Page {currentPage} / {totalPages}
        </span>

        <button
          type="button"
          disabled={!canGoNext}
          onClick={() => onPageChange(offset + limit)}
          className="neu-btn-secondary text-xs px-3 py-1.5 min-h-0 font-bold inline-flex items-center gap-1 disabled:opacity-40"
        >
          <span>Next</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
