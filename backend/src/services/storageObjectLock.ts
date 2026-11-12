import type { PoolClient } from 'pg';

/**
 * Shared database-backed advisory locking for Cloudflare R2 / S3 object operations.
 *
 * Uses PostgreSQL 64-bit hashtextextended($1::text, 0) to deterministically derive
 * an advisory lock key from the object key.
 *
 * This coordinates multiple processes / Render web instances and prevents:
 * 1. An object being attached while a cleanup worker is checking references or deleting it.
 * 2. Two cleanup workers racing to delete the same object key concurrently.
 * 3. Concurrent image/attachment replacements reading stale keys.
 */

/**
 * Acquires a transaction-level advisory lock on an object key.
 * Automatically released when the transaction commits or rolls back.
 */
export async function acquireObjectLockInTransaction(
  client: PoolClient,
  objectKey: string
): Promise<void> {
  const cleanKey = objectKey?.trim();
  if (!cleanKey) return;

  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    [cleanKey]
  );
}

/**
 * Acquires transaction-level advisory locks for multiple keys in deterministic
 * lexicographical order to prevent deadlocks across concurrent transactions.
 */
export async function acquireObjectLocksInTransaction(
  client: PoolClient,
  keys: (string | null | undefined)[]
): Promise<void> {
  const sortedUniqueKeys = Array.from(
    new Set(
      keys
        .map((k) => k?.trim())
        .filter((k): k is string => Boolean(k && k.length > 0))
    )
  ).sort();

  for (const key of sortedUniqueKeys) {
    await acquireObjectLockInTransaction(client, key);
  }
}

/**
 * Acquires a session-level advisory lock on an object key.
 * Must be explicitly released with releaseObjectSessionLock using the same client.
 * Used by workers that must hold a lock across external R2 deletion requests
 * without leaving a database transaction open.
 */
export async function acquireObjectSessionLock(
  client: PoolClient,
  objectKey: string
): Promise<boolean> {
  const cleanKey = objectKey?.trim();
  if (!cleanKey) return false;

  await client.query(
    `SELECT pg_advisory_lock(hashtextextended($1::text, 0))`,
    [cleanKey]
  );
  return true;
}

/**
 * Releases a session-level advisory lock on an object key.
 */
export async function releaseObjectSessionLock(
  client: PoolClient,
  objectKey: string
): Promise<boolean> {
  const cleanKey = objectKey?.trim();
  if (!cleanKey) return false;

  try {
    const res = await client.query(
      `SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`,
      [cleanKey]
    );
    return Boolean(res.rows[0]?.pg_advisory_unlock);
  } catch {
    return false;
  }
}
