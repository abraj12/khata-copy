import fs from 'fs';
import path from 'path';
import { directPool } from '../src/config/database.js';

const MIGRATION_LOCK_ID = 987654321;

async function runMigrations() {
  console.log('[MIGRATION] Connecting via direct DATABASE_URL connection...');
  const client = await directPool.connect();

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
    await directPool.end();
  }
}

runMigrations().catch((err) => {
  console.error('[MIGRATION ERROR]', err);
  process.exit(1);
});
