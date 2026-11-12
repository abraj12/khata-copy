# Khata ERP — Release #030 Technical Remediation & Verification Report

**Release:** `#030`  
**Owner:** ALGIONS AI LABS PRIVATE LIMITED  
**Working Branch:** `fix/release-030-performance-and-reliability`  
**Protected Base Branch:** `main` (untouched at starting commit)

---

## 1. Executive Summary

Release `#030` resolves the five architectural, scalability, concurrency, and storage-durability findings identified following Release `#029`, along with additional edge defects discovered during code remediation and `EXPLAIN (ANALYZE, BUFFERS)` verification. All financial logic, `decimal.js` `ROUND_HALF_UP` precision, FIFO payment allocations, single-vendor zero-stock catalog semantics, and existing API response contracts were preserved intact.

All backend unit tests, frontend component/concurrency tests, real PostgreSQL 18.6 + MongoDB 8.2.4 integration tests, and `1,000`–`100,000` scale benchmarks were executed directly against disposable local test databases after implementation, alongside full workspace production builds, Digital Asset Links validation, and an Android TWA debug APK build.

---

## 2. Starting Repository Commit

- **Base Branch (`main`) SHA:** `46b82b005cc6abce646da270a36646ed0e0bd402`
- **Feature Branch:** `fix/release-030-performance-and-reliability`

---

## 3. Confirmed Release 029 Issues

| # | Finding | Root Subsystem | Release #030 Status | Verification Basis |
|---|---|---|---|---|
| 1 | Outbox idle/wakeup checks scanned full `app_outbox_events` (`MIN(CASE ...)` / `COUNT(*) FILTER`) | `backend/src/modules/readModels/readModelOutbox.worker.ts` + Migration `031` | **`FIXED AND TESTED`** | Unit tests (`release030.remediation.test.ts`), real PG 18.6 100k `EXPLAIN (ANALYZE, BUFFERS)` (`release030.integration.test.ts`), `benchmark:release030` |
| 2 | PostgreSQL fallback search lacked prefix/trigram indexes across HSN/barcode/phone & ran un-materialized full-ledger CTEs | `backend/src/modules/products/products.service.ts`, `khata.service.ts`, `database.ts`, Migration `031` | **`FIXED AND TESTED`** | Unit tests, real PG 18.6 integration (`searchCapabilities`, `exactBarcode`, Hindi/Punjabi, `+91` phone), `benchmark:release030` |
| 3 | Frontend rapid typing/picker open-close/scroll load-more races & unstable callback re-fetch loops | `frontend/src/hooks/useRemoteSearch.ts`, `SearchablePicker.tsx`, `useBillingCatalogueSearch.ts`, `ProductsView.tsx`, `KhataLedgerView.tsx` | **`FIXED AND TESTED`** | Jsdom frontend concurrency test suite (`frontend/tests/release030.frontend.test.ts`) + full `npm run test:frontend` |
| 4 | Customer sort tie parity divergence (`ROUND(outstanding, 2)` vs paise, `NULL` activity ordering) and missing query-bound cursor helpers | `backend/src/modules/khata/khata.service.ts`, `readModelsQuery.service.ts` | **`FIXED AND TESTED`** | Unit tests + real PG & MongoDB 8.2.4 parity & cursor tamper/replay tests (`release030.integration.test.ts`) + `benchmark:release030` |
| 5 | Best-effort `fire-and-forget` Cloudflare R2 deletions dropped orphaned keys permanently on transient S3 errors | Migrations `030`, `storageCleanup.service.ts`, `storageCleanup.worker.ts`, `storage.service.ts`, service callers | **`FIXED AND TESTED`** | Unit tests + real PG `storage_cleanup_jobs` 6-table live-reference guard, `ON CONFLICT` active dedup, `SKIP LOCKED`, dead-letter (`release030.integration.test.ts`) |

---

## 4. Additional Defects Found

During implementation and verification, six additional defects were identified and resolved:

