# Khata ERP — Release #030 Performance Benchmark Report

**Release:** `#030`  
**Company:** ALGIONS AI LABS PRIVATE LIMITED  
**Branch:** `fix/release-030-performance-and-reliability`  
**Methodology:** Reproducible automated benchmark against local PostgreSQL 18.6 (`127.0.0.1:55432`) and local MongoDB 8.2.4 (`127.0.0.1:27017`) across dataset scales `N ∈ {1,000, 10,000, 25,000, 100,000}` records/events (`backend/scripts/benchmark-release030.ts`).

> **Environment Scope Note:** All latencies below were measured on disposable local databases (`khata_bench_test` / `khata_release030_bench_test`) with warm local buffer pools and `100,000` seeded rows/events. Production Neon PostgreSQL and MongoDB Atlas clusters experience network RTT, shared IOPS, and cold-cache effects; buffer/block counts (`shared hit/read`), `keysExamined`, `docsExamined`, and query execution plan operators provide the hardware-independent comparison baseline.

---

## 1. Reproducible Execution Command & Environment Capabilities

```bash
NODE_ENV=test REQUIRE_TEST_DATABASE_URL=true \
  TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:55432/khata_bench_test" \
  TEST_MONGODB_URI="mongodb://127.0.0.1:27017/khata_release030_bench_test" \
  npm run benchmark:release030 -- --sizes=1000,10000,25000,100000
```

- **Benchmark Total Wall Time (`1k -> 100k` seeding + migrations + Mongo bulkWrite + timed runs + EXPLAIN):** `182,188.935 ms`
- **Observed `inspectSearchIndexCapabilities()` State on PostgreSQL 18.6:**
  - `pgTrgmInstalled`: `true`
  - `fallbackSearchMode`: `pg_trgm_gin`
  - `presentOptionalIndexes` (6/6):
    - `idx_products_active_name_trgm`
    - `idx_products_active_hsn_trgm`
    - `idx_products_active_barcode_trgm`
    - `idx_customers_active_name_trgm`
    - `idx_customers_active_phone_trgm`
    - `idx_customers_active_normalized_phone_trgm`
  - `missingOptionalIndexes`: `[]`

---

## 2. Outbox Wakeup Scaling (`app_outbox_events`: Legacy Aggregate Scan vs Release #030 `LIMIT 1` Union Probe)

At each dataset scale `N`, the table holds `N - 5` historical `'processed'` events alongside `'pending'`, `'failed'` (with exhausted and retryable rows), and `'processing'` (both expired-lease and `NULL`-lease) rows.

| Dataset Size (`N`) | Legacy Aggregate Median (ms) | Legacy P95 (ms) | Legacy PG Plan (`EXPLAIN`) | Legacy PG Exec (ms) | Legacy Shared Blocks | Release #030 Median (ms) | Release #030 P95 (ms) | Release #030 PG Plan (`EXPLAIN`) | Release #030 PG Exec (ms) | Release #030 Shared Blocks | Queries / Check | Idle Timers |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **1,000** | 1.679 | 1.953 | `Aggregate -> Seq Scan` | 0.626 | 21 | **0.972** | **1.313** | `Merge Append -> 3x Index Only Scan` | **0.056** | **6** | 1 | 0 |
| **10,000** | 6.019 | 6.599 | `Aggregate -> Seq Scan` | 2.998 | 205 | **1.350** | 8.018 | `Merge Append -> 3x Index Only Scan` | **0.119** | **6** | 1 | 0 |
| **25,000** | 6.926 | 8.380 | `Aggregate -> Seq Scan` | 7.369 | 511 | **1.044** | **1.750** | `Merge Append -> 3x Index Only Scan` | **0.063** | **6** | 1 | 0 |
| **100,000** | 38.842 | 141.734 | `Aggregate -> Gather -> Parallel Seq Scan` | 35.585 | 2,041 | **1.081** | **1.700** | `Merge Append -> 3x Index Only Scan` | **0.085** | **6** | 1 | 0 |

### Outbox Batch Claim & Completion (`N = 100,000`)

- **`claimOutboxBatch` (`FOR UPDATE SKIP LOCKED`, `LIMIT 25`):**
  - PG Execution Time: `0.095 ms` (`Planning Time: 0.536 ms`)
  - Indexes Used: `idx_app_outbox_pending_ready`, `app_outbox_events_pkey`
  - Shared Hit Blocks: `1`
