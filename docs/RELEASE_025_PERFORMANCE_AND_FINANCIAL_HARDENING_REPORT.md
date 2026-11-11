# Khata ERP — Release #025 Engineering Report
## Application Performance Optimization, Release #024 Financial Corrections, Database Hardening & Dashboard Fixes

- **Repository:** `https://github.com/abraj12/khata-copy`
- **Base Branch & Audited Commit:** `main` at `a3547e75b6436d966fd3ab158fd5dcef5070fa4f`
- **Feature Branch:** `fix/release-025-performance-and-financial-corrections`
- **Deliverable Scope:** Release #024 critical PostgreSQL SQL/financial defect fixes, `025_performance_reporting_hardening.sql` targeted indexing & PG 16+ compatibility, bounded pool tuning & safe slow-query diagnostics, `UNNEST` batch writes for multi-item invoices/bills/Khata/purchase sync, React route & barcode-library code splitting (`React.lazy` + Rollup `manualChunks`), 10-preset fiscal calendar filters, async cancellation race fix, read-only Expense Audit History modal, updated profitability/trend/activity disclosures, and full regression coverage across unit, frontend DOM, and real PostgreSQL 18 integration suites.

---

## 1. Preserved Accounting & Compatibility Boundaries

1. **Zero Inventory / Stock Tracking:** No stock ledger, stock movement, or inventory count fields were introduced in PostgreSQL, APIs, or UI.
2. **Strict Revenue, GST, Khata, Supplier & Quotation Separation:**
   - Sales revenue continues to sum only `normal_bills.total_amount + gst_invoices.taxable_amount` (strictly excluding `gst_invoices.tax_amount` collected).
   - Customer Khata receivables, supplier payables, supplier purchase payments, and unconverted quotations remain isolated from sales revenue and operating P&L.
   - `products.buying_price` continues to flow strictly into `cost_rate_snapshot` at billing time, with `NULL` preserved on manual and legacy uncosted bill items (no synthetic retroactive backfill).
3. **Historical Migrations Preserved & CI Compatibility Intact:**
   - `backend/migrations/001_*` through `024_*` have zero diff against `origin/main`.
   - `.github/workflows/ci.yml` remains on `postgres:16-alpine` to match Neon Serverless PostgreSQL and repo documentation; `025_performance_reporting_hardening.sql` uses standard PG 16+ non-`CONCURRENTLY` idempotent DDL compatible with `backend/src/config/migrator.ts`.
4. **No Production Mutation or Merge Performed:** Production Neon PostgreSQL, Render backend, frontend hosting, Cloudflare R2 storage, and `main` remain untouched.

---

## 2. Release #024 Financial, SQL & Activity Audit Fixes

1. **Critical Production Crash Eliminated — All-Time `getOverview({})` Parameter Mismatch (`08P01`):**
   - **Root Cause:** `DashboardService.getOverview()` unconditionally passed `[timeZone]` (`$1`) to queries whose date clauses evaluated to `'TRUE'` with zero `$N` placeholders when `fromDate` and `toDate` were omitted (`all_time` default landing view), failing on real PostgreSQL with `08P01: bind message supplies 1 parameters, but prepared statement "" requires 0`.
   - **Fix (`backend/src/utils/sqlDateRange.ts`, `backend/src/modules/dashboard/dashboard.service.ts`):** Extracted `buildBusinessTimestampRangeFilter()` which emits sargable bounds (`col >= ($from::date::timestamp AT TIME ZONE $tz) AND col < (($to::date + 1)::timestamp AT TIME ZONE $tz)`) and returns `{ clause: 'TRUE', params: [] }` when no date bounds exist, preventing unused bind parameters across all overview queries.
2. **Sargable Business-Timezone Filtering (`Asia/Kolkata` Default):**
   - **Fix:** Replaced column-wrapped `(col AT TIME ZONE $1)::date` predicates on `customers.created_at`, `payments.received_at`, `supplier_payment_reversals.reversed_at`, `supplier_purchase_bill_cancellations.cancelled_at`, `supplier_payment_allocation_reversals.created_at`, `business_expense_events.created_at`, and `suppliers.service.ts` (`getDashboard`, `getSupplierStatement`) with half-open timestamp intervals against indexable columns.
