import fs from 'fs';
import path from 'path';
import { directPool } from '../src/config/database.js';

async function runMigrations() {
  console.log('[MIGRATION] Connecting via direct DATABASE_URL connection...');
  const migrationPath = path.resolve(process.cwd(), 'migrations', '001_auth_tables.sql');
  const sql = fs.readFileSync(migrationPath, 'utf-8');

  const client = await directPool.connect();
  try {
    console.log('[MIGRATION] Applying 001_auth_tables.sql...');
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('\x1b[32m[MIGRATION SUCCESS] Session, login_attempts, products, and ledger tables verified!\x1b[0m');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\x1b[31m[MIGRATION FAILED]\x1b[0m', (err as Error).message);
    process.exit(1);
  } finally {
    client.release();
    await directPool.end();
  }
}

runMigrations().catch((err) => {
  console.error('[MIGRATION ERROR]', err);
  process.exit(1);
});
