# Khata ERP — Release #027 Engineering Remediation Report
## MongoDB Read-Optimized Architecture, Neon Workload Reduction, Printing Hardening, Storage Bounds & Production Readiness

- **Repository:** `https://github.com/abraj12/khata-copy`
- **Base Branch & Audited Commit:** `main` at `5084a7195468551f1f4de9459238c62cda8aac1d`
- **Feature Branch:** `fix/release-027-neon-mongodb-read-models`
- **Safety Boundaries Preserved:** Zero edits to historical migrations `001_*`–`026_*`; zero stock/inventory/quantity fields added to `products` or `product_search` (preserving the single-vendor Khata model); zero mutations to production Neon PostgreSQL, Render, Cloudflare R2, Vercel, or `main`.

---

## 1. Executive Summary of Remediated Defects & Architecture Changes

1. **Strict Environment Parsing & Destructive Test Database Guards (`mongoEnv.ts`, `env.ts`, `testDbGuard.ts`, `database.ts`):**
   - Added [`parseStrictEnvBoolean()`](../backend/src/config/mongoEnv.ts#L7-L26) and [`validateAndParseMongoEnv()`](../backend/src/config/mongoEnv.ts#L41-L85) in `backend/src/config/mongoEnv.ts` (integrated into `backend/src/config/env.ts`), eliminating `z.coerce.boolean()` truthiness hazards (e.g., `"false"` evaluating to `true`) and failing fast in production unless `MONGODB_ENABLED=true` with a valid non-placeholder `MONGODB_URI`.
   - Hardened `assertSafeTestDatabaseUrl()` and [`resolveValidatedTestPoolUrls()`](../backend/src/config/testDbGuard.ts#L111-L142) in `backend/src/config/testDbGuard.ts` + [`resolveDatabasePoolTargets()`](../backend/src/config/database.ts#L10-L39) in `backend/src/config/database.ts` so destructive test suites unconditionally block cloud DB hosts (including `neon.tech`, `render.com`, `onrender.com`, `supabase.co`, `elephantsql.com`, `rds.amazonaws.com`), block the `neondb_owner` role even on loopback URIs, require `_test` or `_integration_test` database suffixes, require loopback hosts unless `ALLOW_REMOTE_TEST_DB=true`, and reject mismatched `TEST_DATABASE_URL` / `DATABASE_URL` / `DATABASE_URL_POOLED` targets.

2. **MongoDB Read Models, Controlled Indexing & App-Data Schemas (`mongodb.ts`, `readModels/models.ts`, `appData/models.ts`):**
   - Added connection lifecycle, credential redaction (`redactMongoUri()`), startup index synchronization (`createIndexes()`), and readiness reporting in `backend/src/config/mongodb.ts`.
   - Defined MongoDB collections (`product_search`, `customer_summaries`, `daily_analytics`, `recent_activities`, `dashboard_snapshots` in `backend/src/modules/readModels/models.ts`; `user_preferences`, `notifications`, `app_telemetry`, `search_analytics`, `app_activity_events` in `backend/src/modules/appData/models.ts`) with `autoIndex: false` across every model, TTL retention indexes on telemetry/activity/search logs, and a sparse unique `dedupeKey` index on notifications.
   - Documented collection design, index contracts, and fail-closed guarantees in [docs/MONGODB_ARCHITECTURE.md](./MONGODB_ARCHITECTURE.md).

3. **Transactional PostgreSQL Outbox & Batched Zero-Idle-Polling Sync (`027_outbox_events.sql`, `outbox.service.ts`, `readModelOutbox.worker.ts`, `readModelSync.service.ts`):**
   - Added additive migration `backend/migrations/027_outbox_events.sql` creating `app_outbox_events` (registered in [`EXPECTED_MIGRATIONS`](../backend/src/config/database.ts#L108-L136) and [`EXPECTED_CORE_TABLES`](../backend/src/config/database.ts#L138-L168)).
   - Wired transactional `enqueueOutboxEvent(client, ...)` and post-commit wakeups (`notifyOutboxCommitted()`) into PostgreSQL write flows across `products.service.ts`, `khata.service.ts`, `gstInvoices.service.ts`, `normalBills.service.ts`, `quotations.service.ts`, `suppliers.service.ts`, and `dashboard.service.ts`.
   - Implemented [`ReadModelOutboxWorker`](../backend/src/modules/readModels/readModelOutbox.worker.ts#L14-L401) (lifecycle wired in `backend/src/index.ts`):
     - Zero `setInterval` background polling when idle; triggered cleanly on committed writes (`notifyOutboxCommitted()`), claiming leases via `FOR UPDATE SKIP LOCKED`, scheduling bounded one-shot backoff retries only on failure/backlog, and piggybacking bounded 7-day cleanup of processed rows.
   - Implemented `ReadModelSyncService` (`backend/src/modules/readModels/readModelSync.service.ts`) with timestamp-guarded idempotent upserts (`upsertProjectionWithTimestampGuard()` / `bulkUpsertByNumericKey()`), batched PostgreSQL-to-MongoDB projection methods (`syncProductsByIds()` and `syncCustomersByIds()` using `ANY($1::bigint[])` + `bulkWrite`), sequential `await client.query(...)` execution on single `PoolClient` instances, and `{ confirm: true }`-guarded full rebuilds via `rebuildAllReadModels()` (`backend/scripts/rebuild-read-models.ts`, root command `npm run rebuild:read-models -- --confirm`).

4. **Zero-PG-Query Read Paths, Fail-Closed `503` & Liveness Contract (`readModelsQuery.service.ts`, `dashboard.routes.ts`, `products.routes.ts`, `khata.routes.ts`, `app.ts`):**
   - Routed `GET /api/v1/dashboard/overview`, `GET /api/v1/products`, `GET /api/v1/products/barcode/:barcode`, `GET /api/v1/khata/summary`, and `GET /api/v1/khata/customers` to `readModelsQueryService` when `MONGODB_ENABLED=true`, executing zero PostgreSQL queries during read traffic.
   - When `MONGODB_ENABLED=true` and MongoDB is unavailable, routes fail closed with HTTP `503` and `code: 'READ_MODEL_UNAVAILABLE'` without silent PostgreSQL fallback.
   - `/api/v1/health/live` executes `0` PostgreSQL queries and `0` MongoDB queries.

5. **Authenticated App-Data APIs & Frontend Sync Experience (`appData.*`, `Navbar.tsx`, `NotificationCenterButton.tsx`, `ThemeAccessibilityContext.tsx`, `HomeDashboard.tsx`):**
   - Added owner-authenticated `appDataRouter` (`backend/src/modules/appData/appData.routes.ts`, `AppDataService`) serving `/api/v1/preferences`, `/api/v1/notifications` (`read`, `read-all`), and `/api/v1/telemetry`.
   - Integrated `NotificationCenterButton` (event-driven fetch on mount/open/user actions, zero `setInterval` timers) in `Navbar.tsx`, server theme/accessibility preference synchronization (`syncFromServer` / `resetServerSync` in `ThemeAccessibilityContext.tsx` & `KhataDashboard` in `App.tsx`), and dashboard read-model sync freshness badges (`data-testid="sync-fresh-badge"` / `data-testid="sync-stale-badge"` in `HomeDashboard.tsx`).

6. **Bounded Multi-Page PDF Viewer, Canonical A4 Print & R2 Upload Bounds (`PdfDocumentPreviewModal.tsx`, `GstBillingView.tsx`, `NormalBillingView.tsx`, `QuotationPreview.tsx`, `storage.service.ts`, `PurchaseBillsView.tsx`):**
   - Added [`PdfDocumentPreviewModal`](../frontend/src/components/PdfDocumentPreviewModal.tsx#L104) with bounded active canvas windowing (`MAX_ACTIVE_PREVIEW_CANVASES = 6`), eviction/zeroing of off-window canvases, cleanup (`pdfDoc.cleanup()`, `loadingTask.destroy()`), clean print popup handling (`window.open('', '_blank')`, `printWindow.opener = null`, `img.decode()` readiness prior to `print()`, popup-blocked fallback), and unified canonical backend PDFKit draft/saved preview across `GstBillingView.tsx`, `NormalBillingView.tsx`, and `QuotationPreview.tsx`.
   - Bound `ContentLength` in presigned `PutObjectCommand` requests and pre-upload validation in `uploadBufferToR2()` (`backend/src/services/storage.service.ts`), paired with client-side [`preparePurchaseBillAttachment()`](../frontend/src/features/suppliers/PurchaseBillsView.tsx#L35) rejecting empty/invalid files and >10 MB PDFs while compressing JPEG/PNG/WebP images before upload.

---

## 2. Verification Matrix (Post-Final-Edit Observations)

| Check | Command | Scope & Environment | Observed Result |
| --- | --- | --- | --- |
| Digital Asset Links | `node frontend/scripts/validate-assetlinks.js` | Android TWA `assetlinks.json` | **Passed** (`exit 0`: `in.algions.khata` valid SHA-256 fingerprint) |
| Full Monorepo Build | `npm run build` | Backend `tsc` + Frontend `tsc && vite build` (`2356` modules) | **Passed** (`exit 0`, frontend built in `10.64s`) |
| Backend Unit & Architecture Suite | `npm test --workspace=backend` | `vitest run --config vitest.config.ts` (incl. `mongodb.architecture.test.ts` 13 tests) | **25/25 files passed, 293/293 tests passed** (`18.21s`) |
| Frontend Unit & UI Suite | `npm run test:frontend` | `vitest run --config vitest.frontend.config.ts` (incl. `release027.frontend.test.ts` 5 tests) | **15/15 files passed, 118/118 tests passed** (`14.31s`) |
| Clean Schema Migration (`001`–`027`) | `npm run migrate -- "postgresql://postgres@localhost:55432/khata_mig_test"` | Disposable local PostgreSQL 18 cluster (fresh DB) | **Passed** (`[MIGRATION COMPLETE] Successfully applied 27 pending migration(s).`) |
| Real PostgreSQL 18 + MongoDB 8.2 Integration Suite | `npm run test:integration --workspace=backend` | `postgres.integration.test.ts` #1–#34 (`MONGODB_ENABLED=true`, local MongoDB 8.2 + PG 18) | **1/1 file passed, 34/34 tests passed** (`22.24s`; Test #34 in `8,210 ms`) |
| Historical Migrations Integrity | `git diff --name-only origin/main -- backend/migrations/` | Diff against `origin/main` (`5084a7195468551f1f4de9459238c62cda8aac1d`) | **Passed** (empty diff — `001_*`–`026_*` untouched) |
| Patch Whitespace & Cleanup | `git diff --check` + `pg_ctl stop -m fast` + `pg_isready -h 127.0.0.1 -p 55432` | Working tree + temp PG cluster shutdown | **Passed** (`git diff --check` exit `0`; `PG_ISREADY_AFTER_STOP_EXIT=2`) |

### Observed Scope Boundaries & Known Limitations
- **Live Cloud Targets Untouched:** Production Neon PostgreSQL, Render web service, MongoDB Atlas, Vercel, and Cloudflare R2 buckets were neither modified nor queried; real DB integration verified against local PostgreSQL 18 + local MongoDB 8.2, while Cloudflare R2 S3 SDK calls, browser canvas rendering, and `window.print()` popups were tested via mocked interfaces in unit/component suites.
- **Android APK / Gradle Build:** Not executed locally in this Windows environment during Release #027 verification (Digital Asset Links validator passed; APK packaging remains configured in `.github/workflows/ci.yml`).
- **Pre-Existing `pg` Warning Outside Read-Model Sync:** While `ReadModelSyncService` was updated to run `client.query` calls sequentially (eliminating its concurrent `PoolClient` warnings), older integration tests (`Tests #1–#33`) still trigger one `DeprecationWarning: Calling client.query() when the client is already executing a query` log line in legacy service code.

---

## 3. Complete Changed Files Inventory

- **Configuration, CI & Scripts:**
  - `.env.example`
  - `.github/workflows/ci.yml`
  - `package.json`, `package-lock.json`, `backend/package.json`
  - `vitest.frontend.config.ts` (new)
  - `backend/scripts/rebuild-read-models.ts` (new)
- **Backend Core, Database & Storage:**
  - `backend/migrations/027_outbox_events.sql` (new)
  - `backend/src/app.ts`, `backend/src/index.ts`
  - `backend/src/config/database.ts`, `backend/src/config/env.ts`, `backend/src/config/testDbGuard.ts`
  - `backend/src/config/mongoEnv.ts` (new), `backend/src/config/mongodb.ts` (new)
  - `backend/src/services/storage.service.ts`
- **Backend Modules (Read Models, Outbox, App Data & Transactional Hooks):**
  - `backend/src/modules/readModels/models.ts` (new)
  - `backend/src/modules/readModels/outbox.service.ts` (new)
  - `backend/src/modules/readModels/readModelOutbox.worker.ts` (new)
  - `backend/src/modules/readModels/readModelsQuery.service.ts` (new)
  - `backend/src/modules/readModels/readModelSync.service.ts` (new)
  - `backend/src/modules/appData/models.ts` (new)
  - `backend/src/modules/appData/appData.service.ts` (new)
  - `backend/src/modules/appData/appData.routes.ts` (new)
  - `backend/src/modules/dashboard/dashboard.routes.ts`, `backend/src/modules/dashboard/dashboard.service.ts`
  - `backend/src/modules/khata/khata.routes.ts`, `backend/src/modules/khata/khata.service.ts`
  - `backend/src/modules/products/products.routes.ts`, `backend/src/modules/products/products.service.ts`
  - `backend/src/modules/gstInvoices/gstInvoices.service.ts`
  - `backend/src/modules/normalBills/normalBills.service.ts`
  - `backend/src/modules/quotations/quotations.service.ts`
  - `backend/src/modules/suppliers/suppliers.service.ts`
- **Frontend Core, Components & Views:**
  - `frontend/src/App.tsx`
  - `frontend/src/lib/appDataApi.ts` (new)
  - `frontend/src/context/ThemeAccessibilityContext.tsx`
  - `frontend/src/components/Navbar.tsx`
  - `frontend/src/components/NotificationCenterButton.tsx` (new)
  - `frontend/src/components/PdfDocumentPreviewModal.tsx` (new)
  - `frontend/src/features/dashboard/HomeDashboard.tsx`, `frontend/src/features/dashboard/dashboard.types.ts`
  - `frontend/src/features/bills/GstBillingView.tsx`, `frontend/src/features/bills/NormalBillingView.tsx`
  - `frontend/src/features/quotations/QuotationPreview.tsx`
  - `frontend/src/features/suppliers/PurchaseBillsView.tsx`
- **Tests & Documentation:**
  - `backend/tests/mongodb.architecture.test.ts` (new)
  - `backend/tests/integration/postgres.integration.test.ts`
  - `backend/tests/auth.security.test.ts`, `backend/tests/products.barcode.test.ts`, `backend/tests/products.hsn.test.ts`, `backend/tests/products.images.test.ts`, `backend/tests/quotations.service.test.ts`, `backend/tests/testDbGuard.test.ts`
  - `frontend/tests/release027.frontend.test.ts` (new)
  - `frontend/tests/dashboard.test.tsx`
  - `docs/MONGODB_ARCHITECTURE.md` (new)
  - `docs/RELEASE_027_REMEDIATION_REPORT.md` (new)
