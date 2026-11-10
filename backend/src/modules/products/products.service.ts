import { AppError } from '../../utils/errors.js';
import { appPool } from '../../config/database.js';
import { validateMoneyInput, escapeLike } from '../../utils/validation.js';
import { storageService } from '../../services/storage.service.js';

export interface ProductRecord {
  id: number;
  name: string;
  buying_price: string;
  hsn_code?: string | null;
  barcode?: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  image_object_key?: string | null;
  image_content_type?: string | null;
  image_size_bytes?: number | string | null;
  image_updated_at?: string | null;
  image_url?: string | null;
}

export interface ListProductsOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PaginatedProductsResult {
  products: ProductRecord[];
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

export class ProductsService {
  /**
   * Normalizes barcode input without mutating meaningful leading zeroes.
   * Returns trimmed string, or null if empty/whitespace.
   */
  public normalizeBarcode(barcode: string | null | undefined): string | null {
    if (barcode === undefined || barcode === null) return null;
    const trimmed = String(barcode).trim();
    if (!trimmed) return null;
    if (trimmed.length > 64) {
      throw new AppError('Barcode cannot exceed 64 characters.', 400, 'VALIDATION_ERROR');
    }
    return trimmed;
  }

  /**
   * Helper to attach image URLs to product records.
   * Uses direct proxy URLs to eliminate browser CORS and 5-minute presigned expiration timeouts.
   */
  private async attachPresignedUrls(rows: any[]): Promise<ProductRecord[]> {
    if (!storageService.isConfigured()) {
      return rows.map((r) => ({ ...r, image_url: null }));
    }

    return rows.map((r) => {
      let imageUrl: string | null = null;
      if (r.image_object_key) {
        const v = Date.parse(r.image_updated_at || r.updated_at || '') || 1;
        imageUrl = `/api/v1/products/${r.id}/image?v=${v}`;
      }
      return {
        ...r,
        image_url: imageUrl,
      };
    });
  }

  /**
   * Lists active products with case-insensitive search and bounded pagination
   */
  public async listActiveProducts(optionsOrSearch?: string | ListProductsOptions): Promise<PaginatedProductsResult> {
    const opts = typeof optionsOrSearch === 'string' ? { search: optionsOrSearch } : optionsOrSearch || {};
    const limit = Math.min(Math.max(1, opts.limit || 25), 200);
    const offset = Math.max(0, opts.offset || 0);

    let sql = `
      SELECT id, name, buying_price, hsn_code, barcode, created_at, updated_at, archived_at,
             image_object_key, image_content_type, image_size_bytes, image_updated_at
      FROM products
      WHERE archived_at IS NULL
    `;
    const params: unknown[] = [];

    if (opts.search && opts.search.trim()) {
      const cleanSearch = escapeLike(opts.search.trim());
      params.push(`%${cleanSearch}%`);
      sql += ` AND (name ILIKE $${params.length} OR (hsn_code IS NOT NULL AND hsn_code ILIKE $${params.length}) OR (barcode IS NOT NULL AND barcode ILIKE $${params.length}))`;
    }

    sql += ` ORDER BY LOWER(name) ASC, name ASC, id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit + 1, offset);

    const result = await appPool.query(sql, params);
    const hasMore = result.rows.length > limit;
    const rawProducts = hasMore ? result.rows.slice(0, limit) : result.rows;

    const products = await this.attachPresignedUrls(rawProducts);

    return {
      products,
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
    };
  }

  /**
   * Retrieves an active product by ID
   */
  public async getProductById(id: number): Promise<ProductRecord | null> {
    const result = await appPool.query(
      `SELECT id, name, buying_price, hsn_code, barcode, created_at, updated_at, archived_at,
              image_object_key, image_content_type, image_size_bytes, image_updated_at
       FROM products
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;
    const [productWithUrl] = await this.attachPresignedUrls(result.rows);
    return productWithUrl || null;
  }

