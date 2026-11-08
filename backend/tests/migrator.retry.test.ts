import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  retryTransientMigration,
  isTransientNeonConnectionError,
  MigrationSqlError,
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

  it('2. Returns immediately when the migration succeeds (Test A)', async () => {
    const operation = vi.fn().mockResolvedValue('success');
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await retryTransientMigration(operation, {
      sleep,
      random: () => 0,
    });

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('3. Retries the actual migration operation and succeeds after transient Neon failures (Test B)', async () => {
    let attempts = 0;

    const operation = vi.fn().mockImplementation(async () => {
      attempts++;

      if (attempts < 3) {
        const error = new Error('Connection terminated unexpectedly');
        (error as NodeJS.ErrnoException).code = '57P03';
        throw error;
      }

      return 'connected';
    });

    const delays: number[] = [];

    const result = await retryTransientMigration(operation, {
      maxRetries: 5,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      backoffFactor: 2,
      random: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(result).toBe('connected');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it('4. Does not retry deterministic SQL migration failures (Test C)', async () => {
    const error = new MigrationSqlError(
      '015_test.sql',
      new Error('Syntax error in migration')
    );

    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryTransientMigration(operation, {
        maxRetries: 5,
        sleep,
      })
    ).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('5. Stops after the configured maximum attempts (Test D)', async () => {
    const error = Object.assign(
      new Error('Connection refused'),
      { code: 'ECONNREFUSED' }
    );

    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryTransientMigration(operation, {
        maxRetries: 3,
        initialDelayMs: 10,
        random: () => 0,
        sleep,
      })
    ).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('6. Does not retry non-transient errors like SQL constraints and validation (Test E)', async () => {
    const constraintErr = Object.assign(
      new Error('duplicate key value violates unique constraint'),
      { code: '23505' }
    );

    const opConstraint = vi.fn().mockRejectedValue(constraintErr);
    const sleepConstraint = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryTransientMigration(opConstraint, { maxRetries: 5, sleep: sleepConstraint })
    ).rejects.toBe(constraintErr);

    expect(opConstraint).toHaveBeenCalledTimes(1);
    expect(sleepConstraint).not.toHaveBeenCalled();

    const missingTableErr = Object.assign(
      new Error('relation "unknown_table" does not exist'),
      { code: '42P01' }
    );

    const opTable = vi.fn().mockRejectedValue(missingTableErr);
    await expect(
      retryTransientMigration(opTable, { maxRetries: 5, sleep: sleepConstraint })
    ).rejects.toBe(missingTableErr);

    expect(opTable).toHaveBeenCalledTimes(1);
  });

  it('7. Validates retry configuration parameters (Test F)', async () => {
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(
      retryTransientMigration(operation, { maxRetries: 0 })
    ).rejects.toThrow('Invalid migration retry configuration.');

    await expect(
      retryTransientMigration(operation, { maxRetries: -2 })
    ).rejects.toThrow('Invalid migration retry configuration.');

    await expect(
      retryTransientMigration(operation, { initialDelayMs: -100 })
    ).rejects.toThrow('Invalid migration retry configuration.');

    await expect(
      retryTransientMigration(operation, { maxDelayMs: -50 })
    ).rejects.toThrow('Invalid migration retry configuration.');

    await expect(
      retryTransientMigration(operation, { backoffFactor: 0.5 })
    ).rejects.toThrow('Invalid migration retry configuration.');

    expect(operation).not.toHaveBeenCalled();
  });
});
