# Khata ERP — Release #023 Engineering Report
## Financial Consistency, Billing Validation, History Reliability, Catalogue Scalability & Release Security

- **Repository:** `https://github.com/abraj12/khata-copy`
- **Base Branch & Audited Commit:** `main` at `08986e897279853eb0b12037cf82ac92f24dd900` (`08986e8`)
- **Working Branch:** `fix/khata-release-023-financial-ui-hardening`
- **Deliverable Scope:** Migration `023_supplier_audit_truncate_guard.sql`, transactional `REPEATABLE READ READ ONLY` Supplier Statement snapshot consistency, Supplier Statement request-race & dirty-date export guards, Billing/Quotation history race & pagination reset hardening, unified strict backend & frontend discount/GST/Decimal validation, server-side debounced catalogue search & pagination (`> 1,200` products/customers) with 20-line item cap enforcement, CI release signing assertion hardening, repository governance (`CODEOWNERS`, PR template), automated regression tests, local PostgreSQL 18 clean + upgrade + real integration verification, and Android TWA verification.

---

## 1. Preserved Architectural & Financial Guarantees

1. **Single-Vendor Khata ERP:** Zero inventory/stock tracking added.
2. **Buying Price Reference vs. Selling Rate Separation:** Catalogue and barcode helpers (`applyCatalogProductToDraftLine`, `upsertScannedProductLine` in `frontend/src/utils/lineItemDraft.ts`) store `buying_price` strictly in `buyingPriceReference` and leave customer selling `rate` empty unless explicitly provided.
3. **Immutable Financial Audit History:** No historical financial rows are deleted; `023_supplier_audit_truncate_guard.sql` extends `022`'s `UPDATE`/`DELETE` row triggers with statement-level `BEFORE TRUNCATE` triggers (`SQLSTATE '55000'`) across all three supplier financial audit tables.
4. **Historical Migrations Preserved:** `backend/migrations/001_*` through `022_*` remain unmodified (`git diff --stat` confirmed empty).
5. **Fixed Discount Clamping Preserved:** Fixed discounts exceeding subtotal (`resolveValidatedDiscount` in `backend/src/utils/validation.ts`) continue to clamp `discountAmount` at subtotal so invoice totals never go negative, while rejecting malformed or negative discount values regardless of `discountType`.

---

## 2. Database Schema & Migration `023`

- **Added:** `backend/migrations/023_supplier_audit_truncate_guard.sql`
- **Registered:** `backend/src/config/database.ts` (`EXPECTED_MIGRATIONS` line 57) and updated readiness test mock in `backend/tests/auth.security.test.ts`.
- **PostgreSQL Changes:**
  - Reuses `prevent_financial_audit_mutation()` (introduced in `022_supplier_operational_hardening.sql`) for idempotent statement-level `BEFORE TRUNCATE` protection (`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER ... FOR EACH STATEMENT`) on:
    1. `public.supplier_payment_reversals` (`trg_block_supplier_payment_reversals_truncate`)
    2. `public.supplier_payment_allocation_reversals` (`trg_block_supplier_allocation_reversals_truncate`)
    3. `public.supplier_purchase_bill_cancellations` (`trg_block_supplier_bill_cancellations_truncate`)

---

## 3. Detailed Implementation Summary (By Workstream)