- **`markEventsProcessed` (`WHERE id = ANY($1::bigint[])`):**
  - PG Execution Time: `0.150 ms` (`Planning Time: 0.107 ms`)
  - Indexes Used: `app_outbox_events_pkey`
  - Shared Hit Blocks: `18`

**Key Outcome:** Replacing the full-table aggregate scan with three `LIMIT 1` subqueries (`UNION ALL` over `idx_app_outbox_pending_wake`, `idx_app_outbox_failed_retryable`, and `idx_app_outbox_processing_wake`) reduced PostgreSQL server execution at `N = 100,000` from **`35.585 ms` (`2,041` shared blocks via `Parallel Seq Scan`)** down to **`0.085 ms` (`6` shared blocks)** — a **~418x PG server execution speedup** with **`O(log N)`** constant buffer cost independent of processed history size.

---

## 3. MongoDB Deep `.skip()` vs Signed Keyset Cursor Pagination

Measured on `customer_summaries` sorted by `{ outstandingPaise: -1, lastActivityAt: -1, customerId: 1 }` (`limit = 25`, examining `26` docs for `hasMore`):

| Dataset Size (`N`) | Deep Offset | `.skip()` Median (ms) | `.skip()` P95 (ms) | `.skip()` `keysExamined` | Release #030 Cursor Median (ms) | Release #030 Cursor P95 (ms) | Cursor `keysExamined` | Cursor `docsExamined` | Tie Multi-Page Unique / Collected |
|---|---|---|---|---|---|---|---|---|---|
| **1,000** | 800 | 6.299 | 42.269 | 826 | **4.341** | **5.509** | **36** | 26 | **100 / 100** |
| **10,000** | 8,000 | 16.381 | 29.730 | 8,026 | **3.640** | **5.272** | **28** | 26 | **100 / 100** |
| **25,000** | 20,000 | 378.491 | 500.268 | 20,026 | **4.838** | **6.165** | **27** | 26 | **100 / 100** |
| **100,000** | 80,000 | 184.787 | 241.001 | 80,026 | **2.736** | **4.159** | **27** | 26 | **100 / 100** |

**Key Outcome:** At depth `80,000`, keyset cursor pagination achieved **`2.736 ms` median** (`27` index keys examined, `26` docs fetched) versus **`184.787 ms` median (`241.001 ms` p95)** scanning `80,026` keys under `.skip()`, while preserving **`100 / 100` unique zero-skip traversal** across tied balances and `NULL` activity timestamps.

---

## 4. Product & Customer Search Matrix (`N = 1,000` to `N = 100,000`)

Measured through live production query methods (`readModelsQueryService`, `productsService.listActiveProducts`, `khataService.listCustomers`) plus MongoDB `.explain('executionStats')`:

