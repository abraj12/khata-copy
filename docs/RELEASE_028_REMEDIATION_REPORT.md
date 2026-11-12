# Khata ERP — Release #028 Engineering Remediation & Performance Report
## Reliability, Data Consistency, Neon Query Reduction, Search Optimization, Printing Hardening & Production Readiness

- **Repository:** `https://github.com/abraj12/khata-copy`
- **Base Branch & Audited Commit:** `origin/main` at `f14751ceb244b120a37140c9525f4c15ec3c8010`
- **Feature Branch:** `fix/release-028-reliability-neon-performance`
- **Owner / Maintainer:** ALGIONS AI LABS PRIVATE LIMITED
- **Safety Boundaries Preserved:** Zero edits to historical migrations `001_*`–`027_*` (`028_outbox_dead_letter.sql` is strictly additive); zero stock/inventory/quantity fields added to `products` or `product_search` (preserving the single-vendor Khata model); zero connections or writes to production Neon PostgreSQL, Render, MongoDB Atlas, Vercel, Cloudflare R2, or `main`.

---

## 1. Executive Summary of Remediated Defects & Architecture Improvements

1. **Separated Freshness Tracking & Outbox Degradation Reporting (`readModelsQuery.service.ts`, `readModelSync.service.ts`, `HomeDashboard.tsx`, `AppearanceAccessibilityModal.tsx`):**
   - Extended `DashboardSnapshotDoc` (`backend/src/modules/readModels/models.ts`) and `buildSyncStatus()` (`backend/src/modules/readModels/readModelsQuery.service.ts`) with distinct `projectionSyncedAt` (`lastProjectionSyncAt`) and `dashboardSyncedAt` (`lastDashboardRefreshAt`) timestamps alongside `deadLetterCount` and `outboxDegraded`.
   - Enforced `MONGODB_READ_STALE_THRESHOLD_MS` evaluation on actual age even when the in-memory outbox backlog flag is clear, while scoping product/customer queries to `'projection'` freshness and dashboard overview queries to `'dashboard'` freshness so coalesced snapshot throttling does not trigger false stale alarms on catalogue searches.
   - Updated `DashboardSyncStatus`, `HomeDashboard.tsx`, `appDataApi.ts` (`fetchReadModelSyncStatusApi`), and Section D of `AppearanceAccessibilityModal.tsx` to preserve `sync-stale-badge` / `sync-fresh-badge` test IDs while displaying degraded/dead-letter states (`Sync needs attention (N failed)` / `Sync degraded (catching up)`).

2. **Resilient Transactional Outbox Worker, Dead-Letter Lifecycle & Owner Recovery (`028_outbox_dead_letter.sql`, `readModelOutbox.worker.ts`, `readModelSync.routes.ts`, `app.ts`):**
   - Added additive migration `backend/migrations/028_outbox_dead_letter.sql` (`dead_letter_at TIMESTAMPTZ NULL`, `'dead_letter'` status in `app_outbox_events_status_check`, and partial index `idx_app_outbox_dead_letter` registered in `database.ts`).
   - Hardened `ReadModelOutboxWorker`: propagates failure-recording PG errors into `handleDrainFailure()` with bounded exponential backoff instead of swallowing DB errors, renews long-running batch locks via active lease heartbeats (`renewBatchLease()`), transitions exhausted events (`attempt_count >= max_attempts`) to `status = 'dead_letter'` with `dead_letter_at = NOW()`, and maintains zero idle `setInterval` polling.
   - Mounted owner-authenticated `readModelSyncRouter` at `/api/v1/read-model-sync` (`GET /status` and `POST /outbox/:id/retry`) for live operational visibility and dead-letter recovery.

3. **Coalesced Dashboard Snapshots & Neon Compute Reduction (`mongoEnv.ts`, `readModelSync.service.ts`, `readModelOutbox.worker.ts`):**
   - Added `READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS` (`1000`–`300000`, default `15000`) in `backend/src/config/mongoEnv.ts`.
   - Updated `applyOutboxBatch()` (`{ skipDashboardSnapshot?: boolean }`) and `triggerOrScheduleDashboardRefresh()` / `flushDashboardRefresh()` (`refreshGlobalDashboardSnapshotFromPool()`) so item/date read-model projections (`product_search`, `customer_summaries`, `daily_analytics`, `recent_activity`) sync immediately while burst global snapshot recomputations coalesce into a single trailing refresh.