### Workstream 1 — Supplier Statement Transactional Snapshot Consistency (`backend/src/modules/suppliers/suppliers.service.ts`)
- Wrapped `getSupplierStatement()` in a dedicated single `appPool.connect()` client transaction executing `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.
- Passed that single `client` into `getSupplierById(supplierId, client)` and executed opening balance (`priorRes`), bills (`billsRes`), payments (`paymentsRes`), reversals (`reversalsRes`), and cancellations (`cancellationsRes`) queries sequentially on the same transaction snapshot, followed by `COMMIT` (or `ROLLBACK` on error) and `client.release()` in `finally`.

### Workstream 2 — Supplier Statement UI Stale-Response & Export/Print Date Guards (`frontend/src/features/suppliers/SupplierStatement.tsx`)
- Added `statementRequestIdRef` monotonic counter across `loadStatement` success, error, and `finally` paths and effect cleanup so slow prior responses cannot overwrite newer supplier/date selections or clear newer loading states.
- Cleared stale displayed statement immediately upon supplier changes, invalid ranges, and errors.
- Added `statementMatchesCurrentSelection` verifying displayed `statement.supplier.id`, `statement.filters.fromDate`, and `statement.filters.toDate` match current inputs; `Print Statement` and `Export CSV` buttons remain disabled and a warning banner prompts clicking `Apply` whenever filter dates are unapplied.
- Ensured `handleExportCsv` forwards `statement.filters.fromDate` and `statement.filters.toDate` (applied server filters) rather than unapplied draft inputs.

### Workstream 3 — Quotations Filter/Search Race & Page Reset (`frontend/src/features/quotations/QuotationsView.tsx`)
- Added `quotationRequestIdRef` stale-response protection in `loadQuotations` (success, catch, `finally`, and `useEffect` cleanup).
- Synchronized `setPage(0)` alongside status filter card clicks and search input changes (`debouncedSearch` / `statusFilter` reset effect) so filter changes query offset `0` without stale overlapping responses.

### Workstream 4 — Billing History Race & Filter Reset (`frontend/src/features/bills/NormalBillingView.tsx`, `frontend/src/features/bills/GstBillingView.tsx`)
- Integrated `useDebouncedValue(historySearch, 300)`, `historyRequestIdRef`, and `useCallback`-stabilized history loading across `NormalBillingView` and `GstBillingView`.
- Synchronously reset `historyPage` to `0` on search/date filter changes and explicit search form submission so stale page offsets or slow responses cannot overwrite newer search results.

### Workstream 5 — Unified Discount, GST & Live UI Decimal Validation
- **Backend (`backend/src/utils/validation.ts`, `normalBills.routes.ts`, `normalBills.service.ts`, `gstInvoices.routes.ts`, `gstInvoices.service.ts`, `quotations.service.ts`):**
  - Exported `validatePercentageInput`, `validateGstRateInput`, `resolveValidatedDiscount`, `calculateGstBreakdown`, `optionalNonNegativeMoneyZodField`, `strictGstRateZodField`, and `addPercentageDiscountZodIssue`.
  - Updated `createNormalBillSchema` and `createGstInvoiceSchema` along with `normalBillsService` (`createBillInTransaction`, `generateDraftPdf`), `gstInvoicesService` (`createInvoiceInTransaction`, `generateDraftPdf`), and `quotationsService` (`calculateQuotationTotals`) to enforce identical strict money/percentage rules (`0..100`, max 2 decimals, rejection of scientific notation/text/negative values and invalid omitted-mode values), recompute all totals server-side (`Decimal.ROUND_HALF_UP`), and reject tampered payloads.
- **Frontend (`frontend/src/utils/lineItemDraft.ts`, `GstBillingView.tsx`, `QuotationEditor.tsx`):**
  - Exported `decimalOrZero` to prevent live UI crashes while users type partial decimal fragments (`"."`, `"-"`, `""`), paired with strict submit-time validation via `validatePercentageDraftInput`, `validateQuantityInput`, and `validateSellingRateInput` in `validateGstForm` and `validateQuotationForm`.

### Workstreams 6 & 7 — Server-Paginated Catalogue Search (`> 1,200` Scale) & 20-Item Bill Limit
- **Constants & Shared Hooks/Components:**
  - `frontend/src/utils/billingLimits.ts`: Defined `MAX_BILL_LINE_ITEMS = 20` and `CATALOGUE_PAGE_SIZE = 25`.
  - `frontend/src/features/bills/useBillingCatalogueSearch.ts`: Implemented `usePaginatedProductSearch` and `usePaginatedCustomerSearch` backed by `/api/v1/products` and `/api/v1/khata/customers` with `300ms` debounce, `AbortController`, monotonic `requestIdRef`, `Load More` append deduplication by ID, and `prependItem`.
  - `frontend/src/features/bills/BillingCataloguePickers.tsx`: Created shared `CustomerPickerDropdown` and `ProductPickerPopover` components.
- **Billing Views (`NormalBillingView.tsx`, `GstBillingView.tsx`) & Line Item Upsert (`lineItemDraft.ts`):**
  - Removed bounded initial fetch loops and `<datalist>` dropdowns in favor of server-paginated search/Load More (`CATALOGUE_PAGE_SIZE = 25`), decoupled manual customer name edits from customer dropdown search state, and preserved linked product labels (`description`).
  - Updated `upsertScannedProductLine` with optional `maxItems` / `maxItemsErrorMessage` so 20-item caps block a 21st distinct line cleanly on `Add Item`, barcode scans, and form submission (`createNormalBillSchema` / `createGstInvoiceSchema` `.max(20)` on backend) while still allowing quantity increments (`+1`) on existing items.

### Workstreams 8, 9 & 10 — Audit Truncate Trigger, Release Signing CI Gate & Governance
- Hardened `.github/workflows/ci.yml` (`Verify Release Build Fails Closed Without Signing Config`) to capture output to `release-build.log`, require non-zero exit status, and require the exact fail-closed string `[SECURITY ERROR] Release build requested, but release signing credentials are missing!`.
- Added `.github/CODEOWNERS` (`* @abraj12`) and `.github/pull_request_template.md` documenting migration, CI, and secret/production approval checklists.
- Verified Android TWA config (`android-twa/app/build.gradle`: `applicationId 'in.algions.khata'`, `hostName: "erp.algions.in"`; `frontend/public/.well-known/assetlinks.json`: `package_name: "in.algions.khata"` and single SHA-256 fingerprint).

---

## 4. Verification & Test Matrix (Latest Observed Results After Final Code Edits)

| Check | Command / Scope | Observed Result | Status |
|---|---|---|---|
| Production Monorepo Build | `npm run build` (`backend` `tsc`; `frontend` `tsc && vite build`) | Exit `0`; `2336 modules transformed`; `dist/assets/index-CrbvO93O.js` (`1,213.00 kB`), `dist/assets/index-BIaMnR-R.css` (`76.18 kB`), `14.10s` | **PASS** |
| Backend Unit & API Suite | `npm test --workspace=backend` (`vitest run --config vitest.config.ts`) | `22` test files passed, **`248` tests passed**, `0` failed, `0` skipped (`13.28s`) | **PASS** |
| Frontend Unit & React DOM Suite | `npm run test:frontend` (`vitest run frontend/tests`) | `12` test files passed, **`95` tests passed**, `0` failed, `0` skipped (`12.67s`) | **PASS** |
| Disposable PG 18 Clean Install | `localhost:55432` DB `khata_clean_023_test`, migrations `001`–`023` | `23` migrations tracked; all `3` `BEFORE TRUNCATE` triggers verified in `pg_trigger` | **PASS** |
| Disposable PG 18 Upgrade (`022` -> `023`) & Idempotency | `khata_upgrade_023_test`: `001`–`022`, seed rows in all 3 audit tables, apply `023`, re-apply `023`, test `TRUNCATE` | Existing audit rows preserved (`1` row/table); re-application succeeded with 0 errors; `TRUNCATE TABLE` rejected with `SQLSTATE '55000'` | **PASS** |
| Real PostgreSQL Integration Suite | `npm run test:integration --workspace=backend` against `localhost:55432/khata_integ_test` | `1` test file passed, **`30` tests passed**, `0` failed, `0` skipped (`9.28s`), incl. `Test 30` (`REPEATABLE READ` snapshot, `UPDATE`/`DELETE`/`TRUNCATE` `55000` guards, `> 1,200` product/customer pagination & billing > entry `1,000`) | **PASS** |
| Disposable PG 18 Shutdown & Cleanup | Temp DBs dropped; `pg_ctl stop -m fast`; `pg_isready` check | Temp DBs dropped; server stopped (exit `0`); `pg_isready` exited `2` | **PASS** |
| Digital Asset Links Validator | `node frontend/scripts/validate-assetlinks.js` | Exit `0`; `[SUCCESS] Digital Asset Links validation passed: in.algions.khata configured correctly with valid SHA-256 fingerprints.` | **PASS** |
| Android TWA Debug Build | `android-twa\gradlew.bat assembleDebug --no-daemon` | Exit `0`; `BUILD SUCCESSFUL in 18s`; `android-twa/app/build/outputs/apk/debug/app-debug.apk` (`3,705,852` bytes) | **PASS** |
| Android TWA Fail-Closed Unsigned Release | `android-twa\gradlew.bat assembleRelease --no-daemon` (no signing config) | Exited `1` with `[SECURITY ERROR] Release build requested, but release signing credentials are missing!` | **PASS** |
| Migration Immutability & Git Diff Check | `git diff --stat` on `001_*`–`022_*` + `git diff --check` | Empty diff on `001_*`–`022_*`; `git diff --check` exited `0` | **PASS** |
| Production Keystore SHA-256 Match | Verify `assetlinks.json` fingerprint against production Android release keystore | No production keystore or `signing.properties` present in local workspace | **BLOCKED BY MISSING CREDENTIALS** |
| GitHub Remote Branch Protection Rules | Inspect remote repository protection rules / CI run on GitHub | `gh` CLI unavailable and live GitHub branch protection API not queried locally | **NOT VERIFIED** |

---

## 5. Modified & Added Files Inventory

- **Database Migration & Backend Config:**
  - `backend/migrations/023_supplier_audit_truncate_guard.sql` (new)
  - `backend/src/config/database.ts`
- **Backend Source Modules & Shared Validation:**
  - `backend/src/utils/validation.ts`
  - `backend/src/modules/suppliers/suppliers.service.ts`
  - `backend/src/modules/normalBills/normalBills.routes.ts`, `normalBills.service.ts`
  - `backend/src/modules/gstInvoices/gstInvoices.routes.ts`, `gstInvoices.service.ts`
  - `backend/src/modules/quotations/quotations.service.ts`
- **Frontend Modules, Shared Helpers & Pickers:**
  - `frontend/src/utils/billingLimits.ts` (new)
  - `frontend/src/utils/lineItemDraft.ts`
  - `frontend/src/features/bills/useBillingCatalogueSearch.ts` (new)
  - `frontend/src/features/bills/BillingCataloguePickers.tsx` (new)
  - `frontend/src/features/bills/NormalBillingView.tsx`
  - `frontend/src/features/bills/GstBillingView.tsx`
  - `frontend/src/features/suppliers/SupplierStatement.tsx`
  - `frontend/src/features/quotations/QuotationsView.tsx`, `QuotationEditor.tsx`
- **CI/Governance & Automated Tests:**
  - `.github/workflows/ci.yml`, `.github/CODEOWNERS` (new), `.github/pull_request_template.md` (new)
  - `backend/tests/auth.security.test.ts`, `validators.unit.test.ts`, `normalBills.test.ts`, `gstInvoices.test.ts`, `suppliers.service.test.ts`, `integration/postgres.integration.test.ts`
  - `frontend/tests/suppliersAndBarcode.test.ts`, `normalBilling.test.ts`, `gstBilling.test.ts`, `quotations.test.ts`, `barcodeScanner.test.ts`
  - `docs/RELEASE_023_FINANCIAL_UI_HARDENING_REPORT.md` (new)

---

## 6. Operational Rollout Notes & Unverified Scope

1. **No Live Environments Modified:** Production Neon database, Render backend service, Vercel frontend deployment, Cloudflare R2 bucket, Android release keystores, and GitHub `main` branch were untouched. Changes remain isolated on feature branch `fix/khata-release-023-financial-ui-hardening`.
2. **Pre-Deploy Steps (When Owner Merges to `main`):**
   - Execute database migrations (`023_supplier_audit_truncate_guard.sql` via `npm run migrate --workspace=backend`) prior to backend/frontend rollout.
   - Verify CI checks pass on GitHub Actions (`Build & Test (ubuntu-latest)`, `Build & Test (windows-latest)`, `Vercel Frontend Build (Linux)`, `Render Backend Build (Linux)`, `PostgreSQL Integration Tests (Real DB)`, `Android TWA Debug Build & Security Check`).
   - Confirm in GitHub Repository Settings -> Branches that `main` branch protection requires PR review, status checks, and CODEOWNERS approval (`@abraj12`), and compare Play Store signing keystore SHA-256 certificate fingerprint (`keytool -list -v`) against `frontend/public/.well-known/assetlinks.json`.