3. **Proportional Net-of-Discount Top-Products Attribution:**
   - **Fix (`dashboard.service.ts`):** Computed `doc_subtotal` via `SUM(amount) OVER (PARTITION BY bill_id / invoice_id)` across **all** document lines (including unlinked manual items), allocated net revenue (`nb.total_amount` / `gi.taxable_amount`, excluding GST collected) proportionally with `ROUND(..., 2)` per line, assigned any 1-paise rounding residual strictly to the final positive line (`adj_rn = 1`), and filtered `WHERE product_id IS NOT NULL` only after document allocation.
4. **Mid-Month Clipping on Multi-Month (`> 45` Days) Sales Trend:**
   - **Fix:** `resolveTrendWindow()` and `trendSql` clip source documents using exact business date bounds (`WHERE bill_date >= $3::date AND bill_date <= $4::date`) within the monthly series buckets (`$1::date`..`$2::date`), eliminating boundary leakage outside mid-month custom endpoints. Added `effectiveFromDate`, `effectiveToDate`, and `isSixMonthWindow` metadata to `salesTrend`.
5. **Atomic Single-Snapshot Expense Pagination:**
   - **Fix (`dashboard.service.ts`):** Consolidated `listExpenses()` from separate summary/count/page queries into a single CTE (`WITH summary AS (...), paged AS (...) ...`), ensuring pagination rows, `total`, and `totalActiveAmount` reflect one consistent MVCC snapshot without extra roundtrips.
6. **Complete Recent Activity & Read-Only Expense Audit History API:**
   - **Fix:** Added `supplier_payment_reversal`, `supplier_allocation_reversal`, `supplier_bill_cancellation`, and `expense_void` branches to `recentActivity` in `DashboardService.getOverview()`.
   - Added `expenseHistoryQuerySchema` (`dashboard.validation.ts`), `DashboardService.getExpenseHistory()` inside `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` (`dashboard.service.ts`), and `GET /api/v1/dashboard/expenses/:id/history` behind `requireOwnerSession` and `Cache-Control: no-store` (`dashboard.routes.ts`).

---

## 3. Database Hardening, Pool Tuning & Batch SQL (`Phase C`)

1. **Migration `025_performance_reporting_hardening.sql` (13 Idempotent Indexes):**
   - Customers & Khata: `idx_customers_created_at`, `idx_payments_received_at`, `idx_udhar_transactions_created_at`, `idx_udhar_transactions_date`.
   - Suppliers & Activity: `idx_supplier_payment_reversals_reversed_at`, `idx_supplier_bill_cancellations_cancelled_at`, `idx_supplier_alloc_rev_created_at`, `idx_supplier_purchase_bills_created_at`, `idx_supplier_payments_created_at`.
   - Operating Expenses & Void History: `idx_business_expenses_status_date_created`, `idx_business_expenses_created_at`, `idx_business_expense_events_voided_created` (`WHERE "action" = 'voided'`).
   - Products Catalog Partial Sort: `idx_products_active_lower_name` (`ON "products" (LOWER("name") ASC, "name" ASC, "id" ASC) WHERE "archived_at" IS NULL`).
2. **Pool & Query Diagnostics (`backend/src/config/env.ts`, `backend/src/config/database.ts`, `.env.example`):**
   - Added bounded env configuration: `DB_POOL_MAX` (`1..50`, default `10`), `DB_DIRECT_POOL_MAX` (`1..10`, default `2`), `DB_POOL_IDLE_TIMEOUT_MS` (`1000..300000`, default `30000`), `DB_POOL_CONNECTION_TIMEOUT_MS` (`1000..60000`, default `5000`), `DB_QUERY_TIMEOUT_MS` (`1000..120000`, default `30000`), and `DB_SLOW_QUERY_MS` (`10..60000`, default `250`).
   - Exported `getDatabasePoolStats()` (numeric-only utilization counts without credentials) and `measureDbOperation()` (logs duration and pool counts when slow without logging SQL params or PII), and registered `'025_performance_reporting_hardening.sql'` in `EXPECTED_MIGRATIONS`.
