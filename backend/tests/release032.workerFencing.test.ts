import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appPool } from '../src/config/database.js';
import {
  StorageCleanupWorker,
  STORAGE_CLEANUP_CLAIM_SQL,
  ClaimedCleanupJob,
} from '../src/services/storageCleanup.worker.js';

describe('Khata Release #032 — Worker Claim-Ownership Fencing Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Claim SQL Structure and Claim Tokens', () => {
    it('generates unique claim_token and increments claim_version on claim', () => {
      expect(STORAGE_CLEANUP_CLAIM_SQL).toContain('claim_token = gen_random_uuid()');
      expect(STORAGE_CLEANUP_CLAIM_SQL).toContain('claim_version = j.claim_version + 1');
      expect(STORAGE_CLEANUP_CLAIM_SQL).toContain('FOR UPDATE SKIP LOCKED');
      expect(STORAGE_CLEANUP_CLAIM_SQL).toContain('RETURNING');
      expect(STORAGE_CLEANUP_CLAIM_SQL).toContain('j.claim_token');
      expect(STORAGE_CLEANUP_CLAIM_SQL).toContain('j.claim_version');
    });
  });

  describe('2. Job Completion Claim Fencing', () => {
    it('marks job completed when claim_token matches active processing claim', async () => {
      const mockQuery = vi.spyOn(appPool, 'query').mockResolvedValue({
        rows: [{ id: 42 }],
        rowCount: 1,
      } as any);

      const worker = new StorageCleanupWorker({ registerGlobalListener: false });
      const validToken = '11111111-2222-3333-4444-555555555555';
      const success = await worker.markJobCompleted(42, validToken, null);

      expect(success).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND claim_token = $2'),
        [42, validToken, null]
      );
    });

    it('rejects completion (fences out) when claim_token is stale or mismatched', async () => {
      vi.spyOn(appPool, 'query').mockResolvedValue({
        rows: [],
        rowCount: 0, // 0 rows updated because claim_token mismatched
      } as any);

      const worker = new StorageCleanupWorker({ registerGlobalListener: false });
      const staleToken = '00000000-0000-0000-0000-000000000000';
      const success = await worker.markJobCompleted(42, staleToken, null);

      expect(success).toBe(false);
    });
  });

  describe('3. Failure & Dead-Letter Claim Fencing', () => {
    it('fences out failure transitions when claim_token does not match active lease', async () => {
      vi.spyOn(appPool, 'query').mockResolvedValue({
        rows: [],
        rowCount: 0,
      } as any);

      const worker = new StorageCleanupWorker({ registerGlobalListener: false });
      const job: ClaimedCleanupJob = {
        id: 99,
        object_key: 'products/img.png',
        object_kind: 'product_image',
        reason: 'product_image_replace',
        attempt_count: 1,
        max_attempts: 5,
        claim_token: 'stale-claim-token-1234',
        claim_version: 1,
      };

      const success = await worker.markJobFailedOrDeadLetter(job, 'R2 Connection Timeout');
      expect(success).toBe(false);
    });

    it('fences out dead-letter transition when claim_token has been reclaimed by another worker', async () => {
      vi.spyOn(appPool, 'query').mockResolvedValue({
        rows: [],
        rowCount: 0,
      } as any);

      const worker = new StorageCleanupWorker({ registerGlobalListener: false });
      const job: ClaimedCleanupJob = {
        id: 99,
        object_key: 'products/img.png',
        object_kind: 'product_image',
        reason: 'product_image_replace',
        attempt_count: 5,
        max_attempts: 5, // Exhausted
        claim_token: 'stale-claim-token-exhausted',
        claim_version: 2,
      };

      const success = await worker.markJobFailedOrDeadLetter(job, 'Permanent R2 404');
      expect(success).toBe(false);
    });
  });
});
