import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Load .env and .env.local if present with deterministic precedence (.env.local overrides .env)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });

const booleanStringSchema = z
  .union([z.boolean(), z.string()])
  .transform((val) => {
    if (typeof val === 'boolean') return val;
    const lower = val.toLowerCase().trim();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
    throw new Error(`Invalid boolean string: "${val}"`);
  });

const strictPositiveIntSchema = z
  .union([z.number(), z.string()])
  .transform((val) => {
    if (typeof val === 'number') {
      if (!Number.isInteger(val) || val <= 0) {
        throw new Error(`Expected positive integer, got: ${val}`);
      }
      return val;
    }
    const trimmed = val.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`Invalid positive integer format: "${val}"`);
    }
    const num = parseInt(trimmed, 10);
    if (num <= 0) {
      throw new Error(`Expected positive integer, got: ${num}`);
    }
    return num;
  });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: strictPositiveIntSchema.default(5000),

  // Owner Identity
  OWNER_PHONE: z
    .string()
    .regex(/^[6-9]\d{9}$/, 'OWNER_PHONE must be a canonical 10-digit Indian mobile number starting with 6-9')
    .default('9876543210'),
  OWNER_PASSWORD_HASH: z
    .string()
    .refine((val) => val.startsWith('$argon2id$'), {
      message: 'OWNER_PASSWORD_HASH must be an Argon2id hash (starting with $argon2id$)',
    })
    .default('$argon2id$v=19$m=65536,t=3,p=4$dummyhashforinitializationonly00000000000000000'),

  // Neon PostgreSQL
  DATABASE_URL_POOLED: z
    .string()
    .url()
    .default('postgresql://neondb_owner:dummy@ep-shy-mud-94919289-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require'),
  DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://neondb_owner:dummy@ep-shy-mud-94919289.us-east-2.aws.neon.tech/neondb?sslmode=require'),

  // Neon Realtime (Optional while Realtime is explicitly deferred)
  NEON_REALTIME_URL: z.string().url().optional(),
  NEON_REALTIME_SECRET: z.string().min(16).optional(),

  // Server-side Sessions
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters')
    .default('super_secret_session_key_at_least_32_characters_long_khata'),
  SESSION_MAX_AGE_MS: strictPositiveIntSchema.default(604800000), // 7 days
  SESSION_COOKIE_NAME: z.string().min(1).default('khata_session'),
  SESSION_COOKIE_SECURE: booleanStringSchema.default(false),
  SESSION_COOKIE_HTTP_ONLY: booleanStringSchema.default(true),
  SESSION_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // Frontend origin for credentialed CORS
  FRONTEND_URL: z.string().url().default('https://khata.algions.in'),

  // Login abuse protection thresholds
  LOGIN_MAX_ATTEMPTS: strictPositiveIntSchema.default(5),
  LOGIN_FAILURE_WINDOW_MS: strictPositiveIntSchema.default(900000), // 15 mins
  LOGIN_LOCK_DURATION_MS: strictPositiveIntSchema.default(900000), // 15 mins
  LOGIN_EXTENDED_THRESHOLD: strictPositiveIntSchema.default(10),
  LOGIN_EXTENDED_WINDOW_MS: strictPositiveIntSchema.default(86400000), // 24 hours
  LOGIN_EXTENDED_LOCK_DURATION_MS: strictPositiveIntSchema.default(1800000), // 30 mins
  LOGIN_LOG_RETENTION_DAYS: strictPositiveIntSchema.default(30),

  // Reverse proxy
  TRUST_PROXY: z
    .union([z.number(), z.string(), z.boolean()])
    .transform((val) => {
      if (typeof val === 'boolean') return val ? 1 : 0;
      if (typeof val === 'number') {
        if (!Number.isInteger(val) || val < 0) throw new Error('TRUST_PROXY number must be non-negative integer');
        return val;
      }
      const trimmed = val.trim();
      if (!/^\d+$/.test(trimmed)) {
        throw new Error(`Invalid TRUST_PROXY integer: "${val}"`);
      }
      return parseInt(trimmed, 10);
    })
    .default(1),
});

export type Env = z.infer<typeof envSchema>;

export function loadAndValidateEnv(overrides: Partial<Record<string, string | undefined>> = {}): Env {
  const merged = { ...process.env, ...overrides };
  const result = envSchema.safeParse(merged);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `  - ${e.path.join('.')}: ${e.message}`).join('\n');
    console.error(`\x1b[31m[CONFIG ERROR] Invalid environment configuration:\x1b[0m\n${errors}`);
    throw new Error(`Environment validation failed:\n${errors}`);
  }

  const env = result.data;

  // Enforce production security rules: fail closed if production has defaults or dummy placeholders
  if (env.NODE_ENV === 'production') {
    if (!env.SESSION_COOKIE_SECURE) {
      throw new Error('[SECURITY FATAL] In production, SESSION_COOKIE_SECURE must be true.');
    }
    if (!env.SESSION_COOKIE_HTTP_ONLY) {
      throw new Error('[SECURITY FATAL] In production, SESSION_COOKIE_HTTP_ONLY must be true.');
    }
    if (env.SESSION_COOKIE_SAME_SITE !== 'lax' && env.SESSION_COOKIE_SAME_SITE !== 'strict') {
      throw new Error('[SECURITY FATAL] In production, SESSION_COOKIE_SAME_SITE must be lax or strict.');
    }
    if (
      !env.SESSION_SECRET ||
      env.SESSION_SECRET === 'super_secret_session_key_at_least_32_characters_long_khata' ||
      env.SESSION_SECRET.includes('dummy') ||
      env.SESSION_SECRET.includes('super_secret') ||
      env.SESSION_SECRET.length < 32
    ) {
      throw new Error(
        '[SECURITY FATAL] In production, SESSION_SECRET must be an explicitly configured, cryptographically random secret of at least 32 characters.'
      );
    }
    if (
      !env.OWNER_PASSWORD_HASH ||
      env.OWNER_PASSWORD_HASH.includes('dummy') ||
      !env.OWNER_PASSWORD_HASH.startsWith('$argon2id$v=19$')
    ) {
      throw new Error(
        '[SECURITY FATAL] In production, OWNER_PASSWORD_HASH must be configured with a real, valid Argon2id hash.'
      );
    }
    const rawOwnerPhone = merged.OWNER_PHONE;
    if (!rawOwnerPhone || rawOwnerPhone === '9876543210') {
      throw new Error(
        '[SECURITY FATAL] In production, OWNER_PHONE must be explicitly configured with the owner canonical phone number.'
      );
    }
    if (env.DATABASE_URL.includes('sslmode=disable') || env.DATABASE_URL_POOLED.includes('sslmode=disable')) {
      throw new Error('[SECURITY FATAL] In production, database connection cannot use sslmode=disable.');
    }
    if (
      !env.DATABASE_URL_POOLED ||
      env.DATABASE_URL_POOLED.includes('dummy') ||
      !env.DATABASE_URL_POOLED.includes('sslmode=')
    ) {
      throw new Error(
        '[SECURITY FATAL] In production, DATABASE_URL_POOLED must be explicitly configured with TLS enabled.'
      );
    }
    if (
      !env.DATABASE_URL ||
      env.DATABASE_URL.includes('dummy') ||
      !env.DATABASE_URL.includes('sslmode=')
    ) {
      throw new Error(
        '[SECURITY FATAL] In production, DATABASE_URL must be explicitly configured with TLS enabled.'
      );
    }
  }

  return env;
}

export const env = loadAndValidateEnv();
