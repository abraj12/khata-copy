import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

// Reusable single application connection pool (against Neon pooled endpoint)
export const appPool = new Pool({
  connectionString: env.DATABASE_URL_POOLED,
  ssl: {
    rejectUnauthorized: false, // Neon SSL connection
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Admin / migration pool (direct endpoint)
export const directPool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 2,
  connectionTimeoutMillis: 5000,
});

appPool.on('error', (err) => {
  console.error('[DB ERROR] Unexpected error on idle client in application pool', err.message);
});

directPool.on('error', (err) => {
  console.error('[DB ERROR] Unexpected error on idle client in direct pool', err.message);
});