  /**
   * Retrieves an active product by barcode.
   * Only matches non-archived products.
   * Preserves leading zeroes in barcode lookup.
   */
  public async findByBarcode(rawBarcode: string): Promise<ProductRecord | null> {
    const normalized = this.normalizeBarcode(rawBarcode);
    if (!normalized) {
      throw new AppError('Barcode parameter is required.', 400, 'VALIDATION_ERROR');
    }

    const result = await appPool.query(
      `SELECT id, name, buying_price, hsn_code, barcode, created_at, updated_at, archived_at,
              image_object_key, image_content_type, image_size_bytes, image_updated_at
       FROM products
       WHERE barcode = $1 AND archived_at IS NULL`,
      [normalized]
    );

    if (result.rows.length === 0) return null;
    if (result.rows.length > 1) {
      throw new AppError('Multiple active products match this barcode.', 409, 'CONFLICT');
    }

    const [productWithUrl] = await this.attachPresignedUrls(result.rows);
    return productWithUrl || null;
  }

  /**
   * Creates a new reference product with strict money validation and optional barcode
   */
  public async createProduct(
    name: string,
    buyingPrice: string | number,
    hsnCode?: string | null,
    barcode?: string | null
  ): Promise<ProductRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('Product name cannot be empty.', 400, 'VALIDATION_ERROR');

    const priceDec = validateMoneyInput(buyingPrice, 'Buying price');
    const formattedPrice = priceDec.toFixed(2);
    const cleanHsn = hsnCode && hsnCode.trim() ? hsnCode.trim() : null;
    const cleanBarcode = this.normalizeBarcode(barcode);

    try {
      const result = await appPool.query(
        `INSERT INTO products (name, buying_price, hsn_code, barcode, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id, name, buying_price, hsn_code, barcode, created_at, updated_at, archived_at,
                   image_object_key, image_content_type, image_size_bytes, image_updated_at`,
        [trimmed, formattedPrice, cleanHsn, cleanBarcode]
      );
      return { ...result.rows[0], image_url: null };
    } catch (err: any) {
      if (err.code === '23505' && (err.constraint === 'idx_products_barcode_active' || String(err.message).includes('barcode'))) {
        throw new AppError(`A product with barcode "${cleanBarcode}" already exists.`, 409, 'DUPLICATE_BARCODE');
      }
      throw err;
    }
  }

  /**
   * Updates an existing product's name, buying price, HSN, and/or barcode
   */
  public async updateProduct(
    id: number,
    data: { name?: string; buyingPrice?: string | number; hsnCode?: string | null; barcode?: string | null }
  ): Promise<ProductRecord | null> {
    const existing = await this.getProductById(id);
    if (!existing || existing.archived_at) return null;

    const newName = data.name !== undefined ? data.name.trim() : existing.name;
    let newPrice = existing.buying_price;

    if (data.buyingPrice !== undefined) {
      const priceDec = validateMoneyInput(data.buyingPrice, 'Buying price');
      newPrice = priceDec.toFixed(2);
    }

    const newHsn = data.hsnCode !== undefined
      ? (data.hsnCode && data.hsnCode.trim() ? data.hsnCode.trim() : null)
      : (existing.hsn_code || null);

    const newBarcode = data.barcode !== undefined
      ? this.normalizeBarcode(data.barcode)
      : (existing.barcode || null);

    try {
      const result = await appPool.query(
        `UPDATE products
         SET name = $1, buying_price = $2, hsn_code = $3, barcode = $4, updated_at = NOW()
         WHERE id = $5 AND archived_at IS NULL
         RETURNING id, name, buying_price, hsn_code, barcode, created_at, updated_at, archived_at,
                   image_object_key, image_content_type, image_size_bytes, image_updated_at`,
        [newName, newPrice, newHsn, newBarcode, id]
      );
      if (result.rows.length === 0) return null;
      const [updatedWithUrl] = await this.attachPresignedUrls(result.rows);
      return updatedWithUrl || null;
    } catch (err: any) {
      if (err.code === '23505' && (err.constraint === 'idx_products_barcode_active' || String(err.message).includes('barcode'))) {
        throw new AppError(`A product with barcode "${newBarcode}" already exists.`, 409, 'DUPLICATE_BARCODE');
      }
      throw err;
    }
  }

