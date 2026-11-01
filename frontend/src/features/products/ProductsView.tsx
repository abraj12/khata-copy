import React, { useEffect, useState, useRef } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import { Tag, Plus, Search, Edit2, Archive, AlertTriangle, CheckCircle, X, Loader2 } from 'lucide-react';
import { formatCurrency, safeDecimal, parseStrictDecimal } from '../../lib/formatters.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';

interface Product {
  id: number;
  name: string;
  buying_price: string;
  created_at: string;
  updated_at?: string;
  archived_at?: string | null;
}

export const ProductsView: React.FC = () => {
  const [products, setProducts] = useState<Product[]>([]);
  const [pagination, setPagination] = useState<{
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
  }>({
    limit: 25,
    offset: 0,
    hasMore: false,
    nextOffset: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 280);

  // Create state
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit state
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Archive state
  const [archivingProduct, setArchivingProduct] = useState<Product | null>(null);
  const [isSubmittingArchive, setIsSubmittingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // Global notification banner
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  const fetchProductsRequestIdRef = useRef(0);
  const fetchProductsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (fetchProductsAbortRef.current) {
        fetchProductsAbortRef.current.abort();
      }
    };
  }, []);

  const fetchProducts = async (searchQuery: string = '', offset: number = 0, append: boolean = false) => {
    if (fetchProductsAbortRef.current) {
      fetchProductsAbortRef.current.abort();
    }
    const controller = new AbortController();
    fetchProductsAbortRef.current = controller;
    const currentReqId = ++fetchProductsRequestIdRef.current;

    try {
      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
        if (searchQuery !== '') {
          setProducts([]);
        }
      }
      const res = await apiClient<{
        success: boolean;
        products?: Product[];
        data?: Product[];
        pagination?: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
      }>(
        `/api/v1/products?search=${encodeURIComponent(searchQuery)}&limit=25&offset=${offset}`,
        { signal: controller.signal }
      );

      if (currentReqId !== fetchProductsRequestIdRef.current) return;

      const items = res.data.products || res.data.data || [];
      const pag = res.data.pagination || { limit: 25, offset, hasMore: false, nextOffset: null };
      if (append) {
        setProducts((prev) => [...prev, ...items]);
      } else {
        setProducts(items);
      }
      setPagination(pag);
    } catch (err) {
      if (currentReqId !== fetchProductsRequestIdRef.current) return;
      if ((err as Error).name === 'AbortError') return;
      showNotification('error', (err as Error).message || 'Failed to load products.');
    } finally {
      if (currentReqId === fetchProductsRequestIdRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    fetchProducts(debouncedSearch, 0, false);
  }, [debouncedSearch]);

  const handleLoadMore = () => {
    if (pagination.hasMore && pagination.nextOffset !== null && !isLoadingMore) {
      fetchProducts(debouncedSearch, pagination.nextOffset, true);
    }
  };

  const validatePrice = (priceStr: string): boolean => {
    try {
      const d = parseStrictDecimal(priceStr, { maxDecimalPlaces: 2, fieldName: 'Buying price' });
      return d.greaterThanOrEqualTo(0);
    } catch {
      return false;
    }
  };

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPrice.trim()) {
      setCreateError('Product name and buying price are required.');
      return;
    }

    if (!validatePrice(newPrice)) {
      setCreateError('Buying price must be a valid non-negative number with at most 2 decimal places (e.g. 150.00).');
      return;
    }

    setCreateError(null);
    setIsSubmittingCreate(true);

    try {
      await apiClient('/api/v1/products', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          buying_price: safeDecimal(newPrice).toNumber(),
        }),
      });
      setNewName('');
      setNewPrice('');
      setIsAdding(false);
      showNotification('success', 'Product added successfully.');
      await fetchProducts(debouncedSearch, 0, false);
    } catch (err) {
      setCreateError((err as Error).message || 'Failed to add product.');
    } finally {
      setIsSubmittingCreate(false);
    }
  };

  const handleStartEdit = (product: Product) => {
    setEditingProduct(product);
    setEditName(product.name);
    setEditPrice(safeDecimal(product.buying_price).toFixed(2));
    setEditError(null);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProduct) return;

    if (!editName.trim() || !editPrice.trim()) {
      setEditError('Product name and buying price are required.');
      return;
    }

    if (!validatePrice(editPrice)) {
      setEditError('Buying price must be a valid non-negative number with at most 2 decimal places.');
      return;
    }

    setEditError(null);
    setIsSubmittingEdit(true);

    try {
      await apiClient(`/api/v1/products/${editingProduct.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          buying_price: safeDecimal(editPrice).toNumber(),
        }),
      });
      setEditingProduct(null);
      showNotification('success', 'Product updated successfully.');
      await fetchProducts(debouncedSearch, 0, false);
    } catch (err) {
      setEditError((err as Error).message || 'Failed to update product.');
    } finally {
      setIsSubmittingEdit(false);
    }
  };

  const handleConfirmArchive = async () => {
    if (!archivingProduct) return;
    setIsSubmittingArchive(true);
    setArchiveError(null);

    try {
      await apiClient(`/api/v1/products/${archivingProduct.id}`, {
        method: 'DELETE',
      });
      setArchivingProduct(null);
      showNotification('success', `Product "${archivingProduct.name}" archived.`);
      await fetchProducts(debouncedSearch, 0, false);
    } catch (err) {
      setArchiveError((err as Error).message || 'Failed to archive product.');
    } finally {
      setIsSubmittingArchive(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Notification banner */}
      {notification && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-center justify-between p-4 rounded-xl text-xs sm:text-sm font-semibold border ${
            notification.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-[var(--khata-success)]'
              : 'bg-red-500/10 border-red-500/30 text-[var(--khata-danger)]'
          }`}
        >
          <div className="flex items-center gap-2">
            {notification.type === 'success' ? (
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            )}
            <span>{notification.message}</span>
          </div>
          <button
            onClick={() => setNotification(null)}
            className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] transition"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Header card with Neumorphic styling */}
      <div className="neu-card p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-[var(--khata-text)] flex items-center gap-2">
            <Tag className="w-5 h-5 text-[var(--khata-accent)]" />
            <span>Products (Reference Catalog)</span>
          </h2>
          <p className="text-xs text-[var(--khata-text-muted)] mt-1 max-w-xl">
            Reference catalogue storing item names and confidential owner buying prices. Udhar transactions capture permanent snapshots and custom selling prices.
          </p>
        </div>

        <button
          onClick={() => {
            setIsAdding(!isAdding);
            setCreateError(null);
          }}
          className="neu-btn-primary text-xs sm:text-sm font-bold px-4 py-2.5 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>{isAdding ? 'Close Form' : 'Add Product'}</span>
        </button>
      </div>

      {/* Add Product Form (Collapsible) */}
      {isAdding && (
        <form
          onSubmit={handleAddProduct}
          className="neu-card p-6 space-y-4 border-2 border-[var(--khata-accent)]/30"
          style={{ background: 'var(--khata-surface)' }}
        >
          <div className="flex items-center justify-between pb-2 border-b border-[var(--khata-border)]">
            <h3 className="text-sm font-bold text-[var(--khata-text)]">
              Add New Reference Product
            </h3>
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="p-1 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]"
              aria-label="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {createError && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 text-[var(--khata-danger)] text-xs rounded-xl font-medium">
              {createError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
                Product Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Fevicol SH 1kg"
                className="neu-input w-full text-sm font-medium"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
                Buying Price (₹) <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                inputMode="decimal"
                required
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                placeholder="e.g. 450.00"
                className="neu-input w-full text-sm font-medium tabular-numbers"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="neu-btn-secondary text-xs px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmittingCreate}
              className="neu-btn-primary text-xs px-5 py-2"
            >
              {isSubmittingCreate ? 'Saving Product...' : 'Save Product'}
            </button>
          </div>
        </form>
      )}

      {/* Inset Search Input */}
      <div className="relative flex items-center">
        <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-3.5 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products by name..."
          className="neu-input neu-input-with-leading-icon w-full text-sm font-medium"
        />
      </div>

      {/* Products Table Card */}
      <div className="neu-card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-[var(--khata-text-muted)] font-medium flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
            <span>Loading reference products...</span>
          </div>
        ) : products.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--khata-text-muted)]">
            {search ? 'No products match your search.' : 'No active products yet. Click "Add Product" above to create one.'}
          </div>
        ) : (
          <div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--khata-border)] bg-[var(--khata-surface-inset)] text-xs font-bold text-[var(--khata-text-muted)] uppercase tracking-wider">
                    <th className="py-3.5 px-4 sm:px-6">Product Name</th>
                    <th className="py-3.5 px-4 sm:px-6 text-right">Owner Buying Price</th>
                    <th className="py-3.5 px-4 sm:px-6 text-center w-28">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--khata-border)] text-sm">
                  {products.map((item) => (
                    <tr
                      key={item.id}
                      className="hover:bg-[var(--khata-surface-inset)]/60 transition-colors"
                    >
                      <td className="py-3.5 px-4 sm:px-6 font-semibold text-[var(--khata-text)]">
                        {item.name}
                      </td>
                      <td className="py-3.5 px-4 sm:px-6 text-right font-semibold text-[var(--khata-accent)] tabular-numbers">
                        {formatCurrency(item.buying_price)}
                      </td>
                      <td className="py-3.5 px-4 sm:px-6 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleStartEdit(item)}
                            className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-accent)] hover:bg-[var(--khata-surface-inset)] transition"
                            title="Edit product"
                            aria-label={`Edit ${item.name}`}
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              setArchivingProduct(item);
                              setArchiveError(null);
                            }}
                            className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-danger)] hover:bg-[var(--khata-surface-inset)] transition"
                            title="Archive product"
                            aria-label={`Archive ${item.name}`}
                          >
                            <Archive className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Bounded pagination "Load more" button */}
            {pagination.hasMore && (
              <div className="p-3 text-center border-t border-[var(--khata-border)] bg-[var(--khata-surface)]">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                  className="neu-btn-secondary text-xs px-5 py-2 font-bold inline-flex items-center gap-1.5 min-h-[38px]"
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
                      <span>Loading more products...</span>
                    </>
                  ) : (
                    <span>Load More Products</span>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit Product Modal */}
      {editingProduct && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-product-title"
        >
          <div
            className="neu-card max-w-md w-full p-6 space-y-4"
            style={{ background: 'var(--khata-surface)' }}
          >
            <div className="flex items-center justify-between pb-2 border-b border-[var(--khata-border)]">
              <h3 id="edit-product-title" className="text-base font-bold text-[var(--khata-text)]">
                Edit Reference Product
              </h3>
              <button
                type="button"
                onClick={() => setEditingProduct(null)}
                className="p-2 rounded-xl text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] min-h-[44px] min-w-[44px] flex items-center justify-center -mr-1 -mt-1"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {editError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 text-[var(--khata-danger)] text-xs rounded-xl font-medium">
                {editError}
              </div>
            )}

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
                  Product Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="neu-input w-full text-sm font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
                  Buying Price (₹) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  required
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                  className="neu-input w-full text-sm font-medium tabular-numbers"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingProduct(null)}
                  className="neu-btn-secondary text-xs px-4 py-2.5 min-h-[44px]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingEdit}
                  className="neu-btn-primary text-xs px-5 py-2.5 min-h-[44px] font-bold"
                >
                  {isSubmittingEdit ? 'Updating...' : 'Update Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Archive Confirmation Modal */}
      {archivingProduct && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="archive-product-title"
        >
          <div
            className="neu-card max-w-md w-full p-6 space-y-4"
            style={{ background: 'var(--khata-surface)' }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-[var(--khata-danger)]">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 id="archive-product-title" className="text-base font-bold text-[var(--khata-text)]">
                  Archive Product?
                </h3>
                <p className="text-xs text-[var(--khata-text-muted)]">
                  Archive <strong>{archivingProduct.name}</strong> from active catalogue?
                </p>
              </div>
            </div>

            <p className="text-xs text-[var(--khata-text-muted)] neu-input p-3 rounded-xl leading-relaxed">
              Archiving hides the product from future Udhar entries. All past transactions and ledger records preserve their exact historical snapshots and prices unchanged.
            </p>

            {archiveError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 text-[var(--khata-danger)] text-xs rounded-xl font-medium">
                {archiveError}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setArchivingProduct(null)}
                className="neu-btn-secondary text-xs px-4 py-2.5 min-h-[44px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmArchive}
                disabled={isSubmittingArchive}
                className="neu-btn-danger text-xs px-5 py-2.5 min-h-[44px] font-bold"
              >
                {isSubmittingArchive ? 'Archiving...' : 'Confirm Archive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
