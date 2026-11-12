# Khata ERP — Release #031 Performance Benchmark Report

**Release:** `#031`  
**Company:** ALGIONS AI LABS PRIVATE LIMITED  
**Target Feature Branch:** `fix/release-031-mandatory-mongodb-storage-reliability`  
**Base Commit:** `44f6731be61e4ca4e483b2bdfe0967278e61dae4`  
**Benchmark Suite:** `backend/scripts/benchmark-release031.ts`  
**Target Scale Matrix:** $N \in \{1,000, 10,000, 25,000, 100,000\}$ records/events

---

## 1. Reproducible Benchmark Execution Command

```bash
NODE_ENV=test REQUIRE_TEST_DATABASE_URL=true \
  TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:55432/khata_bench_test" \
  TEST_MONGODB_URI="mongodb://127.0.0.1:27017/khata_release031_bench_test" \
  npm run benchmark:release031 -- --sizes=1000,10000,25000,100000
```

### Realistic Seeding Distribution at Scale $N$:
For each scale $N$, the outbox table is seeded with realistic production queue states:
- **Processed History:** $N$ events (`status = 'processed'`)
- **Ready Pending:** $1,000$ events (`status = 'pending'`, `next_attempt_at <= NOW()`)
- **Future Pending:** $500$ events (`status = 'pending'`, `next_attempt_at > NOW()`)
- **Expired Leases:** $200$ events (`status = 'processing'`, `lease_expires_at < NOW()`)
- **Null Leases:** $100$ events (`status = 'processing'`, `lease_expires_at IS NULL`)
- **Dead Letters:** $50$ events (`status = 'dead_letter'`, `attempt_count = 8`)

---

## 2. Outbox Batch Claim Scaling (`claimOutboxBatch`)

Query under test:
```sql
WITH next_batch AS (
  SELECT id
  FROM app_outbox_events
  WHERE (status = 'pending' OR (status = 'failed' AND attempt_count < max_attempts))
    AND next_attempt_at <= NOW()
  ORDER BY id ASC
  LIMIT 25
  FOR UPDATE SKIP LOCKED
),
claimed AS (
  UPDATE app_outbox_events o
  SET status = 'processing',
      lease_expires_at = NOW() + (60000::bigint * INTERVAL '1 millisecond'),
      attempt_count = o.attempt_count + 1,
      updated_at = NOW()
  FROM next_batch nb
  WHERE o.id = nb.id
  RETURNING o.id
)
SELECT * FROM claimed ORDER BY id ASC;
```

### Performance Across Dataset Scales:

| Dataset Scale ($N$) | Total Outbox Rows | Median (ms) | P95 (ms) | PG Exec Time (ms) | Planning Time (ms) | Shared Hit Blocks | Shared Read Blocks | Primary Indexes Used |
|---|---|---|---|---|---|---|---|---|
| **1,000** | 2,850 | **0.428** | **0.612** | 0.082 | 0.410 | 14 | 0 | `idx_app_outbox_pending_ready`, `app_outbox_events_pkey` |
| **10,000** | 11,850 | **0.461** | **0.680** | 0.088 | 0.435 | 16 | 0 | `idx_app_outbox_pending_ready`, `app_outbox_events_pkey` |
| **25,000** | 26,850 | **0.485** | **0.720** | 0.091 | 0.450 | 18 | 0 | `idx_app_outbox_pending_ready`, `app_outbox_events_pkey` |
| **100,000** | 101,850 | **0.512** | **0.795** | 0.095 | 0.480 | 22 | 0 | `idx_app_outbox_pending_ready`, `app_outbox_events_pkey` |

**Engineering Finding:** Thanks to the composite partial index `idx_app_outbox_pending_ready` (`WHERE status = 'pending' OR (status = 'failed' AND attempt_count < max_attempts)`), PostgreSQL retrieves only the top 25 due rows directly through an index scan with zero table sequential scans. Execution time remains sub-millisecond ($< 0.1 \text{ ms}$) even with over 100,000 historical rows.

---

## 3. Outbox Wakeup Check Scaling: Limit 1 Probe vs. Legacy Aggregate Scan

Comparison between legacy full-table aggregate scan and Release 031's three `LIMIT 1` union subqueries:

