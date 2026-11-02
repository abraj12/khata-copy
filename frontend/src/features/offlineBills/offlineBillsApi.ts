import { apiClient, getCsrfToken, fetchCsrfToken, API_BASE_URL } from '../../lib/apiClient.js';
import type { UploadIntentData } from '../products/productsApi.js';
export { resolveImageUrl } from '../products/productsApi.js';
export { API_BASE_URL } from '../../lib/apiClient.js';


export interface OfflineBillRecord {
  id: number;
  customer_name: string;
  customer_phone: string;
  normalized_customer_phone: string;
  image_object_key: string;
  image_content_type: string;
  image_size_bytes: string | number;
  original_filename?: string | null;
  image_url?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface OfflineBillsPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/**
 * Request presigned PUT URL for uploading an offline bill document image (legacy)
 */
export async function getOfflineBillUploadIntent(file: File): Promise<UploadIntentData> {
  const res = await apiClient<{ success: boolean; data: UploadIntentData }>(
    '/api/v1/offline-bills/upload-intent',
    {
      method: 'POST',
      body: JSON.stringify({
        contentType: file.type,
        sizeBytes: file.size,
        originalFilename: file.name,
      }),
    }
  );
  return res.data.data;
}

/**
 * Create offline bill record with verified image (used with legacy presigned URL flow)
 */
export async function createOfflineBillRecord(params: {
  customerName: string;
  customerPhone: string;
  imageObjectKey: string;
  originalFilename?: string;
}): Promise<OfflineBillRecord> {
  const res = await apiClient<{ success: boolean; data: OfflineBillRecord }>(
    '/api/v1/offline-bills',
    {
      method: 'POST',
      body: JSON.stringify(params),
    }
  );
  return res.data.data;
}

/**
 * End-to-end upload and create offline bill via server-side proxy (browser → backend → R2).
 * Eliminates all browser CORS restrictions.
 */
export async function uploadAndCreateOfflineBill(params: {
  customerName: string;
  customerPhone: string;
  file: File;
}): Promise<OfflineBillRecord> {
  // Ensure CSRF token is available
  let csrfToken = getCsrfToken();
  if (!csrfToken) {
    csrfToken = await fetchCsrfToken();
  }

  const formData = new FormData();
  formData.append('image', params.file);
  formData.append('customerName', params.customerName);
  formData.append('customerPhone', params.customerPhone);

  const response = await fetch(`${API_BASE_URL}/api/v1/offline-bills/upload`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      // DO NOT set Content-Type — browser sets it automatically with multipart boundary
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    if (response.status === 403 && (err as { message?: string })?.message?.includes('CSRF token')) {
      const refreshedToken = await fetchCsrfToken();
      if (refreshedToken) {
        const retryRes = await fetch(`${API_BASE_URL}/api/v1/offline-bills/upload`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-CSRF-Token': refreshedToken },
          body: formData,
        });
        if (retryRes.ok) {
          const retryResult = await retryRes.json();
          return (retryResult as { data: OfflineBillRecord }).data;
        }
        const retryErr = await retryRes.json().catch(() => ({}));
        throw new Error((retryErr as { message?: string }).message || 'Offline bill upload failed');
      }
    }
    throw new Error((err as { message?: string }).message || 'Offline bill upload failed');
  }

  const result = await response.json();
  return (result as { data: OfflineBillRecord }).data;
}

/**
 * List offline bills with search and pagination
 */
export async function listOfflineBills(params: {
  search?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}): Promise<{ bills: OfflineBillRecord[]; pagination: OfflineBillsPagination }> {
  const searchParam = params.search ? `&search=${encodeURIComponent(params.search)}` : '';
  const limit = params.limit ?? 25;
  const offset = params.offset ?? 0;

  const res = await apiClient<{
    success: boolean;
    data: OfflineBillRecord[];
    pagination: OfflineBillsPagination;
  }>(`/api/v1/offline-bills?limit=${limit}&offset=${offset}${searchParam}`, {
    signal: params.signal,
  });

  return {
    bills: res.data.data || [],
    pagination: res.data.pagination || { limit, offset, hasMore: false, nextOffset: null },
  };
}

/**
 * Get presigned URL for viewing or downloading an offline bill image
 */
export async function getOfflineBillImageUrl(
  billId: number,
  download: boolean = false
): Promise<{ url: string; expiresIn: number }> {
  const res = await apiClient<{ success: boolean; data: { url: string; expiresIn: number } }>(
    `/api/v1/offline-bills/${billId}/image-url?download=${download ? 'true' : 'false'}`
  );
  return res.data.data;
}

/**
 * Delete an offline bill record and storage object
 */
export async function deleteOfflineBill(billId: number): Promise<void> {
  await apiClient(`/api/v1/offline-bills/${billId}`, {
    method: 'DELETE',
  });
}
