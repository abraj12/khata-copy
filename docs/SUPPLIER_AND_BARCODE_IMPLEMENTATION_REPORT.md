# Khata ERP — Supplier Management & Barcode Scanner Engineering Report

- **Branch:** `feat/suppliers-and-barcode-020` (branched from `fix/khata-audit-remediation-019`)
- **Scope:** Module 1 (Supplier Management & Supplier Accounts), Module 2 (Product Barcode Management), Module 3 (Barcode-based Product Selection in Normal Billing, GST Billing, and Quotations), database migration `020_supplier_management.sql`, automated unit & PostgreSQL integration test suites, production builds, and Android TWA verification.

---

## 1. Architecture & Non-Negotiable Guarantees Preserved

1. **Zero Inventory / Stock Management:** Confirmed via recursive source scan across `backend/src`, `backend/migrations`, and `frontend/src` — no `stock_in`, `stock_out`, `stock_quantity`, or warehouse tracking exists.
2. **Strict Separation of Purchase Cost vs. Customer Selling Rate:** `applyCatalogProductToDraftLine` and `upsertScannedProductLine` in [`frontend/src/utils/lineItemDraft.ts`](../frontend/src/utils/lineItemDraft.ts) populate `buyingPriceReference` for internal shopkeeper display only and never copy `product.buying_price` into customer-facing `rate`.
3. **Strictly Opt-In Buying Price Update from Purchase Bills:** `createPurchaseBillSchema` and `updatePurchaseBillSchema` in [`backend/src/modules/suppliers/suppliers.validation.ts`](../backend/src/modules/suppliers/suppliers.validation.ts) default `updateProductBuyingPrice` to `false`. [`frontend/src/features/suppliers/PurchaseBillsView.tsx`](../frontend/src/features/suppliers/PurchaseBillsView.tsx) renders the checkbox unchecked by default on every line and does not modify `products.buying_price` unless explicitly checked.
4. **Never Invent Opening Balances:** `buildSupplierStatementLedger` in [`backend/src/modules/suppliers/suppliers.accounting.ts`](../backend/src/modules/suppliers/suppliers.accounting.ts) sets `openingBalance` to `'0.00'` when no prior transactions exist before the statement filter start date, and computes prior balance strictly from recorded finalized purchase bills minus recorded supplier payments.
5. **Single Authoritative Accounting Formula:** `computeSupplierAccountSummary`, `computePurchaseBillTotals`, `buildSupplierStatementLedger`, and `aggregateSupplierDashboardKPIs` in [`backend/src/modules/suppliers/suppliers.accounting.ts`](../backend/src/modules/suppliers/suppliers.accounting.ts) power Supplier Dashboard, Suppliers List, Supplier Details, and Supplier Statements consistently.
6. **Barcode Overwrite Protection & Unknown Barcode Confirmation:** [`backend/src/modules/products/products.service.ts`](../backend/src/modules/products/products.service.ts) returns HTTP `409 BARCODE_REPLACE_CONFIRMATION_REQUIRED` when updating/replacing an existing non-null barcode without `confirmReplaceBarcode: true`. [`frontend/src/features/barcode/BillingBarcodeControls.tsx`](../frontend/src/features/barcode/BillingBarcodeControls.tsx) and [`frontend/src/features/barcode/BarcodeScannerModal.tsx`](../frontend/src/features/barcode/BarcodeScannerModal.tsx) prompt `"Product not found for this barcode."` and never auto-create products without explicit confirmation.

---

## 2. Database Migration `020_supplier_management.sql`

File: [`backend/migrations/020_supplier_management.sql`](../backend/migrations/020_supplier_management.sql)  
Registered in [`backend/src/config/database.ts`](../backend/src/config/database.ts) (`EXPECTED_MIGRATIONS` length `20`, `EXPECTED_CORE_TABLES` length `23`).

