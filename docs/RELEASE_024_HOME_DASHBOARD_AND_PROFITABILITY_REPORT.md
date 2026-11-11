# Khata ERP — Release #024 Engineering Report
## Home Dashboard, Business Overview, Financial Analytics, Profit & Loss & Expense Management

- **Repository:** `https://github.com/abraj12/khata-copy`
- **Base Branch & Audited Commit:** `main` at `7bfacac6ab902508628e277f595d7ab3434a18c7`
- **Feature Branch:** `feat/khata-release-024-home-dashboard`
- **Deliverable Scope:** Default `/` **Home** Business Overview route & navbar landing tab, migration `024_home_dashboard_profitability.sql`, transactional line-item `cost_rate_snapshot` capture in Normal Bills and GST Invoices, append-only `business_expense_events` audit ledger with `UPDATE`/`DELETE`/`TRUNCATE` `SQLSTATE '55000'` guards, `REPEATABLE READ READ ONLY` cross-module analytics API (`/api/v1/dashboard`), strict GST/Khata/Supplier/Quotation separation, honest partial-cost coverage profitability disclosures, modular Home Dashboard & Operating Expenses UI, automated backend/frontend/PostgreSQL 18 tests, and engineering documentation.

---

## 1. Architecture & Preserved Accounting Boundaries

1. **Zero Inventory / Stock Tracking:** Consistent with the single-vendor Khata ERP design, no stock counts, SKU stock ledgers, or inventory movement tracking were introduced in the database, API responses, or UI (`dashboard.service.test.ts` Test 5 explicitly verifies `stock` and `inventory` keys are absent from serialized overview payloads).
2. **Buying Price vs. Selling Rate Separation:** `resolveProductCostSnapshots` (`backend/src/modules/billing/costSnapshot.ts`) copies `products.buying_price` strictly into `cost_rate_snapshot` for cost analytics and never overwrites or auto-fills customer selling `rate`.
3. **GST Collected Excluded From Sales Revenue & Profit:**
   - `totalSalesRevenue = normalBillsTotal + gstTaxableSales`
   - `gstCollected` is computed from `gst_invoices.tax_amount` and displayed separately.
   - `totalBilledAmountIncludingGst = totalSalesRevenue + gstCollected` (`normal_bills.total_amount + gst_invoices.grand_total`).
4. **Khata Credit Ledger Separated From Billed Sales:** Customer receivables (`GREATEST(total_udhar - total_allocated, 0)`), credit given (`udhar_transactions.total_amount`), and customer receipts (`payments.amount`) remain strictly in the `customersKhata` summary rather than being added into billed sales revenue.
5. **Supplier Purchases & Payments Separated From Operating Expenses:** Supplier finalized purchase bills (`supplier_purchase_bills`), active payments (`supplier_payments`), payment reversals (`supplier_payment_reversals`), allocation reversals (`supplier_payment_allocation_reversals`), outstanding payable, advance credit, and unallocated payments remain isolated under the `suppliers` summary and never mix with `business_expenses`.
6. **Quotations Pipeline Separated From Realized Sales:** Quotation counts (`draft`, `sent`, `accepted`, `converted`, `rejected`, `expired` including effective expiry when `valid_until < businessDate`), pipeline value, and conversion rate remain distinct under `quotations`.
7. **Historical Migrations Preserved:** `backend/migrations/001_*` through `023_*` remain unmodified.

---

## 2. Navigation & Default Home Route

- **Navbar (`frontend/src/components/Navbar.tsx`):** Updated top-level desktop and mobile navigation order to place **Home** first: `Home`, `Khata`, `Products`, `Quotations`, `Suppliers`, `Bill`.
- **Routing (`frontend/src/App.tsx`):**
  - Exported `getInitialTab()` mapping `/` (and unrecognized non-module subpaths) to `'home'`, while preserving `/khata`, `/products`, `/quotations`, `/suppliers`, `/bills/gst`, and `/bills/normal`.
  - Wired `window.history.pushState` / `popstate` transitions cleanly between `/` (`'home'`) and all existing module paths without altering authentication gating.
  - Mounted `<HomeDashboard onNavigate={handleTabChange} />` for the `'home'` view so KPI cards, Quick Actions, and Recent Business Activity entries navigate directly into the target module.

