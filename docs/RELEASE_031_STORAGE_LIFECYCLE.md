# Khata ERP — Release #031 Storage Lifecycle & Cloudflare R2 Reliability Guide

**Release:** `#031`  
**Company:** ALGIONS AI LABS PRIVATE LIMITED  
**Architecture Domain:** Cloudflare R2 Object Storage, PostgreSQL Transactional Consistency, Distributed Advisory Locks, Durable Asynchronous Garbage Collection

---

## 1. Architectural Overview & Problem Statement

Khata ERP integrates Cloudflare R2 (S3-compatible object storage) for storing user-uploaded binary assets:
- **Product Images:** `products/{productId}/{uuid}.{jpg|png|webp}`
- **Supplier Purchase Bill Attachments (PDF & Images):** `supplier-bills/{billId}/{uuid}.{pdf|jpg|png|webp}`
- **Offline Bill Receipts:** `offline-bills/{billId}/{uuid}.{jpg|png|webp}`
- **GST Invoices & Normal Bills:** Canonical rendered PDF blobs
- **Quotation Settings:** Shop logo images

### 1.1 The Vulnerability Pre-Release 031

Prior to Release 031, file replacements and deletions exhibited two dangerous edge cases:
1. **Asynchronous Orphan Leakage:** When a product image or bill attachment was replaced or deleted, the application either attempted an immediate external R2 network call before committing the database transaction, or attempted it after commit without atomic guarantees. If the process crashed, the network timed out, or the database transaction rolled back, either:
   - R2 storage held orphan objects that were never recorded for cleanup (leaking billing storage costs indefinitely).
   - An active database record had its image prematurely deleted from R2 while the transaction was still in flight.
2. **Worker vs. User Mutation Race Conditions:** If an asynchronous storage cleanup worker attempted to delete an object while an owner was re-attaching or referencing the exact same key or updating the entity, race conditions occurred without inter-process coordination across Render web instances.
3. **False Success Errors:** Delete operations that failed due to transient network drops (`ECONNRESET`) or authentication errors could be swallowed or misclassified, or missing keys (`NoSuchKey`) could be treated as fatal failures causing stuck retry loops.

---

## 2. The Release 031 Storage Lifecycle Architecture

```text
       USER ACTION (Replace / Remove Attachment)
                          |
                          v
               START PG TRANSACTION (BEGIN)
                          |
             [1] SELECT ... FOR UPDATE (Row Lock)
                          |
    [2] Acquire Advisory Locks in Sorted Order:
        SELECT pg_advisory_xact_lock(hashtextextended(key, 0))
                          |
           [3] UPDATE Entity Table (Set Key = New / NULL)
                          |
    [4] ATOMIC ENQUEUE INTO storage_cleanup_jobs:
        INSERT INTO storage_cleanup_jobs (object_key, object_kind, reason, status)
        VALUES (old_key, kind, reason, 'pending')
                          |
             [5] Enqueue Outbox Event
                          |
               COMMIT PG TRANSACTION
        (Advisory locks released automatically on commit)
                          |
                          v
         BACKGROUND STORAGE CLEANUP WORKER
                          |
    [6] Claim Pending Job (FOR UPDATE SKIP LOCKED)
                          |
    [7] Acquire Session Advisory Lock on Key:
        SELECT pg_advisory_lock(hashtextextended(key, 0))
                          |
    [8] Check All 6 Live Tables for Active References:
        products, offline_bill_records, supplier_purchase_bills,
        gst_invoices, normal_bills, quotation_settings
                          |
          ---------------------------------
          |                               |
    References Found               Zero References
          |                               |
    Mark Job 'completed'            Delete from R2
    (Do NOT delete file)            (deleteObject)
          |                               |
          |                      -------------------
          |                      |                 |
          |                   Success           Failure
          |                 (or NoSuchKey)  (Net/Auth Error)
          |                      |                 |
          |                 Mark Job          Increment Attempt
          |                'completed'        Set next_attempt_at
          |                                   (Exponential Backoff)
          ---------------------------------
                          |
    [9] Release Session Advisory Lock:
        SELECT pg_advisory_unlock(hashtextextended(key, 0))
```

---

## 3. Transactional Cleanup Enqueuing

Object reference removals and cleanup job creation are strictly bound to the **same PostgreSQL transaction**:

```typescript
// backend/src/modules/products/products.service.ts
await client.query('BEGIN');
const existingRes = await client.query(
  `SELECT id, archived_at, image_object_key FROM products WHERE id = $1 FOR UPDATE`,
  [productId]
);

oldKey = existingRes.rows[0].image_object_key ?? null;

// Advisory lock both old and new keys in deterministic sorted order
await acquireObjectLocksInTransaction(client, [oldKey, cleanKey]);

await client.query(
  `UPDATE products SET image_object_key = $1, ... WHERE id = $2`,
  [cleanKey, productId]
);

// Atomically enqueue cleanup job in the SAME client transaction
if (oldKey && oldKey !== cleanKey) {
  await storageCleanupService.enqueueCleanupJobInTransaction(client, {
    objectKey: oldKey,
    objectKind: 'product_image',
    reason: 'product_image_replace',
  });
}

await enqueueOutboxEvent(client, { aggregateType: 'product', aggregateId: productId, eventType: 'product.image_updated' });
await client.query('COMMIT');
```

