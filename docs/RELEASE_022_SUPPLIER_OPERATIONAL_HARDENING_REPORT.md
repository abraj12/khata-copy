# Khata ERP — Release #022 Engineering Report
## Supplier Operational Hardening, Financial Ledger Integrity, Payment Search, Practical Dashboard & Continuous Barcode Billing

- **Working Branch:** `fix/supplier-operations-dashboard-barcode-022` (branched from `main` commit `c35eea45a8a656b096154041f98efe828b27308d`)
- **Scope:** Migration `022_supplier_operational_hardening.sql`, append-only purchase bill cancellation ledger & database immutability triggers (`SQLSTATE '55000'`), cross-month statement cancellation ledger & CSV export, archived supplier settlement rules, mandatory digital/cheque payment reference validation, supplier payment search & filter pagination resets, practical compact Suppliers list default view & SQL-aggregated Dashboard, continuous supermarket camera barcode scanning (`continuousScan`), automated regression tests, local PostgreSQL 18 clean + upgrade + integration verification, and Android TWA debug verification.

---

## 1. Preserved Architectural & Financial Guarantees

1. **Single-Vendor Khata ERP:** Zero inventory/stock tracking added.
2. **Buying Price vs. Customer Selling Rate Separation:** `applyCatalogProductToDraftLine` and `upsertScannedProductLine` in `frontend/src/utils/lineItemDraft.ts` store `product.buying_price` strictly in `buyingPriceReference` and keep customer selling `rate` empty unless explicitly entered.
3. **Immutable Financial Audit History:** No historical financial ledger entries are deleted. Purchase bill cancellations, supplier payment reversals, and allocation reversals are protected at the PostgreSQL trigger level (`prevent_financial_audit_mutation`, `SQLSTATE '55000'`).
4. **Historical Migrations Preserved:** `backend/migrations/001_*` through `021_*` remain unmodified (`git diff --stat` confirmed empty).

---

## 2. Database Schema & Migration `022`

- **Created:** `backend/migrations/022_supplier_operational_hardening.sql`
- **Registered:** `backend/src/config/database.ts` (`EXPECTED_MIGRATIONS` and `EXPECTED_CORE_TABLES` updated, alongside readiness mock updates in `backend/tests/auth.security.test.ts`).
- **Auto-Discovery Confirmed:** `backend/src/config/migrator.ts` dynamically reads `*.sql` migration files sorted alphabetically (`001` through `022`).

### Schema Changes in `022_supplier_operational_hardening.sql`
- **`supplier_purchase_bill_cancellations`:** Append-only purchase bill cancellation audit table storing cancellation events (`purchase_bill_id`, `supplier_id`, `original_grand_total`, `reason`, timestamps) so bill cancellations appear chronologically on statement ledgers without mutating past closed periods.
- **Historical Backfill:** Backfills legacy cancelled rows in `supplier_purchase_bills` (`status = 'cancelled'`) idempotently into `supplier_purchase_bill_cancellations`.
- **Append-Only Trigger Function `prevent_financial_audit_mutation()`:** Blocks `UPDATE` and `DELETE` (`SQLSTATE '55000'`) across all three supplier financial audit tables:
  1. `supplier_payment_reversals`
  2. `supplier_payment_allocation_reversals`
  3. `supplier_purchase_bill_cancellations`

---

## 3. Backend Changes Summary

- **`backend/src/modules/suppliers/suppliers.validation.ts`, `suppliers.accounting.ts`, `suppliers.controller.ts`, `suppliers.service.ts`:**
  - **Archived Supplier Rules:**
    - Creating or editing purchase bills for an archived supplier returns `409 SUPPLIER_ARCHIVED`.
    - Recording an unallocated advance (`allocations.length === 0`) against an archived supplier returns `409 ARCHIVED_SUPPLIER_ADVANCE_BLOCKED`.
    - Recording a partially allocated payment against an archived supplier returns `409 ARCHIVED_SUPPLIER_PARTIAL_ALLOCATION`.
    - Attempting to allocate against a bill dated/created after `archived_at` returns `409 ARCHIVED_SUPPLIER_BILL_AFTER_ARCHIVE`.
    - Full-allocation settlements against eligible historical finalized bills and allocating existing unallocated advance balances against historical bills on archived suppliers remain permitted.
  - **Mandatory Digital/Cheque Reference Validation:**
    - Non-empty `transactionReference` is required for `upi`, `bank_transfer`, and `cheque` payments (`400 TRANSACTION_REFERENCE_REQUIRED` / `400 VALIDATION_ERROR`), while remaining optional for `cash` and `other`.
    - Case-insensitive duplicate active digital reference per supplier & payment method continues to be blocked (`409 SUPPLIER_PAYMENT_REFERENCE_DUPLICATE`).
  - **Cancellation Ledger & Cross-Month Statements:**
    - `cancelPurchaseBill` inserts an append-only event into `supplier_purchase_bill_cancellations`.
    - `getSupplierStatement` and `formatStatementCsv` include `'purchase_bill_cancellation'` / `"Purchase Bill Cancellation"` credit entries and `periodCancellations`, preserving closed prior period totals while crediting post-cancellation statement periods cleanly.
  - **Payment Search & Pagination Join Consistency:**
    - `listSupplierPayments` supports `search` filtering across `sp.receipt_number`, `s.name`, `sp.transaction_reference`, and `sp.notes`, and includes `INNER JOIN suppliers s` in `resolvePaginatedTotal`'s fallback `COUNT(*)` query for out-of-range offsets.
  - **SQL-Aggregated Dashboard (`getDashboard`):**
    - Computes dashboard KPIs via SQL CTEs and includes period-filtered `recentPayments` (`<= 15`) alongside payment method breakdowns.

---

## 4. Frontend Changes Summary