---

## 3. Database Schema & Migration `024`

- **Migration File:** `backend/migrations/024_home_dashboard_profitability.sql`
- **Registered In:**
  - `backend/src/config/database.ts`: added `'024_home_dashboard_profitability.sql'` to `EXPECTED_MIGRATIONS` and added `'business_expenses'`, `'business_expense_events'` to `EXPECTED_CORE_TABLES`.
  - `backend/tests/auth.security.test.ts`: updated readiness health mock to `rowCount: 28` core tables and `rowCount: 24` migrations.
- **PostgreSQL Schema Additions:**
  1. **Billing Line-Item Cost Snapshots (Zero Legacy Backfill):**
     - `ALTER TABLE "normal_bill_items" ADD COLUMN IF NOT EXISTS "cost_rate_snapshot" NUMERIC(12, 2) NULL` with `chk_normal_bill_items_cost_rate_snapshot` (`IS NULL OR >= 0`) and partial index `idx_normal_bill_items_product_id` (`WHERE "product_id" IS NOT NULL`).
     - `ALTER TABLE "gst_invoice_items" ADD COLUMN IF NOT EXISTS "cost_rate_snapshot" NUMERIC(12, 2) NULL` with `chk_gst_invoice_items_cost_rate_snapshot` (`IS NULL OR >= 0`) and partial index `idx_gst_invoice_items_product_id` (`WHERE "product_id" IS NOT NULL`).
     - Existing historical line items retain `NULL` (`cost_rate_snapshot`) rather than fabricating historical costs from current product prices.
  2. **Operating Expenses Ledger (`business_expenses`):**
     - `id` `UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `expense_date` `DATE NOT NULL`, `category` `VARCHAR(60)` (`'rent'`, `'electricity'`, `'salaries'`, `'transport'`, `'packaging'`, `'maintenance'`, `'marketing'`, `'misc'`), non-empty `title` `VARCHAR(200)`, `vendor_name` `VARCHAR(160) NULL`, `amount` `NUMERIC(14, 2) CHECK (amount > 0)`, `payment_method` `VARCHAR(30)` (`'cash'`, `'upi'`, `'bank_transfer'`, `'cheque'`, `'other'`), `reference_number`, `notes`, `status` (`'active' | 'voided'`), `voided_at`, `void_reason`, `created_at`, `updated_at`.
     - Constraint `chk_business_expenses_void_metadata` enforces consistent soft-void metadata (`active` requires `NULL` `voided_at`/empty `void_reason`; `voided` requires non-null `voided_at` and non-empty trimmed `void_reason`).
     - Indexes: `idx_business_expenses_status_date` (`status`, `expense_date DESC`, `id DESC`) and `idx_business_expenses_category_date` (`category`, `expense_date DESC`).
  3. **Immutable Append-Only Expense Audit Ledger (`business_expense_events`):**
     - `id` `BIGSERIAL PRIMARY KEY`, `expense_id` `UUID REFERENCES business_expenses(id) ON DELETE RESTRICT`, `action` (`'created'`, `'updated'`, `'voided'`), `reason`, `previous_data` `JSONB`, `new_data` `JSONB NOT NULL`, `created_at` `TIMESTAMPTZ`.
     - Protected by `trg_prevent_business_expense_events_mutation` (`BEFORE UPDATE OR DELETE FOR EACH ROW`) and `trg_prevent_business_expense_events_truncate` (`BEFORE TRUNCATE FOR EACH STATEMENT`), executing `prevent_financial_audit_mutation()` raising `SQLSTATE '55000'`.

---

## 4. Transactional Cost Snapshot Capture

- **Helper (`backend/src/modules/billing/costSnapshot.ts`):** `resolveProductCostSnapshots(client, items)` queries `SELECT id, buying_price FROM products WHERE id = ANY($1::bigint[])` using the caller's active `PoolClient`, returning a `Map<number, string>` formatted to 2 decimal places for valid non-negative product buying prices while omitting manual/unlinked lines (`productId` null/undefined).
- **Normal Bills (`backend/src/modules/normalBills/normalBills.service.ts`):** Inside `createBillInTransaction()`, invokes `resolveProductCostSnapshots(client, items)` and persists `cost_rate_snapshot` per inserted `normal_bill_items` row (`null` for manual items).
- **GST Invoices (`backend/src/modules/gstInvoices/gstInvoices.service.ts`):** Inside `createInvoiceInTransaction()`, invokes `resolveProductCostSnapshots(client, items)` and persists `cost_rate_snapshot` per inserted `gst_invoice_items` row (`null` for manual items).

---

## 5. Profitability Formulas & Partial Cost Coverage Transparency

Implemented in `DashboardService.getOverview()` (`backend/src/modules/dashboard/dashboard.service.ts`) using `Decimal.js` (`precision: 20, rounding: Decimal.ROUND_HALF_UP`):

- **Costed Revenue Allocation Per Document (Discount-Safe):**
  - Normal Bills: `ROUND(nb.total_amount * (costed_line_subtotal / line_subtotal), 2)` for bills with `line_subtotal > 0`.
  - GST Invoices: `ROUND(gi.taxable_amount * (costed_line_subtotal / line_subtotal), 2)` (strictly taxable revenue excluding GST collected).
  - Combined `costedSalesRevenue = min(totalSalesRevenue, rawCostedSalesRevenue)` and `uncostedSalesRevenue = max(totalSalesRevenue - costedSalesRevenue, 0)`.
- **Cost of Goods Sold & Gross Margin:**
  - `estimatedCostOfGoodsSold = SUM(quantity * cost_rate_snapshot)` for lines where `cost_rate_snapshot IS NOT NULL`.
  - `estimatedGrossProfit = costedSalesRevenue - estimatedCostOfGoodsSold`.
  - `estimatedGrossMarginPercent = (estimatedGrossProfit / costedSalesRevenue) * 100` (`'0.00'` when `costedSalesRevenue <= 0`).
  - `costCoveragePercent = (costedSalesRevenue / totalSalesRevenue) * 100` (`'0.00'` when `totalSalesRevenue <= 0`).
- **Operating Expenses & Net Operating Result:**
  - `operatingExpenses = SUM(amount)` across `business_expenses` where `status = 'active'` within the period filter (`voided` records excluded from totals, counted separately in `voidedExpensesCount`).
  - `estimatedNetOperatingResult = estimatedGrossProfit - operatingExpenses` (can be negative, clearly displaying operating losses).
- **Honest UI Disclosure (`DashboardProfitability.tsx`):** Whenever `hasIncompleteCostData` (`totalSalesRevenue > 0 && uncostedSalesRevenue > 0`) is `true`, renders a warning banner noting the uncosted portion from legacy/manual items alongside the `Cost Coverage: X%` badge.

---

## 6. Backend Dashboard & Expense APIs (`backend/src/modules/dashboard/`)

Mounted in `backend/src/app.ts` at `/api/v1/dashboard` behind `requireOwnerSession`, existing global `csrfProtection`, and `Cache-Control: no-store, no-cache, must-revalidate, private`:

- **`GET /api/v1/dashboard/overview`:**
  - Validates `fromDate` and `toDate` via `dashboardOverviewQuerySchema` (calendar validity + non-inverted date range) and `validateDateRangeOrder()`.
  - Runs inside a single dedicated `appPool.connect()` transaction executing `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` with sequential queries (`sales`, `profitability`, `expenses` + `expensesByCategory`, `customersKhata`, `products` + `topProducts` top 5 across `normal_bill_items` and `gst_invoice_items`, `suppliers`, `quotations`, `salesTrend`, and bounded `recentActivity` top 12 across all 8 activity types), committed and released in `finally`.
  - **Business Timezone:** Reads `env.BUSINESS_TIME_ZONE || 'Asia/Kolkata'`, computes `businessDate` via `getBusinessDateISO(timeZone)`, applies `(col AT TIME ZONE $1)::date` for timestamp-backed date filters (`customers.created_at`, `payments.received_at`, `supplier_payment_reversals.reversed_at`), and evaluates effective quotation expiration (`valid_until < businessDate`).
  - **Adaptive Trend Granularity (`resolveTrendWindow`):** Uses `1 day` buckets when the span is `<= 45` days (or 30-day window ending `toDate`), and `1 month` buckets otherwise (default All Time displays a 6-month window ending with the current business month).
- **`GET /api/v1/dashboard/expenses`:** Parameterized filter (`search` escaped with `escapeLike`, `category`, `status` default `'active'`, `fromDate`, `toDate`, bounded `limit` `1..200` default `25`, `offset >= 0`), returning paginated items plus `total` and `totalActiveAmount`.
- **`POST /api/v1/dashboard/expenses`:** Validates positive money (`<= 2` decimal places via `validateMoneyInput`), inserts into `business_expenses`, and appends `'created'` audit event in `business_expense_events` within a transaction.
- **`PUT /api/v1/dashboard/expenses/:id`:** Validates UUID, locks row `FOR UPDATE`, returns `404` (`EXPENSE_NOT_FOUND`) if missing or `409` (`EXPENSE_VOIDED_IMMUTABLE`) if already voided, updates record, and appends `'updated'` audit event with `previous_data` and `new_data`.
- **`POST /api/v1/dashboard/expenses/:id/void`:** Requires non-empty trimmed `reason`, locks row `FOR UPDATE`, returns `404` (`EXPENSE_NOT_FOUND`) or `409` (`EXPENSE_ALREADY_VOIDED`) on double-void, soft-voids row (`status = 'voided'`, `voided_at = NOW()`, `void_reason`), and appends `'voided'` audit event. Permanent deletion is intentionally unsupported.

---

## 7. Modular Frontend Implementation (`frontend/src/features/dashboard/`)

- **`dashboard.types.ts` & `dashboardApi.ts`:** Strict TypeScript interfaces, `resolveHomeDateRange()` presets (`today`, `last_7_days`, `this_month`, `last_30_days`, `all_time`, `custom`), category/payment labels, and typed API helpers using `apiClient`.
- **`HomeDashboard.tsx`:** Orchestrates period presets/custom date filter (`DashboardDateFilter`), `AbortController` + monotonic `requestIdRef` stale-response protection, loading skeleton (`aria-busy="true"`), retry error banner, Quick Actions (`Add Expense`, `GST Invoice`, `Normal Bill`, `Collect Khata`, `Record Purchase Bill`, `Quotation`), executive KPI grid + module summaries (`DashboardMetricCard`, `DashboardSection`), Top Selling Products, Quotation Pipeline breakdown, `DashboardProfitability`, `DashboardSalesTrend`, `DashboardActivityFeed`, and `DashboardExpenses` + `DashboardExpenseForm` (modal form & mandatory-reason void modal).

---

## 8. Verification & Test Matrix (Observed Results After Final Code Edits)

| Check | Command / Scope | Observed Result | Status |
|---|---|---|---|
| Production Monorepo Build | `npm run build` (`backend` `tsc`; `frontend` `tsc && vite build`) | Exit `0`; `2346 modules transformed`; `dist/assets/index-DuWdq1rp.js` (`1,271.73 kB`), `dist/assets/index-DOYWTtMa.css` (`79.51 kB`), `14.81s` | **PASS** |
| Backend Unit & API Suite | `npm test --workspace=backend` (`vitest run --config vitest.config.ts`) | `23` test files passed, **`257` tests passed**, `0` failed, `0` skipped (`13.87s`), incl. `tests/dashboard.service.test.ts` (`9` tests) and updated readiness mock in `tests/auth.security.test.ts` | **PASS** |
| Frontend Unit & React DOM Suite | `npm run test:frontend` (`vitest run frontend/tests`) | `13` test files passed, **`100` tests passed**, `0` failed, `0` skipped (`13.57s`), incl. `frontend/tests/dashboard.test.tsx` (`5` tests) | **PASS** |
| PG 18 Upgrade (`023` -> `024`), Idempotency & Legacy Snapshot Check | Local PG 18 disposable script `verify_pg18_024.mjs` against `127.0.0.1:55432` | `Upgrade 023 -> 024 + idempotency + NULL legacy cost snapshot check PASSED.` | **PASS** |
| Real PostgreSQL 18 Integration Suite | `npm run test:integration --workspace=backend` (`vitest run --config vitest.integration.config.ts`) | `1` test file passed, **`31` tests passed**, `0` failed, `0` skipped (`10.15s`, tests `7999ms`), incl. **`Test 31`** (`562ms`: overview analytics, cost snapshots vs `NULL` manual items, expense CRUD/void, `SQLSTATE '55000'` `UPDATE`/`DELETE`/`TRUNCATE` audit guards) | **PASS** |
| Local PostgreSQL 18 Teardown Check | `pg_isready.exe -h 127.0.0.1 -p 55432` | `127.0.0.1:55432 - no response` (`pg_isready_exit=2`) after clean shutdown | **PASS** |
| Migration Immutability & Whitespace Hygiene | `git diff --check` and `git diff --stat` on `001_*`–`023_*` | Both exited `0` with empty diff on historical migrations `001_*`–`023_*` | **PASS** |

---

## 9. Modified & Added Files Inventory

- **Database Migration & Backend Config:**
  - `backend/migrations/024_home_dashboard_profitability.sql` (new)
  - `backend/src/config/database.ts`
  - `backend/src/app.ts`
- **Backend Modules:**
  - `backend/src/modules/billing/costSnapshot.ts` (new)
  - `backend/src/modules/normalBills/normalBills.service.ts`
  - `backend/src/modules/gstInvoices/gstInvoices.service.ts`
  - `backend/src/modules/dashboard/dashboard.validation.ts` (new)
  - `backend/src/modules/dashboard/dashboard.service.ts` (new)
  - `backend/src/modules/dashboard/dashboard.routes.ts` (new)
- **Frontend Navigation & Dashboard Feature:**
  - `frontend/src/App.tsx`
  - `frontend/src/components/Navbar.tsx`
  - `frontend/src/features/dashboard/dashboard.types.ts` (new)
  - `frontend/src/features/dashboard/dashboardApi.ts` (new)
  - `frontend/src/features/dashboard/HomeDashboard.tsx` (new)
  - `frontend/src/features/dashboard/components/DashboardSection.tsx` (new)
  - `frontend/src/features/dashboard/components/DashboardMetricCard.tsx` (new)
  - `frontend/src/features/dashboard/components/DashboardDateFilter.tsx` (new)
  - `frontend/src/features/dashboard/components/DashboardProfitability.tsx` (new)
  - `frontend/src/features/dashboard/components/DashboardSalesTrend.tsx` (new)
  - `frontend/src/features/dashboard/components/DashboardActivityFeed.tsx` (new)
  - `frontend/src/features/dashboard/components/DashboardExpenseForm.tsx` (new)
  - `frontend/src/features/dashboard/components/DashboardExpenses.tsx` (new)
- **Automated Tests & Documentation:**
  - `backend/tests/auth.security.test.ts`
  - `backend/tests/dashboard.service.test.ts` (new)
  - `backend/tests/integration/postgres.integration.test.ts`
  - `frontend/tests/dashboard.test.tsx` (new)
  - `docs/RELEASE_024_HOME_DASHBOARD_AND_PROFITABILITY_REPORT.md` (new)

---

## 10. Operational Rollout Notes

1. **No Live Environments Modified:** Production Neon PostgreSQL, Render backend, Vercel frontend, Cloudflare R2 storage, and `main` (`7bfacac6ab902508628e277f595d7ab3434a18c7`) remain untouched. All work is isolated on `feat/khata-release-024-home-dashboard`.
2. **Pre-Deploy Order When Owner Merges to `main`:**
   - Apply `024_home_dashboard_profitability.sql` via `npm run migrate --workspace=backend` against production before rolling out the updated backend/frontend build so `EXPECTED_MIGRATIONS` and `EXPECTED_CORE_TABLES` readiness checks pass immediately.
   - Verify all GitHub Actions CI workflows pass on the pull request before merging.