### Key Schema Objects & Constraints
- **`products` hardening:** Normalizes blank/whitespace-only barcodes to `NULL` and adds schema-scoped constraint `chk_products_barcode_non_empty` (`CHECK ("barcode" IS NULL OR LENGTH(TRIM("barcode")) > 0)`).
- **`suppliers`:** UUID PK (`DEFAULT gen_random_uuid()`), `normalized_name`, `normalized_phone`, `state`, `state_code`, `gstin`, `archived_at`, check constraints (`chk_suppliers_name_non_empty`, `chk_suppliers_state_code_format`, `chk_suppliers_gstin_format`), and active partial unique indexes (`uq_suppliers_active_normalized_name`, `uq_suppliers_active_phone`, `uq_suppliers_active_gstin` where `archived_at IS NULL`).
- **`supplier_purchase_bills`:** Per-supplier unique active invoice index (`uq_supplier_purchase_bills_invoice`), Decimal tax & total columns (`subtotal_amount`, `discount_amount`, `taxable_amount`, `gst_rate`, `gst_amount`, `grand_total`), `status IN ('finalized', 'cancelled')`, R2 attachment metadata columns, `version`, and composite uniqueness `uq_supplier_purchase_bills_id_supplier UNIQUE ("id", "supplier_id")`.
- **`supplier_purchase_bill_items`:** Unconstrained `NUMERIC` quantity with strict 2-decimal-place & range check (`CHECK ("quantity" > 0 AND "quantity" <= 1000000 AND scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity")`) preventing PostgreSQL silent coercion rounding on excess decimal precision, plus `updated_product_buying_price BOOLEAN NOT NULL DEFAULT FALSE`.
- **`supplier_purchase_bill_history`:** Immutable JSONB snapshot audit log (`created`, `edited`, `cancelled`) with reason and version tracking.
- **`supplier_payments` & `supplier_payment_receipt_seq`:** Sequential `SUP-PAY-001` numbering via [`SUPPLIER_PAYMENT_RECEIPT_NUMBERING_CONFIG`](../backend/src/modules/billing/numbering.ts) and composite key `uq_supplier_payments_id_supplier UNIQUE ("id", "supplier_id")`.
- **`supplier_payment_allocations`:** Composite foreign keys `fk_supplier_alloc_payment_supplier` and `fk_supplier_alloc_bill_supplier` enforcing same-supplier integrity directly in PostgreSQL, plus `uq_supplier_payment_bill_allocation`.

---

## 3. Files Added & Modified

### Backend
- **Modified:**
  - [`backend/src/app.ts`](../backend/src/app.ts) — mounted `/api/v1/suppliers`
  - [`backend/src/config/database.ts`](../backend/src/config/database.ts) — added `020_supplier_management.sql` and the 6 supplier tables to readiness checks
  - [`backend/src/modules/billing/numbering.ts`](../backend/src/modules/billing/numbering.ts) — added `SUPPLIER_PAYMENT_RECEIPT_NUMBERING_CONFIG` (`SUP-PAY-001`, advisory lock key `4`)
  - [`backend/src/modules/products/products.routes.ts`](../backend/src/modules/products/products.routes.ts) — accepted `confirmReplaceBarcode`
  - [`backend/src/modules/products/products.service.ts`](../backend/src/modules/products/products.service.ts) — enforced `409 BARCODE_REPLACE_CONFIRMATION_REQUIRED` when replacing existing barcode without confirmation
  - [`backend/src/services/storage.service.ts`](../backend/src/services/storage.service.ts) — added `'supplier-bills'` R2 folder supporting `image/jpeg`, `image/png`, `image/webp`, and `application/pdf` with `%PDF-` magic-byte verification while preserving existing `'Image size exceeds maximum allowed limit'` messaging for `'products'` / `'offline-bills'`
- **Created:**
  - [`backend/migrations/020_supplier_management.sql`](../backend/migrations/020_supplier_management.sql)
  - [`backend/src/modules/suppliers/suppliers.accounting.ts`](../backend/src/modules/suppliers/suppliers.accounting.ts)
  - [`backend/src/modules/suppliers/suppliers.validation.ts`](../backend/src/modules/suppliers/suppliers.validation.ts)
  - [`backend/src/modules/suppliers/suppliers.service.ts`](../backend/src/modules/suppliers/suppliers.service.ts)
  - [`backend/src/modules/suppliers/suppliers.controller.ts`](../backend/src/modules/suppliers/suppliers.controller.ts)
  - [`backend/src/modules/suppliers/suppliers.routes.ts`](../backend/src/modules/suppliers/suppliers.routes.ts)

### Frontend
- **Modified:**
  - [`frontend/src/components/Navbar.tsx`](../frontend/src/components/Navbar.tsx) & [`frontend/src/App.tsx`](../frontend/src/App.tsx) — added `Suppliers` primary navigation tab and `/suppliers` route
  - [`frontend/src/utils/lineItemDraft.ts`](../frontend/src/utils/lineItemDraft.ts) — added `upsertScannedProductLine`
  - [`frontend/src/features/barcode/barcodeApi.ts`](../frontend/src/features/barcode/barcodeApi.ts) — added `confirmReplaceBarcode` option
  - [`frontend/src/features/barcode/BarcodeScannerModal.tsx`](../frontend/src/features/barcode/BarcodeScannerModal.tsx) — `"Product not found for this barcode."` unknown message and existing-barcode replacement confirmation
  - [`frontend/src/features/products/ProductsView.tsx`](../frontend/src/features/products/ProductsView.tsx) — explicit `confirmReplaceBarcode` guard when overwriting/clearing an existing product barcode
  - [`frontend/src/features/bills/NormalBillingView.tsx`](../frontend/src/features/bills/NormalBillingView.tsx), [`frontend/src/features/bills/GstBillingView.tsx`](../frontend/src/features/bills/GstBillingView.tsx), [`frontend/src/features/quotations/QuotationEditor.tsx`](../frontend/src/features/quotations/QuotationEditor.tsx) — integrated `BillingBarcodeControls` (Enter-key hardware scanner, global USB/Bluetooth scanner listener, camera `BarcodeScannerModal`, auto `+1` quantity increment, never copying `buying_price` to selling `rate`)