| Search Case | N=1k Mongo Med (ms) | N=1k PG Med (ms) | N=10k Mongo Med (ms) | N=10k PG Med (ms) | N=25k Mongo Med (ms) | N=25k PG Med (ms) | N=100k Mongo Med (ms) | N=100k Mongo P95 (ms) | N=100k PG Med (ms) | N=100k PG P95 (ms) | N=100k Mongo Stages (`keys / docs / rows`) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `exact_barcode` | 3.373 | 1.582 | 1.571 | 0.982 | 1.497 | 0.913 | **1.454** | 1.856 | **0.639** | 1.161 | `SORT -> FETCH -> IXSCAN(idx_product_search_active_barcode)` (`1 / 1 / 1`) |
| `exact_hsn` | 5.365 | 3.874 | 8.174 | 2.431 | 58.076 | 2.865 | 118.491 | 160.054 | **3.994** | 5.046 | `LIMIT -> FETCH -> IXSCAN(idx_product_search_active_name)` (`1253 / 1253 / 25`)* |
| `product_prefix` | 3.585 | 1.407 | 2.649 | 1.099 | 2.794 | 1.159 | **2.654** | 3.329 | **1.068** | 1.398 | `LIMIT -> FETCH -> IXSCAN(idx_product_search_active_name)` (`26 / 26 / 25`) |
| `multi_word_product` | 3.634 | 2.471 | 4.487 | 1.957 | 8.897 | 3.104 | **18.934** | 21.367 | **3.348** | 5.076 | `SORT -> FETCH -> IXSCAN(idx_product_search_active_tokens)` (`1000 / 1000 / 25`) |
| `hindi_search` (`बासमती`) | 2.512 | 3.050 | 2.894 | 11.578 | 2.387 | 27.343 | **3.049** | 4.686 | 92.401 | 112.233 | `SORT -> FETCH -> IXSCAN(idx_product_search_active_tokens)` (`1 / 1 / 1`) |
| `punjabi_search` (`ਪੰਜਾਬੀ`) | 2.873 | 2.195 | 2.177 | 8.234 | 2.264 | 19.852 | **2.393** | 3.010 | 111.683 | 129.631 | `SORT -> FETCH -> IXSCAN(idx_product_search_active_tokens)` (`1 / 1 / 1`) |
| `two_char_broad` (`ca`) | 4.297 | 1.987 | 3.423 | 1.216 | 2.210 | 1.183 | **4.043** | 5.224 | **1.171** | 1.587 | `LIMIT -> FETCH -> IXSCAN(idx_product_search_active_name)` (`26 / 26 / 25`) |
| `no_result` | 2.771 | 1.971 | 1.831 | 0.933 | 1.834 | 0.947 | **1.834** | 3.113 | **1.175** | 1.315 | `SORT -> FETCH -> IXSCAN(idx_product_search_active_tokens)` (`0 / 0 / 0`) |
| `customer_phone` (`+91 98111`) | 4.356 | 3.259 | 2.689 | 2.685 | 1.910 | 2.399 | **1.877** | 2.434 | **3.746** | 4.448 | `SORT -> FETCH -> IXSCAN(idx_customer_summaries_active_phone)` (`1 / 1 / 1`) |
| `customer_name` (`sharma`) | 2.469 | 3.322 | 4.252 | 4.608 | 7.269 | 6.536 | 27.915 | 40.143 | **14.561** | 15.235 | `SORT -> FETCH -> IXSCAN(idx_customer_summaries_active_name)` (`2000 / 2000 / 25`) |

> **Observed Optimizer Findings at `N = 100,000` (Honest Bottleneck Attribution):**
> 1. `* exact_hsn` on MongoDB: At `1k–25k`, MongoDB selected `SORT -> FETCH -> IXSCAN(idx_product_search_active_norm_hsn)`. At `100k`, because results are sorted by `{ normalizedName: 1, productId: 1 }` and the query applies `[normHsn, upperBound)` range, MongoDB's query planner switched to walking `idx_product_search_active_name` to avoid an in-memory sort (`1,253` keys examined, `17 ms` server exec).
> 2. **`pgFallback` Non-ASCII (`hindi_search` / `punjabi_search`):** On `100k` seeded ASCII-heavy names with short non-ASCII `ILIKE '%बासमती%'` strings lacking standard ASCII trigrams, `pg_trgm` selectivity drops or falls back toward wider heap rechecks (`92–111 ms`), whereas MongoDB's token-prefix index (`idx_product_search_active_tokens`) remained `~2.4–3.0 ms` (`1` key examined).

---

## 5. Verbatim PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` Plans (`N = 100,000`)

### 5.1 Legacy Full-Table Outbox Aggregate (Before Release #030)

```text
Finalize Aggregate  (cost=5835.48..5835.49 rows=1 width=48) (actual time=41.082..45.684 rows=1.00 loops=1)
  Buffers: shared hit=2041
  ->  Gather  (cost=5835.24..5835.45 rows=2 width=48) (actual time=28.511..45.670 rows=2.00 loops=1)
        Workers Planned: 1
        Workers Launched: 1
        Buffers: shared hit=2041
        ->  Partial Aggregate  (cost=4835.24..4835.25 rows=1 width=48) (actual time=14.066..14.067 rows=1.00 loops=2)
              Buffers: shared hit=2041
              ->  Parallel Seq Scan on app_outbox_events  (cost=0.00..2629.26 rows=58826 width=34) (actual time=0.005..2.977 rows=50002.50 loops=2)
                    Buffers: shared hit=2041
Planning Time: 0.153 ms
Execution Time: 45.733 ms
```

### 5.2 Release #030 3-Branch `LIMIT 1` Outbox Wakeup Probe