3. **Batched `UNNEST` Writes & Explicit `ESCAPE '\'`:**
   - Replaced per-line `INSERT` loops with single `UNNEST` batch inserts in `normalBills.service.ts` (`createBillInTransaction`), `gstInvoices.service.ts` (`createInvoiceInTransaction`), `quotations.service.ts` (`createQuotation`), `khata.service.ts` (`recordUdhar` — batched `ANY($1::bigint[])` product lookup + `UNNEST` insert), and `suppliers.service.ts` (`insertPurchaseBillItemsAndSyncPrices()` shared across `createPurchaseBill` and `updatePurchaseBill` with deduplicated `UNNEST` `UPDATE products` buying-price sync).
   - Added explicit `ESCAPE '\'` matching `escapeLike()` in `products.service.ts` (`listActiveProducts`) and `quotations.service.ts` (`listQuotations`).

---

## 4. Frontend Bundle Splitting, Race Fixes & Dashboard UI (`Phases D & E`)

1. **Route Code Splitting & Manual Vendor/Barcode Chunking (`frontend/vite.config.ts`, `frontend/src/App.tsx`):**
   - Kept `HomeDashboard` eager as the default landing route and converted all 6 secondary modules (`KhataLedgerView`, `ProductsView`, `GstBillingView`, `NormalBillingView`, `QuotationsView`, `SuppliersModuleView`) to `React.lazy` inside `<Suspense fallback={<ModuleLoadingFallback />}>`.
   - Configured `manualChunks` in `frontend/vite.config.ts` to isolate `react-vendor`, `icons-vendor`, `math-vendor`, and `@zxing` (`barcode-scanner`), keeping `@zxing` (`412.00 kB` raw / `107.66 kB` gzip) completely off the Home landing preloads in `frontend/dist/index.html`.
2. **Async Cancellation Race Fix (`frontend/src/features/dashboard/HomeDashboard.tsx`):**
   - Executed `abortRef.current?.abort()` and incremented `requestIdRef.current` **before** early validation returns on malformed or inverted custom date ranges so slower in-flight preset requests cannot overwrite validation errors.
3. **10 Fiscal Presets & Business Timezone Math (`frontend/src/utils/businessDate.ts`, `dashboardApi.ts`, `DashboardDateFilter.tsx`):**
   - Added `getShiftedBusinessMonthRange()`, `getPreviousBusinessMonthRange()`, and `getIndianFinancialYearRange()` (`Apr 1 – Mar 31` handling Jan–Mar vs Apr–Dec rollover and leap-year February boundaries).
   - Expanded `DashboardDateFilter` to 10 presets: `Today`, `Yesterday`, `Last 7 Days`, `Last 30 Days`, `This Month`, `Last Month`, `This FY`, `Previous FY`, `All Time`, `Custom`.
4. **Honest Disclosures & Read-Only Expense History Modal:**
   - Wrapped `DashboardMetricCard`, `DashboardProfitability`, `DashboardSalesTrend`, and `DashboardActivityFeed` with `React.memo`.
   - Updated `DashboardProfitability` & `HomeDashboard` KPI cards to label `'Partial Est. Net Operating Result'` when `hasIncompleteCostData` is true, clarify `'Khata Receivable (Live)'` and `'Supplier Payable (Live)'` all-time live balances, surface the trailing 6-month vs period range window on `DashboardSalesTrend`, and style the 4 reversal/cancellation/void badges in `DashboardActivityFeed`.
   - Added **"History"** action and accessible read-only Audit History modal in `DashboardExpenses.tsx` backed by `fetchDashboardExpenseHistory()`.

---

## 5. Before vs. After Performance Benchmarks (Observed)

### 5.1 Frontend Production Bundle (`frontend/dist`)

