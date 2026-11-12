# Khata ERP — Algorithm, Data Structure & Complexity Review (Release #030)

**Release:** `#030`  
**Owner:** ALGIONS AI LABS PRIVATE LIMITED  
**Scope:** End-to-end algorithmic review comparing theoretical asymptotic complexity against empirically measured PostgreSQL 18.6 (`EXPLAIN (ANALYZE, BUFFERS)`) and MongoDB 8.2.4 (`executionStats`) behavior across outbox wakeups, fallback & read-model search, query-bound keyset pagination, frontend concurrency, and durable R2 cleanup.

---

## 1. Summary Complexity Matrix

| Subsystem | Prior Complexity / Bottleneck | Release #029 Algorithm / Data Structure | Current Complexity | Primary Source File |
|---|---|---|---|---|
| **Catalog Prefix Search** | `O(N)` regex scan + extra `O(N)` `countDocuments` | Half-open B-tree range `[prefix, upperBound)` via `buildLexicographicPrefixFilter` + skipped filtered count on multi-page | **`O(log N + K)`** (`K <= limit + 1`) | [`backend/src/modules/readModels/readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts) |
| **Multi-Word & Unicode Tokenization** | ASCII regex stripped Indic `\p{M}` matras | `tokenizeSearchText` Unicode property regex `/[^\p{L}\p{M}\p{N}]+/u` + budgeted `Set` (`<= 96` tokens, longest-first) | **`O(L)`** per record (`L = text length`) | [`backend/src/modules/readModels/readModelSync.service.ts`](../backend/src/modules/readModels/readModelSync.service.ts) |
| **Long Token Query Casting (`>12` chars)** | Mongoose `SchemaArray` `cast$all` threw `CastError` | Exact prefix slice `<= 12` in `$all` + `{ $elemMatch: { $gte, $lt } }` via `idx_product_search_active_tokens` | **`O(log N + K)`** multi-key `IXSCAN` | [`backend/src/modules/readModels/readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts) |
| **Deep Pagination (Products & Customers)** | `O(offset + K)` `.skip(offset)` B-tree walk | HMAC-SHA256 signed query-bound cursors (`buildProductCursorQueryContext`, `buildCustomerCursorQueryContext`, null-safe `(outstandingPaise, lastActivityAt, customerId)`) | **`O(log N + K)`** (`27` keys at `skip=80k`) | [`backend/src/modules/readModels/readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts) |
| **Frontend Deduplicated Pagination & Loops** | Unstable inline callback loops + late scroll appends | Ref-stabilized callbacks (`fetcherRef`, `getItemKeyRef`, `fetchPageRef`) + `AbortController` + `requestIdRef` + `isLoadingMoreRef` + `mergeUniqueByKey` | **`O(P + K)`** append (`0` loop re-fetches) | [`frontend/src/hooks/useRemoteSearch.ts`](../frontend/src/hooks/useRemoteSearch.ts), [`frontend/src/features/bills/useBillingCatalogueSearch.ts`](../frontend/src/features/bills/useBillingCatalogueSearch.ts) |
| **Outbox Event Batch Sync** | Per-event PG reads + unconditional snapshot recompute | `Set`-based batch coalescing (`productIds`, `customerIds`, `impactedDates`), single-flight `flushDashboardRefresh`, `skipDashboardSnapshot` | **`O(U)`** distinct aggregates (`U <= B`), **`O(1)`** snapshot refresh per settle window | [`backend/src/modules/readModels/readModelSync.service.ts`](../backend/src/modules/readModels/readModelSync.service.ts), [`backend/src/modules/readModels/readModelOutbox.worker.ts`](../backend/src/modules/readModels/readModelOutbox.worker.ts) |
| **Outbox Worker Wakeup & Dead-Letter** | Full `Parallel Seq Scan` across `100k` processed rows (`2,041` blocks) | 3-branch `LIMIT 1` `UNION ALL` over partial indexes (`idx_app_outbox_pending_wake`, `idx_app_outbox_failed_retryable`, `idx_app_outbox_processing_wake`) + separated `refreshDeadLetterIndicator()` | **`O(log N)`** (`Merge Append -> 3x Index Only Scan`, `6–9` blocks) | [`backend/migrations/031_outbox_worker_search_indexes.sql`](../backend/migrations/031_outbox_worker_search_indexes.sql), [`backend/src/modules/readModels/readModelOutbox.worker.ts`](../backend/src/modules/readModels/readModelOutbox.worker.ts) |
| **PG Search Fallback (`MONGODB_ENABLED=false`)** | Full-table CTE ledger joins & missing HSN/barcode/phone indexes | `exactBarcode` support + `WITH matched_customers AS MATERIALIZED (...)` + aligned `ROUND(GREATEST(..., 0), 2)` sort + B-tree prefix & `pg_trgm` GIN indexes (`031`) | `O(M)` BitmapOr on products; `O(C)` filter before `O(log N)` ledger seeks* | [`backend/migrations/031_outbox_worker_search_indexes.sql`](../backend/migrations/031_outbox_worker_search_indexes.sql), [`backend/src/modules/khata/khata.service.ts`](../backend/src/modules/khata/khata.service.ts) |
| **Durable R2 Orphan Cleanup** | Fire-and-forget memory promises dropped on error/restart | Persistent `storage_cleanup_jobs` (`ON CONFLICT` active dedup), `FOR UPDATE SKIP LOCKED`, 6-table live reference check (`findLiveObjectReferences`), bounded exponential backoff | **`O(log J)`** queue probe + `O(6)` PK/index ref checks | [`backend/src/services/storageCleanup.service.ts`](../backend/src/services/storageCleanup.service.ts), [`backend/src/services/storageCleanup.worker.ts`](../backend/src/services/storageCleanup.worker.ts) |
| **Khata FIFO Payment Allocation** | Potential concurrent double-spend without row locks | Customer row lock (`FOR UPDATE`) + FIFO `udhar_transactions` allocation inside single ACID transaction using `decimal.js` | **`O(T_open)`** open bills (`1` lock round-trip) | [`backend/src/modules/khata/khata.service.ts`](../backend/src/modules/khata/khata.service.ts) |

---

## 2. Detailed Algorithm & Data-Structure Breakdown

### 2.1 Unicode-Safe Search Tokenization (`readModelSync.service.ts`)
- **Normalization (`normalizeSearchText`):** Applies `value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')` (`O(L)`). NFKC folds compatibility equivalents while preserving canonical Indic codepoints.
- **Combining Mark Preservation (`tokenizeSearchText`):** Uses Unicode character-class regex `/[^\p{L}\p{M}\p{N}]+/u` so Devanagari (`आटा`: `U+0906 U+091F U+093E`), Gurmukhi (`ਦਾਲ`: `U+0A26 U+0A3E U+0A32`), Tamil, and accented characters never split mid-grapheme on matras/halants (`\p{M}`).
- **Budgeted Token Prefix Generation:**
  - `buildProductSearchTokens` populates `[name, hsnCode, barcode]` in priority order using a `Set<string>` capped at `maxTokens = 96`, indexing bounded prefixes (`len = 2..min(word.length, 12)`). Ordering `name` before `hsnCode`/`barcode` ensures numeric codes cannot starve product-name prefixes out of the 96-token budget.
  - `buildCustomerSearchTokens` allocates `68` token slots exclusively for normalized name words first, then populates `normalizedPhone` + Indian `+91`/`0`-stripped digit prefixes (`2..15`) and suffixes (`3..10`) up to the `96`-token cap.

### 2.2 Bounded Lexicographic B-Tree Queries & Selective Intersection (`readModelsQuery.service.ts`)
- **`buildLexicographicPrefixFilter(prefix)`:** Computes `upperBound = prefix.slice(0, -1) + String.fromCharCode(lastCode + 1)` returning `{ $gte: prefix, $lt: upperBound }` whenever `lastCode` is non-surrogate `< 0xFFFF`, falling back cleanly to anchored `^...` regex otherwise. MongoDB satisfies both `normalizedName` and `normalizedHsnCode` clauses with bounded `IXSCAN` range seeks rather than full index regex sweeps.
- **`buildSearchTokenFilter(rawTokens)`:**
  1. Deduplicates tokens with length `>= 2` and sorts descending by string length (`longTokens.sort((a, b) => b.length - a.length)`) so the most selective tokens constrain MongoDB's multikey intersection first.
  2. For tokens `<= 12` chars, emits exact membership on `{ searchTokens: ... }` or `{ searchTokens: { $all: ... } }`.
  3. For tokens `> 12` chars, emits BOTH the `12`-char indexed prefix inside `$all` AND `{ searchTokens: { $elemMatch: buildLexicographicPrefixFilter(tok) } }` combined via `$and`, avoiding Mongoose `SchemaArray` `cast$all` `CastError` while ensuring the **same** array element satisfies `$gte` and `$lt`.

### 2.3 Signed Query-Bound Keyset Cursors (`readModelsQuery.service.ts`)
- **Structure & Integrity (`encodeCursor`, `decodeVerifiedCursorPayload`):**
  - Payload contains cursor version `v: 1`, query digest `q = sha256(normalizedQuery).base64url(0..12)`, type tag `'p' | 'c'`, and tie-breaking sort keys, signed with HMAC-SHA256 (`SESSION_SECRET`) verified via `crypto.timingSafeEqual`.
  - Rejects oversized (`> 512` chars), malformed, tampered, cross-endpoint (`t`), or cross-query (`q`) cursors with HTTP `400 INVALID_PAGINATION_CURSOR` (eliminating silent result corruption when a filter changes while scrolling).
- **Deterministic Null-Safe Customer Seek Order (`outstandingPaise: -1, lastActivityAt: -1, customerId: 1`):**
  - Because MongoDB sorts `null` dates *after* non-null `Date` values under descending order (`-1`), a naive `{ lastActivityAt: { $lt: cursorLastActivity } }` misses `lastActivityAt: null` ties!
  - Release #029 explicitly handles all tie cases with a 4-branch predicate when `cursorLastActivity !== null`:
    1. `outstandingPaise < o`
    2. `outstandingPaise === o AND lastActivityAt < cursorLastActivity`
    3. `outstandingPaise === o AND lastActivityAt === null`
    4. `outstandingPaise === o AND lastActivityAt === cursorLastActivity AND customerId > id`
  - When `cursorLastActivity === null`, seeks `{ outstandingPaise < o }` OR `{ outstandingPaise === o AND lastActivityAt === null AND customerId > id }`. Result: `0` skipped and `0` duplicated records across arbitrary ties (`100`/`100` unique verified on real MongoDB 8.2).

### 2.4 Outbox Worker Coalescing, Lease Recovery & Monotonic Projections
- **Atomic Claim & Orphan Reclaim (`ReadModelOutboxWorker.claimOutboxBatch`):**
  - Reclaims both expired leases (`lease_expires_at < NOW()`) and orphaned NULL leases (`lease_expires_at IS NULL` in `'processing'`) before claiming `ORDER BY id ASC LIMIT $1 FOR UPDATE SKIP LOCKED`.
  - Heartbeat timer refreshes `lease_expires_at` every `leaseDurationMs / 3` during long batches so healthy slow syncs are never reclaimed prematurely.
- **Aggregate Deduplication & Monotonic Upsert Guard (`ReadModelSyncService`):**
  - `applyOutboxBatch` folds `B` events into `Set<number>` (`productIds`, `customerIds`) and `Set<string>` (`impactedDates`), turning bursty repeated updates into `1` batched PG query + `1` Mongo `bulkWrite` per collection (`upsertProjectionWithTimestampGuard` enforces `sourceUpdatedAt >= existing.sourceUpdatedAt` so out-of-order replays never regress newer projections).
- **Dashboard Refresh Coalescing (`flushDashboardRefresh` / `triggerOrScheduleDashboardRefresh`):**
  - Outbox batches run with `{ skipDashboardSnapshot: true }`, updating `lastProjectionSyncAt` immediately while scheduling at most one throttled global snapshot refresh per `dashboardRefreshMinIntervalMs` window; if new writes land during an active refresh, `dashboardRefreshDirty = true` schedules a trailing pass instead of dropping updates or multiplying heavy SQL scans.

### 2.5 Frontend Request Concurrency & Deduplication (`frontend/src/`)
- **`buildPaginatedSearchParams` (`frontend/src/types/pagination.ts`):** Uses `cursor` when non-empty and intentionally **omits** `offset` in cursor requests (`cursor` <-> `offset` separation).
- **`mergeUniqueByKey` / `mergeUniqueById`:** Uses a `Set<string | number>` to filter duplicates in `O(prev + next)` linear time when appending pages across `useRemoteSearch`, `SearchablePicker`, `useBillingCatalogueSearch`, `ProductsView`, and `KhataLedgerView`.
- **Ref-Stabilized Hook Callbacks + `AbortController` + Monotonic `requestIdRef`:** `useRemoteSearch` (`fetcherRef`, `getItemKeyRef`) and `useBillingCatalogueSearch` (`fetchPageRef`) decouple effect lifecycles from unstable parent inline closures, eliminating render-loop cascades, while `controller.signal.aborted`, `activeSearchRef`, and synchronous `isLoadingMoreRef` prevent stale cursor pagination appends.

### 2.6 Theoretical Complexity vs Observed Database Plans (Release #030 Empirical Note)

Asymmetric planner selectivity and SQL expression wrappers create observable differences between theoretical index notation and actual database execution plans at `N = 100,000` (see [`RELEASE_030_PERFORMANCE_BENCHMARKS.md`](RELEASE_030_PERFORMANCE_BENCHMARKS.md)):
- **Outbox Wakeup Matches Theory:** PostgreSQL executes `Merge Append` over three partial `Index Only Scan` branches (`6–9` shared hit blocks, `0.054–0.085 ms` PG execution) instead of scanning `100,000` processed rows (`2,041` shared blocks).
- **`COALESCE` Wrapper in `khata.service.ts`:** Wrapping `COALESCE(normalized_phone, '') ILIKE $1` prevented PG from binding `idx_customers_active_normalized_phone_trgm` on `100k` seeded `customers` (`Seq Scan` `75.244 ms`), even though `WITH matched_customers AS MATERIALIZED (...)` still restricted heavy `udhar_transactions` aggregations strictly to `Index Scan` on the `2` matched rows.
- **Sort-Avoiding Index Choice in MongoDB:** On `exact_hsn` at `N = 100,000`, MongoDB sorted by `{ normalizedName: 1, productId: 1 }` chose walking `idx_product_search_active_name` (`1,253` keys examined) over sorting an `idx_product_search_active_norm_hsn` slice.

---

## 3. PostgreSQL & Financial Invariants Preserved

- **Authoritative Financial Engine:** Customer ledger balances, FIFO payment allocations (`udhar_transactions`, `payments`, `payment_allocations`), GST invoices (`gst_invoices`), normal bills (`normal_bills`), quotations (`quotations`), supplier ledgers (`suppliers`, `supplier_purchase_bills`, `supplier_payments`), and business expenses (`business_expenses`) remain strictly in PostgreSQL with `decimal.js` `ROUND_HALF_UP` arithmetic and `NUMERIC` scale checks (`<= 2` decimal places).
- **Zero Inventory / Stock Scope:** `product_search` and `products` strictly hold single-vendor catalog reference fields (`name`, `buying_price`, `hsn_code`, `barcode`, `image_object_key`, `image_url`, timestamps); no stock quantity or warehouse tracking exists.
- **Transaction Scope Hardening:** In `gstInvoices.service.ts` and `normalBills.service.ts`, PDF generation and R2 uploads execute **after** PostgreSQL `COMMIT` so slow R2 network I/O never holds open PostgreSQL row locks or transactions.
