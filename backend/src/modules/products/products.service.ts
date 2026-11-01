import { AppError } from '../../utils/errors.js';
import { appPool } from '../../config/database.js';
import { validateMoneyInput, escapeLike } from '../../utils/validation.js';
import { storageService } from '../../services/storage.service.js';

export interface ProductRecord {
  id: number;
  name: string;
  buying_price: string;
  hsn_code?: string | null;
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
    const limit = Math.min(Math.max(1, opts.limit || 25), 50);
    const offset = Math.max(0, opts.offset || 0);

    let sql = `
      SELECT id, name, buying_price, hsn_code, created_at, updated_at, archived_at,
             image_object_key, image_content_type, image_size_bytes, image_updated_at
      FROM products
      WHERE archived_at IS NULL
    `;
    const params: unknown[] = [];

    if (opts.search && opts.search.trim()) {
      const cleanSearch = escapeLike(opts.search.trim());
      params.push(`%${cleanSearch}%`);
      sql += ` AND (name ILIKE $${params.length} OR (hsn_code IS NOT NULL AND hsn_code ILIKE $${params.length}))`;
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
      `SELECT id, name, buying_price, hsn_code, created_at, updated_at, archived_at,
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
   * Creates a new reference product with strict money validation
   */
  public async createProduct(
    name: string,
    buyingPrice: string | number,
    hsnCode?: string | null
  ): Promise<ProductRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new AppError('Product name cannot be empty.', 400, 'VALIDATION_ERROR');

    const priceDec = validateMoneyInput(buyingPrice, 'Buying price');
    const formattedPrice = priceDec.toFixed(2);
    const cleanHsn = hsnCode && hsnCode.trim() ? hsnCode.trim() : null;

    const result = await appPool.query(
      `INSERT INTO products (name, buying_price, hsn_code, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING id, name, buying_price, hsn_code, created_at, updated_at, archived_at,
                 image_object_key, image_content_type, image_size_bytes, image_updated_at`,
      [trimmed, formattedPrice, cleanHsn]
    );
    return { ...result.rows[0], image_url: null };
  }

  /**
   * Updates an existing product's name and/or buying price with strict money validation
   */
  public async updateProduct(
    id: number,
    data: { name?: string; buyingPrice?: string | number; hsnCode?: string | null }
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

    const result = await appPool.query(
      `UPDATE products
       SET name = $1, buying_price = $2, hsn_code = $3, updated_at = NOW()
       WHERE id = $4 AND archived_at IS NULL
       RETURNING id, name, buying_price, hsn_code, created_at, updated_at, archived_at,
                 image_object_key, image_content_type, image_size_bytes, image_updated_at`,
      [newName, newPrice, newHsn, id]
    );
    if (result.rows.length === 0) return null;
    const [updatedWithUrl] = await this.attachPresignedUrls(result.rows);
    return updatedWithUrl || null;
  }

  /**
   * Safely archives a product without deleting historical references
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
       RETURNING id, name, buying_price, hsn_code, created_at, updated_at, archived_at,
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
       RETURNING id, name, buying_price, hsn_code, created_at, updated_at, archived_at,
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
