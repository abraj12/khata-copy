import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { runPendingMigrations, MIGRATION_LOCK_ID } from '../src/config/migrator.js';
import { directPool } from '../src/config/database.js';
import { env } from '../src/config/env.js';

describe('Migrator Pool Resource Cleanup Test Suite', () => {
  const dummyOverrideUrl = 'postgresql://test_user:test_pass@localhost:5432/khata_cleanup_test';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Closes temporary override pool and releases advisory lock on successful migration run', async () => {
    const executedQueries: string[] = [];
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        executedQueries.push(sql);
        if (sql.includes('schema_migrations')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const connectSpy = vi.spyOn(pg.Pool.prototype, 'connect').mockResolvedValue(client as unknown as pg.PoolClient);
    const endSpy = vi.spyOn(pg.Pool.prototype, 'end').mockResolvedValue(undefined as never);

    await runPendingMigrations(dummyOverrideUrl);

    expect(connectSpy).toHaveBeenCalled();
    // Advisory lock acquired
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    // Advisory lock released
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    // Client released cleanly without error argument
    expect(client.release).toHaveBeenCalledWith(undefined);
    // Temporary pool ended
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('2. Closes temporary override pool even when connect() fails', async () => {
    const connectErr = new Error('Connection refused by host');
    (connectErr as { code?: string }).code = 'ECONNREFUSED';

    const connectSpy = vi.spyOn(pg.Pool.prototype, 'connect').mockRejectedValue(connectErr);
    const endSpy = vi.spyOn(pg.Pool.prototype, 'end').mockResolvedValue(undefined as never);

    await expect(runPendingMigrations(dummyOverrideUrl)).rejects.toThrow('Connection refused by host');

    expect(connectSpy).toHaveBeenCalled();
    // Override pool ended in finally block despite connect failure
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('3. Releases failed client with error to discard it from pool and closes override pool on query failure', async () => {
    const queryErr = new Error('Database disk error');
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT pg_advisory_lock')) {
          return { rows: [] };
        }
        throw queryErr;
      }),
      release: vi.fn(),
    };

    vi.spyOn(pg.Pool.prototype, 'connect').mockResolvedValue(client as unknown as pg.PoolClient);
    const endSpy = vi.spyOn(pg.Pool.prototype, 'end').mockResolvedValue(undefined as never);

    await expect(runPendingMigrations(dummyOverrideUrl)).rejects.toThrow('Database disk error');

    // Client was discarded by passing error to release()
    expect(client.release).toHaveBeenCalledWith(queryErr);
    // Temporary pool was ended
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('4. Shared directPool is NEVER ended during normal migration run without overrideDbUrl', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const envSpy = vi.spyOn(env, 'DATABASE_URL', 'get').mockReturnValue('postgresql://real_app_user:real_pass@localhost:5432/khata_db');

    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('schema_migrations')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const directConnectSpy = vi.spyOn(directPool, 'connect').mockResolvedValue(client as unknown as pg.PoolClient);
    const directEndSpy = vi.spyOn(directPool, 'end').mockResolvedValue(undefined as never);

    try {
      await runPendingMigrations(undefined);

      expect(directConnectSpy).toHaveBeenCalled();
      expect(client.release).toHaveBeenCalled();
      // CRITICAL: directPool MUST NOT be closed!
      expect(directEndSpy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      envSpy.mockRestore();
    }
  });

  it('5. Cleanup error during advisory unlock does not hide original migration error', async () => {
    const originalErr = new Error('Primary migration failure in SQL');
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT pg_advisory_lock')) {
          return { rows: [] };
        }
        throw originalErr;
      }),
      release: vi.fn(),
    };

    vi.spyOn(pg.Pool.prototype, 'connect').mockResolvedValue(client as unknown as pg.PoolClient);
    vi.spyOn(pg.Pool.prototype, 'end').mockResolvedValue(undefined as never);

    await expect(runPendingMigrations(dummyOverrideUrl)).rejects.toThrow('Primary migration failure in SQL');
    expect(client.release).toHaveBeenCalled();
  });
});