- **Created:**
  - [`frontend/src/features/barcode/BillingBarcodeControls.tsx`](../frontend/src/features/barcode/BillingBarcodeControls.tsx)
  - [`frontend/src/features/suppliers/suppliers.types.ts`](../frontend/src/features/suppliers/suppliers.types.ts)
  - [`frontend/src/features/suppliers/suppliersApi.ts`](../frontend/src/features/suppliers/suppliersApi.ts)
  - [`frontend/src/features/suppliers/SuppliersModuleView.tsx`](../frontend/src/features/suppliers/SuppliersModuleView.tsx)
  - [`frontend/src/features/suppliers/SupplierDashboard.tsx`](../frontend/src/features/suppliers/SupplierDashboard.tsx)
  - [`frontend/src/features/suppliers/SuppliersView.tsx`](../frontend/src/features/suppliers/SuppliersView.tsx)
  - [`frontend/src/features/suppliers/SupplierDetails.tsx`](../frontend/src/features/suppliers/SupplierDetails.tsx)
  - [`frontend/src/features/suppliers/PurchaseBillsView.tsx`](../frontend/src/features/suppliers/PurchaseBillsView.tsx)
  - [`frontend/src/features/suppliers/SupplierPaymentsView.tsx`](../frontend/src/features/suppliers/SupplierPaymentsView.tsx)
  - [`frontend/src/features/suppliers/SupplierStatement.tsx`](../frontend/src/features/suppliers/SupplierStatement.tsx)

### Tests
- **Modified:**
  - [`backend/tests/auth.security.test.ts`](../backend/tests/auth.security.test.ts)
  - [`backend/tests/products.barcode.test.ts`](../backend/tests/products.barcode.test.ts) — added tests 10–11 for `BARCODE_REPLACE_CONFIRMATION_REQUIRED` and confirmed replacement
  - [`backend/tests/storage.service.test.ts`](../backend/tests/storage.service.test.ts) — added `'supplier-bills'` PDF magic-byte and key generation test
  - [`backend/tests/integration/postgres.integration.test.ts`](../backend/tests/integration/postgres.integration.test.ts) — updated clean migration baseline to `020` / 23 core tables and added real PostgreSQL tests `24.` (`019 -> 020` schema upgrade + barcode non-empty normalization) and `25.` (end-to-end suppliers/barcode workflows, opt-in buying price, 2dp qty CHECK, composite FKs, `SUP-PAY-` parallel numbering, archived supplier statements, history-safe delete guard, TX rollback)
- **Created:**
  - [`backend/tests/suppliers.service.test.ts`](../backend/tests/suppliers.service.test.ts) (8 tests)
  - [`frontend/tests/suppliersAndBarcode.test.ts`](../frontend/tests/suppliersAndBarcode.test.ts) (6 tests)

---

## 4. Verification Results

All checks listed below were executed directly after code and migration fixes:

| Check | Command | Result |
|---|---|---|
| Backend & Frontend Unit Tests | `npm test` | **Passed:** Backend `22/22` files (`231/231` tests); Frontend `12/12` files (`74/74` tests) |
| Real PostgreSQL Integration Suite | `npm run test:integration` against PostgreSQL 18.6 (`khata_test`) | **Passed:** `1/1` file, `25/25` tests |
| Production TypeScript & Vite Builds | `npm run build` | **Passed:** `backend` `tsc` exit 0; `frontend` `tsc && vite build` (`2330` modules) exit 0 |
| Android Digital Asset Links | `node frontend/scripts/validate-assetlinks.js` | **Passed:** `[SUCCESS] Digital Asset Links validation passed: in.algions.khata` |
| Android TWA Debug Build | `cd android-twa && .\gradlew.bat assembleDebug --no-daemon` | **Passed:** `BUILD SUCCESSFUL in 23s` (`31` tasks up-to-date) |
| Static Guard Scans | PowerShell `Select-String` across `backend/src`, `backend/migrations`, `frontend/src` | **Passed:** Zero stock/warehouse code; zero `buying_price -> rate` assignments |

---

## 5. Notes & Operational Considerations

- **Deployment Order:** Run `npm run migrate` (`backend/migrations/020_supplier_management.sql`) against the Neon PostgreSQL database before deploying the updated backend service, because `/api/v1/health/ready` checks for all 20 migrations and 23 core tables including the 6 supplier tables.
- **Attachments Storage:** Purchase bill document uploads/previews/downloads rely on existing Cloudflare R2 environment variables (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) via authenticated backend proxy endpoints under `/api/v1/suppliers/purchase-bills/:billId/attachment`.
- **Android UI Testing:** Android APK compilation (`assembleDebug`) and Digital Asset Links (`validate-assetlinks.js`) succeeded locally; interactive TWA UI/camera barcode scanning on a physical device was not run in this terminal environment.
