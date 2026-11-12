# Khata ERP — Release #032 Storage Lifecycle, Advisory Locking & Worker Fencing Specification

## 1. Cloudflare R2 Object Storage Model

Khata ERP uses Cloudflare R2 (S3-compatible object storage) for:
1. Product reference images (`products/`)
2. Offline bill receipt snapshots (`offline-bills/`)
3. Supplier purchase bill attachments & invoices (`supplier-bills/`)
4. Customer quotation company logos (`quotations/` or `logos/`)
5. Generated PDF invoices & quotations (`invoices/`, `bills/`, `quotations/`)

---

## 2. Presigned Storage Upload Intent Lifecycle

To prevent orphaned objects and guarantee reference integrity, all presigned client uploads follow a 3-step lifecycle backed by PostgreSQL table `storage_upload_intents` (Migration 033):

```
       CLIENT                             SERVER (EXPRESS)                    POSTGRESQL                    CLOUDFLARE R2
         |                                       |                                 |                              |
  1. POST /api/v1/storage/upload-intent --------->|                                 |                              |
         |                                       |--- registerIntent() ----------->|                              |
         |                                       |    (status: 'issued', 5m)       | (inserted row)               |
         |                                       |<--------------------------------|                              |
         |                                       |--- presignPutObject() ---------------------------------------->|
         |<-- { uploadUrl, objectKey } ----------|                                                                |
         |                                                                                                        |
  2. PUT uploadUrl (direct binary stream) ----------------------------------------------------------------------->|
         |                                                                                                        |
  3. POST /api/v1/products/:id/image ----------->|                                                                |
         |                                       |--- BEGIN TX ------------------->|                              |
         |                                       |--- lockAndValidateIntent() ---->| (FOR UPDATE)                 |
         |                                       |    (verify status='issued')     |                              |
         |                                       |--- headObject() ---------------------------------------------->|
         |                                       |    (verify R2 presence)         |                              |
         |                                       |--- UPDATE products ------------>|                              |
         |                                       |--- completeIntent() ----------->| (status: 'completed')        |
         |                                       |--- enqueueCleanup(oldKey) ----->| (atomic pg_notify)           |
         |                                       |--- COMMIT TX ------------------>|                              |
         |<-- { success: true } -----------------|                                                                |
```

### Reference Safety in Cleanup Service
`storageCleanupService.findLiveObjectReferences(key)` inspects `storage_upload_intents` for active rows:
```sql
EXISTS (
  SELECT 1
  FROM storage_upload_intents
  WHERE object_key = $1
    AND status = 'issued'
    AND expires_at > NOW()
) AS in_upload_intents
```
If an upload intent is active, cleanup skips deletion, protecting in-flight uploads against premature deletion.

---

## 3. Distributed Advisory Locking (`storageObjectLock.ts`)

PostgreSQL session-level advisory locks synchronize concurrent web instances and background cleanup workers without leaving database transactions open during long-running network I/O:

- **Key Derivation:** 64-bit hashing via `hashtextextended(cleanKey, 0)`.
- **Deadlock Immunity via Lexicographical Sorting:** When acquiring locks on multiple keys (such as replacing an old product image with a new one), keys are sorted lexicographically before calling `pg_advisory_lock`. Locks are released in reverse order in `finally` blocks.

```typescript
export async function acquireObjectSessionLocks(
  client: PoolClient,
  keys: (string | null | undefined)[]
): Promise<string[]> {
  const sortedUniqueKeys = Array.from(
    new Set(keys.map((k) => k?.trim()).filter(Boolean))
  ).sort();

  for (const key of sortedUniqueKeys) {
    await acquireObjectSessionLock(client, key);
  }
  return sortedUniqueKeys;
}
```

---

## 4. Worker Claim-Ownership Fencing & PG_NOTIFY Subscription

### Claim Fencing Table Schema (Migration 032)
```sql
ALTER TABLE storage_cleanup_jobs
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_version BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_processing_claim
  ON storage_cleanup_jobs (next_attempt_at ASC, id ASC)
  WHERE status IN ('pending', 'processing', 'failed');
```

### Claim Query with FOR UPDATE SKIP LOCKED
```sql
WITH next_batch AS (
  SELECT id
  FROM storage_cleanup_jobs
  WHERE (status = 'pending' OR (status = 'failed' AND attempt_count < max_attempts))
    AND next_attempt_at <= NOW()
  ORDER BY next_attempt_at ASC, id ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED
),
claimed AS (
  UPDATE storage_cleanup_jobs j
  SET status = 'processing',
      lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
      attempt_count = j.attempt_count + 1,
      claim_version = j.claim_version + 1,
      claim_token = gen_random_uuid(),
      updated_at = NOW()
  FROM next_batch nb
  WHERE j.id = nb.id
  RETURNING j.id, j.object_key, j.claim_token, j.claim_version
)
SELECT * FROM claimed ORDER BY id ASC;
```

### Optimistic Fencing on State Transitions
When marking a job completed, failed, or dead-lettered:
```sql
UPDATE storage_cleanup_jobs
SET status = 'completed',
    lease_expires_at = NULL,
    claim_token = NULL,
    completed_at = NOW(),
    updated_at = NOW()
WHERE id = $1
  AND status = 'processing'
  AND claim_token = $2
RETURNING id;
```
If `res.rowCount === 0`, the worker was fenced out (lease expired and claimed by another worker), guaranteeing that stale workers can never overwrite active or reclaimed jobs.

### Event-Driven PostgreSQL LISTEN / NOTIFY
Workers subscribe via dedicated connection:
```sql
LISTEN storage_cleanup_jobs;
```
Enqueuing jobs inside a transaction executes:
```sql
SELECT pg_notify('storage_cleanup_jobs', id::text);
```
PostgreSQL dispatches this notification strictly upon transaction commit, eliminating premature wakeups for uncommitted jobs.