4. **Out-of-Order Timestamp Guards, `created_at` Preservation & Indexed Keyset Search (`readModelSync.service.ts`, `models.ts`, `readModelsQuery.service.ts`, `products.routes.ts`, `khata.routes.ts`):**
   - Enforced monotonic `sourceUpdatedAt` guards (`upsertProjectionWithTimestampGuard()` / `bulkUpsertByNumericKey()`) across read-model upserts to prevent older outbox retries or rebuilds from overwriting newer projections.
   - Added `createdAtPg` preservation to `product_search` (`syncProductsByIds()`) so `GET /api/v1/products` and `GET /api/v1/products/barcode/:barcode` preserve authoritative PostgreSQL `created_at` timestamps.
   - Added `normalizedHsnCode`, `buildCustomerSearchTokens()`, active compound indexes (`idx_product_search_active_barcode`, `idx_product_search_active_norm_hsn`, `idx_product_search_active_tokens`, `idx_customer_summaries_active_phone`, `idx_customer_summaries_active_tokens`), and validated base64url keyset `cursor` pagination (`InvalidPaginationCursorError` -> HTTP `400 INVALID_PAGINATION_CURSOR`) on `/api/v1/products` and `/api/v1/khata/customers`.

5. **MongoDB App-Data Hardening, Retention & PII Protection (`mongodb.ts`, `appData/models.ts`, `appData.service.ts`, `appData.routes.ts`, `readModels/models.ts`):**
   - Replaced the legacy sparse `idx_notifications_dedupe_unique` index with `{ partialFilterExpression: { dedupeKey: { $type: 'string' } } }`, paired with `migrateNotificationDedupeIndex()` inside `ensureMongoIndexes()` to drop legacy sparse indexes and `$unset` legacy `dedupeKey: null` fields cleanly; omitted `dedupeKey` when absent and handled `E11000` races cleanly in `AppDataService.createNotification()`.
   - Fixed `AppDataService.markNotificationsRead()` invalid ObjectId validation to raise structured HTTP `400` (`INVALID_NOTIFICATION_ID`) and fixed `err.status` error mapping in `appData.routes.ts` (`line 132`).
   - Added **180-day TTL retention** (`idx_recent_activity_ttl_180d`, `expireAfterSeconds: 15552000`) to `recent_activity`.
   - Added `AppDataService.classifyCustomerSearchQuery()` so `search_analytics` redacts customer search queries into `'customer_phone_search'`, `'customer_name_search'`, or `'customer_other_search'` rather than storing customer phones/names.

6. **Canonical PDF Printing Memory & Lifecycle Remediation (`frontend/src/utils/pdfPrint.ts`, `PdfDocumentPreviewModal.tsx`, `NotificationCenterButton.tsx`):**
   - Replaced full-document offscreen canvas PNG rasterization (`toDataURL('image/png')` page array) inside `PdfDocumentPreviewModal.tsx` with `printCanonicalPdfBlob()` (`frontend/src/utils/pdfPrint.ts`).
   - Prints canonical PDF blobs directly via `URL.createObjectURL(pdfBlob)` and a hidden desktop `<iframe>`, falls back cleanly to `window.open(objectUrl, '_blank')` (`opener = null`) on mobile/WebView or iframe load failures and `onFallbackDownload()` when pop-ups are blocked, guards against iframe detach re-entrancy (`fallbackInvoked`, `windowPrintTriggered`, removing DOM element before `removeAttribute('src')`), and deterministically revokes every Object URL on print completion, modal close, or unmount.
   - Added `AbortController` + monotonic sequence guards (`activeFetchControllerRef`, `loadSeqRef`) in `NotificationCenterButton.tsx` to abort superseded fetches cleanly and ignore `REQUEST_ABORTED` / stale responses.