| Metric | Baseline (`a3547e7`) | After Release #025 | Change |
|---|---:|---:|---|
| Entry / Boot JS Preloaded by `index.html` (raw) | `1,271,726 B` (1 chunk) | `~403.98 kB` (`index` `108.26 kB` + `react-vendor` `223.22 kB` + `icons-vendor` `40.28 kB` + `math-vendor` `32.22 kB`) | **~68% reduction** on initial boot |
| Entry / Boot JS Preloaded (gzip) | `313,036 B` | `116.24 kB` (`25.47` + `69.24` + `8.55` + `12.98 kB`) | **~63% reduction** on initial boot |
| Deferred Feature & Barcode Chunks | None (all eager) | `barcode-scanner` (`412.00 kB` / `107.66 kB` gz), `SuppliersModuleView` (`152.10 kB`), `KhataLedgerView` (`71.01 kB`), `QuotationsView` (`66.73 kB`), `GstBillingView` (`44.50 kB`), `NormalBillingView` (`41.96 kB`), `ProductsView` (`32.11 kB`) | Loaded only upon module navigation |
| Primary CSS (`index*.css`) | `79,510 B` (`14,425 B` gz) | `68.33 kB` (`12.21 kB` gz) + `BillingCataloguePickers` (`11.52 kB`) | Pickers CSS split out |

### 5.2 PostgreSQL 18 Local Query & Service Benchmarks (`127.0.0.1:55432`)

> **Benchmark Environment & Dataset:** Local PostgreSQL 18 on `127.0.0.1:55432` seeded with `1,500` products, `1,200` customers, `1,500` normal bills + `4,500` items, `1,200` GST invoices + `3,600` items, `1,500` udhar transactions, `1,200` customer payments, `200` suppliers, `1,000` purchase bills + `60` cancellations, `1,000` supplier payments + `80` reversals, `400` allocations + `60` allocation reversals, `500` quotations, and `1,200` operating expenses + `1,200` expense events (`VACUUM ANALYZE` executed after seeding). Note: `avgMs` below reflects 15 warm iterations per query (or 10 iterations for 20-line batch insert comparison); production Neon serverless WAN roundtrip latency is **NOT MEASURED**.

| Query / Operation | Before Plan & Latency (`EXPLAIN` / Avg) | After Plan & Latency (`EXPLAIN` / Avg) | Notes |
|---|---|---|---|
| **Q1 `payments` date filter** | `Seq Scan` (`1,145` filtered), exec `0.475 ms`, avg `1.33 ms` | `Bitmap Heap Scan` (`idx_payments_received_at`), exec `0.106 ms`, avg `0.87 ms` | Eliminates `(received_at AT TIME ZONE ...)::date` full scan |
| **Q2 `customers` created_at filter** | `Seq Scan` (`1,157` filtered), exec `0.517 ms`, avg `0.96 ms` | `Index Only Scan` (`idx_customers_created_at`, `Heap Fetches: 0`), exec `0.041 ms`, avg `0.81 ms` | Covering index-only range scan |
| **Q3 `udhar_transactions` recent top-12** | `Sort` (top-N heapsort, `1,500` rows), exec `1.222 ms`, avg `1.51 ms` | `Index Scan` (`idx_udhar_transactions_created_at`), exec `0.151 ms`, avg `1.26 ms` | Eliminates full-table top-N sort (`-88%` plan exec time) |
| **Q4 `supplier_payment_reversals` filter** | `Seq Scan` (`70` filtered), exec `0.085 ms`, avg `0.35 ms` | `Seq Scan` (80-row tiny table), exec `0.061 ms`, avg `0.73 ms` | `idx_supplier_payment_reversals_reversed_at` created; PG properly chooses seq scan on 2-page table |
| **Q5 `supplier_purchase_bill_cancellations`** | `Sort` (`cancelled_at` wrap), exec `0.108 ms` | `Sort` (60-row tiny table), exec `0.063 ms` | `idx_supplier_bill_cancellations_cancelled_at` created; sargable predicate |
| **Q6 `products` default `LOWER(name)` sort** | `Sort` (top-N heapsort), exec `1.380 ms`, avg `1.86 ms` | `Index Only Scan` (`idx_products_active_lower_name`, `Heap Fetches: 0`), exec `0.061 ms`, avg `0.74 ms` | Eliminates active-catalog sort (`-96%` plan exec time) |
| **Q7 `business_expenses` active filter page** | `Incremental Sort`, exec `0.084 ms`, avg `0.50 ms` | `Index Scan` (`idx_business_expenses_status_date_created`), exec `0.071 ms`, avg `0.84 ms` | Zero sort node + single-CTE snapshot consistency |
| **Q8 `business_expense_events` voided recent** | `Sort` (top-N heapsort, 100 rows), exec `0.327 ms` | `Index Scan` (`idx_business_expense_events_voided_created`), exec `0.068 ms` | Partial index `WHERE action = 'voided'` |
| **20-line `normal_bill_items` write (TX)** | Row-by-row loop: avg `15.32 ms` (median `14.64 ms`) | Single `UNNEST` batch: avg `2.30 ms` (median `2.29 ms`) | **6.6x faster** locally; removes 19 roundtrips over WAN |

