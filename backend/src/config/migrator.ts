import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { directPool } from './database.js';
import { env } from './env.js';

const { Pool } = pg;
const MIGRATION_LOCK_ID = 987654321;

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
          throw new Error(`[PREFLIGHT ERROR] Found ${fracRes.rows.length} row(s) in udhar_items with non-integer quantities. Migration aborted to prevent data loss.`);
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
        await client.query('ROLLBACK');
        console.error(`[MIGRATION FAILED] Error executing ${file}:`, (err as Error).message);
        throw err;
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
      // Ignore unlock cleanup failure
    }
    client.release();
    if (activePool !== directPool) {
      await activePool.end();
    }
  }
}
