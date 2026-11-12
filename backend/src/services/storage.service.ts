import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { env, isR2Configured } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { storageUploadIntentService, UploadIntentKind } from './storageUploadIntent.service.js';

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const ALLOWED_SUPPLIER_DOC_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_OFFLINE_BILL_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_SUPPLIER_DOC_BYTES = 10 * 1024 * 1024; // 10 MB

export type StorageFolder = 'products' | 'offline-bills' | 'supplier-bills';

export type RejectedUploadCleanupHook = (
  objectKey: string,
  folder: StorageFolder,
  reason: string,
  deleteError: unknown
) => Promise<void>;

let rejectedUploadCleanupHook: RejectedUploadCleanupHook | null = null;

export function setRejectedUploadCleanupHook(hook: RejectedUploadCleanupHook | null): void {
  rejectedUploadCleanupHook = hook;
}

export function isNoSuchKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    record.name === 'NoSuchKey' ||
    record.Code === 'NoSuchKey' ||
    record.code === 'NoSuchKey' ||
    record.$metadata?.httpStatusCode === 404
  );
}

export const MAX_BYTES_BY_FOLDER: Record<StorageFolder, number> = {
  products: MAX_PRODUCT_IMAGE_BYTES,
  'offline-bills': MAX_OFFLINE_BILL_BYTES,
  'supplier-bills': MAX_SUPPLIER_DOC_BYTES,
};

function sanitizeReferenceSegment(referenceId: string | number): string {
  const clean = String(referenceId).trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(clean)) {
    throw new AppError('Invalid storage reference identifier.', 400, 'INVALID_REFERENCE_ID');
  }
  return clean;
}

function assertSafeScopedObjectKey(
  objectKey: string,
  expectedFolder: StorageFolder,
  expectedReferenceId?: string | number
): void {
  if (
    !objectKey ||
    objectKey !== objectKey.trim() ||
    objectKey.includes('..') ||
    objectKey.includes('\\') ||
    objectKey.includes('//') ||
    objectKey.includes('?') ||
    objectKey.includes('#')
  ) {
    throw new AppError('Invalid object key path for requested operation.', 400, 'INVALID_OBJECT_KEY');
  }

  const expectedPrefix =
    expectedReferenceId !== undefined
      ? `${expectedFolder}/${String(expectedReferenceId).trim()}/`
      : `${expectedFolder}/`;

  if (!objectKey.startsWith(expectedPrefix)) {
    throw new AppError('Invalid object key path for requested operation.', 400, 'INVALID_OBJECT_KEY');
  }

  const segments = objectKey.split('/');
  const validSegment = /^[a-zA-Z0-9._-]+$/;
  if (
    segments.some((seg) => !seg || seg === '.' || seg === '..' || !validSegment.test(seg)) ||
    (expectedReferenceId !== undefined && segments.length !== 3) ||
    (expectedReferenceId === undefined && (segments.length < 2 || segments.length > 3))
  ) {
    throw new AppError('Invalid object key path for requested operation.', 400, 'INVALID_OBJECT_KEY');
  }
}

export interface UploadIntentOptions {
  folder: StorageFolder;
  referenceId: string | number;
  contentType: string;
  sizeBytes: number;
  originalFilename?: string;
}

export interface UploadIntentResult {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
  headers: Record<string, string>;
}

export interface VerifiedObjectResult {
  contentLength: number;
  contentType: string;
}

/**
 * Validates image magic bytes (file signature) to prevent content-type spoofing
 */
