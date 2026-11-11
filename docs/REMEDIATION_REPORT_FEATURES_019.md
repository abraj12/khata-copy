# Master Engineering Remediation Report — Khata ERP
## Remediation Release #019: Customer State Integrity, Tax Ordering, Buying-Price Isolation, Complete Idempotency, 2dp Quantity Enforcement, Checksum Validation & Concurrency Verification

- **Repository:** `https://github.com/abraj12/khata-copy`
- **Branch:** `fix/khata-audit-remediation-019`
- **Base Commit:** `c0bfb9e4138e35b7d08990ca0d8c3f7b86101924`
- **Final Commit SHA:** Recorded on branch tip of `fix/khata-audit-remediation-019` upon push
- **Migration Number:** `019` (`backend/migrations/019_customer_tax_integrity_and_idempotency.sql`)
- **Changed Files Count:** `38` modified files
- **Added Files Count:** `9` added files
- **Final Status:** **`CONDITIONAL GO`**

---

## 1. Executive Summary

Remediation Release #019 implements and verifies all 14 confirmed engineering workstreams (`R019-01` through `R019-14`) across the database schema, Express/TypeScript backend, React/TypeScript frontend, CI configuration, Android TWA checks, and documentation without modifying historical migrations `001`–`018`, without modifying `main` or `fix/khata-audit-remediation-018`, and while preserving the single-vendor Khata model (no inventory/stock management, max 2 decimal place quantities, buying price kept strictly internal).

All monorepo builds, unit tests (backend + frontend), real PostgreSQL integration/concurrency tests, Digital Asset Links validation, and Android debug build checks passed after the final code edit. Live Neon production migration `019`, live Render/Vercel environment verification, Play App Signing / production APK signing, and physical Android device testing remain owner-controlled rollout actions, resulting in **`CONDITIONAL GO`**.

---

## 2. Git Details

| Field | Value |
|---|---|
| Repository | `https://github.com/abraj12/khata-copy` |
| Base Commit | `c0bfb9e4138e35b7d08990ca0d8c3f7b86101924` |
| Target Branch | `fix/khata-audit-remediation-019` |
| Final Commit SHA | See push commit SHA on `origin/fix/khata-audit-remediation-019` |
| Modified Files (`M`) | `38` |
| Added Files (`A`) | `9` |
| Migration Number | `019` |

<details>
<summary>Complete Modified & Added File Inventory (47 files)</summary>

**Added (9):**
- `backend/migrations/019_customer_tax_integrity_and_idempotency.sql`
- `backend/src/modules/quotations/logoFetch.ts`
- `backend/src/services/companyTaxProfile.service.ts`
- `backend/src/services/idempotency.service.ts`
- `backend/tests/release019.integrity.test.ts`
- `docs/REMEDIATION_REPORT_FEATURES_019.md`
- `frontend/src/utils/businessDate.ts`
- `frontend/src/utils/lineItemDraft.ts`
- `frontend/tests/release019.test.ts`

