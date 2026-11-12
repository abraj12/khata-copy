import type { PoolClient, Pool } from 'pg';
import { appPool } from '../config/database.js';
import { AppError } from '../utils/errors.js';
import { acquireObjectSessionLock, releaseObjectSessionLock } from './storageObjectLock.js';
import { storageCleanupService, CleanupObjectKind } from './storageCleanup.service.js';

export type UploadIntentKind =
  | 'product_image'
  | 'offline_bill'
  | 'supplier_bill'
  | 'quotation_logo'
  | 'gst_invoice'
  | 'normal_bill'
  | 'other';

export type StorageUploadIntentStatus =
  | 'issued'
  | 'uploaded'
  | 'attached'
  | 'cleanup_pending'
  | 'cleaned'
  | 'failed';

export interface StorageUploadIntentRecord {
  id: string;
  object_key: string;
  object_kind: string;
  folder: string;
  reference_type: string;
  reference_id: string;
  expected_content_type: string | null;
  expected_size_bytes: string | number | null;
  status: StorageUploadIntentStatus;
  upload_mode: 'presigned' | 'server';
  expires_at: Date;
  attached_at: Date | null;
  cleaned_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUploadIntentInput {
  objectKey: string;
  objectKind: UploadIntentKind | string;
  folder?: string;
  referenceType: string;
  referenceId: string | number;
  expectedContentType?: string | null;
  expectedSizeBytes?: number | null;
  uploadMode?: 'presigned' | 'server';
  expiresInSeconds?: number;
  expiresAt?: Date;
}

export class StorageUploadIntentService {
  /**
   * Derives default folder from object kind if not explicitly passed.
   */
  private deriveFolder(kind: string, key: string): string {
    const prefix = key.split('/')[0];
    if (prefix) return prefix;
    if (kind === 'product_image') return 'products';
    if (kind === 'offline_bill') return 'offline-bills';
    if (kind === 'supplier_bill') return 'supplier-bills';
    if (kind === 'gst_invoice') return 'invoices';
    if (kind === 'normal_bill') return 'bills';
    if (kind === 'quotation_logo') return 'quotations';
    return 'misc';
  }

  /**
   * Registers a presigned or server upload intent in PostgreSQL before returning URL or uploading.
   */
  public async registerIntent(
    input: CreateUploadIntentInput,
    db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = appPool
  ): Promise<StorageUploadIntentRecord> {
    const expiresIn = Math.max(60, Math.min(3600, input.expiresInSeconds ?? 300));
    const refId = String(input.referenceId);
    const folder = input.folder || this.deriveFolder(input.objectKind, input.objectKey);
    const uploadMode = input.uploadMode || 'presigned';

    const res = await db.query(
      `INSERT INTO storage_upload_intents (
         object_key,
         object_kind,
         folder,
         reference_type,
         reference_id,
         expected_content_type,
         expected_size_bytes,
         status,
         upload_mode,
         expires_at,
         created_at,
         updated_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         'issued',
         $8,
         $9,
         NOW(),
         NOW()
       )
       ON CONFLICT (object_key)
       DO UPDATE SET
         status = 'issued',
         reference_type = EXCLUDED.reference_type,
         reference_id = EXCLUDED.reference_id,
         expected_content_type = EXCLUDED.expected_content_type,
         expected_size_bytes = EXCLUDED.expected_size_bytes,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()
       RETURNING *`,
      [
        input.objectKey,
        input.objectKind,
        folder,
        input.referenceType,
        refId,
        input.expectedContentType || 'application/octet-stream',
        input.expectedSizeBytes ? Math.trunc(input.expectedSizeBytes) : null,
        uploadMode,
        input.expiresAt || new Date(Date.now() + expiresIn * 1000),
      ]
    );

    return res.rows[0];
  }

  /**
   * Creates upload intent within an existing transaction.
   */
  public async createInTransaction(
    client: PoolClient,
    input: CreateUploadIntentInput
  ): Promise<StorageUploadIntentRecord> {
    return this.registerIntent(input, client);
  }

  /**
   * Marks intent as uploaded (e.g. after direct presigned upload completes).
   */
  public async markUploadedInTransaction(
    client: PoolClient,
    objectKey: string
  ): Promise<void> {
    await client.query(
      `UPDATE storage_upload_intents
       SET status = 'uploaded',
           updated_at = NOW()
       WHERE object_key = $1
         AND status = 'issued'`,
      [objectKey]
    );
  }

  /**
   * Marks intent as attached within transaction.
   */
  public async markAttachedInTransaction(
    client: PoolClient,
    objectKey: string,
    referenceType?: string,
    referenceId?: string | number
  ): Promise<void> {
    await client.query(
      `UPDATE storage_upload_intents
       SET status = 'attached',
           attached_at = NOW(),
           reference_type = COALESCE($2, reference_type),
           reference_id = COALESCE($3, reference_id),
           updated_at = NOW()
       WHERE object_key = $1`,
      [
        objectKey,
        referenceType || null,
        referenceId != null ? String(referenceId) : null,
      ]
    );
  }

  /**
   * Marks intent as cleanup_pending within transaction.
   */
  public async markCleanupPendingInTransaction(
    client: PoolClient,
    objectKey: string,
    error?: string
  ): Promise<void> {
    await client.query(
      `UPDATE storage_upload_intents
       SET status = 'cleanup_pending',
           last_error = COALESCE($2, last_error),
           updated_at = NOW()
       WHERE object_key = $1`,
      [objectKey, error || null]
    );
  }