7. **Repository Audit, Destructive Test Guards, Storage Cleanup & Deployment Separation (`testDbGuard.ts`, `database.ts`, `storage.service.ts`, `offlineBills.service.ts`, `migrate.ts`, `rebuild-read-models.ts`, `render.yaml`, `.github/workflows/ci.yml`):**
   - Enforced `REQUIRE_TEST_DATABASE_URL=true` (`testDbGuard.ts`) in integration/CI paths so destructive DB tests fail loudly unless pointed explicitly to a safe `_test` / `_integration_test` database.
   - Hardened `StorageService.verifyObject()` filename-extension vs verified `contentType` consistency (deleting mismatched uploaded R2 objects and rejecting with `INVALID_CONTENT_TYPE`) and preserved `INVALID_IMAGE_SIGNATURE` with JPEG/PNG/WebP/PDF guidance; added R2 cleanup on unexpected PostgreSQL insert errors in `offlineBillsService.createOfflineBill()` (preserving unique `'23505'` idempotency semantics).
   - Strictly separated SQL migrations (`backend/scripts/migrate.ts`) from explicit `--confirm`-guarded read-model rebuilds (`backend/scripts/rebuild-read-models.ts`).
   - Updated `render.yaml` (`MONGODB_ENABLED`, `MONGODB_URI`, `MONGODB_DATABASE`, `MONGODB_READ_STALE_THRESHOLD_MS`, `READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS`) and `.github/workflows/ci.yml` (`REQUIRE_TEST_DATABASE_URL: 'true'`, MongoDB 8 container configuration).
   - Preserved and documented the single-process `EventEmitter` outbox wakeup architecture (matching Render single-instance deployment; horizontal multi-worker scaling remains a documented future upgrade path).

---

## 2. Verification Matrix (Post-Final-Edit Observations)

| Check | Command | Scope & Environment | Observed Result |
| --- | --- | --- | --- |
| Digital Asset Links | `node frontend/scripts/validate-assetlinks.js` | Android TWA `assetlinks.json` | **Passed** (`exit 0`: `in.algions.khata` valid SHA-256 fingerprints) |
| Full Monorepo Build | `npm run build` | Backend `tsc` + Frontend `tsc && vite build` (`2360` modules) | **Passed** (`exit 0`, frontend built in `16.59s`) |
| Backend Unit & Architecture Suite | `npm test --workspace=backend` | `vitest run --config vitest.config.ts` (incl. `release028.remediation.test.ts` 16 tests) | **26/26 files passed, 311/311 tests passed** (`25.96s`) |
| Frontend Unit & UI Suite | `npm run test:frontend` | `vitest run --config vitest.frontend.config.ts` (incl. `release028.frontend.test.ts` 4 tests) | **18/18 files passed, 136/136 tests passed** (`21.16s`) |
| Real PostgreSQL 18 + MongoDB 8.2 Integration Suite | `npm run test:integration --workspace=backend` | `postgres.integration.test.ts` #1–#35 (`REQUIRE_TEST_DATABASE_URL=true`, `MONGODB_ENABLED=true`, local PG 18 + local MongoDB 8.2) | **1/1 file passed, 35/35 tests passed** (`29.30s`; Test #34 in `11,117 ms`, Test #35 in `2,803 ms`) |
| Android TWA Debug APK Build | `.\gradlew.bat assembleDebug --no-daemon` | `android-twa/` local Gradle JDK/SDK build | **Passed** (`BUILD SUCCESSFUL in 22s`; `31 actionable tasks: 31 up-to-date`) |
| Historical Migrations Integrity | `git diff --name-only origin/main -- backend/migrations/` | Diff against `origin/main` (`f14751ceb244b120a37140c9525f4c15ec3c8010`) | **Passed** (`0` modified historical migrations; additive `028_outbox_dead_letter.sql` only) |

---

## 3. Measured Database & Query Benchmarks (Real Local MongoDB 8.2 & PostgreSQL 18.6)