**Modified (38):**
- `.github/workflows/ci.yml`
- `backend/src/config/database.ts`
- `backend/src/modules/billing/numbering.ts`
- `backend/src/modules/gstInvoices/gstInvoices.pdf.ts`
- `backend/src/modules/gstInvoices/gstInvoices.routes.ts`
- `backend/src/modules/gstInvoices/gstInvoices.service.ts`
- `backend/src/modules/khata/khata.routes.ts`
- `backend/src/modules/khata/khata.service.ts`
- `backend/src/modules/normalBills/normalBills.routes.ts`
- `backend/src/modules/normalBills/normalBills.service.ts`
- `backend/src/modules/quotations/quotations.pdf.ts`
- `backend/src/modules/quotations/quotations.routes.ts`
- `backend/src/modules/quotations/quotations.service.ts`
- `backend/src/modules/quotations/quotations.validation.ts`
- `backend/src/utils/indianTax.ts`
- `backend/src/utils/validation.ts`
- `backend/tests/auth.security.test.ts`
- `backend/tests/billing.numbering-and-tax.test.ts`
- `backend/tests/gstInvoices.test.ts`
- `backend/tests/integration/postgres.integration.test.ts`
- `backend/tests/khata.financial.test.ts`
- `backend/tests/normalBills.test.ts`
- `backend/tests/quotations.service.test.ts`
- `backend/vitest.config.ts`
- `docs/ANDROID_RELEASE.md`
- `docs/DEPLOYMENT.md`
- `frontend/src/components/MannatTaxInvoice/MannatTaxInvoice.tsx`
- `frontend/src/features/barcode/BarcodeScannerModal.tsx`
- `frontend/src/features/bills/GstBillingView.tsx`
- `frontend/src/features/bills/NormalBillingView.tsx`
- `frontend/src/features/bills/gstInvoicesApi.ts`
- `frontend/src/features/bills/normalBillsApi.ts`
- `frontend/src/features/khata/KhataLedgerView.tsx`
- `frontend/src/features/quotations/QuotationConvertModal.tsx`
- `frontend/src/features/quotations/QuotationEditor.tsx`
- `frontend/src/features/quotations/QuotationsView.tsx`
- `frontend/src/lib/indianStates.ts`
- `frontend/tests/gstBilling.test.ts`

</details>

---

## 3. Every Defect Addressed

### `R019-01` — Customer State Storage and GST State Correctness
- **Original Problem:** Customer records lacked persisted GST state columns; GST billing, quotation forms, and conversion paths defaulted missing buyer state to Bihar (`10`), while selecting a customer could leave stale state from a previous selection and lacked consistent name/code validation.
- **Root Cause:** No `state`/`state_code` columns on `customers`, implicit `'Bihar'`/`'10'` column defaults in billing schemas, fallback defaults in frontend state/form initialization, and split seller profile lookups.
- **Exact Files Changed:**
  - `backend/migrations/019_customer_tax_integrity_and_idempotency.sql`
  - `backend/src/config/database.ts`
  - `backend/src/utils/indianTax.ts`
  - `backend/src/services/companyTaxProfile.service.ts`
  - `backend/src/modules/khata/khata.routes.ts`, `backend/src/modules/khata/khata.service.ts`
  - `backend/src/modules/gstInvoices/gstInvoices.service.ts`, `gstInvoices.routes.ts`, `gstInvoices.pdf.ts`
  - `backend/src/modules/normalBills/normalBills.service.ts`
  - `backend/src/modules/quotations/quotations.service.ts`
  - `frontend/src/lib/indianStates.ts`
  - `frontend/src/features/khata/KhataLedgerView.tsx`
  - `frontend/src/features/bills/GstBillingView.tsx`, `NormalBillingView.tsx`, `gstInvoicesApi.ts`, `normalBillsApi.ts`
  - `frontend/src/features/quotations/QuotationEditor.tsx`, `QuotationConvertModal.tsx`, `QuotationsView.tsx`
  - `frontend/src/components/MannatTaxInvoice/MannatTaxInvoice.tsx`
- **Implementation Details:**
  - Added nullable `state VARCHAR(100)` and `state_code VARCHAR(10)` with `chk_customers_state_code_format` check constraint on `customers`; dropped `'Bihar'` / `'10'` column defaults across billing tables in migration `019`.
  - Updated Khata customer create, patch, search, and detail endpoints to store, validate, return, and explicitly clear (`null`) customer `state` / `state_code`.
  - Added authoritative `resolveValidatedState()` in `indianTax.ts` and fail-closed `getCompanyTaxProfile()` in `companyTaxProfile.service.ts` (`500 COMPANY_TAX_PROFILE_MISSING`, `400 STATE_CODE_REQUIRED`, `400 GSTIN_STATE_MISMATCH`).
  - GST invoices and draft GST PDFs strictly require validated buyer state (`required: true`); normal bills keep buyer state optional and preserve `null`; frontend customer pickers use `resolveCustomerStateSelection()` so stale state is cleared when switching to a customer without state.
