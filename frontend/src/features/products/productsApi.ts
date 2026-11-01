import { apiClient } from '../../lib/apiClient.js';

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
 * Request a presigned PUT URL for a product image
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
 * Upload binary file directly to Cloudflare R2 using the presigned PUT URL
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
 * Finalize image attachment: backend verifies file signature & links to product
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
 * Helper to upload and attach an image to an existing product
 */
export async function uploadAndAttachProductImage(
  productId: number,
  file: File
): Promise<void> {
  const intent = await getProductImageUploadIntent(productId, file);
  await uploadFileToPresignedUrl(intent.uploadUrl, file, intent.headers);
  await completeProductImage(productId, intent.objectKey);
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