### 3.1 MongoDB 8.2 `explain('executionStats')` Across 1,000 / 10,000 / 25,000 Seeded Documents

Executed against isolated benchmark collections (`khata_benchmark_r28`, dropped immediately after benchmarking) built with `ensureMongoIndexes()` (`90%` active / `10%` archived):

| Query Shape (Limit `26`) | `N = 1,000` Docs | `N = 10,000` Docs | `N = 25,000` Docs |
| --- | --- | --- | --- |
| **Product Exact Barcode** (`{ barcode, isArchived: false }`) | `IXSCAN[idx_product_search_active_barcode]` · keys `1` · docs `1` · `1 ms` | `IXSCAN[idx_product_search_active_barcode]` · keys `1` · docs `1` · `0 ms` | `IXSCAN[idx_product_search_active_barcode]` · keys `1` · docs `1` · `1 ms` |
| **Product Prefix+Token Search** (`{ isArchived: false, $or: [...] }`, high-selectivity `'tata'` 10% prefix) | `SORT -> FETCH -> OR(IXSCAN[...active_name \| active_barcode \| active_norm_hsn \| active_tokens])` · keys `202` · docs `100` · `36 ms` | `OR(IXSCAN[...])` · keys `2,002` · docs `1,000` · `236 ms` | `OR(IXSCAN[...])` · keys `5,002` · docs `2,500` · `2,657 ms` |
| **Product Deep `skip(25%)`** (`{ isArchived: false }` sorted `{ normalizedName: 1, productId: 1 }`) | `IXSCAN[idx_product_search_active_name]` + `SKIP` · keys `276` · docs `26` · `12 ms` | `IXSCAN` + `SKIP` · keys `2,526` · docs `26` · `88 ms` | `IXSCAN` + `SKIP` · keys `6,276` · docs `26` · `1,553 ms` |
| **Product Keyset Seek (`25%` depth)** | `SORT_MERGE(IXSCAN[idx_product_search_active_name])` · keys `26` · docs `26` · **`6 ms`** | `SORT_MERGE(IXSCAN)` · keys `26` · docs `26` · **`4 ms`** | `SORT_MERGE(IXSCAN)` · keys `26` · docs `26` · **`6 ms`** (**-99.6% keys / 258.8x faster**) |
| **Customer Phone Prefix** (`6`-digit prefix `$or` across `active_name \| active_phone \| active_tokens`) | `OR(IXSCAN)` · keys `184` · docs `90` · `28 ms` | `OR(IXSCAN)` · keys `184` · docs `90` · `23 ms` | `OR(IXSCAN)` · keys `184` · docs `90` · `44 ms` |
| **Customer Deep `skip(40%)`** (`{ isArchived: false }` sorted `{ outstandingPaise: -1, lastActivityAt: -1, customerId: 1 }`) | `IXSCAN[idx_customer_summaries_active_outstanding]` + `SKIP` · keys `426` · docs `26` · `14 ms` | `IXSCAN` + `SKIP` · keys `4,026` · docs `26` · `139 ms` | `IXSCAN` + `SKIP` · keys `10,026` · docs `26` · `1,421 ms` |
| **Customer Keyset Seek (`40%` depth)** | `SORT_MERGE(IXSCAN[idx_customer_summaries_active_outstanding])` · keys `26` · docs `26` · **`9 ms`** | `SORT_MERGE(IXSCAN)` · keys `26` · docs `26` · **`8 ms`** | `SORT_MERGE(IXSCAN)` · keys `26` · docs `26` · **`9 ms`** (**-99.7% keys / 157.9x faster**) |

- **Zero `COLLSCAN` plans** observed across all 21 `explain('executionStats')` probes.

### 3.2 PostgreSQL 18 Outbox Query Reduction Under Burst Writes (20 Real Domain Mutations)

Measured against real local PostgreSQL 18.6 (`10` `productsService.updateProduct` + `10` `khataService.createTransaction` events):

