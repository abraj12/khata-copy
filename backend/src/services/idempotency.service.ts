import crypto from 'crypto';
import Decimal from 'decimal.js';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppError } from '../utils/errors.js';

export type IdempotencyDbClient = Pick<Pool | PoolClient, 'query'>;

export const IDEMPOTENCY_TTL_HOURS = 24;
const IDEMPOTENCY_CLEANUP_LOCK_KEY = 919005;
const DEFAULT_EXPIRED_CLEANUP_LIMIT = 100;

export interface IdempotencyRecord extends QueryResultRow {
  key: string;
  action: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
  created_at: Date | string;
  expires_at: Date | string;
}

export type IdempotencyLookupResult<TBody = unknown> =
  | { found: false }
  | {
      found: true;
      expired: true;
    }
  | {
      found: true;
      expired: false;
      responseStatus: number;
      responseBody: TBody;
    };

/**
 * Recursively converts arbitrary request values into canonical JSON-compatible structures
 * with sorted object keys so SHA-256 request hashes are 100% deterministic.
 */
function stableNormalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Decimal.isDecimal(value)) {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedEntries: Array<[string, unknown]> = [];
    for (const key of Object.keys(obj).sort()) {
      const val = obj[key];
      if (val !== undefined) {
        sortedEntries.push([key, stableNormalize(val)]);
      }
    }
    return Object.fromEntries(sortedEntries);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }

  return value;
}

/**
 * Computes deterministic key-sorted SHA-256 hash over complete canonical document inputs.
 * Never includes the idempotency key itself.
 */
export function hashIdempotencyPayload(payload: unknown): string {
  const normalized = stableNormalize(payload);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

/**
 * Derives a stable two-part 32-bit PostgreSQL advisory lock key from an idempotency key string.
 */
function deriveAdvisoryLockPair(idempotencyKey: string): [number, number] {
  const digest = crypto.createHash('sha256').update(idempotencyKey).digest();
  // Signed 32-bit integers accepted by pg_advisory_xact_lock(integer, integer)
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Acquires a transaction-scoped advisory lock on the given idempotency key so
 * concurrent identical retries serialize cleanly without consuming duplicate sequences.
 */
export async function acquireIdempotencyLock(
  client: IdempotencyDbClient,
  idempotencyKey: string
): Promise<void> {
  const [k1, k2] = deriveAdvisoryLockPair(idempotencyKey);
  await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [k1, k2]);
}

/**
 * Looks up an idempotency record, enforcing both action equality, request_hash equality,
 * and 24-hour expiration semantics (`expires_at > NOW()`).
 * Throws 409 IDEMPOTENCY_CONFLICT when an active (non-expired) key is reused for a
 * different action or payload.
 */
export async function checkIdempotencyRecord<TBody = unknown>(
  db: IdempotencyDbClient,
  key: string,
  expectedAction: string,
  expectedHash: string
): Promise<IdempotencyLookupResult<TBody>> {
  const res = await db.query<IdempotencyRecord & { is_expired?: boolean }>(
    `SELECT
       key,
       action,
       request_hash,
       response_status,
       response_body,
       created_at,
       expires_at,
       (expires_at <= NOW()) AS is_expired
     FROM idempotency_keys
     WHERE key = $1`,
    [key]
  );

  if (res.rows.length === 0) {
    return { found: false };
  }

  const record = res.rows[0];
  const expired =
    typeof record.is_expired === 'boolean'
      ? record.is_expired
      : new Date(record.expires_at).getTime() <= Date.now();

  if (expired) {
    return { found: true, expired: true };
  }

  if (record.action !== expectedAction || record.request_hash !== expectedHash) {
    throw new AppError(
      'Idempotency key reused with a different request.',
      409,
      'IDEMPOTENCY_CONFLICT'
    );
  }

  return {
    found: true,
    expired: false,
    responseStatus: record.response_status,
    responseBody: record.response_body as TBody,
  };
}

/**
 * Persists or refreshes (when expired) an idempotency key record with a strict 24-hour TTL.
 */
export async function storeIdempotencyRecord(
  client: IdempotencyDbClient,
  params: {
    key: string;
    action: string;
    requestHash: string;
    responseStatus: number;
    responseBody: unknown;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (
       key, action, request_hash, response_status, response_body, created_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, NOW(), NOW() + INTERVAL '24 hours'
     )
     ON CONFLICT (key) DO UPDATE SET
       action = EXCLUDED.action,
       request_hash = EXCLUDED.request_hash,
       response_status = EXCLUDED.response_status,
       response_body = EXCLUDED.response_body,
       created_at = NOW(),
       expires_at = NOW() + INTERVAL '24 hours'
     WHERE idempotency_keys.expires_at <= NOW()`,
    [
      params.key,
      params.action,
      params.requestHash,
      params.responseStatus,
      JSON.stringify(params.responseBody),
    ]
  );
}

/**
 * Updates stored response_body after post-commit asynchronous work (e.g., PDF upload / r2_object_key)
 * so subsequent replays match current persisted document state.
 */
export async function updateIdempotencyResponse(
  db: IdempotencyDbClient,
  params: {
    key: string;
    action: string;
    requestHash: string;
    responseStatus: number;
    responseBody: unknown;
  }
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys
     SET response_status = $4,
         response_body = $5
     WHERE key = $1
       AND action = $2
       AND request_hash = $3
       AND expires_at > NOW()`,
    [
      params.key,
      params.action,
      params.requestHash,
      params.responseStatus,
      JSON.stringify(params.responseBody),
    ]
  );
}

/**
 * Performs bounded, index-backed, non-blocking cleanup of expired idempotency records.
 * Uses pg_try_advisory_xact_lock so concurrent requests skip cleanup rather than blocking.
 */
export async function cleanupExpiredIdempotencyKeys(
  db: IdempotencyDbClient,
  limit = DEFAULT_EXPIRED_CLEANUP_LIMIT
): Promise<number> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
  const lockRes = await db.query<{ acquired?: boolean }>(
    `SELECT pg_try_advisory_xact_lock($1) AS acquired`,
    [IDEMPOTENCY_CLEANUP_LOCK_KEY]
  );

  // In mock tests returning [], treat undefined as skipped cleanly
  if (lockRes.rows.length > 0 && lockRes.rows[0].acquired === false) {
    return 0;
  }

  const deleteRes = await db.query(
    `DELETE FROM idempotency_keys
     WHERE key IN (
       SELECT key
       FROM idempotency_keys
       WHERE expires_at <= NOW()
       ORDER BY expires_at ASC
       LIMIT $1
     )`,
    [safeLimit]
  );

  return deleteRes.rowCount ?? 0;
}