  /**
   * Locks the upload intent row FOR UPDATE inside a transaction and validates it.
   */
  public async lockAndValidateIntent(
    client: PoolClient,
    options: {
      objectKey: string;
      expectedReferenceType?: string;
      expectedReferenceId?: string | number;
    }
  ): Promise<StorageUploadIntentRecord | null> {
    const res = await client.query(
      `SELECT *
       FROM storage_upload_intents
       WHERE object_key = $1
       FOR UPDATE`,
      [options.objectKey]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const intent = res.rows[0] as StorageUploadIntentRecord;

    // Both 'attached' and legacy 'completed' represent an attached upload
    if (intent.status === 'attached' || (intent.status as string) === 'completed') {
      return intent;
    }

    if (intent.status !== 'issued' && intent.status !== 'uploaded') {
      throw new AppError(
        `Upload intent for object is in invalid status: ${intent.status}`,
        400,
        'INVALID_UPLOAD_INTENT'
      );
    }

    const expiresAtMs = new Date(intent.expires_at).getTime();
    if (Date.now() > expiresAtMs) {
      await client.query(
        `UPDATE storage_upload_intents
         SET status = 'cleanup_pending',
             last_error = 'Upload intent expired',
             updated_at = NOW()
         WHERE id = $1`,
        [intent.id]
      );
      throw new AppError(
        'Upload intent has expired. Please request a new upload URL.',
        400,
        'UPLOAD_INTENT_EXPIRED'
      );
    }

    if (
      options.expectedReferenceType &&
      intent.reference_type !== options.expectedReferenceType
    ) {
      throw new AppError(
        `Upload intent reference type mismatch: expected ${options.expectedReferenceType}, found ${intent.reference_type}`,
        400,
        'UPLOAD_INTENT_MISMATCH'
      );
    }

    if (
      options.expectedReferenceId !== undefined &&
      intent.reference_id !== String(options.expectedReferenceId)
    ) {
      throw new AppError(
        `Upload intent reference ID mismatch: expected ${options.expectedReferenceId}, found ${intent.reference_id}`,
        400,
        'UPLOAD_INTENT_MISMATCH'
      );
    }

    return intent;
  }

  /**
   * Atomically marks the upload intent as attached/completed inside the same business transaction.
   */
  public async completeIntentInTransaction(
    client: PoolClient,
    objectKey: string
  ): Promise<boolean> {
    const res = await client.query(
      `UPDATE storage_upload_intents
       SET status = 'attached',
           attached_at = NOW(),
           updated_at = NOW()
       WHERE object_key = $1
         AND status IN ('issued', 'uploaded')
       RETURNING id`,
      [objectKey]
    );

    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Returns active, unexpired upload intent if present.
   */
  public async getActiveIntent(
    objectKey: string,
    db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = appPool
  ): Promise<StorageUploadIntentRecord | null> {
    const res = await db.query(
      `SELECT *
       FROM storage_upload_intents
       WHERE object_key = $1
         AND status IN ('issued', 'uploaded')
         AND expires_at > NOW()`,
      [objectKey]
    );
    return res.rows[0] || null;
  }

  /**
   * Reconciles expired upload intents after a safe grace period (Section 18).
   * Identifies unattached expired intents, confirms no database references exist,
   * transitions status to cleanup_pending, and enqueues a cleanup job inside a transaction.
   */
  public async reconcileExpiredIntents(limit = 50): Promise<number> {
    const client = await appPool.connect();
    let reconciledCount = 0;

    try {
      // Find candidate expired intents past 5-minute signed URL grace period
      const candidatesRes = await client.query(
        `SELECT id, object_key, object_kind
         FROM storage_upload_intents
         WHERE status IN ('issued', 'uploaded')
           AND expires_at < NOW() - INTERVAL '5 minutes'
         ORDER BY expires_at ASC
         LIMIT $1`,
        [limit]
      );

      for (const row of candidatesRes.rows) {
        let lockAcquired = false;
        try {
          lockAcquired = await acquireObjectSessionLock(client, row.object_key);
          await client.query('BEGIN');

          // Verify row is still expired and unattached
          const intentCheck = await client.query(
            `SELECT * FROM storage_upload_intents
             WHERE id = $1 AND status IN ('issued', 'uploaded')
             FOR UPDATE`,
            [row.id]
          );

          if (intentCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            continue;
          }

          // Check live database references
          const refs = await storageCleanupService.findLiveObjectReferences(row.object_key, client);
          if (refs.length > 0) {
            // Object is attached in database; update intent to attached
            await client.query(
              `UPDATE storage_upload_intents
               SET status = 'attached', attached_at = NOW(), updated_at = NOW()
               WHERE id = $1`,
              [row.id]
            );
            await client.query('COMMIT');
            continue;
          }

          // Transition to cleanup_pending
          await client.query(
            `UPDATE storage_upload_intents
             SET status = 'cleanup_pending',
                 last_error = 'Reconciled expired unattached upload',
                 updated_at = NOW()
             WHERE id = $1`,
            [row.id]
          );

          // Enqueue cleanup job atomically with pg_notify
          const objectKind: CleanupObjectKind =
            row.object_kind === 'supplier_bill'
              ? 'supplier_bill'
              : row.object_kind === 'offline_bill'
                ? 'offline_bill'
                : 'product_image';

          await storageCleanupService.enqueueCleanupJobInTransaction(client, {
            objectKey: row.object_key,
            objectKind,
            reason: 'expired_upload_intent_reconciliation',
          });

          await client.query('COMMIT');
          reconciledCount++;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.warn('[STORAGE INTENT] Failed to reconcile expired intent:', {
            objectKey: row.object_key,
            message: (err as Error).message,
          });
        } finally {
          if (lockAcquired) {
            await releaseObjectSessionLock(client, row.object_key).catch(() => {});
          }
        }
      }
    } finally {
      client.release();
    }

    return reconciledCount;
  }
}

export const storageUploadIntentService = new StorageUploadIntentService();