1. **Infinite Re-Render Loop on Inline Callbacks (`useRemoteSearch.ts` / `useBillingCatalogueSearch.ts`):** Placing non-memoized prop callbacks (`fetcher`, `getItemKey`, `fetchPage`) inside `useCallback` dependency arrays caused continuous re-fetch loops when parent components passed inline arrow functions, and calling `reset()` unnecessarily replaced state when already empty. Resolved via ref-stabilization (`fetcherRef`, `getItemKeyRef`, `fetchPageRef`) and an empty-state no-op guard (`FIXED AND TESTED`).
2. **Stale `total: null` vs Active Search Mismatch in `ProductsView.tsx` & `KhataLedgerView.tsx`:** Clearing pagination state on non-append searches and gating `handleLoadMore` against `search !== activeSearchRef.current` and synchronous `isLoadingMoreRef` prevents appending old-query pages into newly filtered results (`FIXED AND TESTED`).
3. **Unexposed Degraded Search State (`readModelSync.routes.ts` / `database.ts`):** When a managed PostgreSQL database lacks `pg_trgm` privileges, admins had no observability indicator. Added `inspectSearchIndexCapabilities()` surfaced on `GET /api/v1/read-model-sync/status` (`searchCapabilities`) (`FIXED AND TESTED`).
4. **Live R2 Reference Collisions Across Shared Keys:** Blindly retrying an R2 delete after a timeout could remove an object re-attached or shared by another record. Added 6-table live reference check (`findLiveObjectReferences`) before executing or retrying physical deletes (`FIXED AND TESTED`).
5. **Unbounded Benchmark & Integration Isolation Safety:** `vitest.integration.config.ts` ran integration files in parallel against shared test DBs; set `fileParallelism: false` and `testTimeout: 60000`, and enforced `assertSafeTestDatabaseUrl` + loopback `_test` DB guards in `benchmark-release030.ts` (`FIXED AND TESTED`).
6. **Legacy Broken Link in `docs/ALGORITHM_AND_COMPLEXITY_REVIEW.md`:** Corrected stale migration path link and outdated complexity notes during documentation alignment (`FIXED AND TESTED`).

---

## 5. Root Cause Analysis

1. **Outbox Full-Table Scan:** Computing `MIN(next_attempt_at)` + `COUNT(*) FILTER (WHERE status = 'dead_letter')` in a single conditional aggregate query prevented PostgreSQL from using selective partial B-tree indexes, forcing a `Parallel Seq Scan` across `100,000` historical `'processed'` rows (`2,041` shared blocks, `45.7 ms`).
2. **Missing Partial Indexes & Unbounded Aggregate CTEs in PG Fallback Search:** `customers` fallback previously joined/aggregated `udhar_transactions`, `payment_allocations`, and `payments` broadly instead of materializing matching `customers` rows first, and `products` lacked active `LOWER(barcode) text_pattern_ops`, `LOWER(hsn_code) text_pattern_ops`, and guarded `pg_trgm` GIN indexes across HSN, barcode, and phone columns.
3. **Frontend Reference Instability & Stale Async Commits:** Both render-cycle callback recreation in hooks and missing `controller.signal.aborted` + request-ID + active-query checks allowed aborted/superseded HTTP responses to mutate state or re-trigger `useEffect` loops.
4. **PG vs Mongo Customer Sort Mismatch:** Floating-point / unrounded `GREATEST(total_udhar - allocated, 0)` in PG could diverge from Mongo's integer paise rounding `outstandingPaise` on sub-paisa fractions or NULL activity dates.
5. **Non-Durable R2 Orphan Cleanup:** Inline `void deleteObject(...)` calls lived solely in Node heap memory; process restarts or transient R2 `5xx`/network timeouts lost cleanup work irreversibly.

---

## 6. Files Modified

### Backend Source & Migrations
- [`backend/migrations/030_storage_cleanup_jobs.sql`](../backend/migrations/030_storage_cleanup_jobs.sql) *(new)*
- [`backend/migrations/031_outbox_worker_search_indexes.sql`](../backend/migrations/031_outbox_worker_search_indexes.sql) *(new)*
- [`backend/src/config/database.ts`](../backend/src/config/database.ts)
- [`backend/src/index.ts`](../backend/src/index.ts)
- [`backend/src/modules/khata/khata.service.ts`](../backend/src/modules/khata/khata.service.ts)
- [`backend/src/modules/offlineBills/offlineBills.routes.ts`](../backend/src/modules/offlineBills/offlineBills.routes.ts)
- [`backend/src/modules/offlineBills/offlineBills.service.ts`](../backend/src/modules/offlineBills/offlineBills.service.ts)
- [`backend/src/modules/products/products.routes.ts`](../backend/src/modules/products/products.routes.ts)
- [`backend/src/modules/products/products.service.ts`](../backend/src/modules/products/products.service.ts)
- [`backend/src/modules/readModels/readModelOutbox.worker.ts`](../backend/src/modules/readModels/readModelOutbox.worker.ts)
- [`backend/src/modules/readModels/readModelSync.routes.ts`](../backend/src/modules/readModels/readModelSync.routes.ts)
- [`backend/src/modules/readModels/readModelsQuery.service.ts`](../backend/src/modules/readModels/readModelsQuery.service.ts)
- [`backend/src/modules/suppliers/suppliers.controller.ts`](../backend/src/modules/suppliers/suppliers.controller.ts)
- [`backend/src/modules/suppliers/suppliers.service.ts`](../backend/src/modules/suppliers/suppliers.service.ts)
- [`backend/src/services/storage.service.ts`](../backend/src/services/storage.service.ts)
- [`backend/src/services/storageCleanup.service.ts`](../backend/src/services/storageCleanup.service.ts) *(new)*
- [`backend/src/services/storageCleanup.worker.ts`](../backend/src/services/storageCleanup.worker.ts) *(new)*
- [`backend/scripts/benchmark-release030.ts`](../backend/scripts/benchmark-release030.ts) *(new)*
- [`backend/package.json`](../backend/package.json), [`backend/vitest.integration.config.ts`](../backend/vitest.integration.config.ts), [`package.json`](../package.json)

