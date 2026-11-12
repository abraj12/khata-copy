import { Pool, PoolClient } from 'pg';
import { appPool } from '../config/database.js';
import { setRejectedUploadCleanupHook, storageService } from './storage.service.js';

export type CleanupObjectKind =
  | 'product_image'
  | 'offline_bill'
  | 'supplier_bill'
  | 'gst_invoice'
  | 'normal_bill'
  | 'quotation_logo'
  | 'other';

export interface EnqueueCleanupJobInput {
  objectKey: string;
  objectKind: CleanupObjectKind;
  reason: string;
  lastError?: string | null;
  maxAttempts?: number;
  initialDelayMs?: number;
}

export interface AttemptCleanupInput {
  objectKey: string | null | undefined;
  objectKind: CleanupObjectKind;
  reason: string;
  isRollbackNewUpload?: boolean;
  initialRetryDelayMs?: number;
}

export interface AttemptCleanupResult {
  outcome: 'noop' | 'deleted' | 'queued' | 'skipped_referenced' | 'enqueue_failed';
  jobId?: number | null;
  referencedIn?: string[];
}

export type StorageCleanupListener = (delayMs?: number) => void;

const cleanupListeners = new Set<StorageCleanupListener>();

export function registerStorageCleanupListener(listener: StorageCleanupListener): () => void {
  cleanupListeners.add(listener);
  return () => {
    cleanupListeners.delete(listener);
  };
}

export function notifyStorageCleanupQueued(delayMs = 0): void {
  for (const listener of cleanupListeners) {
    try {
      listener(delayMs);
    } catch {
      // Listener errors must never affect cleanup callers or rollback paths
    }
  }
}

/**
 * Redacts full object keys / signed URLs for logs without exposing sensitive tokens or paths.
 */
export function redactObjectKeyForLog(objectKey: string | null | undefined): string {
  if (!objectKey) return '<empty>';
  const noQuery = String(objectKey).split('?')[0];
  const segments = noQuery.split('/').filter(Boolean);
  if (segments.length <= 1) {
    const token = segments[0] || '';
    return token.length > 8 ? `${token.slice(0, 4)}...${token.slice(-4)}` : token;
  }
  const tail = segments[segments.length - 1];
  const redactedTail = tail.length > 10 ? `${tail.slice(0, 4)}...${tail.slice(-4)}` : tail;
  return `${segments[0]}/${redactedTail}`;
}

/**
 * Sanitizes S3/R2 or DB error strings so signed query parameters, credentials, or
 * raw object URLs are never persisted in storage_cleanup_jobs.last_error or logs.
 */