### 5.3 Service-Level Benchmarks (`bench_service.ts` on Local PG 18)

| Service Call | Before (`bench_service_before.json`) | After (`bench_service_after.json`) |
|---|---|---|
| `dashboardService.getOverview({})` (`All Time`) | **CRASHED** (`08P01`: bind message parameter mismatch) | **SUCCEEDS** (cold `407.76 ms`, avg `126.64 ms`, median `123.11 ms`) |
| `dashboardService.getOverview` (30d) | cold `201.36 ms`, avg `49.62 ms`, median `49.80 ms` | cold `69.43 ms`, avg `65.36 ms`, median `64.90 ms` |
| `dashboardService.listExpenses` (page 1) | cold `6.85 ms`, avg `4.24 ms`, median `4.41 ms` | cold `6.78 ms`, avg `5.51 ms`, median `5.25 ms` (single CTE MVCC snapshot) |
| `productsService.listActiveProducts({ search: 'Pipe' })` | cold `5.69 ms`, avg `4.27 ms`, median `4.11 ms` | cold `3.65 ms`, avg `2.03 ms`, median `1.94 ms` |
| `productsService.listActiveProducts` (default) | cold `3.20 ms`, avg `3.44 ms`, median `3.64 ms` | cold `2.13 ms`, avg `1.74 ms`, median `1.59 ms` |
| `suppliersService.getDashboard` (30d) | cold `212.67 ms`, avg `19.58 ms`, median `8.73 ms` | cold `151.93 ms`, avg `27.08 ms`, median `30.35 ms` |

---

## 6. Verification Matrix (Post-Edit Observed Results)

| Check | Command / Scope | Observed Result | Status |
|---|---|---|---|
| **Backend Build** | `npm run build:backend` (`tsc`) | Exited `0` with zero TypeScript errors | **PASS** |
| **Frontend Build & Splitting** | `npm run build:frontend` (`tsc && vite build`) | Exited `0`; `2347` modules transformed; route/vendor chunks generated | **PASS** |
| **Backend Unit & Security Suite** | `npm test --workspace=backend` | `23` files passed, **`263` tests passed**, `0` failed, `0` skipped (`17.30s`), incl. `dashboard.service.test.ts` (Tests `1–15`), `auth.security.test.ts`, `khata.financial.test.ts` | **PASS** |
| **Frontend React DOM & UI Suite** | `npm run test:frontend` | `13` files passed, **`106` tests passed**, `0` failed, `0` skipped (`18.87s`), incl. `dashboard.test.tsx` (`11` tests, zero React `act`/socket warnings) | **PASS** |
| **PG 18 Upgrade (`024 -> 025`) & Idempotency** | Disposable `khata_024_025_upgrade_test` | Zero row loss across seeded tables; all `13` `025` indexes verified; re-applying `025` idempotently succeeded | **PASS** |
| **Real PG 18 Integration Suite** | `npm run test:integration --workspace=backend` (`khata_025_test`) | `1` file passed, **`32` tests passed**, `0` failed, `0` skipped (`14.57s`), incl. **`Test 32`** (`719ms`: `all_time` `08P01` guard, IST `18:15Z`/`18:45Z` boundaries, proportional discount + manual lines, mid-month trend clipping, batched `UNNEST`, reversals/voids in activity feed, `getExpenseHistory`) | **PASS** |
| **Digital Asset Links Check** | `node frontend/scripts/validate-assetlinks.js` | Exited `0` (`in.algions.khata` SHA-256 fingerprints valid) | **PASS** |
| **Android TWA Debug Build & Unsigned Release Guard** | `cd android-twa && .\gradlew.bat assembleDebug` / `assembleRelease` | `assembleDebug` exited `0` (`app-debug.apk` present); unsigned `assembleRelease` exited `1` with `[SECURITY ERROR] Release build requested, but release signing credentials are missing!` | **PASS** |
| **Migration Immutability & Whitespace Check** | `git diff --name-only origin/main -- backend/migrations/` & `git diff --check` | Empty diff on `001_*`–`024_*`; `git diff --check` exited `0` | **PASS** |
| **Local PG 18 Shutdown Check** | `pg_isready.exe -h 127.0.0.1 -p 55432` | Returned `127.0.0.1:55432 - no response` (`pg_isready_exit=2`) | **PASS** |
| **Live Production Neon/Render Latency** | Remote deployment environment | Not touched or measured per safety boundary | **NOT MEASURED** |

