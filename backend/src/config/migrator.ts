import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { directPool } from './database.js';
import { env } from './env.js';

const { Pool } = pg;
export const MIGRATION_LOCK_ID = 987654321;

/**
 * Custom error class for deterministic SQL / migration preflight failures.
 * These errors must NEVER be blindly retried by the startup connection loop.
 */
export class MigrationSqlError extends Error {
  public readonly isFatalMigrationError = true;
  constructor(public readonly file: string, public readonly originalError: Error) {
    super(`[MIGRATION SQL ERROR] Migration failed in ${file}: ${originalError.message}`);
    this.name = 'MigrationSqlError';
  }
}

/**
 * Checks whether an error during startup/migration is a transient Neon / PostgreSQL connection failure.
 */
export function isTransientNeonConnectionError(err: unknown): boolean {
  if (!err) return false;
  if ((err as { isFatalMigrationError?: boolean }).isFatalMigrationError) {
    return false;
  }

  const error = err as { code?: string; message?: string };
  const transientCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    'EAI_AGAIN',
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08007',
    '57P01',
    '57P02',
    '57P03', // Neon wake-up / cannot_connect_now
    '53300', // too_many_connections
  ]);

  if (error.code && transientCodes.has(error.code)) {
    return true;
  }

  const message = (error.message || '').toLowerCase();
  return (
    message.includes('connection terminated') ||
    message.includes('timeout exceeded') ||
    message.includes('connection timeout') ||
    message.includes('connection lost') ||
    message.includes('cannot connect now') ||
    message.includes('server closed the connection') ||
    message.includes('failed to connect') ||
    message.includes('could not connect to server') ||
    message.includes('read econnreset') ||
    message.includes('socket has been ended')
  );
}

export interface MigrationRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;

  // Injectable dependencies for deterministic unit tests.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Executes an operation using bounded exponential-backoff retries.
 *
 * Only recognized transient Neon connection errors are retried.
 * Fatal SQL migration errors and other deterministic errors fail immediately.
 *
 * maxRetries represents the maximum TOTAL number of attempts,
 * including the initial attempt, preserving existing behaviour.
 */
export async function retryTransientMigration<T>(
  operation: () => Promise<T>,
  options: MigrationRetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 10000;
  const backoffFactor = options.backoffFactor ?? 2;

  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const random = options.random ?? Math.random;

  if (
    !Number.isInteger(maxRetries) ||
    maxRetries < 1 ||
    initialDelayMs < 0 ||
    maxDelayMs < 0 ||
    backoffFactor < 1
  ) {
    throw new Error('Invalid migration retry configuration.');
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      // Deterministic SQL/preflight failures must never be retried.
      if (
        (err as { isFatalMigrationError?: boolean })?.isFatalMigrationError ||
        !isTransientNeonConnectionError(err)
      ) {
        throw err;
      }

      if (attempt >= maxRetries) {
        console.error(
          `[MIGRATION FAILED] Exhausted all ${maxRetries} attempts: ${
            (err as Error).message
          }`
        );

        throw err;
      }

      const rawDelay =
        initialDelayMs * Math.pow(backoffFactor, attempt - 1);

      const jitter = Math.floor(random() * 200);

      const delay = Math.min(
        rawDelay + jitter,
        maxDelayMs
      );

      console.warn(
        `[MIGRATION RETRY] Transient Neon failure on attempt ${attempt}/${maxRetries}. Retrying in ${delay}ms.`
      );

      await sleep(delay);
    }
  }

  throw new Error('Migration retry loop terminated unexpectedly.');
}

/**
 * Finds the migrations directory across dev and production paths.
 */
function getMigrationsDir(): string {
  const candidateDirs = [
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'backend/migrations'),
    path.resolve(__dirname, '../../migrations'),
    path.resolve(__dirname, '../../../migrations'),
  ];

  const found = candidateDirs.find((dir) => fs.existsSync(dir));
  if (!found) {
    throw new Error(`[MIGRATION ERROR] Could not locate migrations directory in: ${candidateDirs.join(', ')}`);
  }
  return found;
}

/**
 * Runs all pending PostgreSQL schema migrations in sequential order.
 * Uses PostgreSQL advisory lock to ensure thread/instance safety.
 *
 * @param overrideDbUrl Optional connection string (e.g. from CLI arguments)
 */
