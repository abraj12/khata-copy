import React from 'react';
import { Loader2, X } from 'lucide-react';
import {
  CustomerCatalogOption,
  ProductCatalogOption,
} from './useBillingCatalogueSearch.js';

interface CustomerPickerDropdownProps {
  customers: CustomerCatalogOption[];
  search: string;
  onSearchChange: (value: string) => void;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onSelectCustomer: (customer: CustomerCatalogOption) => void;
}

export const CustomerPickerDropdown: React.FC<CustomerPickerDropdownProps> = ({
  customers,
  search,
  onSearchChange,
  isLoading,
  isLoadingMore,
  error,
  hasMore,
  onLoadMore,
  onSelectCustomer,
}) => {
  return (
    <div
      className="absolute left-0 right-0 sm:left-auto sm:right-0 top-full mt-2 w-full sm:w-72 sm:max-w-[85vw] p-2 rounded-xl border border-[var(--khata-border)] shadow-xl z-30 space-y-2 animate-in fade-in"
      style={{ background: 'var(--khata-surface)' }}
    >
      <div className="p-1 text-[10px] font-bold text-[var(--khata-text-muted)] border-b border-[var(--khata-border)] flex flex-wrap items-center justify-between gap-1">
        <span>
          KHATA CUSTOMERS ({customers.length}
          {hasMore ? '+' : ''})
        </span>
        {isLoading ? (
          <span className="inline-flex items-center gap-1 text-[var(--khata-accent)]">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Searching...</span>
          </span>
        ) : (
          <span>Click to autofill</span>
        )}
      </div>
      <input
        type="text"
        placeholder="Search customer by name or phone..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="neu-input w-full text-xs p-1.5"
        autoFocus
      />
      {error && (
        <div className="px-2 py-1 text-[11px] font-semibold text-rose-600 bg-rose-500/10 rounded">
          {error}
        </div>
      )}
      <div className="max-h-48 overflow-y-auto space-y-1">
        {customers.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelectCustomer(c)}
            className="w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--khata-surface-inset)] flex flex-wrap items-center justify-between gap-2 transition cursor-pointer"
          >
            <div className="min-w-0">
              <span className="font-bold text-[var(--khata-text)] block truncate">{c.name}</span>
              {c.address && (
                <span className="text-[10px] text-[var(--khata-text-muted)] block truncate max-w-full">
                  {c.address}
                </span>
              )}
            </div>
            {c.phone && (
              <span className="text-[10px] text-[var(--khata-text-muted)] font-mono ml-2 shrink-0">
                {c.phone}
              </span>
            )}
          </button>
        ))}
        {!isLoading && customers.length === 0 && (
          <div className="p-2 text-center text-xs text-[var(--khata-text-muted)]">
            No Khata customers found.
          </div>
        )}
        {isLoading && customers.length === 0 && (
          <div className="p-2 text-center text-xs text-[var(--khata-text-muted)] flex items-center justify-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
            <span>Searching customers...</span>
          </div>
        )}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={isLoadingMore || isLoading}
          className="w-full py-1.5 text-[11px] font-bold text-[var(--khata-accent)] hover:bg-[var(--khata-surface-inset)] rounded-lg border border-[var(--khata-border)] transition disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"
        >
          {isLoadingMore ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Loading more...</span>
            </>
          ) : (
            <span>Load More Customers</span>
          )}
        </button>
      )}
    </div>
  );
};

interface ProductPickerPopoverProps {
  products: ProductCatalogOption[];
  search: string;
  onSearchChange: (value: string) => void;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onSelectProduct: (product: ProductCatalogOption) => void;
  onClose: () => void;
}

export const ProductPickerPopover: React.FC<ProductPickerPopoverProps> = ({
  products,
  search,
  onSearchChange,
  isLoading,
  isLoadingMore,
  error,
  hasMore,
  onLoadMore,
  onSelectProduct,
  onClose,
}) => {
  return (
    <div
      className="absolute left-0 right-0 top-full mt-1.5 p-2 rounded-xl border border-[var(--khata-border)] shadow-2xl z-30 space-y-2 animate-in fade-in"
      style={{ background: 'var(--khata-surface)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] font-bold text-[var(--khata-text-muted)] pb-1 border-b border-[var(--khata-border)]">
        <span className="flex items-center gap-1.5">
          <span>
            SELECT PRODUCT FROM CATALOGUE ({products.length}
            {hasMore ? '+' : ''})
          </span>
          {isLoading && <Loader2 className="w-3 h-3 animate-spin text-[var(--khata-accent)]" />}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close product picker"
          className="text-neutral-400 hover:text-neutral-600 p-0.5 cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <input
        type="text"
        placeholder="Search products by name, HSN, or barcode..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="neu-input w-full text-xs p-1.5"
        autoFocus
      />
      {error && (
        <div className="px-2 py-1 text-[11px] font-semibold text-rose-600 bg-rose-500/10 rounded">
          {error}
        </div>
      )}
      <div className="max-h-48 overflow-y-auto space-y-1">
        {products.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelectProduct(p)}
            className="w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-[var(--khata-surface-inset)] flex flex-wrap items-center justify-between gap-2 transition cursor-pointer"
          >
            <div className="min-w-0">
              <span className="font-bold text-[var(--khata-text)] block truncate">{p.name}</span>
              {p.hsn_code && (
                <span className="text-[10px] text-[var(--khata-text-muted)] font-mono">
                  HSN: {p.hsn_code}
                </span>
              )}
            </div>
            <span className="text-xs font-bold text-[var(--khata-text-muted)] font-mono ml-2 shrink-0">
              Ref: ₹{p.buying_price}
            </span>
          </button>
        ))}
        {!isLoading && products.length === 0 && (
          <div className="p-2 text-center text-xs text-[var(--khata-text-muted)]">
            No products found.
          </div>
        )}
        {isLoading && products.length === 0 && (
          <div className="p-2 text-center text-xs text-[var(--khata-text-muted)] flex items-center justify-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
            <span>Loading catalogue...</span>
          </div>
        )}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={isLoadingMore || isLoading}
          className="w-full py-1.5 text-[11px] font-bold text-[var(--khata-accent)] hover:bg-[var(--khata-surface-inset)] rounded-lg border border-[var(--khata-border)] transition disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"
        >
          {isLoadingMore ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Loading more...</span>
            </>
          ) : (
            <span>Load More Products</span>
          )}
        </button>
      )}
    </div>
  );
};
