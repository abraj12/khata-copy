import React, { useEffect, useState, useRef } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import {
  Tag,
  Plus,
  Search,
  Edit2,
  Archive,
  AlertTriangle,
  CheckCircle,
  X,
  Loader2,
  Camera,
  Upload,
  Trash2,
  Eye,
} from 'lucide-react';
import { formatCurrency, safeDecimal, parseStrictDecimal } from '../../lib/formatters.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import {
  uploadAndAttachProductImage,
  removeProductImage,
} from './productsApi.js';

interface Product {
  id: number;
  name: string;
  buying_price: string;
  image_url?: string | null;
  image_object_key?: string | null;
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
  const [createImageFile, setCreateImageFile] = useState<File | null>(null);
  const [createImagePreview, setCreateImagePreview] = useState<string | null>(null);
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const createCameraRef = useRef<HTMLInputElement>(null);
  const createFileRef = useRef<HTMLInputElement>(null);

  // Edit state
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editImageFile, setEditImageFile] = useState<File | null>(null);
  const [editImagePreview, setEditImagePreview] = useState<string | null>(null);
  const [isRemovingImage, setIsRemovingImage] = useState(false);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const editCameraRef = useRef<HTMLInputElement>(null);
  const editFileRef = useRef<HTMLInputElement>(null);

  // Archive state
  const [archivingProduct, setArchivingProduct] = useState<Product | null>(null);
  const [isSubmittingArchive, setIsSubmittingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // Lightbox View State
  const [lightboxProduct, setLightboxProduct] = useState<{ url: string; name: string; price: string } | null>(null);

  // Global notification banner
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // Revoke object URLs on unmount
  useEffect(() => {
    return () => {
      if (createImagePreview && createImagePreview.startsWith('blob:')) {
        URL.revokeObjectURL(createImagePreview);
      }
      if (editImagePreview && editImagePreview.startsWith('blob:')) {
        URL.revokeObjectURL(editImagePreview);
      }
    };
  }, [createImagePreview, editImagePreview]);

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

  const handleImageFileValidation = (file: File): string | null => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      return 'Only JPEG, PNG, and WebP images are allowed.';
    }
    if (file.size > 5 * 1024 * 1024) {
      return 'Image size must be at most 5 MB.';
    }
    return null;
  };

  const handleCreateImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const error = handleImageFileValidation(file);
    if (error) {
      setCreateError(error);
      return;
    }

    setCreateError(null);
    setCreateImageFile(file);
    if (createImagePreview && createImagePreview.startsWith('blob:')) {
      URL.revokeObjectURL(createImagePreview);
    }
    setCreateImagePreview(URL.createObjectURL(file));
  };

  const handleClearCreateImage = () => {
    if (createImagePreview && createImagePreview.startsWith('blob:')) {
      URL.revokeObjectURL(createImagePreview);
    }
    setCreateImageFile(null);
    setCreateImagePreview(null);
    if (createCameraRef.current) createCameraRef.current.value = '';
    if (createFileRef.current) createFileRef.current.value = '';
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
      const createRes = await apiClient<{ success: boolean; data: Product }>(
        '/api/v1/products',
        {
          method: 'POST',
          body: JSON.stringify({
            name: newName.trim(),
            buying_price: safeDecimal(newPrice).toNumber(),
          }),
        }
      );

      const createdProduct = createRes.data.data;

      // If user selected an image, upload and attach it
      if (createImageFile && createdProduct?.id) {
        try {
          await uploadAndAttachProductImage(createdProduct.id, createImageFile);
        } catch (imgErr) {
          console.error('Product created but image upload failed:', imgErr);
          showNotification('error', `Product created, but image upload failed: ${(imgErr as Error).message}`);
        }
      }

      setNewName('');
      setNewPrice('');
      handleClearCreateImage();
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
    setEditImageFile(null);
    setEditImagePreview(null);
    setEditError(null);
  };

  const handleEditImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const error = handleImageFileValidation(file);
    if (error) {
      setEditError(error);
      return;
    }

    setEditError(null);
    setEditImageFile(file);
    if (editImagePreview && editImagePreview.startsWith('blob:')) {
      URL.revokeObjectURL(editImagePreview);
    }
    setEditImagePreview(URL.createObjectURL(file));
  };

  const handleClearEditImage = () => {
    if (editImagePreview && editImagePreview.startsWith('blob:')) {
      URL.revokeObjectURL(editImagePreview);
    }
    setEditImageFile(null);
    setEditImagePreview(null);
    if (editCameraRef.current) editCameraRef.current.value = '';
    if (editFileRef.current) editFileRef.current.value = '';
  };

  const handleRemoveExistingImage = async () => {
    if (!editingProduct) return;
    setIsRemovingImage(true);
    setEditError(null);

    try {
      await removeProductImage(editingProduct.id);
      setEditingProduct((prev) => (prev ? { ...prev, image_url: null, image_object_key: null } : null));
      showNotification('success', 'Product image removed successfully.');
      await fetchProducts(debouncedSearch, 0, false);
    } catch (err) {
      setEditError((err as Error).message || 'Failed to remove image.');
    } finally {
      setIsRemovingImage(false);
    }
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

      // If new image was chosen, upload and attach it
      if (editImageFile) {
        await uploadAndAttachProductImage(editingProduct.id, editImageFile);
      }

      setEditingProduct(null);
      handleClearEditImage();
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
              <CheckCircle className="w-4 h-4 text-[var(--khata-success)] flex-shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-[var(--khata-danger)] flex-shrink-0" />
            )}
            <span>{notification.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotification(null)}
            className="p-1 rounded-lg hover:bg-black/5"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Header and Add Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-[var(--khata-text)] flex items-center gap-2">
            <Tag className="w-5 h-5 text-[var(--khata-accent)]" />
            <span>Product Master Catalogue</span>
          </h2>
          <p className="text-xs text-[var(--khata-text-muted)] mt-1">
            Maintain catalogue items, reference owner buying prices, and optional product photographs.
          </p>
        </div>
        <button
          onClick={() => {
            setIsAdding(!isAdding);
            setCreateError(null);
            handleClearCreateImage();
          }}
          className="neu-btn-primary text-xs sm:text-sm font-bold px-4 py-2.5 self-start sm:self-auto inline-flex items-center gap-2"
        >
          {isAdding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          <span>{isAdding ? 'Cancel' : 'Add Product'}</span>
        </button>
      </div>

      {/* Add Product Inline Form */}
      {isAdding && (
        <form
          onSubmit={handleAddProduct}
          className="neu-card p-4 sm:p-6 space-y-4 rounded-2xl"
        >
          <div className="flex items-center justify-between pb-3 border-b border-[var(--khata-border)]">
            <h3 className="text-sm font-bold text-[var(--khata-text)] uppercase tracking-wider">
              Add New Reference Product
            </h3>
            <span className="text-[11px] text-[var(--khata-text-muted)]">* Required fields</span>
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
                placeholder="e.g. Basmati Rice 1kg"
                className="neu-input w-full text-sm font-medium"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
                Owner Buying Price (₹) <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                inputMode="decimal"
                required
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                placeholder="e.g. 110.00"
                className="neu-input w-full text-sm font-medium tabular-numbers"
              />
            </div>
          </div>

          {/* Optional Product Image Section */}
          <div className="pt-1">
            <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
              Product Photograph <span className="text-neutral-400 font-normal">(Optional)</span>
            </label>

            {/* Hidden native inputs */}
            <input
              ref={createCameraRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="hidden"
              onChange={handleCreateImageSelect}
            />
            <input
              ref={createFileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleCreateImageSelect}
            />

            {!createImageFile ? (
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => createCameraRef.current?.click()}
                  className="neu-btn-secondary text-xs px-3.5 py-2 inline-flex items-center gap-1.5"
                >
                  <Camera className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                  <span>Take Photo</span>
                </button>
                <button
                  type="button"
                  onClick={() => createFileRef.current?.click()}
                  className="neu-btn-secondary text-xs px-3.5 py-2 inline-flex items-center gap-1.5"
                >
                  <Upload className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                  <span>Select Image</span>
                </button>
                <span className="text-[11px] text-[var(--khata-text-muted)] hidden sm:inline">
                  JPEG, PNG, WebP (Max 5 MB)
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-2.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/40 max-w-md">
                {createImagePreview && (
                  <img
                    src={createImagePreview}
                    alt="Preview"
                    className="w-12 h-12 rounded-lg object-cover border border-[var(--khata-border)]"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-[var(--khata-text)] truncate">
                    {createImageFile.name}
                  </p>
                  <p className="text-[10px] text-[var(--khata-text-muted)]">
                    {(createImageFile.size / 1024).toFixed(1)} KB
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleClearCreateImage}
                  className="text-xs text-[var(--khata-danger)] font-semibold hover:underline px-2 py-1"
                >
                  Remove
                </button>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                setIsAdding(false);
                handleClearCreateImage();
              }}
              className="neu-btn-secondary text-xs px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmittingCreate}
              className="neu-btn-primary text-xs px-5 py-2 font-bold inline-flex items-center gap-2"
            >
              {isSubmittingCreate ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
                  <span>Saving Product...</span>
                </>
              ) : (
                <span>Save Product</span>
              )}
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
      <div className="neu-card overflow-hidden rounded-2xl">
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
                    <th className="py-3.5 px-4 sm:px-6 w-14 text-center">Photo</th>
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
                      {/* Photo Thumbnail */}
                      <td className="py-2.5 px-4 sm:px-6 text-center">
                        {item.image_url ? (
                          <div
                            onClick={() =>
                              setLightboxProduct({
                                url: item.image_url!,
                                name: item.name,
                                price: item.buying_price,
                              })
                            }
                            className="w-10 h-10 rounded-lg overflow-hidden border border-[var(--khata-border)] cursor-pointer group relative mx-auto bg-black/5"
                            title="Click to view full image"
                          >
                            <img
                              src={item.image_url}
                              alt={item.name}
                              className="w-full h-full object-cover group-hover:scale-110 transition-transform"
                            />
                            <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
                              <Eye className="w-3.5 h-3.5" />
                            </div>
                          </div>
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] flex items-center justify-center text-[var(--khata-text-muted)] mx-auto">
                            <Tag className="w-4 h-4 opacity-40" />
                          </div>
                        )}
                      </td>

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
            className="neu-card max-w-md w-full p-6 space-y-4 rounded-2xl"
            style={{ background: 'var(--khata-surface)' }}
          >
            <div className="flex items-center justify-between pb-2 border-b border-[var(--khata-border)]">
              <h3 id="edit-product-title" className="text-base font-bold text-[var(--khata-text)]">
                Edit Reference Product
              </h3>
              <button
                type="button"
                onClick={() => {
                  setEditingProduct(null);
                  handleClearEditImage();
                }}
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

              {/* Product Photograph Management in Edit */}
              <div className="pt-1">
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
                  Product Photograph
                </label>

                {/* Hidden native inputs */}
                <input
                  ref={editCameraRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  className="hidden"
                  onChange={handleEditImageSelect}
                />
                <input
                  ref={editFileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={handleEditImageSelect}
                />

                {/* Current or newly chosen preview */}
                {editImagePreview ? (
                  <div className="flex items-center gap-3 p-2.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/40">
                    <img
                      src={editImagePreview}
                      alt="New preview"
                      className="w-12 h-12 rounded-lg object-cover border border-[var(--khata-border)]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-[var(--khata-text)] truncate">
                        New: {editImageFile?.name}
                      </p>
                      <p className="text-[10px] text-[var(--khata-text-muted)]">
                        Will be uploaded when saved
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleClearEditImage}
                      className="text-xs text-[var(--khata-danger)] font-semibold hover:underline px-2 py-1"
                    >
                      Cancel
                    </button>
                  </div>
                ) : editingProduct.image_url ? (
                  <div className="flex items-center gap-3 p-2.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/40">
                    <img
                      src={editingProduct.image_url}
                      alt={editingProduct.name}
                      className="w-12 h-12 rounded-lg object-cover border border-[var(--khata-border)]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-[var(--khata-text)]">
                        Current Image Attached
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <button
                          type="button"
                          onClick={() => editCameraRef.current?.click()}
                          className="text-xs text-[var(--khata-accent)] font-semibold hover:underline inline-flex items-center gap-1"
                        >
                          <Camera className="w-3 h-3" /> Retake
                        </button>
                        <button
                          type="button"
                          onClick={() => editFileRef.current?.click()}
                          className="text-xs text-[var(--khata-accent)] font-semibold hover:underline inline-flex items-center gap-1 ml-1"
                        >
                          <Upload className="w-3 h-3" /> Replace
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={isRemovingImage}
                      onClick={handleRemoveExistingImage}
                      className="text-xs text-[var(--khata-danger)] font-semibold hover:underline px-2 py-1 inline-flex items-center gap-1"
                    >
                      {isRemovingImage ? (
                        <Loader2 className="w-3 h-3 animate-spin text-[var(--khata-danger)]" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      <span>Remove</span>
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => editCameraRef.current?.click()}
                      className="neu-btn-secondary text-xs px-3.5 py-2 inline-flex items-center gap-1.5"
                    >
                      <Camera className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                      <span>Take Photo</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => editFileRef.current?.click()}
                      className="neu-btn-secondary text-xs px-3.5 py-2 inline-flex items-center gap-1.5"
                    >
                      <Upload className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
                      <span>Select Image</span>
                    </button>
                    <span className="text-[11px] text-[var(--khata-text-muted)]">
                      No image currently attached
                    </span>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingProduct(null);
                    handleClearEditImage();
                  }}
                  className="neu-btn-secondary text-xs px-4 py-2.5 min-h-[44px]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingEdit}
                  className="neu-btn-primary text-xs px-5 py-2.5 min-h-[44px] font-bold inline-flex items-center gap-2"
                >
                  {isSubmittingEdit ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
                      <span>Updating...</span>
                    </>
                  ) : (
                    <span>Update Product</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Lightbox / Zoom View Modal */}
      {lightboxProduct && (
        <div
          className="fixed inset-0 bg-black/85 backdrop-blur-md z-[60] flex flex-col items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-2xl flex items-center justify-between text-white pb-3">
            <div>
              <h3 className="font-bold text-base">{lightboxProduct.name}</h3>
              <p className="text-xs text-neutral-300 font-mono">
                Buying Price: {formatCurrency(lightboxProduct.price)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setLightboxProduct(null)}
              className="p-2 rounded-xl bg-white/10 hover:bg-white/20 min-h-[44px] min-w-[44px] flex items-center justify-center transition"
              aria-label="Close image preview"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          <div className="max-w-2xl max-h-[80vh] overflow-auto rounded-xl flex items-center justify-center">
            <img
              src={lightboxProduct.url}
              alt={lightboxProduct.name}
              className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
            />
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
            className="neu-card max-w-md w-full p-6 space-y-4 rounded-2xl"
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