- **Suppliers Navigation & Operational UI (`frontend/src/features/suppliers/`):**
  - **`SuppliersModuleView.tsx`:** Updated default active section to `'all-suppliers'` (`DEFAULT_SUPPLIER_SECTION_TAB`) and ordered tabs: All Suppliers, Purchase Bills, Supplier Payments, Statements, Dashboard.
  - **`SuppliersView.tsx`:** Added compact desktop operational table layout, mobile card view, and `requestIdRef` stale-response guard.
  - **`SupplierDetails.tsx`:** Displays archived supplier banner, exposes `Settle Outstanding Bills` and `Allocate Advance` actions, and hides `Record Purchase Bill` when archived.
  - **`PurchaseBillsView.tsx`:** Added `requestIdRef` stale-response guard, archived supplier filter banner, and disabled create/edit bill controls for archived suppliers.
  - **`SupplierPaymentsView.tsx`:** Added debounced `search` filter, `requestIdRef` guard, `setOffset(0)` pagination reset across filter changes, required digital/cheque reference indicators & inline validation (`isDigitalSupplierPaymentMethod`, `getSupplierPaymentReferenceFieldMeta`, `validateSupplierPaymentFormInput` in `suppliersApi.ts`), archived supplier settlement selection with full-allocation lock, and enabled `Allocate Advance` for archived suppliers.
  - **`SupplierStatement.tsx`:** Added `Bill Cancels (-)` summary card and `purchase_bill_cancellation` table/mobile card entries.
  - **`SupplierDashboard.tsx`:** Implemented SQL-aggregated dashboard consumer with `resolveDashboardDateRange`, date presets, 6 summary KPI cards, 5 payment method cards, `Recent Supplier Payments` responsive list/table, and Payment Detail modal.
  - **`suppliers.types.ts` & `suppliersApi.ts`:** Added dashboard summary types, cancellation statement types, `search` query wiring, and digital payment reference validation helpers.

- **Continuous Barcode Scanning (`frontend/src/features/barcode/`):**
  - **`barcodePresenceLock.ts` (new):** Implemented `createCameraBarcodePresenceLock(750)` (suppressing duplicate stationary frames across brief blurs until barcode switches or leaves camera view for `>= 750ms`) and `resolveContinuousBarcodeLookup`.
  - **`BarcodeScannerModal.tsx`:** Added `continuousScan` mode keeping camera open with non-blocking feedback banner, FIFO lookup queue integration, `Done` close button, and timer cleanup on close/unmount while keeping single-scan close behavior intact when `continuousScan={false}`.
  - **`BillingBarcodeControls.tsx`:** Enabled `continuousScan={true}`, paired with existing `useHardwareBarcodeScanner` (`frontend/src/features/barcode/useHardwareBarcodeScanner.ts`) and FIFO queue lookup processing.

---

## 5. Verification & Test Results (Executed After Final Code Edit)

1. **Production TypeScript & Vite Build (`npm run build`):**
   - Backend (`tsc`) and Frontend (`tsc && vite build`): exited `0` (`2333 modules transformed`, output written to `frontend/dist`).
2. **Backend & Frontend Unit Tests (`npm test`):**
   - **Backend:** `22` test files passed (`239` tests passed, `0` failed, `0` skipped), including updated `suppliers.service.test.ts` and `auth.security.test.ts`.
   - **Frontend:** `12` test files passed (`86` tests passed, `0` failed, `0` skipped), including updated `suppliersAndBarcode.test.ts` (`11` tests) and `barcodeScanner.test.ts` (`12` tests covering presence lock, `continuousScan`, and 4-item continuous HID FIFO burst).
3. **Disposable Local PostgreSQL 18 (`localhost:55432`) Verification:**
   - **Clean Install (`khata_rel022_clean` via `npm run migrate --workspace=backend`):** Applied all `22` migrations (`001`–`022`), verified `supplier_purchase_bill_cancellations` exists and `prevent_financial_audit_mutation` triggers are active on all 3 audit tables.
   - **Upgrade (`021` -> `022` on `khata_rel022_upgrade`):** Seeded a pre-`022` cancelled bill, applied `022_supplier_operational_hardening.sql`, confirmed backfill count (`1`), verified `UPDATE`/`DELETE` rejection with `SQLSTATE '55000'`, and verified idempotent re-execution with no duplicate rows.
   - **PostgreSQL Real Database Integration Suite (`npm run test:integration --workspace=backend` against `khata_rel022_integ_test`):** `1` test file passed (**`29` passed, `0` failed, `0` skipped**), including test `29. Release #022 Operational Hardening: Cancellation Ledger, Append-Only Triggers, Archived Settlement & SQL Dashboard`.
   - Cleaned up all temporary databases and stopped local PostgreSQL 18 (`pg_isready` exited `2`).
4. **Migration Integrity & Git Hygiene:**
   - Verified `git diff --stat` on `001_*` through `021_*` migrations is empty.
   - Verified `git diff --check` exited `0`.
5. **Android TWA & Digital Asset Links:**
   - `node frontend/scripts/validate-assetlinks.js`: passed (`in.algions.khata`).
   - `android-twa\gradlew.bat assembleDebug --no-daemon`: `BUILD SUCCESSFUL in 19s` (`31 actionable tasks: 31 up-to-date`).

---

## 6. Remaining Scope & Live-Environment Notes

- Production Neon database, Render backend service, Vercel frontend deployment, Cloudflare R2 storage, and Android release APK signing keystores were intentionally left untouched.
- Changes were committed and pushed exclusively to feature branch `fix/supplier-operations-dashboard-barcode-022` and have not been merged into `main`. When deploying Release #022 to live environments, apply migration `022_supplier_operational_hardening.sql` before rolling out the updated backend/frontend build.