export function validateImageMagicBytes(buffer: Uint8Array, declaredType: string): boolean {
  if (!buffer || buffer.length < 4) return false;

  // PDF: %PDF-
  if (declaredType === 'application/pdf') {
    return (
      buffer.length >= 5 &&
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46 &&
      buffer[4] === 0x2d
    );
  }

  // JPEG: FF D8 FF
  if (declaredType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (declaredType === 'image/png') {
    return (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }

  // WebP: RIFF .... WEBP
  if (declaredType === 'image/webp') {
    if (buffer.length < 12) return false;
    const isRiff = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;
    const isWebp = buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
    return isRiff && isWebp;
  }

  return false;
}

export class StorageService {
  private s3Client: S3Client | null = null;

  constructor() {
    this.initClient();
  }

  private initClient() {
    if (isR2Configured(env)) {
      let endpoint = env.R2_ENDPOINT;
      if (endpoint) {
        endpoint = endpoint.trim().replace(/\/+$/, '');
        if (env.R2_BUCKET_NAME && endpoint.endsWith(`/${env.R2_BUCKET_NAME}`)) {
          endpoint = endpoint.slice(0, -(env.R2_BUCKET_NAME.length + 1));
        }
      } else if (env.R2_ACCOUNT_ID) {
        endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
      }

      this.s3Client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID!,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        forcePathStyle: true,
      });
    }
  }

  /**
   * For testing: inject custom or mocked S3 client
   */
  public setClient(client: S3Client | null) {
    this.s3Client = client;
  }

  public getClient(): S3Client | null {
    return this.s3Client;
  }

  public isConfigured(): boolean {
    return Boolean(this.s3Client && env.R2_BUCKET_NAME);
  }

  public assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new AppError(
        'Cloudflare R2 object storage is not configured on the server. Please configure R2 environment variables.',
        503,
        'STORAGE_NOT_CONFIGURED'
      );
    }
  }

  /**
   * Generates a presigned PUT URL for direct client-to-R2 upload
   */
  public async getUploadIntent(options: UploadIntentOptions): Promise<UploadIntentResult> {
    this.assertConfigured();

    const { folder, referenceId, contentType, sizeBytes } = options;

    // Validate Content-Type
    const cleanContentType = contentType.toLowerCase().trim();
    const allowedSet = folder === 'supplier-bills' ? ALLOWED_SUPPLIER_DOC_TYPES : ALLOWED_IMAGE_TYPES;
    if (!allowedSet.has(cleanContentType)) {
      const msg =
        folder === 'supplier-bills'
          ? `Unsupported file type "${contentType}". Only JPEG, PNG, WebP, and PDF are permitted.`
          : `Unsupported image type "${contentType}". Only JPEG, PNG, and WebP are permitted.`;
      throw new AppError(msg, 400, 'INVALID_CONTENT_TYPE');
    }

    const safeReferenceId = sanitizeReferenceSegment(referenceId);

    // Validate size limit strictly against per-folder authoritative map
    const maxBytes = MAX_BYTES_BY_FOLDER[folder];
    const maxMb = maxBytes / (1024 * 1024);

    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new AppError('File size must be greater than zero bytes.', 400, 'INVALID_FILE_SIZE');
    }
    if (sizeBytes > maxBytes) {
      const sizeLabel = folder === 'supplier-bills' ? 'File' : 'Image';
      throw new AppError(
        `${sizeLabel} size exceeds maximum allowed limit of ${maxMb}MB.`,
        400,
        'FILE_TOO_LARGE'
      );
    }

    // Determine extension
    let ext = 'jpg';
    if (cleanContentType === 'image/png') ext = 'png';
    else if (cleanContentType === 'image/webp') ext = 'webp';
    else if (cleanContentType === 'application/pdf') ext = 'pdf';

    // Server-controlled random object key to prevent directory traversal
    const randomId = crypto.randomUUID();
    const objectKey = `${folder}/${safeReferenceId}/${randomId}.${ext}`;

    const kindMap: Record<string, UploadIntentKind> = {
      products: 'product_image',
      'offline-bills': 'offline_bill',
      'supplier-bills': 'supplier_bill',
    };

    try {
      await storageUploadIntentService.registerIntent({
        objectKey,
        objectKind: kindMap[folder] || 'other',
        referenceType: folder,
        referenceId: safeReferenceId,
        expectedContentType: cleanContentType,
        expectedSizeBytes: Math.trunc(sizeBytes),
        expiresInSeconds: 300,
      });
    } catch (intentErr) {
      if (env.NODE_ENV !== 'test') {
        throw intentErr;
      }
    }

    const command = new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME!,
      Key: objectKey,
      ContentType: cleanContentType,
      ContentLength: Math.trunc(sizeBytes),
    });

    const expiresIn = 300; // 5 minutes
    const uploadUrl = await getSignedUrl(this.s3Client!, command, { expiresIn });

    return {
      uploadUrl,
      objectKey,
      expiresIn,
      headers: {
        'Content-Type': cleanContentType,
      },
    };
  }

  /**
   * Verifies an uploaded object exists in R2, verifies size and magic bytes
   */
  public async verifyObject(
    objectKey: string,
    expectedFolder: StorageFolder,
    expectedReferenceId?: string | number
  ): Promise<VerifiedObjectResult> {
    this.assertConfigured();

    // Guard against directory traversal, cross-entity key reuse, or spoofed key BEFORE any S3 access or delete
    assertSafeScopedObjectKey(objectKey, expectedFolder, expectedReferenceId);

    try {
      // 1. HeadObject: verify object existence and metadata
      const head = await this.s3Client!.send(
        new HeadObjectCommand({
          Bucket: env.R2_BUCKET_NAME!,
          Key: objectKey,
        })
      );

      const contentLength = head.ContentLength || 0;
      const contentType = (head.ContentType || '').toLowerCase().trim();

      const maxBytes = MAX_BYTES_BY_FOLDER[expectedFolder];
      if (contentLength <= 0 || contentLength > maxBytes) {
        await this.cleanupRejectedUpload(objectKey, expectedFolder, 'invalid_object_size');
        throw new AppError(
          `Uploaded object size (${contentLength} bytes) is outside permitted limits.`,
          400,
          'INVALID_OBJECT_SIZE'
        );
      }

      const allowedSet = expectedFolder === 'supplier-bills' ? ALLOWED_SUPPLIER_DOC_TYPES : ALLOWED_IMAGE_TYPES;
      if (!allowedSet.has(contentType)) {
        await this.cleanupRejectedUpload(objectKey, expectedFolder, 'invalid_content_type');
        throw new AppError(
          `Uploaded object Content-Type "${contentType}" is not an accepted file format.`,
          400,
          'INVALID_CONTENT_TYPE'
        );
      }

      const extMatch = objectKey.toLowerCase().match(/\.([a-z0-9]+)$/);
      if (extMatch) {
        const ext = extMatch[1];
        const expectedMimeByExt: Record<string, string> = {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          webp: 'image/webp',
          pdf: 'application/pdf',
        };
        const expectedMime = expectedMimeByExt[ext];
        if (expectedMime && expectedMime !== contentType) {
          await this.cleanupRejectedUpload(objectKey, expectedFolder, 'invalid_mime_extension_mismatch');
          throw new AppError(
            `Uploaded object extension ".${ext}" does not match Content-Type "${contentType}".`,
            400,
            'INVALID_CONTENT_TYPE'
          );
        }
      }

      // 2. Read first 16 bytes to verify magic bytes / file signature (fail-closed)
      const getRange = await this.s3Client!.send(
        new GetObjectCommand({
          Bucket: env.R2_BUCKET_NAME!,
          Key: objectKey,
          Range: 'bytes=0-15',
        })
      );

      if (!getRange.Body) {
        await this.cleanupRejectedUpload(objectKey, expectedFolder, 'empty_object_body');
        throw new AppError(
          expectedFolder === 'supplier-bills'
            ? 'Unable to inspect uploaded file contents from storage.'
            : 'Unable to inspect uploaded image contents from storage.',
          502,
          'STORAGE_VERIFICATION_FAILED'
        );
      }

      const chunk = await getRange.Body.transformToByteArray();
      const validSignature = validateImageMagicBytes(chunk, contentType);
      if (!validSignature) {
        await this.cleanupRejectedUpload(objectKey, expectedFolder, 'invalid_magic_bytes');
        const message =
          contentType === 'application/pdf' || expectedFolder === 'supplier-bills'
            ? 'Uploaded file contents do not match a valid JPEG, PNG, WebP, or PDF signature.'
            : 'Uploaded file contents do not match a valid JPEG, PNG, or WebP image signature.';
        throw new AppError(message, 400, 'INVALID_IMAGE_SIGNATURE');
      }

      return {
        contentLength,
        contentType,
      };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      const errorName = (err as Error)?.name || '';
      if (errorName === 'NotFound' || errorName === 'NoSuchKey') {
        throw new AppError('Uploaded image not found in storage.', 404, 'OBJECT_NOT_FOUND');
      }
      throw new AppError(
        `Storage service verification failed: ${(err as Error).message}`,
        502,
        'STORAGE_ERROR'
      );
    }
  }

  /**
   * Directly streams an object from R2 storage.
   * Used by server proxy routes to serve images directly to clients without CORS or domain issues.
   */
  public async getObjectStream(objectKey: string): Promise<{
    stream: NodeJS.ReadableStream;
    contentType: string;
    contentLength?: number;
  }> {
    this.assertConfigured();

    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME!,
      Key: objectKey,
    });

    const response = await this.s3Client!.send(command);
    if (!response.Body) {
      throw new AppError('Object body is empty or not found in storage.', 404, 'NOT_FOUND');
    }

    return {
      stream: response.Body as unknown as NodeJS.ReadableStream,
      contentType: response.ContentType || 'image/jpeg',
      contentLength: response.ContentLength,
    };
  }

  /**
   * Generates a temporary presigned GET URL for viewing an image in browser/TWA
   */
  public async getPresignedViewUrl(objectKey: string, expiresInSeconds = 300): Promise<string> {
    this.assertConfigured();

    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME!,
      Key: objectKey,
    });

    return getSignedUrl(this.s3Client!, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Generates a temporary presigned GET URL with Content-Disposition: attachment for downloading
   */
  public async getPresignedDownloadUrl(
    objectKey: string,
    downloadFilename: string,
    expiresInSeconds = 300
  ): Promise<string> {
    this.assertConfigured();

    // Sanitize filename for HTTP header
    const sanitizedName = downloadFilename.replace(/[^a-zA-Z0-9._-]/g, '_');

    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME!,
      Key: objectKey,
      ResponseContentDisposition: `attachment; filename="${sanitizedName}"`,
    });

    return getSignedUrl(this.s3Client!, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Uploads an in-memory buffer directly to R2 (server-side proxy upload).
   * This eliminates all browser CORS issues by having the backend act as the upload intermediary.
   */
  public async uploadBufferToR2(options: {
    buffer: Buffer;
    objectKey: string;
    contentType: string;
  }): Promise<void> {
    this.assertConfigured();
    const prefix = options.objectKey.split('/')[0] as StorageFolder;
    const folderLimit = MAX_BYTES_BY_FOLDER[prefix] ?? 25 * 1024 * 1024;
    if (!options.buffer || options.buffer.length <= 0) {
      throw new AppError('File size must be greater than zero bytes.', 400, 'INVALID_FILE_SIZE');
    }
    if (options.buffer.length > folderLimit) {
      const maxMb = Math.round((folderLimit / (1024 * 1024)) * 10) / 10;
      throw new AppError(
        `Object exceeds maximum allowed upload limit of ${maxMb}MB.`,
        400,
        'FILE_TOO_LARGE'
      );
    }
    await this.s3Client!.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME!,
        Key: options.objectKey,
        Body: options.buffer,
        ContentType: options.contentType,
        ContentLength: options.buffer.length,
      })
    );
  }

  /**
   * Validates and uploads an image buffer to R2 in one step.
   * Used by the server-side proxy upload routes to avoid browser CORS.
   */
  public async validateAndUploadBuffer(options: {
    buffer: Buffer;
    mimeType: string;
    folder: StorageFolder;
    referenceId: string | number;
    customKey?: string;
  }): Promise<{ objectKey: string; contentType: string; sizeBytes: number }> {
    this.assertConfigured();

    const { buffer, mimeType, folder, referenceId } = options;
    const cleanMime = mimeType.toLowerCase().trim();

    // Validate MIME type
    const allowedSet = folder === 'supplier-bills' ? ALLOWED_SUPPLIER_DOC_TYPES : ALLOWED_IMAGE_TYPES;
    if (!allowedSet.has(cleanMime)) {
      const msg =
        folder === 'supplier-bills'
          ? `Unsupported file type "${mimeType}". Only JPEG, PNG, WebP, and PDF are permitted.`
          : `Unsupported image type "${mimeType}". Only JPEG, PNG, and WebP are permitted.`;
      throw new AppError(msg, 400, 'INVALID_CONTENT_TYPE');
    }

    const safeReferenceId = sanitizeReferenceSegment(referenceId);

    // Validate size limit strictly against per-folder authoritative map
    const maxBytes = MAX_BYTES_BY_FOLDER[folder];
    const maxMb = maxBytes / (1024 * 1024);
    if (buffer.length <= 0) {
      throw new AppError('File size must be greater than zero bytes.', 400, 'INVALID_FILE_SIZE');
    }
    if (buffer.length > maxBytes) {
      throw new AppError(
        `File size exceeds maximum allowed limit of ${maxMb}MB.`,
        400,
        'FILE_TOO_LARGE'
      );
    }

    // Validate magic bytes (file signature) to prevent content-type spoofing
    if (!validateImageMagicBytes(buffer, cleanMime)) {
      throw new AppError(
        'File contents do not match an accepted file signature.',
        400,
        'INVALID_IMAGE_SIGNATURE'
      );
    }

    // Generate server-controlled random object key or use pre-locked verified custom key
    let ext = 'jpg';
    if (cleanMime === 'image/png') ext = 'png';
    else if (cleanMime === 'image/webp') ext = 'webp';
    else if (cleanMime === 'application/pdf') ext = 'pdf';
    let objectKey: string;
    if (options.customKey) {
      assertSafeScopedObjectKey(options.customKey, folder, referenceId);
      objectKey = options.customKey.trim();
    } else {
      const randomId = crypto.randomUUID();
      objectKey = `${folder}/${safeReferenceId}/${randomId}.${ext}`;
    }

    await this.uploadBufferToR2({ buffer, objectKey, contentType: cleanMime });

    return { objectKey, contentType: cleanMime, sizeBytes: buffer.length };
  }

  private async cleanupRejectedUpload(
    objectKey: string,
    folder: StorageFolder,
    reason: string
  ): Promise<void> {
    try {
      await this.deleteObject(objectKey);
    } catch (delErr) {
      if (rejectedUploadCleanupHook) {
        await rejectedUploadCleanupHook(objectKey, folder, reason, delErr).catch((hookErr) => {
          console.warn('[STORAGE] Rejected-upload cleanup enqueue warning:', (hookErr as Error)?.message);
        });
      } else {
        console.warn('[STORAGE] Failed to delete rejected R2 upload:', (delErr as Error)?.message);
      }
    }
  }

  /**
   * Deletes an object from R2. Treats missing R2 objects (NoSuchKey / 404) as
   * already cleaned up and propagates transport/permission failures so durable
   * cleanup retry queues can enqueue retries.
   */
  public async deleteObject(objectKey: string): Promise<void> {
    if (!objectKey || !objectKey.trim()) {
      throw new AppError('Storage object key is required.', 400, 'INVALID_OBJECT_KEY');
    }
    this.assertConfigured();

    try {
      await this.s3Client!.send(
        new DeleteObjectCommand({
          Bucket: env.R2_BUCKET_NAME!,
          Key: objectKey.trim(),
        })
      );
    } catch (err) {
      if (isNoSuchKeyError(err)) {
        return;
      }
      throw err;
    }
  }
}

export const storageService = new StorageService();