If the transaction rolls back for any reason, the row update, the outbox event, and the cleanup job are **all** rolled back together. The old object remains safely referenced and untouched in R2.

---

## 4. Distributed Advisory Locking

To coordinate across distributed Render instances and between background workers and user mutations, Release 031 establishes a unified 64-bit advisory lock namespace.

### 4.1 64-Bit Hash Derivation
All object locks are computed using PostgreSQL's native hash function:
```sql
SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0));
```
- `hashtextextended(text, 0)` produces an evenly distributed 64-bit signed `bigint` matching PostgreSQL's 64-bit advisory lock space.
- Zero hash collisions observed across practical key spaces.

### 4.2 Multi-Key Deadlock Prevention
When an operation mutates an entity with both an old key and a new key (e.g. replacing image A with image B), acquiring locks in arbitrary order risks deadlocks with concurrent transactions.

Release 031 enforces **lexicographical sorting**:
```typescript
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
```

### 4.3 Transaction vs. Session Locks
- **User Mutations:** Use `pg_advisory_xact_lock`. The lock is held during the database transaction and released automatically by PostgreSQL on `COMMIT` or `ROLLBACK`.
- **Background Cleanup Workers:** Use `pg_advisory_lock` / `pg_advisory_unlock` on dedicated session clients. This allows the worker to verify database references, make the HTTP call to Cloudflare R2, and finalize the job record without holding an open database transaction during slow network I/O.

---

## 5. False-Success Prevention & Idempotent Deletion

Cloudflare R2 and AWS S3 delete operations require careful error discrimination:

```typescript
// backend/src/services/storage.service.ts
public async deleteObject(objectKey: string): Promise<void> {
  if (!objectKey || !objectKey.trim()) {
    throw new AppError('Storage object key is required.', 400, 'INVALID_OBJECT_KEY');
  }
  this.assertConfigured();

  try {
    await this.s3Client!.send(
      new DeleteObjectCommand({
        Bucket: env.R2_BUCKET_NAME!,
        Key: objectKey.trim(),
      })
    );
  } catch (err) {
    // NoSuchKey / 404 is an idempotent success — the object is already deleted.
    if (isNoSuchKeyError(err)) {
      return;
    }
    // Network errors (ECONNRESET), 403 Access Denied, 500 Internal S3 Error
    // MUST propagate so the cleanup worker reschedules the job for durable retry.
    throw err;
  }
}
```

### Distinction Table:

| Error Type | Example | Handling | Worker Outcome |
|---|---|---|---|
| **NoSuchKey** | `err.name === 'NoSuchKey'` | Return normally (No-op) | Job marked `completed` |
| **HTTP 404** | `err.$metadata?.httpStatusCode === 404` | Return normally (No-op) | Job marked `completed` |
| **Network Timeout** | `ECONNRESET`, `ETIMEDOUT` | Propagate error | Job marked `failed`, exponential backoff scheduled |
| **Permission Error** | `AccessDenied` (HTTP 403) | Propagate error | Job marked `failed`, alert logged |
| **Cloudflare Outage** | HTTP 500 / 503 | Propagate error | Job marked `failed`, retried up to `max_attempts` |

---

## 6. Live Reference Safety Verification

Before any object is deleted from Cloudflare R2, `storageCleanupService.findLiveObjectReferences` checks all six R2-backed database tables in a single query:

```sql
SELECT
  EXISTS (SELECT 1 FROM products WHERE image_object_key = $1) AS in_products,
  EXISTS (SELECT 1 FROM offline_bill_records WHERE image_object_key = $1) AS in_offline_bills,
  EXISTS (SELECT 1 FROM supplier_purchase_bills WHERE attachment_object_key = $1) AS in_supplier_bills,
  EXISTS (SELECT 1 FROM gst_invoices WHERE r2_object_key = $1) AS in_gst_invoices,
  EXISTS (SELECT 1 FROM normal_bills WHERE r2_object_key = $1) AS in_normal_bills,
  EXISTS (
    SELECT 1
    FROM quotation_settings
    WHERE logo_url = $1
       OR RIGHT(SPLIT_PART(logo_url, '?', 1), LENGTH($1) + 1) = '/' || $1
  ) AS in_quotation_settings
```

If `referencedIn.length > 0`:
1. The physical delete from Cloudflare R2 is **skipped**.
2. A security warning log is emitted: `[STORAGE CLEANUP] Skipping R2 delete because object key is still referenced in database`.
3. The job is marked `completed` to prevent retry storms on an actively used asset.