### Frontend Source
- [`frontend/src/hooks/useRemoteSearch.ts`](../frontend/src/hooks/useRemoteSearch.ts)
- [`frontend/src/components/SearchablePicker.tsx`](../frontend/src/components/SearchablePicker.tsx)
- [`frontend/src/features/bills/useBillingCatalogueSearch.ts`](../frontend/src/features/bills/useBillingCatalogueSearch.ts)
- [`frontend/src/features/products/ProductsView.tsx`](../frontend/src/features/products/ProductsView.tsx)
- [`frontend/src/features/khata/KhataLedgerView.tsx`](../frontend/src/features/khata/KhataLedgerView.tsx)

### Tests & Documentation
- [`backend/tests/release030.remediation.test.ts`](../backend/tests/release030.remediation.test.ts) *(new)*
- [`backend/tests/integration/release030.integration.test.ts`](../backend/tests/integration/release030.integration.test.ts) *(new)*
- [`frontend/tests/release030.frontend.test.ts`](../frontend/tests/release030.frontend.test.ts) *(new)*
- Updated compatibility assertions in [`backend/tests/auth.security.test.ts`](../backend/tests/auth.security.test.ts), [`backend/tests/mongodb.architecture.test.ts`](../backend/tests/mongodb.architecture.test.ts), [`backend/tests/release028.remediation.test.ts`](../backend/tests/release028.remediation.test.ts), [`backend/tests/release029.remediation.test.ts`](../backend/tests/release029.remediation.test.ts), [`backend/tests/search.api.test.ts`](../backend/tests/search.api.test.ts), and [`backend/tests/integration/postgres.integration.test.ts`](../backend/tests/integration/postgres.integration.test.ts)
- Updated documentation: `docs/RELEASE_030_REMEDIATION_REPORT.md`, `docs/RELEASE_030_PERFORMANCE_BENCHMARKS.md`, `docs/DATABASE_AND_MIGRATIONS.md`, `docs/MONGODB_ARCHITECTURE.md`, `docs/ALGORITHM_AND_COMPLEXITY_REVIEW.md`, and `README.md`

---

## 7. Database Migration Summary

Historical migrations `001`–`029` remain completely untouched.

- **Migration `030` (`backend/migrations/030_storage_cleanup_jobs.sql`):**
  - Creates table `storage_cleanup_jobs` (`pending | processing | failed | completed | dead_letter`, `attempt_count >= 0`, `max_attempts >= 1`, `next_attempt_at`, `lease_expires_at`, `last_error`, `completed_at`, `dead_letter_at`).
  - Partial unique index `idx_storage_cleanup_active_object ON storage_cleanup_jobs (object_key) WHERE status IN ('pending', 'processing', 'failed')` deduplicates active retries without blocking future legitimate re-enqueues once completed/dead-lettered.
  - Wakeup & retention partial indexes: `idx_storage_cleanup_pending_ready`, `idx_storage_cleanup_failed_retryable`, `idx_storage_cleanup_processing_wake` (`lease_expires_at ASC NULLS FIRST`), `idx_storage_cleanup_completed_at`.
