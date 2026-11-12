# Khata ERP — Release #029 Remediation & Hardening Report

**Release:** `#029`  
**Owner / Maintainer:** ALGIONS AI LABS PRIVATE LIMITED  
**Base Commit (`main`):** `2ab921ac761399817a7972078cae8150bd8dc715`  
**Feature Branch:** `fix/release-029-dsa-performance-reliability`  
**Companion Documentation:**
- [`docs/RELEASE_029_PERFORMANCE_BENCHMARKS.md`](./RELEASE_029_PERFORMANCE_BENCHMARKS.md)
- [`docs/ALGORITHM_AND_COMPLEXITY_REVIEW.md`](./ALGORITHM_AND_COMPLEXITY_REVIEW.md)
- [`docs/MONGODB_ARCHITECTURE.md`](./MONGODB_ARCHITECTURE.md)
- [`docs/DATABASE_AND_MIGRATIONS.md`](./DATABASE_AND_MIGRATIONS.md)

---

## 1. Executive Summary

Release `#029` resolves confirmed reliability, search-scaling, pagination, security, and database-efficiency defects across the Node.js/Express backend, PostgreSQL schema/outbox pipeline, MongoDB read-model layer, and React/TypeScript frontend — while preserving the single-vendor Khata business model and keeping Neon PostgreSQL authoritative for all financial, authentication, idempotency, and outbox state.