export async function runPendingMigrations(overrideDbUrl?: string): Promise<void> {
  if (env.NODE_ENV === 'test' && !overrideDbUrl && process.env.NODE_ENV === 'test') {
    return;
  }

  const effectiveUrl = overrideDbUrl || env.DATABASE_URL;
  if (!effectiveUrl || effectiveUrl.includes('dummy')) {
    console.log('[MIGRATION] Skipping migrations: DATABASE_URL is dummy or unset.');
    return;
  }

  const activePool = overrideDbUrl
    ? new Pool({
        connectionString: overrideDbUrl,
        ssl: overrideDbUrl.includes('localhost') ? false : true,
        max: 2,
        connectionTimeoutMillis: 10000,
      })
    : directPool;

  let client: pg.PoolClient | undefined;
  let releaseError: Error | undefined;
  let advisoryLockAcquired = false;

  try {
    console.log('[MIGRATION] Connecting to PostgreSQL to verify schema migrations...');
    client = await activePool.connect();

    // 1. Acquire advisory lock
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    advisoryLockAcquired = true;

    // 2. Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "version" VARCHAR(255) PRIMARY KEY,
        "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 3. Read migration files
    const migrationsDir = getMigrationsDir();
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // 4. Fetch applied migrations
    const appliedRes = await client.query('SELECT version FROM schema_migrations');
    const appliedSet = new Set(appliedRes.rows.map((r) => r.version));

    let appliedCount = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        continue;
      }

      if (file.includes('004_integer_quantity')) {
        console.log('[MIGRATION] Performing preflight fractional quantity audit on udhar_items...');
        const fracRes = await client.query('SELECT id, quantity FROM udhar_items WHERE quantity <> TRUNC(quantity)');
        if (fracRes.rows.length > 0) {
          throw new MigrationSqlError(
            file,
            new Error(`[PREFLIGHT ERROR] Found ${fracRes.rows.length} row(s) in udhar_items with non-integer quantities. Migration aborted to prevent data loss.`)
          );
        }
        console.log('\x1b[32m[PREFLIGHT PASSED] 0 fractional rows found in udhar_items.\x1b[0m');
      }

      console.log(`[MIGRATION] Applying pending migration: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedCount++;
        console.log(`[MIGRATION SUCCESS] Applied ${file}`);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failure if connection died
        }
        console.error(`[MIGRATION FAILED] Error executing ${file}:`, (err as Error).message);

        // If the error during SQL execution is a transient connection drop, let it be retried as a connection drop
        if (isTransientNeonConnectionError(err)) {
          throw err;
        }

        // Otherwise, it is an actual SQL syntax / constraint / schema error: NEVER retry!
        throw new MigrationSqlError(file, err as Error);
      }
    }

    if (appliedCount > 0) {
      console.log(`[MIGRATION COMPLETE] Successfully applied ${appliedCount} pending migration(s).`);
    } else {
      console.log('[MIGRATION] Schema is up to date. All migrations already applied.');
    }
  } catch (err) {
    releaseError = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    if (client) {
      if (advisoryLockAcquired && !releaseError) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
        } catch (unlockError) {
          releaseError = unlockError instanceof Error ? unlockError : new Error(String(unlockError));
          console.error('[MIGRATION] Advisory lock cleanup failed.');
        }
      }

      // A failed client must be discarded instead of re-entering the pool.
      client.release(releaseError);
    }

    // Always close a temporary override pool, including failed connection attempts.
    if (activePool !== directPool) {
      try {
        await activePool.end();
      } catch (closeError) {
        console.error('[MIGRATION] Temporary pool cleanup failed:', (closeError as Error).message);
      }
    }
  }
}

/**
 * Runs pending migrations with bounded exponential-backoff retries for transient Neon connection failures.
 * Distinguishes connection drops from deterministic SQL errors (which fail fast without retry).
 */
export async function runPendingMigrationsWithRetry(
  overrideDbUrl?: string,
  options?: MigrationRetryOptions
): Promise<void> {
  if (env.NODE_ENV === 'test' && !overrideDbUrl && process.env.NODE_ENV === 'test') {
    return;
  }

  await retryTransientMigration(
    () => runPendingMigrations(overrideDbUrl),
    options
  );
}
