import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';
import { directPool } from '../src/config/database.js';

// Pre-load .env and .env.local from current directory or backend directory
const envFiles = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), 'backend/.env'),
  path.resolve(process.cwd(), 'backend/.env.local'),
];
for (const envFile of envFiles) {
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: true });
  }
}

const { Pool } = pg;
const MIGRATION_LOCK_ID = 987654321;

// Allow direct CLI URL argument: npm run migrate -- "postgresql://..."
const cliUrl = process.argv.slice(2).find((arg) => arg.startsWith('postgres://') || arg.startsWith('postgresql://'));
const effectiveDbUrl = cliUrl || process.env.DATABASE_URL;

const activePool = effectiveDbUrl
  ? new Pool({
      connectionString: effectiveDbUrl,
      ssl: effectiveDbUrl.includes('localhost') ? false : true,
      max: 2,
      connectionTimeoutMillis: 10000,
    })
  : directPool;

async function runMigrations() {
  console.log('[MIGRATION] Connecting to PostgreSQL direct endpoint...');
  const client = await activePool.connect();

  try {
    // 1. Acquire advisory lock to prevent concurrent migrations
    console.log('[MIGRATION] Acquiring advisory lock...');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    // 2. Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "version" VARCHAR(255) PRIMARY KEY,
        "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 3. Find all .sql migration files in order
    const possibleDirs = [
      path.resolve(process.cwd(), 'migrations'),
      path.resolve(process.cwd(), 'backend/migrations'),
      path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../migrations'),
    ];
    const migrationsDir = possibleDirs.find((d) => fs.existsSync(d));
    if (!migrationsDir) {
      throw new Error(`Could not locate migrations directory in: ${possibleDirs.join(', ')}`);
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // 4. Fetch already applied versions
    const appliedRes = await client.query('SELECT version FROM schema_migrations');
    const appliedSet = new Set(appliedRes.rows.map((r) => r.version));

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[MIGRATION] Skipping already applied: ${file}`);
        continue;
      }

      console.log(`[MIGRATION] Applying migration: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`\x1b[32m[MIGRATION SUCCESS] Successfully applied ${file}\x1b[0m`);
      } catch (migrationErr) {
        await client.query('ROLLBACK');
        throw migrationErr;
      }
    }

    console.log('\x1b[32m[MIGRATION COMPLETE] All schema migrations up to date!\x1b[0m');
  } catch (err) {
    console.error('\x1b[31m[MIGRATION FAILED]\x1b[0m', (err as Error).message);
    process.exit(1);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } catch {
      // Ignore unlock failure on exit
    }
    client.release();
    await activePool.end();
  }
}

runMigrations().catch((err) => {
  console.error('[MIGRATION ERROR]', err);
  process.exit(1);
});