---

## 7. Changed Files Inventory (`29` Modified, `3` New)

- **Database Migration & Backend Config / Env:**
  - `backend/migrations/025_performance_reporting_hardening.sql` (new)
  - `backend/src/config/database.ts`
  - `backend/src/config/env.ts`
  - `.env.example`
- **Backend Utilities & Modules:**
  - `backend/src/utils/sqlDateRange.ts` (new)
  - `backend/src/modules/dashboard/dashboard.routes.ts`
  - `backend/src/modules/dashboard/dashboard.service.ts`
  - `backend/src/modules/dashboard/dashboard.validation.ts`
  - `backend/src/modules/suppliers/suppliers.service.ts`
  - `backend/src/modules/normalBills/normalBills.service.ts`
  - `backend/src/modules/gstInvoices/gstInvoices.service.ts`
  - `backend/src/modules/quotations/quotations.service.ts`
  - `backend/src/modules/khata/khata.service.ts`
  - `backend/src/modules/products/products.service.ts`
- **Frontend Build, Utils, Dashboard & Route Splitting:**
  - `frontend/vite.config.ts`
  - `frontend/src/App.tsx`
  - `frontend/src/utils/businessDate.ts`
  - `frontend/src/features/dashboard/dashboard.types.ts`
  - `frontend/src/features/dashboard/dashboardApi.ts`
  - `frontend/src/features/dashboard/HomeDashboard.tsx`
  - `frontend/src/features/dashboard/components/DashboardMetricCard.tsx`
  - `frontend/src/features/dashboard/components/DashboardDateFilter.tsx`
  - `frontend/src/features/dashboard/components/DashboardProfitability.tsx`
  - `frontend/src/features/dashboard/components/DashboardSalesTrend.tsx`
  - `frontend/src/features/dashboard/components/DashboardActivityFeed.tsx`
  - `frontend/src/features/dashboard/components/DashboardExpenses.tsx`
- **Automated Tests & Documentation:**
  - `backend/tests/auth.security.test.ts`
  - `backend/tests/khata.financial.test.ts`
  - `backend/tests/dashboard.service.test.ts`
  - `backend/tests/integration/postgres.integration.test.ts`
  - `frontend/tests/dashboard.test.tsx`
  - `docs/RELEASE_025_PERFORMANCE_AND_FINANCIAL_HARDENING_REPORT.md` (new)

---

## 8. Rollout Notes

1. Execute `npm run migrate --workspace=backend` against production Neon PostgreSQL before deploying the updated backend/frontend build so `025_performance_reporting_hardening.sql` indexes exist when `checkDatabaseReadiness()` runs.
2. Verify all CI jobs in `.github/workflows/ci.yml` pass on branch `fix/release-025-performance-and-financial-corrections` before opening/merging a PR into `main`.