```text
Result  (cost=4.91..4.93 rows=1 width=16) (actual time=0.027..0.028 rows=1.00 loops=1)
  Buffers: shared hit=9
  InitPlan 1
    ->  Limit  (cost=3.11..4.91 rows=1 width=8) (actual time=0.025..0.026 rows=1.00 loops=1)
          Buffers: shared hit=9
          ->  Merge Append  (cost=3.11..8.53 rows=3 width=8) (actual time=0.024..0.025 rows=1.00 loops=1)
                Sort Key: "*SELECT* 1".candidate_wake_at
                Buffers: shared hit=9
                ->  Subquery Scan on "*SELECT* 1"  (cost=0.12..1.48 rows=1 width=8) (actual time=0.015..0.015 rows=1.00 loops=1)
                      ... ->  Index Only Scan using idx_app_outbox_pending_wake on app_outbox_events
                ->  Subquery Scan on "*SELECT* 2"  (cost=0.12..4.15 rows=1 width=8) (actual time=0.002..0.003 rows=1.00 loops=1)
                      ... ->  Index Only Scan using idx_app_outbox_failed_retryable on app_outbox_events app_outbox_events_1
                ->  Sort  (cost=2.83..2.84 rows=1 width=8) (actual time=0.006..0.006 rows=0.00 loops=1)
                      ... ->  Index Only Scan using idx_app_outbox_processing_wake on app_outbox_events app_outbox_events_2
Planning Time: 0.583 ms
Execution Time: 0.054 ms
```

### 5.3 Product PostgreSQL Fallback Multi-Field Search (`ILIKE '%basmati%'` OR `barcode = 'basmati'`)

```text
Limit  (cost=263.69..263.75 rows=26 width=149) (actual time=12.280..12.285 rows=26.00 loops=1)
  Buffers: shared hit=149 read=887 written=622
  ->  Sort  (cost=263.69..263.76 rows=31 width=149) (actual time=12.278..12.282 rows=26.00 loops=1)
        Sort Key: (lower(TRIM(BOTH FROM name))), id
        Sort Method: top-N heapsort  Memory: 33kB
        ->  Bitmap Heap Scan on products
              ->  BitmapOr
                    ->  Bitmap Index Scan on idx_products_active_name_trgm
                    ->  Bitmap Index Scan on idx_products_active_hsn_trgm
                    ->  Bitmap Index Scan on idx_products_barcode_active
                    ->  Bitmap Index Scan on idx_products_active_barcode_trgm
Planning Time: 0.428 ms
Execution Time: 12.386 ms
```

### 5.4 Customer PostgreSQL Fallback Search (`'%98111%'` with `MATERIALIZED matched_customers` CTE)

```text
Limit  (cost=4962.04..4962.10 rows=26 width=564) (actual time=75.552..75.563 rows=2.00 loops=1)
  Buffers: shared hit=1421 read=472 written=388
  CTE matched_customers
    ->  Seq Scan on customers c_1  (cost=0.00..3637.00 rows=180 width=67) (actual time=0.241..75.244 rows=2.00 loops=1)
          Filter: ((archived_at IS NULL) AND (((name)::text ~~* '%98111%'::text) OR ((phone)::text ~~* '%98111%'::text) OR ((COALESCE(normalized_phone, ''::character varying))::text ~~* '%98111%'::text)))
          Rows Removed by Filter: 99998
  ->  Sort ...
        ->  Hash Left Join ...
              ->  CTE Scan on matched_customers c
              ->  Nested Loop -> Index Scan using idx_udhar_tx_activity_composite on udhar_transactions u_1
Planning Time: 1.275 ms
Execution Time: 75.812 ms
```

> **Empirical Finding Documented:** In `5.4`, `WITH matched_customers AS MATERIALIZED (...)` successfully confines ledger aggregations (`tx_agg`, `alloc_agg`, `pay_agg`) strictly to the **2 matched customers** (using `Index Scan` on `udhar_transactions` instead of scanning all customer ledgers). However, inside `matched_customers` itself, PostgreSQL chose `Seq Scan` (`75.244 ms`) rather than `BitmapOr` over the GIN trigram indexes because `COALESCE(normalized_phone, '') ILIKE '%98111%'` wraps `normalized_phone` in `COALESCE(...)`, preventing planner index matching against `idx_customers_active_normalized_phone_trgm` (which indexes bare `normalized_phone`). Tracked as a follow-on SQL simplification candidate (`(normalized_phone IS NOT NULL AND normalized_phone ILIKE ...)`).
