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

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_OFFLINE_BILL_BYTES = 10 * 1024 * 1024; // 10 MB

export interface UploadIntentOptions {
  folder: 'products' | 'offline-bills';
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
    if (!ALLOWED_IMAGE_TYPES.has(cleanContentType)) {
      throw new AppError(
        `Unsupported image type "${contentType}". Only JPEG, PNG, and WebP are permitted.`,
        400,
        'INVALID_CONTENT_TYPE'
      );
    }

    // Validate size limit based on folder
    const maxBytes = folder === 'products' ? MAX_PRODUCT_IMAGE_BYTES : MAX_OFFLINE_BILL_BYTES;
    const maxMb = maxBytes / (1024 * 1024);

    if (sizeBytes <= 0) {
      throw new AppError('File size must be greater than zero bytes.', 400, 'INVALID_FILE_SIZE');
    }
    if (sizeBytes > maxBytes) {
      throw new AppError(
        `Image size exceeds maximum allowed limit of ${maxMb}MB.`,
        400,
        'FILE_TOO_LARGE'
      );
    }

    // Determine extension
    let ext = 'jpg';
    if (cleanContentType === 'image/png') ext = 'png';
    else if (cleanContentType === 'image/webp') ext = 'webp';

    // Server-controlled random object key to prevent directory traversal
    const randomId = crypto.randomUUID();
    const objectKey = `${folder}/${referenceId}/${randomId}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME!,
      Key: objectKey,
    });

    const expiresIn = 300; // 5 minutes
    const uploadUrl = await getSignedUrl(this.s3Client!, command, { expiresIn });

    return {
      uploadUrl,
      objectKey,
      expiresIn,
      headers: {},
    };
  }

  /**
   * Verifies an uploaded object exists in R2, verifies size and magic bytes
   */
  public async verifyObject(
    objectKey: string,
    expectedFolder: 'products' | 'offline-bills',
    expectedReferenceId?: string | number
  ): Promise<VerifiedObjectResult> {
    this.assertConfigured();

    // Guard against directory traversal or spoofed key
    const expectedPrefix = expectedReferenceId !== undefined
      ? `${expectedFolder}/${expectedReferenceId}/`
      : `${expectedFolder}/`;

    if (!objectKey.startsWith(expectedPrefix)) {
      throw new AppError(
        'Invalid object key path for requested operation.',
        400,
        'INVALID_OBJECT_KEY'
      );
    }

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

      const maxBytes = expectedFolder === 'products' ? MAX_PRODUCT_IMAGE_BYTES : MAX_OFFLINE_BILL_BYTES;
      if (contentLength <= 0 || contentLength > maxBytes) {
        throw new AppError(
          `Uploaded object size (${contentLength} bytes) is outside permitted limits.`,
          400,
          'INVALID_OBJECT_SIZE'
        );
      }

      if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
        throw new AppError(
          `Uploaded object Content-Type "${contentType}" is not an accepted image format.`,
          400,
          'INVALID_CONTENT_TYPE'
        );
      }

      // 2. Read first 16 bytes to verify magic bytes / file signature
      try {
        const getRange = await this.s3Client!.send(
          new GetObjectCommand({
            Bucket: env.R2_BUCKET_NAME!,
            Key: objectKey,
            Range: 'bytes=0-15',
          })
        );

        if (getRange.Body) {
          const chunk = await getRange.Body.transformToByteArray();
          const validSignature = validateImageMagicBytes(chunk, contentType);
          if (!validSignature) {
            // Delete invalid spoofed object immediately
            await this.deleteObject(objectKey);
            throw new AppError(
              'Uploaded file contents do not match a valid JPEG, PNG, or WebP image signature.',
              400,
              'INVALID_IMAGE_SIGNATURE'
            );
          }
        }
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        console.warn('[STORAGE] Magic bytes range check skipped/failed:', (err as Error).message);
      }

      return {
        contentLength,
        contentType,
      };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'Uploaded image could not be verified in storage. Please retry.',
        400,
        'OBJECT_NOT_FOUND'
      );
    }
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
   * Deletes an object from R2 safely without breaking caller execution
   */
  public async deleteObject(objectKey: string): Promise<void> {
    if (!this.isConfigured() || !objectKey) return;

    try {
      await this.s3Client!.send(
        new DeleteObjectCommand({
          Bucket: env.R2_BUCKET_NAME!,
          Key: objectKey,
        })
      );
    } catch (err) {
      console.warn('[STORAGE] Failed to delete R2 object:', objectKey, (err as Error).message);
    }
  }
}

export const storageService = new StorageService();
