import { apiClient, getCsrfToken, fetchCsrfToken, API_BASE_URL } from '../../lib/apiClient.js';

export { API_BASE_URL };

/**
 * Resolves an image URL (relative or absolute) to a full URL.
 */
export function resolveImageUrl(url?: string | null): string {
  if (!url) return '';
  if (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('blob:') ||
    url.startsWith('data:')
  ) {
    return url;
  }
  return `${API_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

export interface UploadIntentData {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
  headers: Record<string, string>;
}

export interface ProductImageUrls {
  viewUrl: string;
  expiresIn: number;
}

/**
 * Request a presigned PUT URL for a product image (legacy — kept for compatibility)
 */
export async function getProductImageUploadIntent(
  productId: number,
  file: File
): Promise<UploadIntentData> {
  const res = await apiClient<{ success: boolean; data: UploadIntentData }>(
    `/api/v1/products/${productId}/image/upload-intent`,
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
 * Upload binary file directly to Cloudflare R2 using the presigned PUT URL (legacy)
 */
export async function uploadFileToPresignedUrl(
  uploadUrl: string,
  file: File,
  headers: Record<string, string> = {}
): Promise<void> {
  try {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type,
        ...headers,
      },
      body: file,
    });

    if (!response.ok) {
      throw new Error(`Direct upload to storage failed with status ${response.status}`);
    }
  } catch (err) {
    if ((err as Error).message === 'Failed to fetch') {
      throw new Error(
        'Upload blocked by browser. Please configure the CORS policy in your Cloudflare R2 bucket settings.'
      );
    }
    throw err;
  }
}

/**
 * Finalize image attachment: backend verifies file signature & links to product (legacy)
 */
export async function completeProductImage(
  productId: number,
  objectKey: string
): Promise<void> {
  await apiClient(`/api/v1/products/${productId}/image/complete`, {
    method: 'POST',
    body: JSON.stringify({ objectKey }),
  });
}

/**
 * Upload and attach a product image via server-side proxy (browser → backend → R2).
 * Eliminates all browser CORS restrictions.
 */
export async function uploadAndAttachProductImage(
  productId: number,
  file: File
): Promise<void> {
  // Ensure CSRF token is available
  let csrfToken = getCsrfToken();
  if (!csrfToken) {
    csrfToken = await fetchCsrfToken();
  }

  const formData = new FormData();
  formData.append('image', file);

  const response = await fetch(`${API_BASE_URL}/api/v1/products/${productId}/image/upload`, {
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
        const retryRes = await fetch(`${API_BASE_URL}/api/v1/products/${productId}/image/upload`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-CSRF-Token': refreshedToken },
          body: formData,
        });
        if (retryRes.ok) return;
        const retryErr = await retryRes.json().catch(() => ({}));
        throw new Error((retryErr as { message?: string }).message || 'Image upload failed');
      }
    }
    throw new Error((err as { message?: string }).message || 'Image upload failed');
  }
}

/**
 * Remove image from product without deleting product
 */
export async function removeProductImage(productId: number): Promise<void> {
  await apiClient(`/api/v1/products/${productId}/image`, {
    method: 'DELETE',
  });
}

/**
 * Get refreshed presigned view URL for a product image
 */
export async function getProductImageUrl(productId: number): Promise<ProductImageUrls> {
  const res = await apiClient<{ success: boolean; data: ProductImageUrls }>(
    `/api/v1/products/${productId}/image-url`
  );
  return res.data.data;
}