Key engineering outcomes:
1. **Separated Outbox Freshness Signals & Trailing Dashboard Coalescing:** Split projection freshness (`lastProjectionSyncAt`) from global snapshot freshness (`lastDashboardRefreshAt`) across `readModelSync.service.ts` and `readModelsQuery.service.ts` (`buildSyncStatus`), fixed missed refreshes when concurrent writes arrive mid-flush (`dashboardRefreshDirty` trailing scheduler in `ReadModelOutboxWorker.flushDashboardRefresh()`), and eliminated false stale warnings during coalesced burst writes.
2. **Legacy Dead-Letter Backfill & Lease Recovery Hardening:** Added migration `029_outbox_legacy_dead_letter_and_perf_indexes.sql` to transition legacy exhausted `'failed'` rows (`attempt_count >= max_attempts`) into `'dead_letter'`, reclaimed orphaned `lease_expires_at IS NULL` processing rows in `ReadModelOutboxWorker.claimOutboxBatch()`, calculated retry delays from processing lease expiries instead of fixed 1-second polling, and made `/api/v1/read-model-sync/status` resilient to nullable timestamps (`toIsoOrNull`).
3. **Indic Unicode Search & Sub-Linear Indexed MongoDB Queries:** Replaced punctuation stripping that fractured Devanagari/Gurmukhi matras with Unicode property regex `/[^\p{L}\p{M}\p{N}]+/u` (`tokenizeSearchText`), prioritized product names and customer Indian phone variants (`+91` / `0` / 10-digit) within the 96-token budget, replaced unbounded `$regex` scans with bounded lexicographic half-open intervals `[prefix, upperBound)` (`buildLexicographicPrefixFilter`), fixed a Mongoose `CastError` bug discovered during 100k benchmarking for tokens longer than 12 chars (and phone variants longer than 15 chars) via `$elemMatch`, and skipped redundant `countDocuments` scans on multi-page filtered queries (`total: null`, `totalIsExact: false`).
4. **Signed Query-Bound Keyset Cursors (Backend + Frontend):** Upgraded cursor tokens (`v: 1`) with an HMAC-SHA256 signature (`crypto.timingSafeEqual`), endpoint tag (`t`), and normalized query digest (`q`), implemented a 4-branch null-safe seek predicate for customer sorting (`outstandingPaise: -1, lastActivityAt: -1, customerId: 1`), and adopted keyset cursors end-to-end across `ProductsView`, `KhataLedgerView`, `usePaginatedProductSearch`, `usePaginatedCustomerSearch`, `useRemoteSearch`, and `SearchablePicker` with `Set`-based `mergeUniqueById` / `mergeUniqueByKey` deduplication.
5. **SQL, Storage Cleanup & Test Guard Hardening:** Escaped SQL `LIKE` metacharacters (`%`, `_`, `\`) using `escapeLike` + `ESCAPE '\'` in GST invoices, normal bills, and offline bills; prevented R2 cleanup failures in `products.routes.ts` from masking underlying DB attach errors while preserving existing product images on rollback; preserved non-blocking post-commit PDF/R2 handling outside PostgreSQL transactions; and introduced `TestDatabaseUnavailableError` + `UnavailableTestPool` in `backend/src/config/database.ts` so DB-free unit tests fail closed if an unmocked query leaks.

---

## 2. Preserved Domain & Architecture Guarantees

- **Single-Vendor Khata Model (Zero Inventory/Stock):** Products continue to store reference attributes (`name`, `buying_price`, `hsn_code`, `barcode`, `image_object_key`, `image_updated_at`, timestamps) with zero stock quantities, warehouse ledgers, or stock deduction logic.
- **PostgreSQL Authoritative Financial Engine:** `udhar_transactions`, FIFO `payments` / `payment_allocations`, `gst_invoices`, `normal_bills`, `quotations`, `suppliers`, `supplier_purchase_bills`, `supplier_payments`, `business_expenses`, owner sessions, idempotency keys, and `app_outbox_events` remain strictly in PostgreSQL with `decimal.js` arithmetic.
- **Zero-PG Read Paths (`MONGODB_ENABLED=true`):** Dashboard overview, product search/barcode/image-metadata, Khata ledger/summary/customer search, preferences, notifications, and telemetry read exclusively from MongoDB and fail closed with HTTP `503 READ_MODEL_UNAVAILABLE` if MongoDB disconnects.
- **Production Deployment Safety:** All migrations (`029`), integration suites (`37` tests), and `1,000`–`100,000` scale benchmarks were executed strictly against local disposable PostgreSQL (`khata_test` / `khata_bench_029_test`, guarded by `testDbGuard.ts`) and local MongoDB (`127.0.0.1:27017`).

---

## 3. Confirmed Defects & Implemented Remediations

### 3.1 Read-Model Sync Freshness, Dashboard Coalescing & Outbox Worker Reliability

| Area | Root Cause | Remediation | Files & Symbols |
|---|---|---|---|
| **Projection vs Dashboard Freshness** | Updating fast entity projections and full global snapshots shared/overwrote staleness semantics, causing false stale statuses or masking dashboard snapshot lag. Also, `applyOutboxBatch(..., { skipDashboardSnapshot: true })` could leave `lastProjectionSyncAt` uninitialized if no global snapshot doc existed yet. | Separated `lastProjectionSyncAt` (`$max` on projection sync) from `lastDashboardRefreshAt` (`$set` on global snapshot sync); tracked `pendingProjectionSyncAt` until snapshot creation; added scope parameter (`'projection'` vs `'dashboard'`) in `buildSyncStatus()`. | [`readModelSync.service.ts`](../backend/src/modules/readModels/readModelSync.service.ts), [`readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts) (`buildSyncStatus`) |
| **Mid-Flight Dashboard Refresh Drops** | Concurrent `flushDashboardRefresh()` callers awaited `activeDashboardRefreshPromise` without flagging that newer domain writes happened mid-flight. | Set `this.dashboardRefreshDirty = true` on concurrent arrival and scheduled a bounded trailing refresh (`scheduleCoalescedDashboardRefreshTimer`) once the active flush settles (`finally` block). | [`readModelOutbox.worker.ts`](../backend/src/modules/readModels/readModelOutbox.worker.ts) (`flushDashboardRefresh`) |
| **Orphaned NULL Leases & Polling Spikes** | Crash victims left with `status = 'processing'` and `lease_expires_at IS NULL` were excluded by `lease_expires_at IS NOT NULL AND lease_expires_at < NOW()`. Unresolved processing inspections also defaulted to a `1000` ms fallback timer instead of `leaseDurationMs`. | Reclaimed `(lease_expires_at IS NULL OR lease_expires_at < NOW())` in `claimOutboxBatch()`; computed wake delay dynamically via SQL `CASE` (`COALESCE(lease_expires_at, NOW() - INTERVAL '1 millisecond')`) across `status IN ('pending', 'processing')` and retryable `'failed'` rows; replaced `1000` ms fallback with `this.leaseDurationMs`. | [`readModelOutbox.worker.ts`](../backend/src/modules/readModels/readModelOutbox.worker.ts) (`claimOutboxBatch`, backlog delay query) |
| **Legacy Dead-Letter Visibility & Null Dates** | Exhausted rows created prior to migration `028` could remain in `status = 'failed'` with `attempt_count >= max_attempts` and `updated_at = NULL`, crashing `new Date(row.updated_at).toISOString()` or missing dead-letter listings. | Added SQL backfill in migration `029`, broadened `/status` query (`status = 'dead_letter' OR (status = 'failed' AND attempt_count >= max_attempts)`), ordered via `COALESCE(dead_letter_at, updated_at, created_at) DESC, id DESC`, and formatted dates via `toIsoOrNull()`. | [`029_outbox_legacy_dead_letter_and_perf_indexes.sql`](../backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql), [`readModelSync.routes.ts`](../backend/src/modules/readModels/readModelSync.routes.ts) (`toIsoOrNull`) |

### 3.2 Indic Search, DSA Indexing, Mongoose CastError Fix & Keyset Pagination

| Area | Root Cause | Remediation | Files & Symbols |
|---|---|---|---|
| **Indic Matra Stripping & Token Budget Starvation** | Previous regex tokenization split combining marks (`\p{M}`) in Devanagari/Gurmukhi words, and long HSN/barcode tokens could exhaust the token array before product words were indexed. | Switched `tokenizeSearchText()` to `/[^\p{L}\p{M}\p{N}]+/u` after `NFKC` normalization; added `buildProductSearchTokens()` (product name prefixes `2..12` ahead of HSN/barcode, capped at `96`) and `buildCustomerSearchTokens()` (`68` slots reserved for customer name tokens + Indian `+91`/`0`/10-digit phone prefixes `2..15` and suffixes `3..10`). | [`readModelSync.service.ts`](../backend/src/modules/readModels/readModelSync.service.ts) (`normalizeSearchText`, `tokenizeSearchText`, `buildProductSearchTokens`, `buildCustomerSearchTokens`) |
| **Linear `$regex` Scans & Redundant `countDocuments`** | Prefix matching emitted `$regex` patterns and issued full collection `countDocuments(filter)` queries even when `hasMore` pagination already fetched `limit + 1` docs. | Implemented `buildLexicographicPrefixFilter()` computing half-open `[prefix, upperBound)` bounds (`$gte`/`$lt`); sorted query tokens longest-first so selective terms intersect first; skipped exact `countDocuments` on multi-page filtered search (`total: null`, `totalIsExact: false`); surfaced `totalIsExact` consistently across routes. | [`readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts), [`products.routes.ts`](../backend/src/modules/products/products.routes.ts), [`khata.routes.ts`](../backend/src/modules/khata/khata.routes.ts) |
| **`CastError` on Search Words `> 12` Chars (Discovered in 100k Benchmark)** | Putting `{ $gte, $lt }` interval objects directly inside `{ searchTokens: { $all: [...] } }` (or customer phone `{ searchTokens: { $gte, $lt } }`) triggered Mongoose `SchemaArray` casting failures (`Cast to string failed for value "{ '$gte': ... }"`). | Kept exact `<= 12` slices in `$all` and wrapped long token `> 12` / phone variant `> 15` interval predicates inside `{ searchTokens: { $elemMatch: buildLexicographicPrefixFilter(...) } }` combined via `$and`, achieving `IXSCAN` with zero `CastError`s. Verified with `zzzznomatch999abc` regression test. | [`readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts) (`buildSearchTokenFilter`, `listCustomersFromMongo`) |
| **Tamperable / Cross-Query Cursors & Null-Date Ties** | Cursors not bound to normalized search filters could skip/corrupt items if replayed across queries, and naive `$lt` comparisons on nullable `lastActivityAt` missed customers with `null` activity dates in descending sort order. | Bound `v: 1` HMAC-SHA256 cursors to `t` (endpoint) and `q` (12-char base64url SHA-256 of normalized query), verified via `crypto.timingSafeEqual`, widened route validation to `max(512)` chars, and wrote a 4-branch null-safe tie-breaking seek predicate on `(outstandingPaise: -1, lastActivityAt: -1, customerId: 1)`. | [`readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts) (`InvalidPaginationCursorError`), [`products.routes.ts`](../backend/src/modules/products/products.routes.ts), [`khata.routes.ts`](../backend/src/modules/khata/khata.routes.ts) |

### 3.3 SQL, R2 Error Safety & Test Isolation Hardening

- **LIKE Metacharacter Escaping:** Added `escapeLike` and explicit `ESCAPE '\'` clauses to `listInvoices` in [`gstInvoices.service.ts`](../backend/src/modules/gstInvoices/gstInvoices.service.ts), `listBills` in [`normalBills.service.ts`](../backend/src/modules/normalBills/normalBills.service.ts), and `listOfflineBills` in [`offlineBills.service.ts`](../backend/src/modules/offlineBills/offlineBills.service.ts) so `%`, `_`, and `\` search characters match literally without wildcard expansion.
- **R2 Image Cleanup Resilience:** Wrapped orphan `storageService.deleteObject(objectKey)` cleanup inside `.catch(() => {})` in [`products.routes.ts`](../backend/src/modules/products/products.routes.ts) so transient R2 delete errors never obscure the primary PostgreSQL rollback error (`productsService.attachProductImage` test verified existing `products/21/existing-old.jpg` remains untouched while cleaning only new candidate objects).
- **Safe Unit-Test DB Guard:** Added `TestDatabaseUnavailableError` (`code: 'TEST_DB_UNAVAILABLE'`) and `UnavailableTestPool` in [`database.ts`](../backend/src/config/database.ts) (`resolveDatabasePoolTargets().isUnitTestUnavailable = true` when `NODE_ENV === 'test'` and no `TEST_DATABASE_URL` is configured), preventing accidental real-DB connections during mocked unit runs while keeping integration DB safety assertions intact.

---

## 4. Database Schema, Migrations & Indexes (`029`)

Added [`backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql`](../backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql) and registered it in `EXPECTED_MIGRATIONS` inside [`database.ts`](../backend/src/config/database.ts):
1. **Legacy Dead-Letter Backfill:** Transitions `app_outbox_events` rows with `status = 'failed' AND attempt_count >= max_attempts` to `status = 'dead_letter'`, preserving/populating `dead_letter_at` and `updated_at`.
2. **Partial Unresolved Outbox Index (`idx_app_outbox_unresolved_created`):** Covers `(created_at ASC, id ASC) WHERE status IN ('pending', 'processing', 'failed')`, enabling `Index Only Scan` with `Heap Fetches: 0` on local PostgreSQL 18.6 (`0.101 ms`, `2` shared hit blocks vs `4.779 ms` / `887` blocks forced seq scan).
3. **PostgreSQL Fallback Trigram GIN Indexes (`pg_trgm`):** Added `idx_products_active_name_trgm` and `idx_customers_active_name_trgm` (partial `WHERE archived_at IS NULL` using `gin_trgm_ops`) to accelerate `MONGODB_ENABLED=false` fallback `ILIKE '%...%'` queries (`0.157 ms` / `14` blocks on `10k+` active products vs `9.568 ms` / `134` blocks seq scan).

---

## 5. Frontend Keyset Cursor Adoption & Canonical PDF Printing

- **Shared Cursor Helpers ([`frontend/src/types/pagination.ts`](../frontend/src/types/pagination.ts)):** Added `buildPaginatedSearchParams()` (emits `cursor` when present while intentionally omitting `offset`), `mergeUniqueById()`, and `mergeUniqueByKey()` for `O(prev + next)` duplicate-free appending across boundary overlaps.
- **View & Hook Adoption:** Updated [`useRemoteSearch.ts`](../frontend/src/hooks/useRemoteSearch.ts), [`SearchablePicker.tsx`](../frontend/src/components/SearchablePicker.tsx), [`useBillingCatalogueSearch.ts`](../frontend/src/features/bills/useBillingCatalogueSearch.ts), [`ProductsView.tsx`](../frontend/src/features/products/ProductsView.tsx), and [`KhataLedgerView.tsx`](../frontend/src/features/khata/KhataLedgerView.tsx) to forward opaque keyset `cursor` tokens on "Load More", fall back cleanly to `offset` when `nextCursor` is `null`, abort stale requests on rapid typing via `AbortController` + monotonic `requestIdRef`, and reset pagination cursors on query changes.
- **Canonical PDF Print Lifecycle Verification:** Verified in [`release029.frontend.test.ts`](../frontend/tests/release029.frontend.test.ts) across `1`, `10`, and `50`-page Blobs that `printCanonicalPdfBlob()` uses Object URLs without `HTMLCanvasElement.toDataURL()` full-document rasterization, keeps URLs alive until `afterprint`, falls back to download + revokes URLs cleanly on popup/iframe blocks, and cleans up PDF.js tasks/documents in `PdfDocumentPreviewModal` unmount.

---

## 6. Inventory of Release #029 Changes vs. `main`

- **Database & Backend (`15` files):** `backend/migrations/029_outbox_legacy_dead_letter_and_perf_indexes.sql`, `backend/src/config/database.ts`, `backend/src/modules/gstInvoices/gstInvoices.service.ts`, `backend/src/modules/khata/khata.routes.ts`, `backend/src/modules/normalBills/normalBills.service.ts`, `backend/src/modules/offlineBills/offlineBills.service.ts`, `backend/src/modules/products/products.routes.ts`, `backend/src/modules/readModels/readModelOutbox.worker.ts`, `backend/src/modules/readModels/readModelSync.routes.ts`, `backend/src/modules/readModels/readModelSync.service.ts`, `backend/src/modules/readModels/readModelsQuery.service.ts`, `backend/tests/auth.security.test.ts`, `backend/tests/integration/postgres.integration.test.ts`, `backend/tests/release028.remediation.test.ts`, `backend/tests/release029.remediation.test.ts`.
- **Frontend (`7` files):** `frontend/src/types/pagination.ts`, `frontend/src/hooks/useRemoteSearch.ts`, `frontend/src/components/SearchablePicker.tsx`, `frontend/src/features/bills/useBillingCatalogueSearch.ts`, `frontend/src/features/khata/KhataLedgerView.tsx`, `frontend/src/features/products/ProductsView.tsx`, `frontend/tests/release029.frontend.test.ts`.
- **Documentation (`6` files):** `README.md`, `docs/DATABASE_AND_MIGRATIONS.md`, `docs/MONGODB_ARCHITECTURE.md`, `docs/ALGORITHM_AND_COMPLEXITY_REVIEW.md`, `docs/RELEASE_029_PERFORMANCE_BENCHMARKS.md`, `docs/RELEASE_029_REMEDIATION_REPORT.md`.

---

## 7. Final Verification Matrix (Post-Edit Observed Results)

All checks below executed cleanly after the final source code edits on branch `fix/release-029-dsa-performance-reliability`:

| Verification Command | Target Scope | Observed Result |
|---|---|---|
| `npm run build` | Backend TypeScript (`tsc`) + Frontend TypeScript & Vite bundle (`2,361` modules) | **Exited `0`** (`28.45s` frontend build) |
| `npm test` (Backend) | `vitest run --config vitest.config.ts` | **`27` files passed, `328` tests passed** (`0` failed, `0` skipped; `31.87s`), including `tests/release029.remediation.test.ts` (`17` tests) |
| `npm test` (Frontend) | `vitest run --config vitest.frontend.config.ts` | **`19` files passed, `146` tests passed** (`0` failed, `0` skipped; `42.55s`), including `frontend/tests/release029.frontend.test.ts` (`8` tests) |
| `npm run test:integration --workspace=backend` | `vitest.integration.config.ts` against local disposable PG `18.6` (`khata_test`) + MongoDB `8.2.4` (`khata_integration_test`) with `REQUIRE_TEST_DATABASE_URL=true` | **`1` file passed, `37` tests passed** (`0` failed, `0` skipped; `45.01s`), including Test `36` (`984ms`) |
| `node frontend/scripts/validate-assetlinks.js` | `frontend/public/.well-known/assetlinks.json` | **Passed** (`in.algions.khata` valid SHA-256 fingerprints) |
| `.\gradlew.bat assembleDebug --no-daemon` | `android-twa` debug APK packaging | **Passed** (`BUILD SUCCESSFUL in 38s`, `31` tasks) |

Local disposable databases (`khata_bench_029_test`, `khata_integration_test`) were dropped cleanly after verification and the temporary local PostgreSQL 18.6 cluster was stopped and removed. Zero production Neon, MongoDB Atlas, Render, or Cloudflare R2 resources were touched.