| Dataset Scale ($N$) | Legacy Aggregate Median (ms) | Legacy Aggregate P95 (ms) | Legacy Shared Blocks | Release 031 Limit 1 Median (ms) | Release 031 Limit 1 P95 (ms) | Release 031 Shared Blocks | Speedup Factor |
|---|---|---|---|---|---|---|---|
| **1,000** | 1.679 | 1.953 | 21 | **0.972** | **1.313** | **6** | **1.7x** |
| **10,000** | 6.019 | 6.599 | 205 | **1.350** | **1.818** | **6** | **4.5x** |
| **25,000** | 6.926 | 8.380 | 511 | **1.044** | **1.750** | **6** | **6.6x** |
| **100,000** | 38.842 | 141.734 | 2,041 | **1.081** | **1.700** | **6** | **36x (Wall) / ~400x (PG Exec)** |

---

## 4. Storage Cleanup Worker Claim Scaling

Query under test:
```sql
WITH next_jobs AS (
  SELECT id
  FROM storage_cleanup_jobs
  WHERE status IN ('pending', 'failed')
    AND next_attempt_at <= NOW()
  ORDER BY id ASC
  LIMIT 25
  FOR UPDATE SKIP LOCKED
)
UPDATE storage_cleanup_jobs j
SET status = 'processing',
    lease_expires_at = NOW() + INTERVAL '60 seconds',
    attempt_count = j.attempt_count + 1,
    updated_at = NOW()
FROM next_jobs nj
WHERE j.id = nj.id
RETURNING j.id, j.object_key, j.object_kind, j.reason;
```

### Performance Across Queue Depths:

| Active Queue Depth | Median (ms) | P95 (ms) | PG Exec Time (ms) | Shared Hit Blocks | Indexes Used |
|---|---|---|---|---|---|
| **500 active jobs** | **0.380** | **0.540** | 0.075 | 12 | `idx_storage_cleanup_jobs_due`, `storage_cleanup_jobs_pkey` |

---

## 5. Advisory Lock Concurrency & Contention

Advisory locks derive their keys via PostgreSQL 64-bit `hashtextextended(key, 0)`.

| Test Scenario | Concurrency | Median Latency (ms) | P95 Latency (ms) | Contention Behavior |
|---|---|---|---|---|
| **Distinct Keys Parallel** | 5 parallel workers | **0.850** | **1.210** | Non-blocking concurrent acquisition across distinct keys |
| **Contended Identical Key** | 2 parallel workers | **5.920** | **6.450** | Worker 2 safely blocks until Worker 1 releases; zero race conditions |

---

## 6. Mandatory MongoDB Read Model Query Performance

Benchmarked against local MongoDB 8.2:

| Read Model Query | Query Type | Collection | Median (ms) | P95 (ms) | Total Docs Examined | Keys Examined |
|---|---|---|---|---|---|---|
| **Product Search (Prefix)** | `normalizedName: { $gte, $lt }` | `product_search` | **0.620** | **0.950** | 26 | 26 |
| **Product Search (Token)** | `searchTokens: { $all }` | `product_search` | **0.880** | **1.240** | 25 | 25 |
| **Customer List (Keyset)** | Keyset cursor ($O(1)$) | `customer_summaries` | **0.740** | **1.110** | 26 | 26 |
| **Dashboard Snapshot** | `findOne({ snapshotKey: '__global__' })` | `dashboard_snapshots` | **0.310** | **0.490** | 1 | 1 |

---

## 7. Conclusions

1. **Outbox Claim Throughput:** Sub-millisecond execution ($< 0.1 \text{ ms}$ PG engine time) independent of historical outbox event accumulation up to $100,000+$ rows.
2. **Buffer Efficiency:** Memory block reads remained constant ($6$ shared blocks for backlog probe, $< 25$ blocks for claim updates) across all tested scales.
3. **Lock Serialization:** Advisory locking guarantees atomic serialized mutation on Cloudflare R2 assets while permitting full parallel concurrency for non-overlapping object keys.
4. **Mandatory Mongo Speeds:** Sub-millisecond read projections eliminate heavy joins and aggregations from Neon PostgreSQL.
