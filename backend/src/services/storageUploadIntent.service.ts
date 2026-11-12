import type { PoolClient, Pool } from 'pg';
import { appPool } from '../config/database.js';
import { AppError } from '../utils/errors.js';

export type UploadIntentKind =
  | 'product_image'
  | 'offline_bill'
  | 'supplier_bill'
  | 'quotation_logo'
  | 'gst_invoice'
  | 'normal_bill'
  | 'other';

export interface StorageUploadIntentRecord {
  id: string;
  object_key: string;
  object_kind: string;
  reference_type: string;
  reference_id: string;
  expected_content_type: string | null;
  expected_size_bytes: string | number | null;
  status: 'issued' | 'completed' | 'expired' | 'failed';
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUploadIntentInput {
  objectKey: string;
  objectKind: UploadIntentKind;
  referenceType: string;
  referenceId: string | number;
  expectedContentType?: string | null;
  expectedSizeBytes?: number | null;
  expiresInSeconds?: number;
}

export class StorageUploadIntentService {
  /**
   * Registers a presigned upload intent in PostgreSQL before the signed URL is returned to the client.
   */
  public async registerIntent(
    input: CreateUploadIntentInput,
    db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = appPool
  ): Promise<StorageUploadIntentRecord> {
    const expiresIn = Math.max(60, Math.min(3600, input.expiresInSeconds ?? 300));
    const refId = String(input.referenceId);

    const res = await db.query(
      `INSERT INTO storage_upload_intents (
         object_key,
         object_kind,
         reference_type,
         reference_id,
         expected_content_type,
         expected_size_bytes,
         status,
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
         'issued',
         NOW() + ($7::int * INTERVAL '1 second'),
         NOW(),
         NOW()
       )
       RETURNING *`,
      [
        input.objectKey,
        input.objectKind,
        input.referenceType,
        refId,
        input.expectedContentType || null,
        input.expectedSizeBytes ? Math.trunc(input.expectedSizeBytes) : null,
        expiresIn,
      ]
    );

    return res.rows[0];
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

    if (intent.status === 'completed') {
      // Replayed completion or already completed
      return intent;
    }

    if (intent.status !== 'issued') {
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
         SET status = 'expired', updated_at = NOW()
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
   * Atomically marks the upload intent as completed inside the same business transaction.
   */
  public async completeIntentInTransaction(
    client: PoolClient,
    objectKey: string
  ): Promise<boolean> {
    const res = await client.query(
      `UPDATE storage_upload_intents
       SET status = 'completed',
           completed_at = NOW(),
           updated_at = NOW()
       WHERE object_key = $1
         AND status = 'issued'
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
         AND status = 'issued'
         AND expires_at > NOW()`,
      [objectKey]
    );
    return res.rows[0] || null;
  }
}

export const storageUploadIntentService = new StorageUploadIntentService();
