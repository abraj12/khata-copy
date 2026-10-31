import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

// Reusable single application connection pool (against Neon pooled endpoint)
export const appPool = new Pool({
  connectionString: env.DATABASE_URL_POOLED,
  ssl: env.NODE_ENV === 'test' ? false : true, // Enforce TLS verification without disabling certificate checks
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Admin / migration pool (direct endpoint)
export const directPool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.NODE_ENV === 'test' ? false : true,
  max: 2,
  connectionTimeoutMillis: 5000,
});

appPool.on('error', (err) => {
  console.error('[DB ERROR] Unexpected error on idle client in application pool:', err.message);
});

directPool.on('error', (err) => {
  console.error('[DB ERROR] Unexpected error on idle client in direct pool:', err.message);
});

/**
 * Lightweight database liveness check
 */
export async function checkDatabaseLiveness(): Promise<boolean> {
  try {
    const res = await appPool.query('SELECT 1');
    return (res.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Comprehensive database readiness check (measures latency and verifies session table)
 */
export async function checkDatabaseReadiness(): Promise<{ isReady: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await appPool.query('SELECT 1');
    const latencyMs = Date.now() - start;
    return { isReady: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return { isReady: false, latencyMs, error: (err as Error).message };
  }
}
