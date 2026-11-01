import { apiClient } from '../../lib/apiClient.js';
import { uploadFileToPresignedUrl, UploadIntentData } from '../products/productsApi.js';

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
 * Request presigned PUT URL for uploading an offline bill document image
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
 * Create offline bill record with verified image
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
 * End-to-end upload and create offline bill
 */
export async function uploadAndCreateOfflineBill(params: {
  customerName: string;
  customerPhone: string;
  file: File;
}): Promise<OfflineBillRecord> {
  const intent = await getOfflineBillUploadIntent(params.file);
  await uploadFileToPresignedUrl(intent.uploadUrl, params.file, intent.headers);
  return await createOfflineBillRecord({
    customerName: params.customerName,
    customerPhone: params.customerPhone,
    imageObjectKey: intent.objectKey,
    originalFilename: params.file.name,
  });
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