- **Migration `031` (`backend/migrations/031_outbox_worker_search_indexes.sql`):**
  - Outbox partial indexes: `idx_app_outbox_pending_wake`, `idx_app_outbox_failed_retryable`, `idx_app_outbox_processing_wake`, `idx_app_outbox_processed_at`.
  - Standard B-tree indexes: `idx_products_active_barcode_prefix`, `idx_products_active_hsn_prefix`, `idx_customers_active_normalized_name_id`, `idx_customers_active_phone_digits`.
  - Permission-safe guarded `DO $$ ... $$` block installing `pg_trgm` (handling `insufficient_privilege` / `undefined_file` gracefully) and creating `idx_products_active_hsn_trgm`, `idx_products_active_barcode_trgm`, `idx_customers_active_phone_trgm`, and `idx_customers_active_normalized_phone_trgm`.
- **`database.ts` Governance:** Registered `030` and `031` in `EXPECTED_MIGRATIONS`, added `storage_cleanup_jobs` to `EXPECTED_CORE_TABLES`, and added `OPTIONAL_SEARCH_TRGM_INDEXES` + `inspectSearchIndexCapabilities()`.

---

## 8. Outbox Worker Optimization

- Replaced the single conditional aggregate wake query with three selective `LIMIT 1` subqueries (`UNION ALL` + `ORDER BY next_attempt_at ASC` / `lease_expires_at ASC NULLS FIRST`) inside `ReadModelOutboxWorker.inspectRetryableBacklogDelay()`.
- Separated dead-letter count updates (`refreshDeadLetterIndicator()`) out of hot wake loops so they execute on worker startup and dead-letter transitions only.
- Preserved `FOR UPDATE SKIP LOCKED`, `NULL` and expired lease reclamation, lease heartbeat renewal (`renewBatchLease()`), bounded retry scheduling (`clampOutboxWakeDelayMs`), and zero idle polling timers when backlog is empty (`idlePollingTimersWhenEmpty = 0`).

---

## 9. PostgreSQL Search Optimization

- `products.service.ts` supports `exactBarcode` alongside escaping `ILIKE` filters (`name`, `hsn_code`, `barcode`) using active partial indexes and optional `pg_trgm` GIN indexes (`idx_products_active_name_trgm`, `idx_products_active_hsn_trgm`, `idx_products_active_barcode_trgm`, `idx_products_barcode_active`).
- `khata.service.ts` isolates customer predicate filtering inside `WITH matched_customers AS MATERIALIZED (...)` before running `tx_agg`, `alloc_agg`, and `pay_agg`, extends `+91` / leading-`0` phone normalization with explicit `ESCAPE '\'`, and aligns fallback sorting with MongoDB (`ROUND(GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0), 2) DESC, GREATEST(tx.last_activity, pay.last_payment) DESC NULLS LAST, c.id ASC`).
- Degraded `pg_trgm` environments remain fully functional and report `fallbackSearchMode` accurately on `/api/v1/read-model-sync/status`.

---

## 10. MongoDB Search and Pagination

- Added `buildProductCursorQueryContext` and `buildCustomerCursorQueryContext` in `backend/src/modules/readModels/readModelsQuery.service.ts` to cryptographically bind HMAC-SHA256 pagination cursors (`encodeCursor`, `decodeProductCursor`, `decodeCustomerCursor`) to their exact normalized query filters, preventing cross-query replay (`HTTP 400 INVALID_PAGINATION_CURSOR`).
- Verified zero-skip null-safe tie pagination (`100 / 100` unique docs collected across identical `outstandingPaise` and mixed `NULL` `lastActivityAt` values on live MongoDB 8.2.4), Unicode token searches (`बासमती`, `ਪੰਜਾਬੀ`), and deep cursor seek at `80,000` (`27` keys examined, `2.736 ms` median vs `184.787 ms` `.skip()`).

---

## 11. Frontend Race-Condition Fixes

- `useRemoteSearch.ts` (`fetcherRef`, `getItemKeyRef`), `useBillingCatalogueSearch.ts` (`fetchPageRef`), `SearchablePicker.tsx`, `ProductsView.tsx`, and `KhataLedgerView.tsx`:
  - Eliminated infinite render-effect loops when inline callbacks are passed.
  - Aborted stale requests on keystroke/filter change, unmount, and disabled transitions; guarded state setters with `controller.signal.aborted`, `requestIdRef`, `activeSearchRef`, and synchronous `isLoadingMoreRef`.
  - Cleared stale `pagination` / `nextCursor` on new searches before resolving page 1.

---

## 12. R2 Cleanup Reliability