| Outbox Sync Strategy (Same 20 Real Events) | Measured SQL Queries (`appPool`) | Measured Duration | Reduction vs Baseline |
| --- | --- | --- | --- |
| **Uncoalesced `20 × 1`** (pre-Release #028: snapshot rebuilt after each event) | `230` | `1,285.8 ms` | Baseline |
| **Coalesced `10 × 2` + 1 Trailing Flush** (`15s` throttle window, `skipDashboardSnapshot` between bursts) | `158` | `1,132.7 ms` | **`-31.3%`** (`72` fewer queries) |
| **Single Deduplicated Batch Drain** (`ReadModelOutboxWorker` batching all `20` burst events + 1 snapshot) | `19` | `78.9 ms` | **`-91.7%`** (`211` fewer queries) |

### Observed Scope Boundaries & Known Limitations

- **Live Cloud Environments Untouched:** Production Neon PostgreSQL, Render, MongoDB Atlas, Vercel, and Cloudflare R2 buckets were neither connected to nor modified. Cloudflare R2 SDK calls and `window.open` / `iframe.contentWindow.print` browser print dialogs were exercised via mocked tests in `vitest`.
- **Release APK Signing:** Unsigned `assembleRelease` was intentionally left unexecuted without production keystore credentials; CI enforces fail-closed release signing checks.
- **High-Cardinality Substring Prefixes:** Wide prefixes matching ~10% of all seeded products (`'tata'` across 25k synthetic docs) still intersect thousands of matching index keys prior to top-26 sorting (`2,657 ms` under local synthetic 25k load).
- **Single-Instance EventEmitter Wakeup:** Outbox commit wakeups operate in-process; deploying multiple concurrent API worker processes behind a load balancer will require adding an external broker or bounded worker wakeup hook.

---

## 4. Complete Changed Files Inventory

- **Configuration, CI & Scripts:**
  - `.github/workflows/ci.yml`
  - `render.yaml`
  - `backend/scripts/migrate.ts`
  - `backend/scripts/rebuild-read-models.ts`
- **Backend Migrations, Config & Infrastructure:**
  - `backend/migrations/028_outbox_dead_letter.sql` *(new)*
  - `backend/src/app.ts`
  - `backend/src/config/database.ts`, `backend/src/config/env.ts`, `backend/src/config/mongoEnv.ts`, `backend/src/config/mongodb.ts`, `backend/src/config/testDbGuard.ts`
  - `backend/src/services/storage.service.ts`
- **Backend Modules:**
  - `backend/src/modules/appData/appData.routes.ts`, `backend/src/modules/appData/appData.service.ts`, `backend/src/modules/appData/models.ts`
  - `backend/src/modules/khata/khata.routes.ts`
  - `backend/src/modules/offlineBills/offlineBills.service.ts`
  - `backend/src/modules/products/products.routes.ts`
  - `backend/src/modules/readModels/models.ts`, `backend/src/modules/readModels/readModelOutbox.worker.ts`, `backend/src/modules/readModels/readModelSync.routes.ts` *(new)*, `backend/src/modules/readModels/readModelSync.service.ts`, `backend/src/modules/readModels/readModelsQuery.service.ts`
- **Frontend:**
  - `frontend/src/utils/pdfPrint.ts` *(new)*
  - `frontend/src/components/PdfDocumentPreviewModal.tsx`, `frontend/src/components/NotificationCenterButton.tsx`, `frontend/src/components/AppearanceAccessibilityModal.tsx`
  - `frontend/src/features/dashboard/HomeDashboard.tsx`, `frontend/src/features/dashboard/dashboard.types.ts`
  - `frontend/src/lib/appDataApi.ts`
- **Automated Tests & Documentation:**
  - `backend/tests/auth.security.test.ts`, `backend/tests/mongodb.architecture.test.ts`, `backend/tests/release028.remediation.test.ts` *(new)*, `backend/tests/testDbGuard.test.ts`, `backend/tests/integration/postgres.integration.test.ts`
  - `frontend/tests/release027.frontend.test.ts`, `frontend/tests/release028.frontend.test.ts` *(new)*
  - `docs/MONGODB_ARCHITECTURE.md`, `docs/RELEASE_028_REMEDIATION_REPORT.md` *(new)*
