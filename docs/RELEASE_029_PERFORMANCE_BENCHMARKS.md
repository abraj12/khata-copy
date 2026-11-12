# Khata ERP — Release #029 Performance Benchmarks

**Release:** `#029`  
**Owner:** ALGIONS AI LABS PRIVATE LIMITED  
**Measurement Date:** `2026-11-12`  
**Environment:** Local disposable databases only (zero production Neon, MongoDB Atlas, or R2 instances accessed)

---

## 1. Benchmark Environment & Methodology

| Parameter | Measured Environment |
|---|---|
| **Node.js Runtime** | `v22.18.0` |
| **OS / Architecture** | `win32/x64` |
| **PostgreSQL Engine** | `PostgreSQL 18.6` (`127.0.0.1:55432`, disposable DB `khata_bench_029_test`, guarded by `testDbGuard.ts` + `REQUIRE_TEST_DATABASE_URL=true`) |
| **MongoDB Engine** | `MongoDB 8.2.4` (`127.0.0.1:27017`, disposable DB `khata_bench_029_test`, indexes initialized via `ensureMongoIndexes()`) |
| **Dataset Scales** | MongoDB `product_search` & `customer_summaries`: `1,000`, `10,000`, `25,000`, `100,000` documents each.<br>PostgreSQL `app_outbox_events`: `100`, `1,000`, `10,000` events across `100` distinct aggregates (`batchSize=100`, `dashboardRefreshMinIntervalMs=60000`).<br>PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)`: `10,000` processed outbox rows + `50` dead-letter rows + `10` pending rows; `10,000+` products & customers. |
| **Latency Sampling** | Each end-to-end `readModelsQueryService` scenario executed `2` warmup calls followed by `10` timed iterations (`min`, `median`, `p95`, `max`). Concurrent bursts ran `20` parallel requests x `3` iterations. |

---

## 2. MongoDB Read-Model Scale Benchmarks (`1,000` → `100,000` Docs)

### 2.1 Before vs. After: Prefix Search & Redundant `countDocuments` Elimination

Compares:
- **Before pattern:** Unbounded `$regex` name/HSN filter + extra `countDocuments(filter)` round-trip per search query.
- **After pattern (`readModelsQuery.service.ts`):** Bounded lexicographic half-open interval `[prefix, upperBound)` (`buildLexicographicPrefixFilter`) on `normalizedName` & `normalizedHsnCode`, exact/bounds `searchTokens` filter, and omitted `countDocuments` on multi-page filtered searches (`total: null, totalIsExact: false`).

| Scale (`N`) | Before: `.explain()` Time (ms) | Before: Keys / Docs Examined | Before: Extra `countDocuments` (ms) | **Before Total (ms)** | **After: `.explain()` Time (ms)** | After: Keys / Docs Examined | Plan Check |
|---|---|---|---|---|---|---|---|
| `1,000` | `95` | `1,000` / `1,000` | `106.81` (`4` matched) | `201.81` | **`6`** | `4` / `4` | Zero `COLLSCAN` (`IXSCAN`) |
| `10,000` | `43` | `324` / `324` | `1,082.97` (`49` matched) | `1,125.97` | **`17`** | `49` / `49` | Zero `COLLSCAN` (`IXSCAN`) |
| `25,000` | `71` | `399` / `399` | `464.53` (`124` matched) | `535.53` | **`59`** | `124` / `124` | Zero `COLLSCAN` (`IXSCAN`) |
| `100,000` | `93` | `774` / `774` | `3,834.15` (`499` matched) | **`3,927.15`** | **`47`** | `499` / `499` | Zero `COLLSCAN` (`IXSCAN`) |

*Note on end-to-end service latency:* Calling `readModelsQueryService.searchProductsFromMongo({ search: 'pr', limit: 25 })` at `100,000` products took **`8.13 ms` median (`9.47 ms` p95)** with `total: null` and `totalIsExact: false`. Unfiltered catalog browse (`search=''`) serves exact totals in `O(1)` directly from `dashboard_snapshots.globals` without scanning collections.

---

### 2.2 Before vs. After: Deep Pagination (`.skip(offset)` vs. Signed Keyset `cursor`)

Measured at target offset `max(25, N - 50)` (`limit=25`, fetching `limit + 1 = 26` docs):

#### Product Catalog (`product_search`, sort `{ normalizedName: 1, productId: 1 }`)

| Scale (`N`) | Offset | Offset `.skip()` Time (ms) | Offset Keys Examined | **Keyset `cursor` Time (ms)** | Keyset Keys Examined | Speedup / Key Reduction |
|---|---|---|---|---|---|---|
| `1,000` | `950` | `51` | `976` | **`7`** | `26` | **`7.3x`** faster / `37.5x` fewer keys |
| `10,000` | `9,950` | `641` | `9,976` | **`8`** | `26` | **`80.1x`** faster / `383.7x` fewer keys |
| `25,000` | `24,950` | `643` | `24,976` | **`8`** | `26` | **`80.4x`** faster / `960.6x` fewer keys |
| `100,000` | `99,950` | `6,206` | `99,976` | **`13`** | `26` | **`477.4x`** faster / **`3,845.2x`** fewer keys |

#### Customer Ledger (`customer_summaries`, sort `{ outstandingPaise: -1, lastActivityAt: -1, customerId: 1 }`)

| Scale (`N`) | Offset | Offset `.skip()` Time (ms) | Offset Keys Examined | **Keyset `cursor` Time (ms)** | Keyset Keys Examined | Speedup / Key Reduction |
|---|---|---|---|---|---|---|
| `1,000` | `950` | `45` | `976` | **`7`** | `26` | **`6.4x`** faster |
| `10,000` | `9,950` | `687` | `9,976` | **`5`** | `26` | **`137.4x`** faster |
| `25,000` | `24,950` | `567` | `24,976` | **`9`** | `26` | **`63.0x`** faster |
| `100,000` | `99,950` | `5,439` | `99,976` | **`72`** | `26` | **`75.5x`** faster / **`3,845.2x`** fewer keys |

*(All `explain('executionStats')` plans confirmed index-backed `IXSCAN` / `SORT_MERGE` and zero `COLLSCAN`.)*

---

### 2.3 End-to-End `readModelsQueryService` Scenario Matrix (`1k` → `100k`)

Measured median (`p95`) latencies in milliseconds (`ms`) across realistic shopkeeper queries:

| Query Scenario | `1,000` Docs | `10,000` Docs | `25,000` Docs | `100,000` Docs |
|---|---|---|---|---|
| Exact Barcode (`000000501`) | `2.24` (`3.45`) | `3.06` (`3.57`) | `2.99` (`3.44`) | `2.62` (`3.70`) |
| Exact HSN (`11010000`) | `3.72` (`4.78`) | `12.46` (`14.48`) | `10.74` (`13.58`) | `18.01` (`23.51`) |
| Single-Word Prefix (`basmati`) | `3.36` (`3.90`) | `7.41` (`25.71`) | `8.13` (`11.35`) | `9.35` (`10.32`) |
| Multi-Word Product (`ashirwad chakki`) | `3.84` (`4.67`) | `4.70` (`5.58`) | `4.25` (`5.03`) | `6.04` (`19.97`) |
| Hindi Devanagari (`आटा`) | `4.51` (`5.18`) | `5.62` (`7.25`) | `6.02` (`7.57`) | `8.07` (`16.07`) |
| Punjabi Gurmukhi (`ਦਾਲ`) | `5.44` (`7.43`) | `5.52` (`6.57`) | `7.04` (`18.60`) | `11.08` (`13.24`) |
| Broad 2-Char Prefix (`pr`, skipped count) | `7.85` (`50.69`) | `6.48` (`51.74`) | `8.11` (`12.18`) | `8.13` (`9.47`) |
| No-Result Miss (`zzzznomatch999`) | `4.66` (`7.69`) | `4.12` (`5.41`) | `4.04` (`4.71`) | `3.03` (`4.03`) |
| Customer Phone Variant (`+91 98110`) | `4.29` (`5.96`) | `5.46` (`15.30`) | `4.20` (`4.71`) | `3.58` (`4.81`) |
| Customer Hindi Name (`राजेश्वरी`) | `3.65` (`5.12`) | `4.01` (`20.44`) | `3.95` (`6.60`) | `2.92` (`3.86`) |
| `20` Concurrent Mixed Searches (wall-clock total) | `49.61` (`104.55`) | `69.96` (`84.84`) | `53.89` (`54.14`) | `55.89` (`59.07`) |
| Tied Zero-Balance + `null` Activity Keyset Walk (`100` docs) | `65.93` ms (`100`/`100` unique) | `46.37` ms (`100`/`100` unique) | `20.18` ms (`100`/`100` unique) | `30.23` ms (`100`/`100` unique) |

---

## 3. PostgreSQL Outbox Worker & Coalescing Benchmarks (`100` / `1,000` / `10,000` Events)

Measured using `ReadModelOutboxWorker` (`batchSize=100`, `dashboardRefreshMinIntervalMs=60000`) draining duplicate-heavy pending events referencing `100` distinct aggregates (`50` products + `50` customers), followed by `flushDashboardRefresh()`:

| Outbox Queue Size | Distinct Aggregates | Wall-Clock Drain Time (ms) | Throughput (events/sec) | Total PG Queries | Mongo `bulkWrite` Ops | Full Dashboard Snapshot Refreshes |
|---|---|---|---|---|---|---|
| `100` | `100` (`50` prod + `50` cust) | `336.56` | `297.1` | `30` | `2` | `2` |
| `1,000` | `100` (`10x` duplicates/agg) | `804.25` | `1,243.4` | `120` | `20` | `2` |
| `10,000` | `100` (`100x` duplicates/agg) | `7,496.84` | `1,333.9` | `1,020` | `200` | `2` |

*Key observations:*
1. Without Release 029 batch coalescing + `skipDashboardSnapshot` trailing scheduling, `10,000` events across `100` batches would otherwise recompute the full global PostgreSQL `dashboard_snapshots` aggregation after every batch (`100+` multi-CTE snapshot scans) instead of **2** coalesced refreshes (one leading-edge / trailing drain cycle + final flush).
2. Within every `100`-event batch, `applyOutboxBatch` deduplicated repeated aggregate updates into single `ANY($1::bigint[])` PG queries and paired `ProductSearchModel.bulkWrite` / `CustomerSummaryModel.bulkWrite` writes (`2` bulk writes per batch).

---

## 4. PostgreSQL 18.6 `EXPLAIN (ANALYZE, BUFFERS)` — Migration 028 & 029 Indexes

Populated local `khata_bench_029_test` with `10,000` `processed` outbox events, `50` `dead_letter` events, `10` `pending` events, and `10,000+` `products` and `customers`:

### 4.1 Outbox Queries

| Query Target | Before (`enable_indexscan=off, enable_bitmapscan=off`) | After (Partial Index Enabled + `VACUUM ANALYZE`) |
|---|---|---|
| Unresolved backlog lookup (`WHERE status IN ('pending','processing','failed') ORDER BY created_at ASC, id ASC LIMIT 10`) | Seq Scan: `4.779 ms`, `887` shared hit blocks | **`Index Only Scan` on `idx_app_outbox_unresolved_created` (Migration 029)**: **`0.101 ms`**, `Heap Fetches: 0`, **`2` shared hit blocks** (**443x fewer buffer reads**, **47x faster**) |
| Dead-letter inspection (`WHERE status = 'dead_letter' ORDER BY dead_letter_at DESC, id DESC LIMIT 20`) | Seq Scan: `3.232 ms`, `887` shared hit blocks | **`Index Scan` on `idx_app_outbox_dead_letter` (Migration 028)**: **`0.056 ms`**, **`3` shared hit blocks** (**295x fewer buffer reads**, **57x faster**) |

### 4.2 PostgreSQL Fallback `ILIKE` Trigram Search (`pg_trgm`)

| Query Target | Before (Forced Seq Scan) | After (`pg_trgm` GIN Index, Migration 029) |
|---|---|---|
| Product fallback (`name ILIKE '%Rajdhani%' AND archived_at IS NULL`) | Seq Scan (`134` shared hit blocks, `9.568 ms` for `Atta Item 950` scan) | **`Bitmap Index Scan` + `Bitmap Heap Scan` on `idx_products_active_name_trgm`**: **`0.157 ms`**, **`14` shared hit blocks** (**61x faster**) |
| Customer fallback (`normalized_name ILIKE '%trader 950%' AND archived_at IS NULL`) | Seq Scan (`155` shared hit blocks, `7.093 ms`, planning `10.191 ms`) | **`Bitmap Index Scan` on `idx_customers_active_name_trgm`**: `49` shared hit blocks (`3.16x` fewer buffers), planning `0.351 ms`, execution `8.824 ms` |

*Honest planner observation:* Before running `VACUUM` after bulk `DELETE` of 10,000 outbox rows, the unresolved index scan visited MVCC dead-tuple index entries (`18,077` buffer hits, `8.852 ms`), underscoring why standard PostgreSQL autovacuum (enabled on Neon) is essential on high-churn queues. Additionally, for non-selective substrings where trigrams match nearly every row (e.g. searching a common table-wide prefix on a small `<200`-page table), PostgreSQL's cost planner appropriately chooses a Sequential Scan until table size or term selectivity increases.

---

## 5. Limitations & Production Translation Notes

- **Network Round-Trip Overhead:** Local IPC measurements (`127.0.0.1`) exclude Neon/MongoDB Atlas WAN TLS latency (~`15–60 ms` per round-trip in cloud deployments). Consequently, eliminating extra `countDocuments` round-trips and coalescing outbox `dashboard_snapshots` refreshes yields even larger wall-clock savings in production than the local CPU deltas alone suggest.
- **Neon Compute Auto-Suspend Savings:** With `readModelsQueryService` serving searches and pagination purely from MongoDB (`0` PG queries) and `ReadModelOutboxWorker` backing off adaptively when empty or waiting for the earliest `next_delay_ms`, idle Neon compute wakes are minimized.
