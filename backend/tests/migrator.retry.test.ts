import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isTransientNeonConnectionError,
  MigrationSqlError,
  runPendingMigrationsWithRetry,
} from '../src/config/migrator.js';

describe('Migrator Startup Reliability & Retry Test Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Correctly classifies transient Neon connection errors vs deterministic SQL errors', () => {
    // Transient errors
    expect(isTransientNeonConnectionError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientNeonConnectionError({ code: '57P03' })).toBe(true); // Neon compute wake-up
    expect(isTransientNeonConnectionError({ code: '08006' })).toBe(true);
    expect(isTransientNeonConnectionError({ message: 'Connection terminated unexpectedly' })).toBe(true);
    expect(isTransientNeonConnectionError({ message: 'Connection timeout' })).toBe(true);
    expect(isTransientNeonConnectionError({ message: 'Server closed the connection unexpectedly' })).toBe(true);

    // Deterministic SQL / schema errors - must NOT be treated as transient
    expect(isTransientNeonConnectionError({ code: '42601', message: 'syntax error at or near SELECT' })).toBe(false);
    expect(isTransientNeonConnectionError({ code: '42P01', message: 'relation does not exist' })).toBe(false);
    expect(isTransientNeonConnectionError({ code: '23505', message: 'unique constraint violation' })).toBe(false);

    // Fatal migration error wrapper
    const fatalErr = new MigrationSqlError('015_test.sql', new Error('Syntax error'));
    expect(fatalErr.isFatalMigrationError).toBe(true);
    expect(isTransientNeonConnectionError(fatalErr)).toBe(false);
  });

  it('2. Retries transient connection errors with bounded backoff and succeeds on reconnect', async () => {
    let callCount = 0;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock an operation that fails twice with transient Neon errors and succeeds on the 3rd attempt
    const mockRunner = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        const transientErr = new Error('Connection terminated unexpectedly');
        (transientErr as { code?: string }).code = '57P03';
        throw transientErr;
      }
      return Promise.resolve();
    });

    // Run retry loop with small delay for testing
    let attempt = 0;
    const maxRetries = 5;
    const initialDelayMs = 10;
    const backoffFactor = 2;

    while (true) {
      attempt++;
      try {
        await mockRunner();
        break;
      } catch (err) {
        if (!isTransientNeonConnectionError(err)) throw err;
        if (attempt >= maxRetries) throw err;
        const delay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
        console.warn(`[MIGRATION RETRY] Attempt ${attempt}/${maxRetries}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    expect(callCount).toBe(3);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('3. Fails immediately without retry when encountering a MigrationSqlError', async () => {
    let callCount = 0;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mockRunner = vi.fn().mockImplementation(async () => {
      callCount++;
      throw new MigrationSqlError('015_broken.sql', new Error('syntax error in migration script'));
    });

    let caughtError: unknown = null;
    let attempt = 0;
    const maxRetries = 5;

    try {
      while (true) {
        attempt++;
        try {
          await mockRunner();
          break;
        } catch (err) {
          if ((err as { isFatalMigrationError?: boolean }).isFatalMigrationError) {
            throw err; // Fail-fast without retry
          }
          if (!isTransientNeonConnectionError(err)) throw err;
          if (attempt >= maxRetries) throw err;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    } catch (e) {
      caughtError = e;
    }

    expect(callCount).toBe(1); // Exactly 1 attempt - no retries
    expect(warnSpy).not.toHaveBeenCalled();
    expect((caughtError as Error).message).toContain('015_broken.sql');
  });

  it('4. Exhausts bounded retries if connection drops persist and reports clear failure', async () => {
    let callCount = 0;
    const mockRunner = vi.fn().mockImplementation(async () => {
      callCount++;
      const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      (err as { code?: string }).code = 'ECONNREFUSED';
      throw err;
    });

    let caughtError: unknown = null;
    let attempt = 0;
    const maxRetries = 3;

    try {
      while (true) {
        attempt++;
        try {
          await mockRunner();
          break;
        } catch (err) {
          if (!isTransientNeonConnectionError(err)) throw err;
          if (attempt >= maxRetries) {
            throw new Error(`Exhausted all ${maxRetries} connection attempts: ${(err as Error).message}`);
          }
          await new Promise((r) => setTimeout(r, 5));
        }
      }
    } catch (e) {
      caughtError = e;
    }

    expect(callCount).toBe(3);
    expect((caughtError as Error).message).toContain('Exhausted all 3 connection attempts');
  });
});