- `storageCleanup.service.ts` + `storageCleanup.worker.ts` + `storage.service.ts`:
  - Added `findLiveObjectReferences(key)` checking all 6 live object tables (`products`, `offline_bill_records`, `supplier_purchase_bills`, `gst_invoices`, `normal_bills`, `quotation_settings`) prior to physical deletion.
  - Wired `attemptDeleteOrEnqueue()` across offline bill / supplier bill / storage delete call sites so transient S3 failures enqueue durable retries in `storage_cleanup_jobs` (`ON CONFLICT` active deduplication, bounded exponential backoff via `computeStorageCleanupBackoffMs`, `FOR UPDATE SKIP LOCKED`, `NULL`/expired lease recovery, and `dead_letter` transition on exhaustion).
  - Started and cleanly drained/stopped `storageCleanupWorker` in `backend/src/index.ts`.
  - Sanitized logged errors and masked object keys via `redactObjectKeyForLog()` / `sanitizeStorageErrorMessage()`.

---

## 13. Financial Regression Verification

Verified across `postgres.integration.test.ts`, `release030.integration.test.ts`, and backend unit suites:
- **`decimal.js` `ROUND_HALF_UP`** calculations and DB `NUMERIC` constraints remain authoritative in PostgreSQL.
- **FIFO Payment Allocations & Overpayment Concurrency:** Customer row locking (`FOR UPDATE`) and allocation constraints block concurrent overpayments safely inside PostgreSQL transactions.
- **Idempotency Keys:** Preserved transactional idempotency protections (`idempotency.service.ts`) without duplicate ledger charges.
- **Single-Vendor Scope:** Zero stock/inventory quantities or stock movement ledgers exist anywhere in the codebase.

---

## 14. Security Verification

- **Session & CSRF Revocation:** Real-DB integration test verified authenticated logout invalidates both cookie session and CSRF token (`GET /api/v1/auth/me` -> `401`).
- **Signed Pagination Cursors:** HMAC-SHA256 + `timingSafeEqual` rejects malformed, tampered, expired/cross-endpoint, and cross-query cursors (`400 INVALID_PAGINATION_CURSOR`).
- **Test DB Guard (`testDbGuard.ts`):** All integration and benchmark scripts require explicit disposable test flags/loopback `_test` databases and block `neondb_owner` / non-test endpoints.
- **PII & Credential Redaction:** Search analytics strips customer PII (`AppDataService`); storage worker scrubs signed query strings / secrets before DB persistence or logging.

---

## 15. Unit Test Results

*(Final post-doc-edit command results observed directly at handoff — see conversation verification step)*:
- Backend unit test suite (`npm test --workspace=backend`): **28 test files passed (28), 342 tests passed (342)** including all **14** Release `#030` tests in `backend/tests/release030.remediation.test.ts`.
- Frontend test suite (`npm run test:frontend`): **20 test files passed (20), 153 tests passed (153)** including all **7** concurrency tests in `frontend/tests/release030.frontend.test.ts`.

---

## 16. Integration Test Results

Executed against disposable local **PostgreSQL 18.6 (`127.0.0.1:55432/khata_integration_test`)** and **MongoDB 8.2.4 (`127.0.0.1:27017`)** via `npm run test:integration`:
- **2 test files passed (2), 43 tests passed (43)** (`0` skipped, `0` failed):
  - `tests/integration/postgres.integration.test.ts`: **37/37 passed**
  - `tests/integration/release030.integration.test.ts`: **6/6 passed** (clean 001–031 install, 029->031 upgrade preserving financial data, 100k outbox `EXPLAIN ANALYZE` wakeup + lease recovery + freshness separation, 100-event burst + PG/Mongo sort parity + Hindi/Punjabi + phone search + cursor tamper/replay rejection, 6-table R2 cleanup live guard + `ON CONFLICT` + `SKIP LOCKED` + dead-letter, financial FIFO/overpay concurrency/idempotency + session/CSRF revocation).

---

## 17. Benchmark Methodology