  /**
   * Specifically associates or removes a barcode from an existing active product
   */
  public async updateBarcode(id: number, barcode: string | null): Promise<ProductRecord | null> {
    const normalized = this.normalizeBarcode(barcode);

    try {
      const result = await appPool.query(
        `UPDATE products
         SET barcode = $1, updated_at = NOW()
         WHERE id = $2 AND archived_at IS NULL
         RETURNING id, name, buying_price, hsn_code, barcode, created_at, updated_at, archived_at,
                   image_object_key, image_content_type, image_size_bytes, image_updated_at`,
        [normalized, id]
      );
      if (result.rows.length === 0) return null;
      const [updatedWithUrl] = await this.attachPresignedUrls(result.rows);
      return updatedWithUrl || null;
    } catch (err: any) {
      if (err.code === '23505' && (err.constraint === 'idx_products_barcode_active' || String(err.message).includes('barcode'))) {
        throw new AppError(`A product with barcode "${normalized}" already exists.`, 409, 'DUPLICATE_BARCODE');
      }
      throw err;
    }
  }

  /**
   * Safely archives a product without deleting historical references.
   * Frees up the product's barcode for reuse.
   */
  public async archiveProduct(id: number): Promise<boolean> {
    const result = await appPool.query(
      `UPDATE products
       SET archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND archived_at IS NULL`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Attaches or replaces a product image after verifying the uploaded R2 object
   */
  public async attachProductImage(productId: number, imageObjectKey: string): Promise<ProductRecord> {
    const existing = await this.getProductById(productId);
    if (!existing || existing.archived_at) {
      throw new AppError('Product not found or archived.', 404, 'NOT_FOUND');
    }

    // Verify object in storage
    const verified = await storageService.verifyObject(imageObjectKey, 'products', productId);

    const oldKey = existing.image_object_key;

    // Update product record
    const result = await appPool.query(
      `UPDATE products
       SET image_object_key = $1,
           image_content_type = $2,
           image_size_bytes = $3,
           image_updated_at = NOW(),
           updated_at = NOW()
       WHERE id = $4 AND archived_at IS NULL
       RETURNING id, name, buying_price, hsn_code, barcode, created_at, updated_at, archived_at,
                 image_object_key, image_content_type, image_size_bytes, image_updated_at`,
      [imageObjectKey, verified.contentType, verified.contentLength, productId]
    );

    if (result.rows.length === 0) {
      throw new AppError('Product not found or archived.', 404, 'NOT_FOUND');
    }

    // Delete previous image if replaced
    if (oldKey && oldKey !== imageObjectKey) {
      await storageService.deleteObject(oldKey);
    }

    const [updatedWithUrl] = await this.attachPresignedUrls(result.rows);
    return updatedWithUrl;
  }

  /**
   * Removes a product image without deleting the product itself
   */
  public async removeProductImage(productId: number): Promise<ProductRecord> {
    const existing = await this.getProductById(productId);
    if (!existing || existing.archived_at) {
      throw new AppError('Product not found or archived.', 404, 'NOT_FOUND');
    }

    const oldKey = existing.image_object_key;

    const result = await appPool.query(
      `UPDATE products
       SET image_object_key = NULL,
           image_content_type = NULL,
           image_size_bytes = NULL,
           image_updated_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND archived_at IS NULL
       RETURNING id, name, buying_price, hsn_code, barcode, created_at, updated_at, archived_at,
                 image_object_key, image_content_type, image_size_bytes, image_updated_at`,
      [productId]
    );

    if (result.rows.length === 0) {
      throw new AppError('Product not found or archived.', 404, 'NOT_FOUND');
    }

    // Delete previous R2 object
    if (oldKey) {
      await storageService.deleteObject(oldKey);
    }

    return { ...result.rows[0], image_url: null };
  }

  /**
   * Retrieves fresh image URL for product image
   */
  public async getProductImageUrl(productId: number): Promise<{ imageUrl: string | null; expiresIn: number }> {
    const existing = await this.getProductById(productId);
    if (!existing || existing.archived_at) {
      throw new AppError('Product not found or archived.', 404, 'NOT_FOUND');
    }

    if (!existing.image_object_key || !storageService.isConfigured()) {
      return { imageUrl: null, expiresIn: 0 };
    }

    const v = Date.parse(existing.image_updated_at || existing.updated_at || '') || 1;
    const imageUrl = `/api/v1/products/${productId}/image?v=${v}`;
    return { imageUrl, expiresIn: 86400 };
  }
}

export const productsService = new ProductsService();
