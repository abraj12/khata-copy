# Khata ERP — Algorithm, Data Structure & Complexity Review (Release #029)

**Release:** `#029`  
**Owner:** ALGIONS AI LABS PRIVATE LIMITED  
**Scope:** End-to-end algorithmic audit of search tokenization, MongoDB index scans, keyset cursor pagination, outbox queue coalescing, frontend concurrency guards, and PostgreSQL financial locking.

---

## 1. Summary Complexity Matrix

| Subsystem | Prior Complexity / Bottleneck | Release #029 Algorithm / Data Structure | Current Complexity | Primary Source File |
|---|---|---|---|---|
| **Catalog Prefix Search** | `O(N)` regex scan + extra `O(N)` `countDocuments` | Half-open B-tree range `[prefix, upperBound)` via `buildLexicographicPrefixFilter` + skipped filtered count on multi-page | **`O(log N + K)`** (`K <= limit + 1`) | [`backend/src/modules/readModels/readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts) |
| **Multi-Word & Unicode Tokenization** | ASCII regex stripped Indic `\p{M}` matras | `tokenizeSearchText` Unicode property regex `/[^\p{L}\p{M}\p{N}]+/u` + budgeted `Set` (`<= 96` tokens, longest-first) | **`O(L)`** per record (`L = text length`) | [`backend/src/modules/readModels/readModelSync.service.ts`](../backend/src/modules/readModels/readModelSync.service.ts) |
| **Long Token Query Casting (`>12` chars)** | Mongoose `SchemaArray` `cast$all` threw `CastError` | Exact prefix slice `<= 12` in `$all` + `{ $elemMatch: { $gte, $lt } }` via `idx_product_search_active_tokens` | **`O(log N + K)`** multi-key `IXSCAN` | [`backend/src/modules/readModels/readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts) |
| **Deep Pagination (Products & Customers)** | `O(offset + K)` `.skip(offset)` B-tree walk | HMAC-SHA256 signed query-bound keyset cursor (`(normalizedName, productId)` and null-safe `(outstandingPaise, lastActivityAt, customerId)`) | **`O(log N + K)`** independent of depth | [`backend/src/modules/readModels/readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts) |
| **Frontend Deduplicated Pagination** | Offset re-fetch + potential stale overwrite / duplicates | `AbortController` + monotonic `requestIdRef` + `mergeUniqueByKey` (`Set` / `Map` in insertion order) | **`O(P + K)`** per page append (`O(1)` lookup) | [`frontend/src/types/pagination.ts`](../frontend/src/types/pagination.ts), [`frontend/src/hooks/useRemoteSearch.ts`](../frontend/src/hooks/useRemoteSearch.ts) |
| **Outbox Event Batch Sync** | Per-event PG reads + unconditional snapshot recompute | `Set`-based batch coalescing (`productIds`, `customerIds`, `impactedDates`), single-flight `flushDashboardRefresh`, `skipDashboardSnapshot` | **`O(U)`** distinct aggregates (`U <= B`), **`O(1)`** snapshot refresh per settle window | [`backend/src/modules/readModels/readModelSync.service.ts`](../backend/src/modules/readModels/readModelSync.service.ts), [`backend/src/modules/readModels/readModelOutbox.worker.ts`](../backend/src/modules/readModels/readModelOutbox.worker.ts) |
| **Outbox Worker Backlog & Dead-Letter** | Full predicate scan & lost NULL-lease orphans | Partial indexes (`idx_app_outbox_unresolved_created`, `idx_app_outbox_dead_letter`) + SQL `CASE` null-lease reclaim + legacy backfill | **`O(log N)`** backlog probe (`Index Only Scan`) | [`backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql`](../backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql), [`backend/src/modules/readModels/readModelOutbox.worker.ts`](../backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql) |
| **PG Search Fallback (`MONGODB_ENABLED=false`)** | Full-table sequential `ILIKE '%q%'` scan | PostgreSQL `pg_trgm` partial GIN indexes (`idx_products_active_name_trgm`, `idx_customers_active_name_trgm`) | **`O(M)`** posting-list intersection (`Bitmap Index Scan`) | [`backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql`](../backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql) |
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
- **`AbortController` + Monotonic `requestIdRef`:** Every rapid keystroke aborts any in-flight HTTP request and discards late arrivals if `requestId !== requestIdRef.current`.

---

## 3. PostgreSQL & Financial Invariants Preserved

- **Authoritative Financial Engine:** Customer ledger balances, FIFO payment allocations (`udhar_transactions`, `payments`, `payment_allocations`), GST invoices (`gst_invoices`), normal bills (`normal_bills`), quotations (`quotations`), supplier ledgers (`suppliers`, `supplier_purchase_bills`, `supplier_payments`), and business expenses (`business_expenses`) remain strictly in PostgreSQL with `decimal.js` `ROUND_HALF_UP` arithmetic and `NUMERIC` scale checks (`<= 2` decimal places).
- **Zero Inventory / Stock Scope:** `product_search` and `products` strictly hold single-vendor catalog reference fields (`name`, `buying_price`, `hsn_code`, `barcode`, `image_object_key`, `image_url`, timestamps); no stock quantity or warehouse tracking exists.
- **Transaction Scope Hardening:** In `gstInvoices.service.ts` and `normalBills.service.ts`, PDF generation and R2 uploads execute **after** PostgreSQL `COMMIT` so slow R2 network I/O never holds open PostgreSQL row locks or transactions.
