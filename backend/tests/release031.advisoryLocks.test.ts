import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  acquireObjectLockInTransaction,
  acquireObjectLocksInTransaction,
  acquireObjectSessionLock,
  releaseObjectSessionLock,
} from '../src/services/storageObjectLock.js';

function buildMockPoolClient(queryHandler: (sql: string, params?: unknown[]) => Promise<any>) {
  return {
    query: vi.fn(queryHandler),
    release: vi.fn(),
  } as any;
}

describe('Khata Release #031 — Advisory Locks & Concurrency Protection Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('1. Shared Advisory Lock Derivation & Key Normalization', () => {
    it('uses pg_advisory_xact_lock with 64-bit hashtextextended for transaction locks', async () => {
      const executed: { sql: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executed.push({ sql, params });
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      });

      await acquireObjectLockInTransaction(mockClient, 'products/42/image.png');

      expect(executed).toHaveLength(1);
      expect(executed[0].sql).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))');
      expect(executed[0].params).toEqual(['products/42/image.png']);
    });

    it('trims whitespace and ignores null, undefined or empty keys safely', async () => {
      const executed: { sql: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executed.push({ sql, params });
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      });

      await acquireObjectLockInTransaction(mockClient, '');
      await acquireObjectLockInTransaction(mockClient, '   ');
      await acquireObjectLockInTransaction(mockClient, null as any);
      await acquireObjectLockInTransaction(mockClient, undefined as any);

      expect(executed).toHaveLength(0);

      await acquireObjectLockInTransaction(mockClient, '  trimmed-key.jpg  ');
      expect(executed).toHaveLength(1);
      expect(executed[0].params).toEqual(['trimmed-key.jpg']);
    });
  });

  describe('2. Deterministic Multi-Key Sorted Acquisition (Deadlock Prevention)', () => {
    it('sorts keys lexicographically and deduplicates before acquiring locks', async () => {
      const acquiredKeys: string[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          acquiredKeys.push(params?.[0] as string);
        }
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      });

      const unsortedKeys = [
        'supplier-bills/99/z_receipt.pdf',
        'products/1/a_image.jpg',
        'offline-bills/5/m_bill.png',
        'products/1/a_image.jpg', // Duplicate
        null,
        '',
        'products/1/a_image.jpg', // Duplicate
      ];

      await acquireObjectLocksInTransaction(mockClient, unsortedKeys);

      expect(acquiredKeys).toEqual([
        'offline-bills/5/m_bill.png',
        'products/1/a_image.jpg',
        'supplier-bills/99/z_receipt.pdf',
      ]);
    });
  });

  describe('3. Session-Level Advisory Lock Acquisition & Release', () => {
    it('acquires session-level lock using pg_advisory_lock', async () => {
      const executed: { sql: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executed.push({ sql, params });
        return { rows: [{ pg_advisory_lock: null }], rowCount: 1 };
      });

      const success = await acquireObjectSessionLock(mockClient, 'products/test.png');

      expect(success).toBe(true);
      expect(executed).toHaveLength(1);
      expect(executed[0].sql).toBe('SELECT pg_advisory_lock(hashtextextended($1::text, 0))');
      expect(executed[0].params).toEqual(['products/test.png']);
    });

    it('releases session-level lock using pg_advisory_unlock and returns true on success', async () => {
      const executed: { sql: string; params?: unknown[] }[] = [];
      const mockClient = buildMockPoolClient(async (sql, params) => {
        executed.push({ sql, params });
        return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      });

      const released = await releaseObjectSessionLock(mockClient, 'products/test.png');

      expect(released).toBe(true);
      expect(executed).toHaveLength(1);
      expect(executed[0].sql).toBe('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))');
      expect(executed[0].params).toEqual(['products/test.png']);
    });

    it('returns false cleanly if pg_advisory_unlock query throws error', async () => {
      const mockClient = buildMockPoolClient(async () => {
        throw new Error('Connection lost during unlock');
      });

      const released = await releaseObjectSessionLock(mockClient, 'products/test.png');
      expect(released).toBe(false);
    });
  });

  describe('4. Worker and Attachment Lock Collision Prevention', () => {
    it('both worker and mutation paths derive the identical advisory lock function and arguments', async () => {
      const xactSqlList: string[] = [];
      const sessionSqlList: string[] = [];

      const xactClient = buildMockPoolClient(async (sql, params) => {
        xactSqlList.push(sql);
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      });

      const sessionClient = buildMockPoolClient(async (sql, params) => {
        sessionSqlList.push(sql);
        return { rows: [{ pg_advisory_lock: null }], rowCount: 1 };
      });

      const key = 'shared-asset-key/file.jpg';
      await acquireObjectLockInTransaction(xactClient, key);
      await acquireObjectSessionLock(sessionClient, key);

      // Both target the same 64-bit hashtextextended hash expression
      expect(xactSqlList[0]).toContain('hashtextextended($1::text, 0)');
      expect(sessionSqlList[0]).toContain('hashtextextended($1::text, 0)');
    });
  });
});
