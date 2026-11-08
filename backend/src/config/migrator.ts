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
  if (env.NODE_ENV === 'test') {
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

  console.log('[MIGRATION] Connecting to PostgreSQL to verify schema migrations...');
  const client = await activePool.connect();

  try {
    // 1. Acquire advisory lock
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

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
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } catch {
      // Ignore unlock cleanup failure if connection died
    }
    client.release();
    if (activePool !== directPool) {
      await activePool.end();
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
  if (env.NODE_ENV === 'test') {
    return;
  }

  const maxRetries = options?.maxRetries ?? 5;
  const initialDelayMs = options?.initialDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 10000;
  const backoffFactor = options?.backoffFactor ?? 2;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await runPendingMigrations(overrideDbUrl);
      return;
    } catch (err) {
      if ((err as { isFatalMigrationError?: boolean }).isFatalMigrationError) {
        console.error(
          `[MIGRATION FATAL] Non-transient migration failure: ${(err as Error).message}. Startup aborted without retry.`
        );
        throw err;
      }

      if (!isTransientNeonConnectionError(err)) {
        console.error(
          `[MIGRATION FATAL] Non-connection migration error: ${(err as Error).message}. Startup aborted without retry.`
        );
        throw err;
      }

      if (attempt >= maxRetries) {
        console.error(
          `[MIGRATION FAILED] Exhausted all ${maxRetries} connection attempts to database: ${(err as Error).message}. Startup aborted.`
        );
        throw err;
      }

      const rawDelay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
      const jitter = Math.floor(Math.random() * 200);
      const delay = Math.min(rawDelay + jitter, maxDelayMs);

      console.warn(
        `[MIGRATION RETRY] Transient Neon connection failure on attempt ${attempt}/${maxRetries} (${(err as Error).message}). Retrying in ${delay}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