Executed `npm run benchmark:release030 -- --sizes=1000,10000,25000,100000` (`backend/scripts/benchmark-release030.ts`) against disposable PostgreSQL 18.6 (`khata_bench_test`) and MongoDB 8.2.4 (`khata_release030_bench_test`), verifying DB safety guards, seeding up to `100,000` products/customers/outbox events, computing median & P95 timings, running live service methods, and capturing raw PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` and MongoDB `.explain('executionStats')` plans.

---

## 18. Before/After Benchmark Tables

Full 4-scale tables (`1,000`, `10,000`, `25,000`, `100,000`) are documented verbatim in [`docs/RELEASE_030_PERFORMANCE_BENCHMARKS.md`](RELEASE_030_PERFORMANCE_BENCHMARKS.md). Highlights at `N = 100,000`:
- **Outbox Wakeup:** `38.842 ms` median / `45.733 ms` PG exec / `2,041` shared blocks (`Parallel Seq Scan`) -> **`1.081 ms` median / `0.054–0.085 ms` PG exec / `6–9` shared blocks** (`Merge Append -> 3x Index Only Scan`), **`0` idle polling timers**.
- **Deep Pagination (`offset = 80,000`):** `184.787 ms` median / `241.001 ms` p95 / `80,026` keys (`.skip()`) -> **`2.736 ms` median / `4.159 ms` p95 / `27` keys** (`cursor`).
- **Unicode Search (`बासमती` / `ਪੰਜਾਬੀ`):** MongoDB `2.393–3.049 ms` median (`1` key, `IXSCAN`).

---

## 19. Actual Query Execution Plans

All raw PG `EXPLAIN (ANALYZE, BUFFERS)` plans and MongoDB `executionStats` stages (`IXSCAN` index names, `keysExamined`, `docsExamined`) are reproduced verbatim in [`docs/RELEASE_030_PERFORMANCE_BENCHMARKS.md`](RELEASE_030_PERFORMANCE_BENCHMARKS.md), including the transparent finding that `khata.service.ts` currently wraps `normalized_phone` inside `COALESCE(normalized_phone, '')`, causing PG to `Seq Scan` `customers` inside `matched_customers` (`75.24 ms` at `100k`) while still restricting downstream ledger CTE joins to the 2 matched rows via `Index Scan`.

---

## 20. Known Limitations

1. **Multi-Instance Outbox Wakeup Latency:** `ReadModelOutboxWorker` uses an in-process `EventEmitter` (`zero idle polling`); horizontal scaling across multiple backend web processes would introduce delayed wakeup on instances not receiving the commit unless backed by external pub/sub (`LISTEN/NOTIFY`) or bounded fallback checks.
2. **PG Customer Fallback `COALESCE(normalized_phone, '')`:** Observed via `EXPLAIN (ANALYZE, BUFFERS)` at `100k` rows (`matched_customers` `Seq Scan`). Keeping raw `normalized_phone IS NOT NULL AND normalized_phone ILIKE ...` is recommended for a minor future optimization so PostgreSQL can bind `idx_customers_active_normalized_phone_trgm` cleanly.
3. **PG `pg_trgm` Privileges on Restricted Hosts:** If a managed PostgreSQL role lacks `CREATE EXTENSION pg_trgm`, Migration `031` skips GIN creation cleanly without failing (`fallbackSearchMode: 'degraded_no_pg_trgm'` / `'sequential_fallback'`), leaving non-prefix substring PG fallback slower (MongoDB search stays primary in production).
4. **Mongo `exact_hsn` Cost Choice at `100k`:** Because results sort by `{ normalizedName: 1, productId: 1 }`, MongoDB switched from `idx_product_search_active_norm_hsn` (at `1k–25k`) to walking `idx_product_search_active_name` at `100k` (`17 ms` server exec).

---

## 21. Production Verification Still Required (`REQUIRES LIVE VERIFICATION`)

Because changes must remain isolated from production infrastructure prior to owner review:
- **`REQUIRES LIVE VERIFICATION`:** Running `npm run migrate --workspace=backend` (`030` and `031`) against live Neon PostgreSQL and inspecting `GET /api/v1/read-model-sync/status` (`searchCapabilities.pgTrgmInstalled` / `missingOptionalIndexes`).
- **`REQUIRES LIVE VERIFICATION`:** End-to-end live Render web service + Cloudflare R2 bucket retry/delete + MongoDB Atlas `M0`/cluster verification under real production network latency.
- **`REQUIRES LIVE VERIFICATION`:** Signing and distributing a release Android TWA APK (`./gradlew assembleRelease`) when native Android updates are next desired.

---

## 22. Final Release Recommendation

**READY FOR PULL REQUEST REVIEW & OWNER STAGED ROLLOUT.**  
All Release `#030` reliability, search, frontend concurrency, R2 cleanup durability, financial integrity, and observability objectives are implemented cleanly on `fix/release-030-performance-and-reliability` (`main` untouched at `46b82b005cc6abce646da270a36646ed0e0bd402`), with full unit, real PostgreSQL 18.6 + MongoDB 8.2.4 integration, 100k benchmark, workspace build, Digital Asset Links, and TWA debug build checks passing.