export function sanitizeStorageErrorMessage(err: unknown): string {
  const raw =
    typeof err === 'string'
      ? err
      : (err as { message?: string })?.message || String(err || 'Storage cleanup error');

  const stripped = raw
    .replace(/https?:\/\/[^\s?]+\?[^\s]+/gi, '[redacted-signed-url]')
    .replace(/(X-Amz-[A-Za-z0-9-]+|Signature|Credential|AccessKeyId|SecretKey|password|token)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .trim();

  return (stripped || 'Storage cleanup error').slice(0, 500);
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export class StorageCleanupService {
  /**
   * Verifies across all R2-backed tables that objectKey is not referenced by any live DB record
   * before deleting it from object storage.
   */
  public async findLiveObjectReferences(
    objectKey: string,
    db: Queryable = appPool
  ): Promise<string[]> {
    if (!objectKey || !objectKey.trim()) {
      return [];
    }

    const res = await db.query(
      `SELECT
         EXISTS (SELECT 1 FROM products WHERE image_object_key = $1) AS in_products,
         EXISTS (SELECT 1 FROM offline_bill_records WHERE image_object_key = $1) AS in_offline_bills,
         EXISTS (SELECT 1 FROM supplier_purchase_bills WHERE attachment_object_key = $1) AS in_supplier_bills,
         EXISTS (SELECT 1 FROM gst_invoices WHERE r2_object_key = $1) AS in_gst_invoices,
         EXISTS (SELECT 1 FROM normal_bills WHERE r2_object_key = $1) AS in_normal_bills,
         EXISTS (
           SELECT 1
           FROM quotation_settings
           WHERE logo_url = $1
              OR RIGHT(SPLIT_PART(logo_url, '?', 1), LENGTH($1) + 1) = '/' || $1
         ) AS in_quotation_settings`,
      [objectKey]
    );

    const row = res.rows?.[0] || {};
    const refs: string[] = [];
    if (row.in_products) refs.push('products');
    if (row.in_offline_bills) refs.push('offline_bill_records');
    if (row.in_supplier_bills) refs.push('supplier_purchase_bills');
    if (row.in_gst_invoices) refs.push('gst_invoices');
    if (row.in_normal_bills) refs.push('normal_bills');
    if (row.in_quotation_settings) refs.push('quotation_settings');
    return refs;
  }

  /**
   * Idempotently enqueues or updates an active cleanup retry job in PostgreSQL.
   * Only enforces uniqueness across active statuses ('pending', 'processing', 'failed')
   * so completed/dead-letter history does not block future cleanup of a re-used key.
   */
  public async enqueueCleanupJob(
    input: EnqueueCleanupJobInput,
    db: Queryable = appPool
  ): Promise<number | null> {
    const trimmedKey = input.objectKey?.trim();
    if (!trimmedKey) return null;

    const maxAttempts = Math.max(1, Math.min(50, Math.floor(input.maxAttempts ?? 10)));
    const delayMs = Math.max(0, Math.floor(input.initialDelayMs ?? 2000));
    const safeError = input.lastError ? sanitizeStorageErrorMessage(input.lastError) : null;

    const res = await db.query(
      `INSERT INTO storage_cleanup_jobs (
         object_key,
         object_kind,
         reason,
         status,
         attempt_count,
         max_attempts,
         next_attempt_at,
         last_error,
         created_at,
         updated_at
       )
       VALUES (
         $1,
         $2,
         $3,
         'pending',
         0,
         $4,
         NOW() + ($5::bigint * INTERVAL '1 millisecond'),
         $6,
         NOW(),
         NOW()
       )
       ON CONFLICT (object_key)
         WHERE status IN ('pending', 'processing', 'failed')
       DO UPDATE SET
         reason = EXCLUDED.reason,
         last_error = COALESCE(EXCLUDED.last_error, storage_cleanup_jobs.last_error),
         updated_at = NOW()
       RETURNING id`,
      [trimmedKey, input.objectKind, input.reason, maxAttempts, delayMs, safeError]
    );

    const jobId = res.rows?.[0]?.id != null ? Number(res.rows[0].id) : null;
    notifyStorageCleanupQueued(delayMs);
    return jobId;
  }

  /**
   * Attempts immediate safe R2 deletion after confirming no live DB record references the object.
   * If R2 deletion fails, persists a durable retry job in storage_cleanup_jobs without throwing or
   * masking any caller transaction error.
   */
  public async attemptDeleteOrEnqueue(input: AttemptCleanupInput): Promise<AttemptCleanupResult> {
    const objectKey = input.objectKey?.trim();
    if (!objectKey) {
      return { outcome: 'noop' };
    }

    let references: string[] = [];
    try {
      references = await this.findLiveObjectReferences(objectKey);
    } catch (refCheckErr) {
      if (!input.isRollbackNewUpload) {
        const safeRefErr = sanitizeStorageErrorMessage(refCheckErr);
        console.warn('[STORAGE CLEANUP] Reference verification failed; deferring to durable cleanup job:', {
          object: redactObjectKeyForLog(objectKey),
          objectKind: input.objectKind,
          reason: input.reason,
          message: safeRefErr,
        });
        try {
          const jobId = await this.enqueueCleanupJob({
            objectKey,
            objectKind: input.objectKind,
            reason: input.reason,
            lastError: safeRefErr,
            initialDelayMs: input.initialRetryDelayMs ?? 2000,
          });
          return { outcome: 'queued', jobId };
        } catch (enqueueErr) {
          console.error('[STORAGE CLEANUP] Failed to persist deferred cleanup job after reference check error:', {
            object: redactObjectKeyForLog(objectKey),
            objectKind: input.objectKind,
            reason: input.reason,
            message: sanitizeStorageErrorMessage(enqueueErr),
          });
          return { outcome: 'enqueue_failed' };
        }
      }
      // For rolled-back freshly generated uploads where DB itself may be degraded,
      // proceed to attempt direct R2 orphan deletion immediately.
    }

    if (references.length > 0) {
      console.info('[STORAGE CLEANUP] Skipping R2 delete because object key is still referenced in database:', {
        object: redactObjectKeyForLog(objectKey),
        objectKind: input.objectKind,
        reason: input.reason,
        referencedIn: references,
      });
      return { outcome: 'skipped_referenced', referencedIn: references };
    }

    try {
      await storageService.deleteObject(objectKey);
      return { outcome: 'deleted' };
    } catch (deleteErr) {
      const safeError = sanitizeStorageErrorMessage(deleteErr);
      console.warn('[STORAGE CLEANUP] Immediate R2 delete failed; enqueueing durable retry:', {
        object: redactObjectKeyForLog(objectKey),
        objectKind: input.objectKind,
        reason: input.reason,
        message: safeError,
      });

      try {
        const jobId = await this.enqueueCleanupJob({
          objectKey,
          objectKind: input.objectKind,
          reason: input.reason,
          lastError: safeError,
          initialDelayMs: input.initialRetryDelayMs ?? 2000,
        });
        return { outcome: 'queued', jobId };
      } catch (enqueueErr) {
        console.error('[STORAGE CLEANUP] Failed to persist durable R2 cleanup job:', {
          object: redactObjectKeyForLog(objectKey),
          objectKind: input.objectKind,
          reason: input.reason,
          deleteError: safeError,
          enqueueError: sanitizeStorageErrorMessage(enqueueErr),
        });
        return { outcome: 'enqueue_failed' };
      }
    }
  }
}

export const storageCleanupService = new StorageCleanupService();

setRejectedUploadCleanupHook(async (objectKey, folder, reason, deleteError) => {
  const objectKind: CleanupObjectKind =
    folder === 'supplier-bills'
      ? 'supplier_bill'
      : folder === 'offline-bills'
        ? 'offline_bill'
        : 'product_image';
  const refs = await storageCleanupService.findLiveObjectReferences(objectKey).catch(() => []);
  if (refs.length > 0) {
    return;
  }
  await storageCleanupService.enqueueCleanupJob({
    objectKey,
    objectKind,
    reason: `upload_rejected:${reason}`,
    lastError: sanitizeStorageErrorMessage(deleteError),
  });
});
