# Khata ERP — Release #021 Engineering Report
## Supplier Financial Integrity, Payment Reversals, Idempotency & Barcode Concurrency

- **Working Branch:** `fix/supplier-integrity-barcode-races-021` (branched from `main` commit `66fc99feb22f1f20e4199ab0ef2a895f511dd7a0`)
- **Scope:** Migration `021_supplier_financial_integrity.sql`, immutable supplier payment & allocation reversals, `Idempotency-Key` protection on payment mutations, duplicate active digital payment reference blocking, immutable historical `supplier_snapshot` on purchase bills, true SQL pagination (`>200` records), race-free FIFO barcode queue & synchronous line-item state commits across billing and quotation editors, automated unit & real PostgreSQL integration tests, Android TWA & Asset Links verification.

---

## 1. Preserved Architectural & Financial Guarantees

1. **Zero Inventory / Stock Tracking:** No stock quantity or warehouse tracking was added.
2. **Buying Price vs. Customer Selling Rate Separation:** `applyCatalogProductToDraftLine` and `upsertScannedProductLine` in `frontend/src/utils/lineItemDraft.ts` store `product.buying_price` strictly in `buyingPriceReference` for shopkeeper reference only and never copy cost into selling `rate`.
3. **Opt-In Buying Price Default Remains `false`:** `PurchaseBillsView.tsx` keeps `updateProductBuyingPrice: false` by default on every line item.
4. **Immutable Audit History (Zero Financial Deletions):** Neither `supplier_payments` nor `supplier_payment_allocations` are deleted to correct errors; all corrections append immutable audit records into `supplier_payment_reversals` and `supplier_payment_allocation_reversals`.
5. **Single Authoritative Accounting Formula & Never-Invented Opening Balances:** Dashboard KPIs, Suppliers List, Supplier Details, Purchase Bills, Supplier Payments, Statements, and CSV exports share one unified reversal-aware calculation via `suppliers.accounting.ts` (`priorReversals` supported in `buildSupplierStatementLedger`, `0.00` when no prior history exists).

---

## 2. Database Schema & Migration `021`

- **Created:** `backend/migrations/021_supplier_financial_integrity.sql` (without modifying historical migrations `001`–`020`)
- **Registered:** `backend/src/config/database.ts` (`EXPECTED_MIGRATIONS` length `21`, `EXPECTED_CORE_TABLES` length `25`), plus readiness test mock in `backend/tests/auth.security.test.ts`

### Schema Changes in `021_supplier_financial_integrity.sql`
- **`supplier_payments`:** Added `status VARCHAR(20) NOT NULL DEFAULT 'active'`, `reversed_at TIMESTAMPTZ NULL`, `reversal_reason TEXT NULL`; constraints `chk_supplier_payments_status` (`status IN ('active', 'reversed')`) and `chk_supplier_payments_reversal_metadata`; index `idx_supplier_payments_supplier_status_date`.
- **`supplier_payment_reversals`:** Immutable reversal ledger (`reversal_number` unique `REV-SUP-PAY-...`, `payment_id` unique, `supplier_id`, `original_amount > 0`, `reason`, `payment_snapshot JSONB`, `reversed_at`, composite FK `fk_supplier_pay_rev_payment_supplier`, index `idx_supplier_payment_reversals_supplier_date`).
- **`supplier_payment_allocations` & `supplier_payment_allocation_reversals`:** Added composite uniqueness `uq_supplier_payment_allocations_composite UNIQUE ("id", "payment_id", "purchase_bill_id", "supplier_id")` referenced by `fk_supplier_alloc_rev_allocation` on `supplier_payment_allocation_reversals` with 4 lookup indexes (`idx_supplier_alloc_rev_allocation_id`, `idx_supplier_alloc_rev_payment_id`, `idx_supplier_alloc_rev_bill_id`, `idx_supplier_alloc_rev_supplier_id`).
- **`supplier_purchase_bills`:** Added nullable `supplier_snapshot JSONB NULL` storing supplier identity snapshot at bill creation (`legacy_live_fallback` when `NULL` on pre-`021` rows).
- **Pre-Index Duplicate Digital Reference Diagnostic & Partial Unique Index:** Checks for existing conflicting active (`status = 'active'`) duplicate `upi` / `bank_transfer` / `cheque` references (`LOWER(BTRIM(transaction_reference))`) per supplier and raises an explicit diagnostic exception before creating partial unique index `uq_supplier_payments_active_reference`.

---

## 3. Backend Changes Summary

- **`backend/src/modules/suppliers/suppliers.validation.ts`:**
  - Added `reversePaymentSchema`, `reversePaymentAllocationSchema`, `normalizeTransactionReference`, and `extractAndValidateIdempotencyKey` (`IDEMPOTENCY_KEY_REQUIRED` / `INVALID_IDEMPOTENCY_KEY`, HTTP `400`).
  - Added `offset` pagination parameter on `listSuppliersQuerySchema`, `listPurchaseBillsQuerySchema`, and `listSupplierPaymentsQuerySchema`, plus `status: 'active' | 'reversed' | 'all'` filter on `listSupplierPaymentsQuerySchema`.
