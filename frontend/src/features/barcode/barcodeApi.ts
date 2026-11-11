import { apiClient } from '../../lib/apiClient.js';

export interface ProductBarcodeRecord {
  id: number;
  name: string;
  buying_price: string;
  hsn_code?: string | null;
  barcode?: string | null;
  image_url?: string | null;
  image_object_key?: string | null;
  created_at: string;
  updated_at?: string;
  archived_at?: string | null;
}

/**
 * Looks up an active product by its barcode string.
 * Returns null if not found (404).
 */
export async function fetchProductByBarcode(rawBarcode: string): Promise<ProductBarcodeRecord | null> {
  const barcode = rawBarcode.trim();
  if (!barcode) return null;

  try {
    const res = await apiClient<{ success: boolean; data: ProductBarcodeRecord }>(
      `/api/v1/products/barcode/${encodeURIComponent(barcode)}`,
      { method: 'GET' }
    );
    return res.data?.data || null;
  } catch (err: any) {
    if (err?.code === 'NOT_FOUND' || err?.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Associates or removes a barcode from an existing product.
 */
export async function updateProductBarcode(
  productId: number,
  barcode: string | null,
  confirmReplaceBarcode = false
): Promise<ProductBarcodeRecord> {
  const res = await apiClient<{ success: boolean; data: ProductBarcodeRecord }>(
    `/api/v1/products/${productId}/barcode`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        barcode: barcode && barcode.trim() ? barcode.trim() : null,
        confirmReplaceBarcode,
      }),
    }
  );
  return res.data?.data;
}