- **Tests Proving Correction:** `backend/tests/release019.integrity.test.ts` (Suites 1, 2, 3), `backend/tests/gstInvoices.test.ts`, `frontend/tests/release019.test.ts` (#2, #4), `backend/tests/integration/postgres.integration.test.ts` (Tests 15, 16, 20, 23).

### `R019-02` — Fix Quotation GST Calculation Order
- **Original Problem:** `quotations.service.ts` previously calculated totals before validating and normalizing buyer state, allowing a missing state to misclassify tax before persistence.
- **Root Cause:** `calculateQuotationTotals` ran prior to `resolveValidatedState` and state requirement enforcement.
- **Exact Files Changed:** `backend/src/modules/quotations/quotations.service.ts`, `backend/src/modules/quotations/quotations.validation.ts`.
- **Implementation Details:** `createQuotation()` now follows strict ordering: (1) load & validate `getCompanyTaxProfile()`, (2) call `resolveValidatedState({ state, stateCode, required: Boolean(input.gstEnabled) })`, (3) validate optional `customerGstin` against normalized buyer state via `validateGstinForState` / `validateGstin`, (4) execute `calculateQuotationTotals()` using validated state codes, and only then (5) open the DB transaction and allocate the sequence number.
- **Tests Proving Correction:** `backend/tests/release019.integrity.test.ts` (Suite 3 — verifies GST quotation without buyer state fails with `400 STATE_CODE_REQUIRED` before any `INSERT INTO quotations`, and GSTIN/state mismatches fail with `400 GSTIN_STATE_MISMATCH`).

### `R019-03` — Never Use Buying Price as Unconfirmed Selling Price
- **Original Problem:** Selecting a product or scanning a barcode in customer-facing billing/quotation forms could copy internal `buying_price` into the selling `rate` input.
- **Root Cause:** Draft line mappers populated selling `rate` from `product.buying_price`.
- **Exact Files Changed:** `frontend/src/utils/lineItemDraft.ts`, `frontend/src/features/bills/NormalBillingView.tsx`, `frontend/src/features/bills/GstBillingView.tsx`, `frontend/src/features/quotations/QuotationEditor.tsx`, `frontend/src/features/barcode/BarcodeScannerModal.tsx`.
- **Implementation Details:** Added `applyCatalogProductToDraftLine()` which attaches `buyingPriceReference` strictly as internal reference metadata and keeps selling `rate` empty (`''`) unless an explicit non-sentinel selling rate was already entered by the operator.
- **Tests Proving Correction:** `frontend/tests/release019.test.ts` (#3) and recursive static grep confirming zero `buying_price` assignments into `rate` in `frontend/src`.

### `R019-04` — Complete Billing Idempotency
- **Original Problem:** Release #018 idempotency payload hashes omitted document fields, did not isolate action types on key reuse, did not handle concurrent in-flight races deterministically, and left cached responses stale after post-commit R2 PDF upload.
- **Root Cause:** Module-specific partial payload hashes without shared canonical serialization, missing `action` mismatch check, and missing post-commit cache sync.
- **Exact Files Changed:** `backend/src/services/idempotency.service.ts`, `backend/src/modules/normalBills/normalBills.service.ts`, `normalBills.routes.ts`, `backend/src/modules/gstInvoices/gstInvoices.service.ts`, `gstInvoices.routes.ts`, `backend/src/modules/khata/khata.service.ts`.
- **Implementation Details:** Implemented canonical recursive SHA-256 `hashIdempotencyPayload()`, transaction advisory locking `acquireIdempotencyLock()`, action + hash conflict detection (`409 IDEMPOTENCY_CONFLICT`) in `checkIdempotencyRecord()`, parameterized storage `storeIdempotencyRecord()`, and post-commit R2 key sync via `updateIdempotencyResponse()`.
- **Tests Proving Correction:** `backend/tests/release019.integrity.test.ts` (Suite 4), `backend/tests/khata.financial.test.ts` (Test 20), `backend/tests/integration/postgres.integration.test.ts` (Test 22).

### `R019-05` — Real Idempotency Expiration
- **Original Problem:** Idempotency keys had no `expires_at` column or expiration/cleanup logic despite documented 24-hour TTL semantics.
- **Root Cause:** `idempotency_keys` lacked `expires_at` schema support and bounded cleanup.
- **Exact Files Changed:** `backend/migrations/019_customer_tax_integrity_and_idempotency.sql`, `backend/src/services/idempotency.service.ts`.
- **Implementation Details:** Migration `019` adds `expires_at TIMESTAMPTZ`, backfills `created_at + INTERVAL '24 hours'`, enforces `NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours')`, and indexes `expires_at`. `idempotency.service.ts` returns `{ found: true, expired: true }` on expired keys, allows atomic `ON CONFLICT (key) DO UPDATE` overwrite only when expired, and adds advisory-locked `cleanupExpiredIdempotencyKeys()`.
- **Tests Proving Correction:** `backend/tests/release019.integrity.test.ts` (Suite 4), `backend/tests/integration/postgres.integration.test.ts` (Tests 20 & 22).

### `R019-06` — Fix Quotation Numbering
- **Original Problem:** Quotation previewing consumed `nextval()` and relied on `MAX()+1` fallback, causing skipped sequence numbers on form open and collisions with manual numbers.
- **Root Cause:** `quotations.service.ts` did not use the shared concurrency-safe `billing/numbering.ts` allocator/previewer.
- **Exact Files Changed:** `backend/migrations/019_customer_tax_integrity_and_idempotency.sql`, `backend/src/modules/billing/numbering.ts`, `backend/src/modules/quotations/quotations.service.ts`, `backend/src/modules/quotations/quotations.routes.ts`.
- **Implementation Details:** Registered `QUOTATION_NUMBERING_CONFIG` in `numbering.ts`; `getNextQuotationNumber()` delegates to read-only `getSuggestedNextDocumentNumber()` without sequence mutation; `createQuotation()` allocates or validates manual quotation numbers (e.g. `QT-150`) inside the transaction with advisory lock `allocateDocumentNumber()` and advances `quotation_number_seq`.
- **Tests Proving Correction:** `backend/tests/quotations.service.test.ts` (Test 1), `backend/tests/release019.integrity.test.ts` (Suite 3 — manual `QT-150`), `backend/tests/integration/postgres.integration.test.ts` (Tests 20, 22, 23).

### `R019-07` — Business Timezone Consistency
- **Original Problem:** Frontend conversion modals and date defaults still used UTC (`new Date().toISOString().slice(0, 10)`), causing off-by-one dates between 00:00 and 05:30 IST.
- **Root Cause:** Client code lacked an IST-aware business date utility matching backend `BUSINESS_TIME_ZONE`.
- **Exact Files Changed:** `frontend/src/utils/businessDate.ts`, `frontend/src/features/quotations/QuotationConvertModal.tsx`, `QuotationEditor.tsx`, `frontend/src/features/bills/GstBillingView.tsx`, `NormalBillingView.tsx`, `frontend/src/features/khata/KhataLedgerView.tsx`.
- **Implementation Details:** Created `getBusinessDateISO('Asia/Kolkata')`, `isValidBusinessDate()`, and `addBusinessCalendarDays()` using `Intl.DateTimeFormat` in `Asia/Kolkata`, replacing runtime UTC date slicing across billing, khata, and quotation flows.
- **Tests Proving Correction:** `frontend/tests/release019.test.ts` (#1 — explicitly tests `2026-11-10T18:29:59Z` -> `2026-11-10` vs `2026-11-10T18:30:00Z` -> `2026-11-11`).

### `R019-08` — GSTIN Checksum Validation
- **Original Problem:** GSTIN checks validated length, regex structure, and 2-digit state prefix but did not verify the 15th check digit.
- **Root Cause:** `indianTax.ts` lacked the Luhn mod-36 GSTIN check-digit calculation.
- **Exact Files Changed:** `backend/src/utils/indianTax.ts`, `backend/tests/billing.numbering-and-tax.test.ts`, `backend/tests/gstInvoices.test.ts`, `backend/tests/quotations.service.test.ts`, `frontend/tests/gstBilling.test.ts`.
- **Implementation Details:** Implemented `computeGstinCheckDigit()` (base-36 weighted Luhn mod-36) inside `validateGstin()` and `validateGstinForState()`, rejecting forged/typo check digits while preserving optionality when GSTIN is omitted.
- **Tests Proving Correction:** `backend/tests/billing.numbering-and-tax.test.ts` (`09AAAAA0000A1Z5` rejected vs `09AAAAA0000A1Z0` accepted) and `backend/tests/release019.integrity.test.ts` (Suite 1).

### `R019-09` — Enforce Maximum Two Decimal Places for Quantity
- **Original Problem:** While `udhar_items` restricted quantities to 2 decimals, quotation validation allowed 3 decimal places, billing routes used weak float validators, and item tables lacked uniform DB `CHECK` constraints.
- **Root Cause:** Missing shared strict 2-decimal validator on billing/quotation Zod schemas and missing SQL `CHECK` constraints across all 4 line-item tables.
- **Exact Files Changed:** `backend/migrations/019_customer_tax_integrity_and_idempotency.sql`, `backend/src/utils/validation.ts`, `backend/src/modules/quotations/quotations.validation.ts`, `backend/src/modules/gstInvoices/gstInvoices.routes.ts`, `backend/src/modules/normalBills/normalBills.routes.ts`, `frontend/src/utils/lineItemDraft.ts`.
- **Implementation Details:** Standardized `validateDecimalQuantityInput()` (`^(?:0|[1-9]\d*)(?:\.\d{1,2})?$`, `> 0`, `<= 1,000,000`) across Zod schemas, services, and frontend `validateQuantityInput()`. Migration `019` normalizes/enforces `NUMERIC(12,2)` and positive + 2dp `CHECK` constraints across `udhar_items`, `normal_bill_items`, `gst_invoice_items`, and `quotation_items`.
- **Tests Proving Correction:** `backend/tests/validators.unit.test.ts`, `frontend/tests/release019.test.ts` (#3), `backend/tests/integration/postgres.integration.test.ts` (Tests 9 & 21 rejecting `1.234`, `0`, `-1` directly in PostgreSQL across all 4 tables).

### `R019-10` — Quotation PDF Company Logo
- **Original Problem:** Quotation settings held `logo_url`, yet `quotations.pdf.ts` did not fetch or draw the company logo in the header.
- **Root Cause:** No SSRF-safe logo fetcher or `doc.image(...)` header placement existed in quotation PDF rendering.
- **Exact Files Changed:** `backend/src/modules/quotations/logoFetch.ts`, `backend/src/modules/quotations/quotations.pdf.ts`, `backend/src/modules/quotations/quotations.validation.ts`.
- **Implementation Details:** Created `fetchSafeLogoBuffer()` supporting trusted R2 object keys (via `storageService.getObjectStream`) and strictly allowlisted HTTPS URLs (`R2_PUBLIC_DOMAIN`, `FRONTEND_URL`), blocking private/loopback/link-local DNS resolutions, HTTP redirects, invalid MIME types, and payloads exceeding `MAX_QUOTATION_LOGO_BYTES` (`2 MiB`). `generateQuotationPdf()` renders valid PNG/JPEG logos proportionally (`fit`) while keeping A4 header details intact.
- **Tests Proving Correction:** `backend/tests/release019.integrity.test.ts` (Suite 5 — verifies SSRF URLs, private DNS `10.0.0.5`, HTTP `302` redirects, oversize payloads are blocked, and valid PNG logo produces valid `%PDF-` buffer).

### `R019-11` — Real Concurrency Tests
- **Original Problem:** Integration tests ran sequentially without true parallel PostgreSQL client contention tests on numbering, idempotency, rollback, or all 4 line-item quantity constraints.
- **Root Cause:** Concurrent multi-connection test coverage was missing in `postgres.integration.test.ts`.
- **Exact Files Changed:** `backend/tests/integration/postgres.integration.test.ts`.
- **Implementation Details:** Added Tests 20–23 using independent `pg` pool connections executed via `Promise.all()`, testing simultaneous GST invoice and quotation sequence allocations, concurrent idempotency advisory locks / `409` conflicts / expiry, Release #018 -> #019 live schema upgrade preservation, all 4 item table CHECK constraints, and multi-statement transaction rollback upon item failure.
- **Tests Proving Correction:** `backend/tests/integration/postgres.integration.test.ts` (23/23 passing against PostgreSQL 18 on `127.0.0.1:55432`).

### `R019-12` — Authentication and Session Regression
- **Original Problem:** Needed regression confirmation that unknown-phone login continues genuine Argon2id dummy verification without throwing or short-circuiting and parallel Vitest execution remains stable.
- **Root Cause:** Parallel worker Argon2id CPU contention in backend unit suites exceeded default 10s `hookTimeout` in 7 suites when run concurrently.
- **Exact Files Changed:** `backend/vitest.config.ts`, `backend/tests/release019.integrity.test.ts`, `backend/tests/auth.security.test.ts`.
- **Implementation Details:** Verified `authService.verifyCredentials()` executes genuine non-throwing `argon2.verify()` against `DUMMY_HASH` on unknown phone login; updated `backend/vitest.config.ts` (`testTimeout: 30000`, `hookTimeout: 30000`) to eliminate parallel Argon2id hook starvation without relaxing any assertions; updated `auth.security.test.ts` expected migrations to 19.
- **Tests Proving Correction:** `backend/tests/auth.security.test.ts` (34/34 passing), `backend/tests/release019.integrity.test.ts` (Suite 6).

### `R019-13` — Deployment, Documentation and Android Consistency
- **Original Problem:** `docs/DEPLOYMENT.md` referenced non-existent `COOKIE_SECRET`, omitted updated cookie flags (`SESSION_COOKIE_SECURE`, `SESSION_COOKIE_HTTP_ONLY`, `SESSION_COOKIE_SAME_SITE`) and `R2_PUBLIC_DOMAIN`, and mixed repo-verified vs owner-only rollout tasks; `.github/workflows/ci.yml` duplicated frontend test execution.
- **Root Cause:** Documentation and workflow drifted relative to `backend/src/config/env.ts` and root `package.json`.
- **Exact Files Changed:** `.github/workflows/ci.yml`, `docs/DEPLOYMENT.md`, `docs/ANDROID_RELEASE.md`.
- **Implementation Details:** Updated `docs/DEPLOYMENT.md` to match `env.ts` verbatim (`019` migrations), clarified debug vs Play App Signing / release SHA-256 fingerprint requirements in `docs/ANDROID_RELEASE.md`, and updated CI test step to run root `npm test`.
- **Tests Proving Correction:** `node frontend/scripts/validate-assetlinks.js` exited `0`; Android `./gradlew.bat assembleDebug --no-daemon` succeeded (`app-debug.apk` `3,705,852` bytes); `./gradlew.bat assembleRelease --no-daemon` failed closed cleanly (`EXIT=1`) without keystore credentials.

### `R019-14` — Full Repository Audit
- **Original Problem:** Residual anti-patterns (`buying_price` leaks, hardcoded `'Bihar'`/`'10'`, UTC `toISOString().slice(0, 10)`, unsafe decimal inputs) needed repository-wide verification.
- **Root Cause:** Partial fixes across individual files without full-tree verification.
- **Exact Files Changed:** Consolidated across the file list above; validated across `backend/src` and `frontend/src`.
- **Implementation Details:** Verified zero `'Bihar'`/`'10'` buyer defaults, zero `buying_price` -> `rate` assignments, zero runtime `toISOString().slice(0, 10)` date fallbacks, and zero `step="any"` / `step="0.001"` UI inputs across `.ts`/`.tsx` sources.

---

## 4. Database Migration Report (`019_customer_tax_integrity_and_idempotency.sql`)

Registered in `backend/src/config/database.ts` (`EXPECTED_MIGRATIONS` count increased to `19`):

- **New Columns:**
  - `customers.state VARCHAR(100)` (nullable)
  - `customers.state_code VARCHAR(10)` (nullable)
  - `idempotency_keys.expires_at TIMESTAMPTZ`
- **Constraints Added / Modified:**
  - `chk_customers_state_code_format` on `customers` ensuring `state_code IS NULL OR state_code ~ '^[0-9]{2}$'` and consistency with `state`.
  - Dropped `'Bihar'` / `'10'` `DEFAULT` clauses from billing tables so missing state is never silently defaulted at the DB layer.
  - Enforced positive & max 2 decimal place quantity (`NUMERIC(12,2)` / `> 0`) `CHECK` constraints across `udhar_items`, `normal_bill_items`, `gst_invoice_items`, and `quotation_items`.
  - Enforced `expires_at NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours')` on `idempotency_keys`.
- **Indexes:**
  - Added index on `idempotency_keys(expires_at)` for bounded expired-key cleanup.
- **Backfills & Sequence Sync:**
  - Backfilled existing `idempotency_keys.expires_at = created_at + INTERVAL '24 hours'` where `NULL`.
  - Synchronized `quotation_number_seq` high-water mark against existing `quotations.quotation_number` numeric values without ever decrementing the sequence.
- **Clean Installation Test:** Verified applying migrations `001`–`019` on an empty PostgreSQL 18 database (`Tests 1`–`19`, `21`–`23` in `postgres.integration.test.ts`).
- **Upgrade Test (`Test 20`):** Verified applying `001`–`018` + seeding Release #018 legacy rows (customer without state, historical idempotency row with `expires_at` absent, `QT-008` manual quotation), then applying `019`: confirmed legacy customer retains `NULL` state/state_code, idempotency row receives 24h backfill, and `quotation_number_seq` advances to produce `QT-009` next cleanly.

---

## 5. Financial Regression Results

All calculations use `Decimal.js` with `ROUND_HALF_UP`:

| Scenario | Line Items | Discount | Taxable Amount | GST Breakdown | Expected & Observed Grand Total | Verified In |
|---|---|---|---|---|---|---|
| Inter-State GST (`Bihar 10` -> `UP 09`) | `2 × ₹100.00 + 1 × ₹300.00 = ₹500.00` | `10%` (`₹50.00`) | `₹450.00` | `18%` IGST = `₹81.00` (`CGST ₹0.00`, `SGST ₹0.00`) | **`₹531.00`** | `billing.financial-regression.test.ts`, `postgres.integration.test.ts` (Test 18) |
| Intra-State GST (`Bihar 10` -> `Bihar 10`) | `2 × ₹100.00 + 1 × ₹300.00 = ₹500.00` | `10%` (`₹50.00`) | `₹450.00` | `9%` CGST (`₹40.50`) + `9%` SGST (`₹40.50`) = `₹81.00` | **`₹531.00`** | `billing.financial-regression.test.ts`, `postgres.integration.test.ts` (Test 18) |
| Khata Udhar FIFO Credit & Partial Payments | `Fevicol 3 × ₹550.00 + PVC Pipe 5 × ₹350.00 = ₹3,400.00` | `—` | `—` | `—` | Due **`₹3,400.00`** -> `₹1,000.00` payment = **`₹2,400.00`** -> `₹500.00` payment = **`₹1,900.00`** | `khata.financial.test.ts`, `postgres.integration.test.ts` |

---

## 6. Test Results & Build Verification

Every check below was executed cleanly after the final source/config edit:

| Check | Command | Exact Observed Result |
|---|---|---|
| Backend Unit Suite | `npm test` (`vitest run --config vitest.config.ts`) | **`21 passed (21)` files, `220 passed (220)` tests** (`14.28s`) |
| Frontend Unit Suite | `npm test` (`vitest run frontend/tests`) | **`11 passed (11)` files, `68 passed (68)` tests** (`10.50s`) |
| PostgreSQL Integration & Concurrency Suite | `npm run test:integration` (PostgreSQL 18 on `127.0.0.1:55432`) | **`1 passed (1)` file, `23 passed (23)` tests** (`7.02s`; includes clean `001`–`019`, Release #018 -> #019 upgrade, `Promise.all` concurrent invoice/quotation numbering, concurrent idempotency lock/conflict/expiry, 4-table 2dp SQL `CHECK`s, and transaction rollback) |
| Monorepo Build (Backend + Frontend) | `npm run build` | **Exit `0`** (`backend`: `tsc` 0 errors; `frontend`: `tsc && vite build`, `✓ 2321 modules transformed`, built in `2m 11s`) |
| Digital Asset Links Validator | `node frontend/scripts/validate-assetlinks.js` | **Exit `0`** (`in.algions.khata` valid SHA-256 fingerprint verified) |
| Android TWA Debug APK Build | `cd android-twa && .\gradlew.bat assembleDebug --no-daemon` | **Exit `0`** (`BUILD SUCCESSFUL in 38s`, produced `android-twa/app/build/outputs/apk/debug/app-debug.apk`, `3,705,852` bytes) |
| Android TWA Release Guard | `cd android-twa && .\gradlew.bat assembleRelease --no-daemon` | **Exit `1` (expected fail-closed)** without release signing credentials |
| CI Workflow URL & Commit SHA | `.github/workflows/ci.yml` | Pending remote GitHub Actions execution after push to `origin/fix/khata-audit-remediation-019` (`https://github.com/abraj12/khata-copy/actions`) |

---

## 7. Remaining Owner Actions

The following production tasks are intentionally outside repository CI and require direct execution by the repository/infrastructure owner:

1. **Production Environment Verification:** Confirm Render environment variables (`DATABASE_URL`, `DATABASE_URL_POOLED`, `SESSION_SECRET`, `OWNER_PHONE`, `OWNER_PASSWORD_HASH`, `FRONTEND_URL=https://erp.algions.in`, `BUSINESS_TIME_ZONE=Asia/Kolkata`, `R2_*` credentials, `R2_PUBLIC_DOMAIN`) and Vercel `VITE_API_BASE_URL=https://erp-api.algions.in`.
2. **Production Database Pre-flight & Migration `019`:** Backup Neon PostgreSQL, run `preflight:quantity` / `preflight:legacy` if desired, and execute `npm run migrate --workspace=backend` against the direct Neon `DATABASE_URL` after approval.
3. **Production Deployment & Smoke Check:** Deploy the approved backend/frontend artifacts and verify `GET https://erp-api.algions.in/api/v1/health/ready` returns HTTP `200`.
4. **Play App Signing / Release Key Fingerprint:** Obtain the production release / Play App Signing SHA-256 certificate fingerprint and update `frontend/public/.well-known/assetlinks.json` alongside the debug SHA-256 before Google Play distribution.
5. **Production APK/AAB Signing:** Sign release artifacts securely outside git using `android-twa` Gradle release credentials.
6. **Physical Android Device Testing:** Install signed APK/AAB on a physical Android device and verify TWA address-bar-less launch, cookie session persistence across restarts, camera barcode scanning, and PDF share/print workflows against `https://erp.algions.in`.

---

## 8. Final Status

**`CONDITIONAL GO`** — All Release #019 defects (`R019-01` through `R019-14`), database migration `019`, financial calculation fixes, unit suites (`220` backend + `68` frontend), PostgreSQL 18 real integration/concurrency tests (`23/23`), monorepo production build, and Android debug assembly pass cleanly. Production rollout remains conditional on the owner-controlled live environment, migration, and signed mobile verification steps listed in Section 7.
