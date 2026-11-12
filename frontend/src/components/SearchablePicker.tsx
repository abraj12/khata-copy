import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { Search, X, ChevronDown, Check, Loader2, AlertCircle, Plus } from 'lucide-react';
import { useRemoteSearch, RemoteSearchResult } from '../hooks/useRemoteSearch.js';

export interface SearchablePickerProps<T> {
  mode: 'customer' | 'product';
  value: number | string | '';
  selectedOption: T | null;
  placeholder: string;
  searchPlaceholder: string;
  pageSize?: number;
  onSearch: (
    query: string,
    offset: number,
    limit: number,
    signal: AbortSignal,
    cursor?: string | null
  ) => Promise<RemoteSearchResult<T>>;
  onSelect: (item: T) => void;
  onClear?: () => void;
  getOptionKey: (item: T) => string | number;
  getOptionLabel: (item: T) => string;
  renderOption?: (item: T, isSelected: boolean) => React.ReactNode;
  emptyMessage?: string;
  onCreateNew?: (currentQuery: string) => void;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  ariaLabel?: string;
}

export function SearchablePicker<T>({
  mode,
  value,
  selectedOption,
  placeholder,
  searchPlaceholder,
  pageSize = 25,
  onSearch,
  onSelect,
  onClear,
  getOptionKey,
  getOptionLabel,
  renderOption,
  emptyMessage = 'No matching results found.',
  onCreateNew,
  disabled = false,
  required = false,
  id,
  ariaLabel,
}: SearchablePickerProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isMobile, setIsMobile] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);

  const componentId = useId();
  const listboxId = `picker-listbox-${id || componentId}`;

  // Responsive mobile detection (< 640px)
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 640);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const {
    query,
    setQuery,
    items,
    isLoading,
    isLoadingMore,
    isError,
    errorMessage,
    hasMore,
    loadMore,
    retry,
    reset,
  } = useRemoteSearch<T>({
    fetcher: onSearch,
    enabled: isOpen && !disabled,
    pageSize,
    debounceMs: 280,
    getItemKey: getOptionKey,
  });

  // Focus trap for mobile bottom sheet modal
  useEffect(() => {
    if (!isOpen || !isMobile) return;

    const modalEl = containerRef.current?.querySelector('[role="dialog"]') as HTMLElement | null;
    if (!modalEl) return;

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      const focusable = modalEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleTabKey);
    return () => document.removeEventListener('keydown', handleTabKey);
  }, [isOpen, isMobile]);

  // Lock body scroll on mobile bottom-sheet open
  useEffect(() => {
    if (isOpen && isMobile) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen, isMobile]);

  const handleOpen = () => {
    if (disabled) return;
    setIsOpen(true);
  };

  const handleClose = useCallback(() => {
    setIsOpen(false);
    reset();
    setTimeout(() => {
      triggerRef.current?.focus();
    }, 50);
  }, [reset]);

  // Invalidate any in-flight fetch and close if picker becomes disabled
  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
      reset();
    }
  }, [disabled, isOpen, reset]);

  // Handle outside clicks to close popover on desktop
  useEffect(() => {
    if (!isOpen || isMobile) return;

    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isOpen, isMobile, handleClose]);

  // Focus search input when opened
  useEffect(() => {
    if (isOpen) {
      setActiveIndex(-1);
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  const handleItemSelect = (item: T) => {
    onSelect(item);
    handleClose();
  };

  const handleClearClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onClear) {
      onClear();
    }
    triggerRef.current?.focus();
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length > 0) {
        setActiveIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0));
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length > 0) {
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1));
      }
      return;
    }

    if (e.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < items.length) {
        e.preventDefault();
        handleItemSelect(items[activeIndex]);
      } else if (items.length === 1) {
        e.preventDefault();
        handleItemSelect(items[0]);
      } else if (items.length === 0 && onCreateNew && query.trim()) {
        e.preventDefault();
        onCreateNew(query.trim());
        handleClose();
      }
    }
  };

  // Scroll active keyboard item into view
  useEffect(() => {
    if (activeIndex >= 0 && listboxRef.current) {
      const activeEl = listboxRef.current.children[activeIndex] as HTMLElement;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeIndex]);

  const displayLabel = selectedOption
    ? getOptionLabel(selectedOption)
    : '';

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Closed State Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        onClick={handleOpen}
        disabled={disabled}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={ariaLabel || placeholder}
        aria-required={required}
        className={`neu-input w-full text-left flex items-center justify-between text-sm font-medium transition cursor-pointer min-h-[44px] px-3.5 py-2.5 ${
          value && onClear && !disabled ? 'pr-16' : 'pr-9'
        } ${disabled ? 'opacity-60 cursor-not-allowed' : 'hover:border-[var(--khata-accent)]'}`}
        style={{
          background: 'var(--khata-surface)',
          color: value ? 'var(--khata-text)' : 'var(--khata-text-muted)',
        }}
      >
        <span className="truncate flex-1">
          {displayLabel || placeholder}
        </span>
      </button>

      {/* Sibling action controls: Non-nested Clear button and Chevron indicator */}
      <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
        {value && onClear && !disabled && (
          <button
            type="button"
            onClick={handleClearClick}
            title="Clear selection"
            aria-label="Clear selection"
            className="p-1 rounded-lg text-[var(--khata-text-muted)] hover:text-rose-500 hover:bg-rose-500/10 transition cursor-pointer min-h-[28px] min-w-[28px] flex items-center justify-center pointer-events-auto"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <span
          onClick={disabled ? undefined : handleOpen}
          aria-hidden="true"
          className={`p-1 flex items-center justify-center text-[var(--khata-text-muted)] transition-transform duration-200 ${
            disabled ? 'pointer-events-none' : 'cursor-pointer'
          } ${isOpen ? 'rotate-180 text-[var(--khata-accent)]' : ''}`}
        >
          <ChevronDown className="w-4 h-4" />
        </span>
      </div>

      {/* Picker Body — Desktop Popover or Mobile Bottom Sheet */}
      {isOpen && (
        <>
          {/* Mobile Overlay & Modal Container */}
          {isMobile ? (
            <div
              className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end justify-center p-0"
              role="dialog"
              aria-modal="true"
              aria-label={`Search ${mode === 'customer' ? 'Customers' : 'Products'}`}
            >
              <div
                className="w-full max-h-[85vh] rounded-t-2xl border-t border-[var(--khata-border)] flex flex-col shadow-2xl animate-in slide-in-from-bottom duration-200"
                style={{
                  background: 'var(--khata-surface)',
                  color: 'var(--khata-text)',
                  paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
                }}
              >
                {/* Mobile Header with Title and Accessible Close Button */}
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--khata-border)]">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="text-sm font-bold text-[var(--khata-text)] uppercase tracking-wider">
                      {mode === 'customer' ? 'Select Customer' : 'Select Product'}
                    </span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--khata-surface-inset)] text-[var(--khata-text-muted)] font-mono">
                      {items.length} {items.length === 1 ? 'item' : 'items'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="p-2 rounded-xl text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] hover:bg-[var(--khata-surface-inset)] min-h-[44px] min-w-[44px] flex items-center justify-center"
                    aria-label="Close search"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Mobile Search Box */}
                <div className="p-3 border-b border-[var(--khata-border)]">
                  <div className="relative">
                    <Search className="w-4 h-4 text-[var(--khata-accent)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={searchPlaceholder}
                      aria-label={searchPlaceholder || (mode === 'customer' ? 'Search customers' : 'Search products')}
                      aria-autocomplete="list"
                      aria-controls={listboxId}
                      aria-activedescendant={
                        activeIndex >= 0 && items[activeIndex]
                          ? `option-${componentId}-${getOptionKey(items[activeIndex])}`
                          : undefined
                      }
                      className="neu-input neu-input-with-leading-icon w-full text-sm font-medium pr-9"
                    />
                    {query && (
                      <button
                        type="button"
                        onClick={() => setQuery('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
                        aria-label="Clear query"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Mobile Results Container */}
                <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-[160px] max-h-[50vh]">
                  {renderResultsList()}
                </div>
              </div>
            </div>
          ) : (
            /* Desktop Popover Container */
            <div
              className="absolute left-0 right-0 z-50 mt-1.5 max-h-80 rounded-xl border border-[var(--khata-border)] shadow-xl flex flex-col animate-in fade-in zoom-in-95 duration-150"
              style={{
                background: 'var(--khata-surface)',
                color: 'var(--khata-text)',
              }}
            >
              {/* Desktop Search Header */}
              <div className="p-2.5 border-b border-[var(--khata-border)]">
                <div className="relative">
                  <Search className="w-4 h-4 text-[var(--khata-accent)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder || (mode === 'customer' ? 'Search customers' : 'Search products')}
                    aria-autocomplete="list"
                    aria-controls={listboxId}
                    aria-activedescendant={
                      activeIndex >= 0 && items[activeIndex]
                        ? `option-${componentId}-${getOptionKey(items[activeIndex])}`
                        : undefined
                    }
                    className="neu-input neu-input-with-leading-icon w-full text-sm font-medium pr-8"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
                      aria-label="Clear query"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Desktop Results Container */}
              <div className="overflow-y-auto p-1.5 space-y-1 max-h-60">
                {renderResultsList()}
              </div>
            </div>
          )}
        </>
      )}

      {/* Screen reader live region */}
      <div role="status" aria-live="polite" className="sr-only">
        {isLoading
          ? 'Loading results...'
          : `${items.length} ${mode === 'customer' ? 'customers' : 'products'} found.`}
      </div>
    </div>
  );

  function renderResultsList() {
    if (isLoading && items.length === 0) {
      return (
        <div className="py-8 flex flex-col items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)] font-medium">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--khata-accent)]" />
          <span>Searching catalogue...</span>
        </div>
      );
    }

    if (isError) {
      return (
        <div className="p-4 text-center space-y-2">
          <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-[var(--khata-danger)]">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{errorMessage || 'Failed to search.'}</span>
          </div>
          <button
            type="button"
            onClick={retry}
            className="neu-btn-secondary text-xs px-3 py-1 font-semibold"
          >
            Retry
          </button>
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="py-6 px-4 text-center space-y-3">
          <p className="text-xs text-[var(--khata-text-muted)] font-medium">
            {emptyMessage}
          </p>

          {mode === 'customer' && onCreateNew && (
            <button
              type="button"
              onClick={() => {
                onCreateNew(query.trim());
                handleClose();
              }}
              className="neu-btn-primary text-xs px-3.5 py-2 inline-flex items-center gap-1.5 font-bold"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>
                {query.trim()
                  ? `Create New Customer "${query.trim()}"`
                  : 'Create New Customer'}
              </span>
            </button>
          )}
        </div>
      );
    }

    return (
      <ul
        ref={listboxRef}
        id={listboxId}
        role="listbox"
        aria-label={`${mode === 'customer' ? 'Customers' : 'Products'} list`}
        className="space-y-1"
      >
        {items.map((item, index) => {
          const itemKey = getOptionKey(item);
          const isSelected = String(itemKey) === String(value);
          const isKeyboardActive = index === activeIndex;

          return (
            <li
              key={itemKey}
              role="option"
              aria-selected={isSelected}
              id={`option-${componentId}-${itemKey}`}
              onClick={() => handleItemSelect(item)}
              onMouseEnter={() => setActiveIndex(index)}
              className={`p-2.5 rounded-xl cursor-pointer text-sm transition flex flex-wrap items-center justify-between gap-2 min-h-[44px] ${
                isSelected
                  ? 'border border-[var(--khata-accent)] bg-[var(--khata-surface-inset)] font-bold'
                  : isKeyboardActive
                  ? 'bg-[var(--khata-surface-inset)] font-semibold'
                  : 'hover:bg-[var(--khata-surface-inset)]'
              }`}
            >
              <div className="flex-1 truncate">
                {renderOption ? (
                  renderOption(item, isSelected)
                ) : (
                  <span className="truncate block">{getOptionLabel(item)}</span>
                )}
              </div>

              {isSelected && (
                <Check className="w-4 h-4 text-[var(--khata-accent)] flex-shrink-0 ml-2" />
              )}
            </li>
          );
        })}

        {/* Bounded pagination "Load more" button */}
        {hasMore && (
          <li className="pt-2 pb-1 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={isLoading || isLoadingMore}
              className="neu-btn-secondary text-xs px-4 py-2 w-full font-semibold min-h-[38px] flex items-center justify-center gap-1.5"
            >
              {isLoadingMore ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
                  <span>Loading more...</span>
                </>
              ) : (
                <span>Load More</span>
              )}
            </button>
          </li>
        )}
      </ul>
    );
  }
}