- **`backend/src/modules/suppliers/suppliers.accounting.ts`:**
  - Extended `StatementEntryInput` and `buildSupplierStatementLedger(..., priorReversals = 0)` to track `payment_reversal` debits (`+` payable) and `periodReversals`.
- **`backend/src/modules/suppliers/suppliers.routes.ts` & `suppliers.controller.ts` & `suppliers.service.ts`:**
  - Enforced mandatory `Idempotency-Key` header validation and transactional `idempotency_keys` replay / conflict (`409 IDEMPOTENCY_CONFLICT`) / 24h expiry protection across:
    - `POST /api/v1/suppliers/payments`
    - `POST /api/v1/suppliers/payments/:paymentId/allocate`
    - `POST /api/v1/suppliers/payments/:paymentId/reverse`
    - `POST /api/v1/suppliers/payments/:paymentId/allocations/:allocationId/reverse`
  - Enforced duplicate active digital reference blocking (`409 SUPPLIER_PAYMENT_REFERENCE_DUPLICATE` + DB constraint `uq_supplier_payments_active_reference`) for `upi`, `bank_transfer`, and `cheque` while allowing `cash` payments and reuse after payment reversal.
  - Added `reverseSupplierPayment` (`409 PAYMENT_ALREADY_REVERSED` on repeat reversal, `409 PAYMENT_REVERSED` when allocating a reversed payment) and `reversePaymentAllocation` (`409 ALLOCATION_REVERSAL_EXCEEDS_ACTIVE_AMOUNT` serialized via `FOR UPDATE`).
  - Updated `cancelPurchaseBill` and bill balance queries to subtract reversed allocations and reversed payments cleanly, unlocking cancellation once effective allocations reach `0.00`.
  - Recorded and returned historical `supplierSnapshot` and `supplierSnapshotSource` (`'snapshot' | 'legacy_live_fallback'`) on `createPurchaseBill`, `getPurchaseBillById`, and `listPurchaseBills`.
  - Implemented true SQL `LIMIT`/`OFFSET` pagination with `total` and `pagination: { limit, offset, hasMore, nextOffset }` on `listSuppliers`, `listPurchaseBills`, and `listSupplierPayments`.
  - Updated `getSupplierStatement` and `formatStatementCsv` to include `Payment Reversal` debit entries and `periodReversals`.

---

## 4. Frontend Changes Summary

### Race-Free Barcode Queue & Synchronous Line-Item Updates
- **Created `frontend/src/features/barcode/barcodeLookupQueue.ts` (`createFifoBarcodeQueue`):** Strict FIFO sequential barcode lookup queue exposing `enqueue`, `getPendingCount`, `isBusy`, and `dispose`, preventing slower earlier lookups from overwriting faster later lookups during bursts.
- **Updated `frontend/src/features/barcode/BillingBarcodeControls.tsx`:** Wired `createFifoBarcodeQueue` with unmount disposal, queued count badge (`Lookup (${queuedCount} queued)`), non-blocking rapid Enter/button/camera/hardware input, and `batchHadUnknownRef` to preserve `Unknown Barcode` banners when mixed known/unknown bursts arrive.
- **Updated `frontend/src/features/bills/NormalBillingView.tsx`, `GstBillingView.tsx`, & `frontend/src/features/quotations/QuotationEditor.tsx`:** Added `itemsRef` + synchronous `commitItems` updater and routed all item mutation handlers (`upsertScannedProductLine(itemsRef.current, ...)` and manual item edits/additions/deletions/resets) through `commitItems` so back-to-back scans never read stale React render closures.

### Supplier Financial Integrity, Reversal UI, Idempotency & Pagination
- **Created `frontend/src/features/suppliers/SupplierPaginationBar.tsx`:** Responsive (`flex-wrap`) Previous/Next pagination control.
- **Updated `frontend/src/features/suppliers/suppliers.types.ts` & `suppliersApi.ts`:**
  - Added `PaginationMeta`, `SupplierSnapshot`, `supplierSnapshotSource`, payment/allocation reversal fields, `'payment_reversal'` statement entries, and `periodReversals`.
  - Added `createSupplierIdempotencyKey`, `isValidIdempotencyKeyFormat`, `fetchAllPages`, `listAllSuppliersApi`, and `listAllOpenPurchaseBillsForSupplierApi`; attached `'Idempotency-Key'` header to `createSupplierPaymentApi`, `allocateSupplierAdvanceApi`, `reverseSupplierPaymentApi`, and `reverseSupplierAllocationApi`.
- **Updated Views (`SuppliersView.tsx`, `PurchaseBillsView.tsx`, `SupplierPaymentsView.tsx`, `SupplierDetails.tsx`, `SupplierStatement.tsx`):**
  - Replaced capped 100/200 fetches with full page pagination bars (`SUPPLIER_PAGE_LIMIT = 50`, `BILLS_PAGE_LIMIT = 50`, `PAYMENTS_PAGE_LIMIT = 50`) and multi-page helpers (`listAllSuppliersApi`, `listAllOpenPurchaseBillsForSupplierApi`) plus searchable open-bill pickers inside payment & advance allocation modals.
  - Maintained per-payload-signature `PendingKeyRecord` idempotency keys in `SupplierPaymentsView.tsx` so network retries reuse the same `Idempotency-Key`.
  - Added **Reverse Payment** and per-allocation **Reverse** modal workflows, Reversed status badges, reversal history display, snapshot/legacy-fallback indicator on purchase bills, and 5-card + `Payment Reversal` debit rows in `SupplierStatement.tsx`.

