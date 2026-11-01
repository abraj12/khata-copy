import { appPool } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { escapeLike } from '../../utils/validation.js';
import { khataService } from '../khata/khata.service.js';
import { storageService } from '../../services/storage.service.js';
import crypto from 'crypto';

export interface OfflineBillRecord {
  id: number;
  customer_name: string;
  customer_phone: string;
  normalized_customer_phone: string;
  image_object_key: string;
  image_content_type: string;
  image_size_bytes: number | string;
  original_filename: string | null;
  created_at: string;
  updated_at: string;
  image_url?: string | null;
}

export interface ListOfflineBillsOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PaginatedOfflineBillsResult {
  bills: OfflineBillRecord[];
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

export class OfflineBillsService {
  /**
   * Helper to attach temporary presigned GET URLs to bill records
   */
  private async attachPresignedUrls(rows: any[]): Promise<OfflineBillRecord[]> {
    if (!storageService.isConfigured()) {
      return rows.map((r) => ({ ...r, image_url: null }));
    }

    return Promise.all(
      rows.map(async (r) => {
        let imageUrl: string | null = null;
        if (r.image_object_key) {
          try {
            imageUrl = await storageService.getPresignedViewUrl(r.image_object_key);
          } catch (err) {
            console.warn('[OFFLINE BILLS] Failed to generate presigned URL for', r.image_object_key, (err as Error).message);
          }
        }
        return {
          ...r,
          image_url: imageUrl,
        };
      })
    );
  }

  /**
   * Requests a presigned PUT upload intent for an offline bill image
   */
  public async getUploadIntent(options: {
    contentType: string;
    sizeBytes: number;
    originalFilename?: string;
  }) {
    const tempId = crypto.randomUUID();
    return storageService.getUploadIntent({
      folder: 'offline-bills',
      referenceId: tempId,
      contentType: options.contentType,
      sizeBytes: options.sizeBytes,
      originalFilename: options.originalFilename,
    });
  }

  /**
   * Creates an isolated offline bill record after verifying the uploaded R2 image.
   *
   * CRITICAL ISOLATION RULE:
   * This method NEVER touches customers, udhar_transactions, payments, or payment_allocations.
   * Customer name and phone are stored purely as document identification metadata.
   */
  public async createOfflineBill(data: {
    customerName: string;
    customerPhone: string;
    imageObjectKey: string;
    originalFilename?: string;
  }): Promise<OfflineBillRecord> {
    const trimmedName = data.customerName.trim();
    if (!trimmedName) {
      throw new AppError('Customer name is required for offline bill.', 400, 'VALIDATION_ERROR');
    }

    const trimmedPhone = data.customerPhone.trim();
    if (!trimmedPhone) {
      throw new AppError('Customer phone number is required for offline bill.', 400, 'VALIDATION_ERROR');
    }

    // Validate phone number format (uses existing Indian phone normalizer)
    const normalizedPhone = khataService.normalizeCustomerPhone(trimmedPhone);
    if (!normalizedPhone) {
      throw new AppError(
        'Please enter a valid 10-digit Indian mobile number for the offline bill.',
        400,
        'VALIDATION_ERROR'
      );
    }

    // Verify image in storage
    const verified = await storageService.verifyObject(data.imageObjectKey, 'offline-bills');

    const result = await appPool.query(
      `INSERT INTO offline_bill_records
        (customer_name, customer_phone, normalized_customer_phone, image_object_key, image_content_type, image_size_bytes, original_filename, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id, customer_name, customer_phone, normalized_customer_phone, image_object_key, image_content_type, image_size_bytes, original_filename, created_at, updated_at`,
      [
        trimmedName,
        trimmedPhone,
        normalizedPhone,
        data.imageObjectKey,
        verified.contentType,
        verified.contentLength,
        data.originalFilename || null,
      ]
    );

    const [createdWithUrl] = await this.attachPresignedUrls(result.rows);
    return createdWithUrl;
  }

  /**
   * Lists previous offline bills with optional customer search and bounded pagination
   */
  public async listOfflineBills(optionsOrSearch?: string | ListOfflineBillsOptions): Promise<PaginatedOfflineBillsResult> {
    const opts = typeof optionsOrSearch === 'string' ? { search: optionsOrSearch } : optionsOrSearch || {};
    const limit = Math.min(Math.max(1, opts.limit || 25), 50);
    const offset = Math.max(0, opts.offset || 0);

    let sql = `
      SELECT id, customer_name, customer_phone, normalized_customer_phone,
             image_object_key, image_content_type, image_size_bytes, original_filename,
             created_at, updated_at
      FROM offline_bill_records
    `;
    const params: unknown[] = [];

    if (opts.search && opts.search.trim()) {
      const cleanSearch = escapeLike(opts.search.trim());
      params.push(`%${cleanSearch}%`);
      sql += ` WHERE (customer_name ILIKE $${params.length} OR customer_phone ILIKE $${params.length} OR normalized_customer_phone ILIKE $${params.length})`;
    }

    sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit + 1, offset);

    const result = await appPool.query(sql, params);
    const hasMore = result.rows.length > limit;
    const rawBills = hasMore ? result.rows.slice(0, limit) : result.rows;

    const bills = await this.attachPresignedUrls(rawBills);

    return {
      bills,
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
    };
  }

  /**
   * Retrieves an offline bill by ID
   */
  public async getOfflineBillById(id: number): Promise<OfflineBillRecord | null> {
    const result = await appPool.query(
      `SELECT id, customer_name, customer_phone, normalized_customer_phone,
              image_object_key, image_content_type, image_size_bytes, original_filename,
              created_at, updated_at
       FROM offline_bill_records
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;
    const [billWithUrl] = await this.attachPresignedUrls(result.rows);
    return billWithUrl || null;
  }

  /**
   * Retrieves presigned URL for viewing or downloading an offline bill image
   */
  public async getOfflineBillImageUrl(
    id: number,
    download = false
  ): Promise<{ url: string; expiresIn: number; filename: string }> {
    const bill = await this.getOfflineBillById(id);
    if (!bill) {
      throw new AppError('Offline bill record not found.', 404, 'NOT_FOUND');
    }

    storageService.assertConfigured();

    const ext = bill.image_content_type === 'image/png' ? 'png' : bill.image_content_type === 'image/webp' ? 'webp' : 'jpg';
    const downloadFilename = `bill-${bill.customer_name.replace(/[^a-zA-Z0-9]/g, '_')}-${bill.id}.${ext}`;

    const url = download
      ? await storageService.getPresignedDownloadUrl(bill.image_object_key, downloadFilename)
      : await storageService.getPresignedViewUrl(bill.image_object_key);

    return {
      url,
      expiresIn: 300,
      filename: downloadFilename,
    };
  }

  /**
   * Deletes an offline bill record and cleans up its R2 object
   */
  public async deleteOfflineBill(id: number): Promise<boolean> {
    const bill = await this.getOfflineBillById(id);
    if (!bill) {
      throw new AppError('Offline bill record not found.', 404, 'NOT_FOUND');
    }

    const result = await appPool.query(
      `DELETE FROM offline_bill_records WHERE id = $1`,
      [id]
    );

    if ((result.rowCount ?? 0) > 0 && bill.image_object_key) {
      await storageService.deleteObject(bill.image_object_key);
      return true;
    }

    return false;
  }
}

export const offlineBillsService = new OfflineBillsService();
