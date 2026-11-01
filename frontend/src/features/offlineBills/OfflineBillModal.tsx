import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Camera,
  Upload,
  Search,
  Download,
  Eye,
  Trash2,
  FileText,
  AlertCircle,
  CheckCircle,
  Loader2,
  Image as ImageIcon,
} from 'lucide-react';
import {
  OfflineBillRecord,
  listOfflineBills,
  uploadAndCreateOfflineBill,
  getOfflineBillImageUrl,
  deleteOfflineBill,
  OfflineBillsPagination,
} from './offlineBillsApi.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';

interface OfflineBillModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const OfflineBillModal: React.FC<OfflineBillModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'upload' | 'previous'>('upload');

  // Form State
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);

  // File Inputs Refs
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Previous Bills State
  const [bills, setBills] = useState<OfflineBillRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const [isLoadingBills, setIsLoadingBills] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [pagination, setPagination] = useState<OfflineBillsPagination>({
    limit: 25,
    offset: 0,
    hasMore: false,
    nextOffset: null,
  });

  // Lightbox View State
  const [lightboxBill, setLightboxBill] = useState<{ url: string; title: string; phone: string } | null>(null);
  const [deletingBillId, setDeletingBillId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Clean up object URL on unmount or file change
  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setUploadError('Only JPEG, PNG, and WebP images are allowed.');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setUploadError('Image size exceeds 10 MB limit.');
      return;
    }

    setUploadError(null);
    setSelectedFile(file);
    if (previewUrl && previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl(URL.createObjectURL(file));
  };

  const handleClearSelectedFile = () => {
    if (previewUrl && previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrl);
    }
    setSelectedFile(null);
    setPreviewUrl(null);
    if (cameraInputRef.current) cameraInputRef.current.value = '';
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Validate phone format (10 digit Indian mobile)
  const validatePhone = (val: string): boolean => {
    const clean = val.replace(/[\s\-+]/g, '');
    const mobile = clean.startsWith('91') && clean.length === 12 ? clean.slice(2) : clean;
    return /^[6-9]\d{9}$/.test(mobile);
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError(null);
    setUploadSuccess(null);

    const nameTrimmed = customerName.trim();
    const phoneTrimmed = customerPhone.trim();

    if (!nameTrimmed) {
      setUploadError('Customer Name is required.');
      return;
    }

    if (!phoneTrimmed) {
      setUploadError('Customer Mobile Number is required.');
      return;
    }

    if (!validatePhone(phoneTrimmed)) {
      setUploadError('Mobile Number must be a valid 10-digit Indian mobile (starts with 6-9).');
      return;
    }

    if (!selectedFile) {
      setUploadError('Please select or capture a bill photograph.');
      return;
    }

    setIsSubmitting(true);
    try {
      await uploadAndCreateOfflineBill({
        customerName: nameTrimmed,
        customerPhone: phoneTrimmed,
        file: selectedFile,
      });

      setUploadSuccess(`Offline bill for "${nameTrimmed}" uploaded successfully.`);
      handleClearSelectedFile();
      setCustomerName('');
      setCustomerPhone('');
      // Refresh previous list
      fetchBills(debouncedSearch, 0, false);
    } catch (err) {
      setUploadError((err as Error).message || 'Failed to upload offline bill document.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Fetch previous bills
  const billsAbortRef = useRef<AbortController | null>(null);

  const fetchBills = useCallback(
    async (query: string, offset: number = 0, append: boolean = false) => {
      if (billsAbortRef.current) {
        billsAbortRef.current.abort();
      }
      const controller = new AbortController();
      billsAbortRef.current = controller;

      try {
        if (append) {
          setIsLoadingMore(true);
        } else {
          setIsLoadingBills(true);
        }

        const res = await listOfflineBills({
          search: query,
          limit: 25,
          offset,
          signal: controller.signal,
        });

        if (append) {
          setBills((prev) => [...prev, ...res.bills]);
        } else {
          setBills(res.bills);
        }
        setPagination(res.pagination);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        console.error('Failed to load offline bills:', err);
      } finally {
        setIsLoadingBills(false);
        setIsLoadingMore(false);
      }
    },
    []
  );

  useEffect(() => {
    if (isOpen && activeTab === 'previous') {
      fetchBills(debouncedSearch, 0, false);
    }
  }, [isOpen, activeTab, debouncedSearch, fetchBills]);

  const handleLoadMoreBills = () => {
    if (pagination.hasMore && pagination.nextOffset !== null && !isLoadingMore) {
      fetchBills(debouncedSearch, pagination.nextOffset, true);
    }
  };

  const handleOpenLightbox = (bill: OfflineBillRecord) => {
    if (bill.image_url) {
      setLightboxBill({
        url: bill.image_url,
        title: bill.customer_name,
        phone: bill.customer_phone,
      });
    } else {
      // Fetch fresh view url
      getOfflineBillImageUrl(bill.id, false)
        .then((res) => {
          setLightboxBill({
            url: res.url,
            title: bill.customer_name,
            phone: bill.customer_phone,
          });
        })
        .catch((_err) => {
          alert('Could not generate view URL for this bill image.');
        });
    }
  };

  const handleDownloadBill = async (bill: OfflineBillRecord) => {
    try {
      const { url } = await getOfflineBillImageUrl(bill.id, true);
      const a = document.createElement('a');
      a.href = url;
      a.download = bill.original_filename || `offline-bill-${bill.id}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      alert('Failed to initiate download: ' + (err as Error).message);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingBillId) return;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      await deleteOfflineBill(deletingBillId);
      setBills((prev) => prev.filter((b) => b.id !== deletingBillId));
      setDeletingBillId(null);
    } catch (err) {
      setDeleteError((err as Error).message || 'Failed to delete offline bill document.');
    } finally {
      setIsDeleting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="offline-bill-modal-title"
    >
      <div
        className="neu-card w-full max-w-3xl flex flex-col max-h-[90vh] overflow-hidden rounded-2xl shadow-2xl"
        style={{ background: 'var(--khata-surface)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-[var(--khata-border)] flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[var(--khata-accent)]/10 text-[var(--khata-accent)] flex items-center justify-center">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 id="offline-bill-modal-title" className="text-base sm:text-lg font-bold text-[var(--khata-text)]">
                Offline Bill Documents
              </h2>
              <p className="text-[11px] sm:text-xs text-[var(--khata-text-muted)]">
                Store photographic records of physical customer bills
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] min-h-[44px] min-w-[44px] flex items-center justify-center -mr-1"
            aria-label="Close offline bills modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Critical Business Clarification Alert Banner */}
        <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-2 flex-shrink-0">
          <AlertCircle className="w-4 h-4 flex-shrink-0 text-amber-500" />
          <span>
            <strong>Reference Only:</strong> Offline bills are archival document records. They do not create udhar transactions, balances, or financial customer accounts.
          </span>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-[var(--khata-border)] bg-[var(--khata-surface-inset)]/40 px-4 pt-2 gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('upload')}
            className={`px-4 py-2 text-xs sm:text-sm font-bold border-b-2 transition flex items-center gap-2 ${
              activeTab === 'upload'
                ? 'border-[var(--khata-accent)] text-[var(--khata-accent)]'
                : 'border-transparent text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
            }`}
          >
            <Upload className="w-4 h-4" />
            <span>Upload Offline Bill</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('previous')}
            className={`px-4 py-2 text-xs sm:text-sm font-bold border-b-2 transition flex items-center gap-2 ${
              activeTab === 'previous'
                ? 'border-[var(--khata-accent)] text-[var(--khata-accent)]'
                : 'border-transparent text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
            }`}
          >
            <ImageIcon className="w-4 h-4" />
            <span>Previous Bills</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          {activeTab === 'upload' ? (
            /* Upload Tab Content */
            <form onSubmit={handleUploadSubmit} className="space-y-4 max-w-lg mx-auto">
              {uploadSuccess && (
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 text-[var(--khata-success)] text-xs rounded-xl flex items-center justify-between font-medium">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{uploadSuccess}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('previous')}
                    className="underline text-[11px] font-bold"
                  >
                    View in Previous Bills
                  </button>
                </div>
              )}

              {uploadError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 text-[var(--khata-danger)] text-xs rounded-xl flex items-center gap-2 font-medium">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{uploadError}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
                  Customer Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Ramesh Kumar"
                  className="neu-input w-full text-sm font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
                  Customer Mobile Number <span className="text-rose-500">*</span>
                </label>
                <input
                  type="tel"
                  required
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="10-digit mobile number (e.g. 9876543210)"
                  className="neu-input w-full text-sm font-medium tabular-numbers"
                />
              </div>

              {/* Photo Capture & File Pickers */}
              <div>
                <label className="block text-xs font-bold text-[var(--khata-text-muted)] uppercase mb-1">
                  Bill Photograph / Scan <span className="text-rose-500">*</span>
                </label>

                {/* Hidden Native File Inputs */}
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={handleFileChange}
                />

                {!selectedFile ? (
                  <div className="border-2 border-dashed border-[var(--khata-border)] rounded-2xl p-6 text-center space-y-3 bg-[var(--khata-surface-inset)]/30">
                    <div className="flex items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => cameraInputRef.current?.click()}
                        className="neu-btn-secondary text-xs sm:text-sm font-bold px-4 py-2.5 inline-flex items-center gap-2"
                      >
                        <Camera className="w-4 h-4 text-[var(--khata-accent)]" />
                        <span>Camera Photo</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="neu-btn-secondary text-xs sm:text-sm font-bold px-4 py-2.5 inline-flex items-center gap-2"
                      >
                        <Upload className="w-4 h-4 text-[var(--khata-accent)]" />
                        <span>Choose File</span>
                      </button>
                    </div>
                    <p className="text-[11px] text-[var(--khata-text-muted)]">
                      Supported formats: JPEG, PNG, WebP (Max 10 MB)
                    </p>
                  </div>
                ) : (
                  <div className="relative border border-[var(--khata-border)] rounded-2xl p-3 bg-[var(--khata-surface-inset)]/30 space-y-2">
                    <div className="flex items-center justify-between text-xs text-[var(--khata-text-muted)] mb-1">
                      <span className="font-semibold text-[var(--khata-text)] truncate max-w-[200px]">
                        {selectedFile.name}
                      </span>
                      <span>{(selectedFile.size / 1024).toFixed(1)} KB</span>
                    </div>

                    {previewUrl && (
                      <div className="relative rounded-xl overflow-hidden max-h-56 bg-black/10 flex items-center justify-center">
                        <img
                          src={previewUrl}
                          alt="Bill preview"
                          className="max-h-56 w-auto object-contain rounded-lg"
                        />
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => cameraInputRef.current?.click()}
                        className="text-xs text-[var(--khata-accent)] font-semibold hover:underline inline-flex items-center gap-1"
                      >
                        <Camera className="w-3.5 h-3.5" /> Retake
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-xs text-[var(--khata-accent)] font-semibold hover:underline inline-flex items-center gap-1 ml-2"
                      >
                        <Upload className="w-3.5 h-3.5" /> Replace
                      </button>
                      <button
                        type="button"
                        onClick={handleClearSelectedFile}
                        className="text-xs text-[var(--khata-danger)] font-semibold hover:underline inline-flex items-center gap-1 ml-2"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isSubmitting || !selectedFile}
                  className="neu-btn-primary w-full py-3 text-sm font-bold flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
                      <span>Uploading to Secure Storage...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      <span>Upload & Store Offline Bill</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : (
            /* Previous Bills Tab Content */
            <div className="space-y-4">
              {/* Search Bar */}
              <div className="relative flex items-center">
                <Search className="w-4 h-4 text-[var(--khata-text-muted)] absolute left-3.5 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search offline bills by customer name or mobile number..."
                  className="neu-input neu-input-with-leading-icon w-full text-sm font-medium"
                />
              </div>

              {/* Bills List / Cards */}
              {isLoadingBills ? (
                <div className="p-8 text-center text-sm text-[var(--khata-text-muted)] font-medium flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--khata-accent)]" />
                  <span>Loading offline bills...</span>
                </div>
              ) : bills.length === 0 ? (
                <div className="p-8 text-center text-sm text-[var(--khata-text-muted)] neu-card">
                  {searchQuery
                    ? 'No offline bills found matching your search.'
                    : 'No offline bills recorded yet. Use the "Upload Offline Bill" tab to save physical bill photos.'}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {bills.map((bill) => (
                    <div
                      key={bill.id}
                      className="neu-card p-3.5 flex flex-col justify-between space-y-3 rounded-xl border border-[var(--khata-border)]"
                    >
                      <div className="space-y-2">
                        {/* Thumbnail */}
                        <div
                          onClick={() => handleOpenLightbox(bill)}
                          className="h-36 rounded-lg bg-[var(--khata-surface-inset)] overflow-hidden flex items-center justify-center cursor-pointer group relative border border-[var(--khata-border)]"
                        >
                          {bill.image_url ? (
                            <img
                              src={bill.image_url}
                              alt={bill.customer_name}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                            />
                          ) : (
                            <div className="flex flex-col items-center text-[var(--khata-text-muted)] gap-1">
                              <ImageIcon className="w-8 h-8 opacity-40" />
                              <span className="text-[10px]">Click to view</span>
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white gap-1 text-xs font-semibold">
                            <Eye className="w-4 h-4" /> View
                          </div>
                        </div>

                        <div>
                          <div className="font-bold text-sm text-[var(--khata-text)] truncate">
                            {bill.customer_name}
                          </div>
                          <div className="text-xs font-mono text-[var(--khata-text-muted)]">
                            {bill.customer_phone}
                          </div>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-[var(--khata-border)] flex items-center justify-between text-xs text-[var(--khata-text-muted)]">
                        <span>
                          {new Date(bill.created_at).toLocaleDateString('en-IN', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleDownloadBill(bill)}
                            className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-accent)] hover:bg-[var(--khata-surface-inset)] transition"
                            title="Download original file"
                            aria-label={`Download bill for ${bill.customer_name}`}
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeletingBillId(bill.id);
                              setDeleteError(null);
                            }}
                            className="p-1.5 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-danger)] hover:bg-[var(--khata-surface-inset)] transition"
                            title="Delete bill record"
                            aria-label={`Delete bill for ${bill.customer_name}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Load More Button */}
              {pagination.hasMore && (
                <div className="pt-2 text-center">
                  <button
                    type="button"
                    onClick={handleLoadMoreBills}
                    disabled={isLoadingMore}
                    className="neu-btn-secondary text-xs px-5 py-2 font-bold inline-flex items-center gap-1.5"
                  >
                    {isLoadingMore ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--khata-accent)]" />
                        <span>Loading more...</span>
                      </>
                    ) : (
                      <span>Load More Bills</span>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[var(--khata-border)] bg-[var(--khata-surface)] flex justify-end flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="neu-btn-secondary text-xs px-5 py-2.5 font-bold min-h-[44px]"
          >
            Close
          </button>
        </div>
      </div>

      {/* Lightbox / Zoom View Modal */}
      {lightboxBill && (
        <div
          className="fixed inset-0 bg-black/85 backdrop-blur-md z-[60] flex flex-col items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-4xl flex items-center justify-between text-white pb-3">
            <div>
              <h3 className="font-bold text-base">{lightboxBill.title}</h3>
              <p className="text-xs text-neutral-300 font-mono">{lightboxBill.phone}</p>
            </div>
            <button
              type="button"
              onClick={() => setLightboxBill(null)}
              className="p-2 rounded-xl bg-white/10 hover:bg-white/20 min-h-[44px] min-w-[44px] flex items-center justify-center transition"
              aria-label="Close image preview"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          <div className="max-w-4xl max-h-[80vh] overflow-auto rounded-xl flex items-center justify-center">
            <img
              src={lightboxBill.url}
              alt={lightboxBill.title}
              className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
            />
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingBillId && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="neu-card max-w-sm w-full p-6 space-y-4 rounded-2xl"
            style={{ background: 'var(--khata-surface)' }}
          >
            <h3 className="text-base font-bold text-[var(--khata-text)]">
              Delete Offline Bill Record?
            </h3>
            <p className="text-xs text-[var(--khata-text-muted)] leading-relaxed">
              This will permanently delete this offline bill image and metadata record from storage. This document does not affect any financial transactions.
            </p>

            {deleteError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 text-[var(--khata-danger)] text-xs rounded-xl font-medium">
                {deleteError}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setDeletingBillId(null)}
                className="neu-btn-secondary text-xs px-4 py-2 min-h-[40px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="neu-btn-danger text-xs px-4 py-2 min-h-[40px] font-bold"
              >
                {isDeleting ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
