import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquireObjectLockInTransaction,
  acquireObjectLocksInTransaction,
  acquireObjectSessionLock,
  acquireObjectSessionLocks,
  releaseObjectSessionLock,
  releaseObjectSessionLocks,
} from '../src/services/storageObjectLock.js';

describe('Khata Release #032 — Storage Object Advisory Locking Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Deterministic Sorted Key Locking (Deadlock Prevention)', () => {
    it('sorts keys lexicographically and eliminates duplicates before acquiring locks in transaction', async () => {
      const acquiredKeys: string[] = [];
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('pg_advisory_xact_lock')) {
            acquiredKeys.push(params[0]);
          }
          return { rows: [], rowCount: 0 };
        }),
      } as any;

      // Pass unsorted keys with duplicates and nulls
      const keys = ['products/zebra.png', 'products/apple.png', 'products/banana.png', 'products/apple.png', null, ''];

      await acquireObjectLocksInTransaction(mockClient, keys);

      expect(acquiredKeys).toEqual([
        'products/apple.png',
        'products/banana.png',
        'products/zebra.png',
      ]);
    });

    it('sorts keys and acquires session locks in exact order', async () => {
      const sessionKeys: string[] = [];
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('pg_advisory_lock')) {
            sessionKeys.push(params[0]);
          }
          return { rows: [], rowCount: 0 };
        }),
      } as any;

      const keys = ['z-key.jpg', 'a-key.jpg', 'm-key.jpg'];
      const lockedKeys = await acquireObjectSessionLocks(mockClient, keys);

      expect(lockedKeys).toEqual(['a-key.jpg', 'm-key.jpg', 'z-key.jpg']);
      expect(sessionKeys).toEqual(['a-key.jpg', 'm-key.jpg', 'z-key.jpg']);
    });
  });

  describe('2. Session Lock Release Order and Error Resilience', () => {
    it('releases session locks in reverse order', async () => {
      const releasedKeys: string[] = [];
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('pg_advisory_unlock')) {
            releasedKeys.push(params[0]);
            return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      } as any;

      const keys = ['a-key.jpg', 'b-key.jpg', 'c-key.jpg'];
      await releaseObjectSessionLocks(mockClient, keys);

      // Reverse order: c, b, a
      expect(releasedKeys).toEqual(['c-key.jpg', 'b-key.jpg', 'a-key.jpg']);
    });

    it('handles unlock query errors gracefully without throwing', async () => {
      const mockClient = {
        query: vi.fn().mockRejectedValue(new Error('Connection terminated')),
      } as any;

      const success = await releaseObjectSessionLock(mockClient, 'some-key.jpg');
      expect(success).toBe(false);
    });

    it('ignores empty or null keys safely', async () => {
      const mockClient = {
        query: vi.fn(),
      } as any;

      await acquireObjectLockInTransaction(mockClient, '');
      await acquireObjectLockInTransaction(mockClient, null as any);
      const sessionAcquired = await acquireObjectSessionLock(mockClient, '   ');
      const sessionReleased = await releaseObjectSessionLock(mockClient, '');

      expect(mockClient.query).not.toHaveBeenCalled();
      expect(sessionAcquired).toBe(false);
      expect(sessionReleased).toBe(false);
    });
  });
});