---

## 5. Automated Verification Results

All checks below ran cleanly after the final code edit against disposable local test infrastructure (no live Neon, Render, Vercel, or Cloudflare R2 resources touched):

1. **Monorepo TypeScript & Production Build (`npm run build`):**
   - `backend` (`tsc`) and `frontend` (`tsc && vite build`, `2332 modules transformed`, bundle `dist/assets/index-CivzHRFk.js`) exited with code `0`.
2. **Unit & Security Test Suites (`npm test`):**
   - **Backend (`vitest run`):** **22 test files passed (22), 235 tests passed (235)** (including `tests/suppliers.service.test.ts` with 12 tests covering reversal ledger/CSV math, Zod reversal schemas, `Idempotency-Key` validation, `401`/`400`/`409 SUPPLIER_PAYMENT_REFERENCE_DUPLICATE` & `PAYMENT_ALREADY_REVERSED`, plus `tests/auth.security.test.ts` with 34 tests).
   - **Frontend (`vitest run frontend/tests`):** **12 test files passed (12), 80 tests passed (80)** (including `frontend/tests/barcodeScanner.test.ts` with 9 tests covering out-of-order FIFO queue serialization, `[unknown, known]` burst DOM banner preservation, synchronous `itemsRef`/`commitItems` burst commits & unmount cleanup, and `frontend/tests/suppliersAndBarcode.test.ts` with 8 tests covering `createSupplierIdempotencyKey`, `isValidIdempotencyKeyFormat`, and `fetchAllPages` across 450 items).
3. **Real PostgreSQL 18 Integration Tests (`npm run test:integration` against local `khata_test` on port `55432`):**
   - **1 test file passed (1), 28 tests passed (28)** (`tests/integration/postgres.integration.test.ts`), covering:
     - Migration registry and table existence (`021_supplier_financial_integrity.sql`, `supplier_payment_reversals`, `supplier_payment_allocation_reversals`).
     - Fixed Test 25 composite FK checks (`fk_supplier_alloc_bill_supplier` and `fk_supplier_alloc_payment_supplier`, SQLSTATE `23503`).
     - Test 26 (`Release #021 Upgrade Path`): `001->020->021` upgrade diagnostic failure on conflicting active duplicate UPI reference, idempotent re-application after resolution, and legacy `NULL` snapshot schema state.
     - Test 27 (`Payment & Advance Idempotency & Digital Ref Uniqueness`): identical key replay, `409 IDEMPOTENCY_CONFLICT`, 24h key expiry, concurrent duplicate key dedup, `409 SUPPLIER_PAYMENT_REFERENCE_DUPLICATE` + `uq_supplier_payments_active_reference` (`23505`), `cash` & cross-supplier exemption, and advance allocation top-up idempotency.
     - Test 28 (`Reversals, Snapshots, Statement Reconciliation & >200 SQL Pagination`): `supplier_snapshot` immutability vs `legacy_live_fallback`, partial & concurrent `FOR UPDATE` allocation reversals, bill cancellation unlock, full payment reversal + `REV-SUP-PAY-...`, reference reuse after reversal, date-range statement/Dashboard/CSV parity, and zero-overlap SQL pagination over `205` suppliers, `205` bills, and `205` payments plus out-of-range empty page checks.
4. **Fresh Runtime Migrator Verification (`npm run migrate --workspace=backend` against clean `khata_migrator_test`):**
   - Applied all `21` pending migrations (`001`–`021`) cleanly on initial run, reported `"Schema is up to date. All migrations already applied."` on second run, and confirmed `COUNT(*) = 21` in `schema_migrations`.
   - Disposable local PostgreSQL 18 daemon (`port 55432`) verified stopped afterward (`pg_ctl: no server running`, `55432 - no response`).
5. **Android TWA & Digital Asset Links:**
   - `cd android-twa && .\gradlew.bat assembleDebug --no-daemon`: `BUILD SUCCESSFUL in 25s` (`31 actionable tasks`).
   - `node frontend/scripts/validate-assetlinks.js`: `[SUCCESS] Digital Asset Links validation passed: in.algions.khata configured correctly with valid SHA-256 fingerprints.`
6. **Code Hygiene & Safety Audits:**
   - `git diff --check`: exited `0`.
   - `git diff --name-only -- "backend/migrations"`: `0` modifications to migrations `001`–`020`.
   - Source scans confirmed `0` stale `setItems(res.nextLines)` / `upsertScannedProductLine(items` occurrences, `0` direct `DELETE` statements on `supplier_payments` / `supplier_payment_allocations`, and `Idempotency-Key` wiring on all supplier payment, allocation, and reversal client calls.
