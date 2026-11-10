# Master Engineering Remediation Report: Khata ERP (Features & Integrity Fix #017)

## Executive Summary

- **Repository**: `https://github.com/abraj12/khata-copy`
- **Target Branch**: `main`
- **Remediation Release**: #017
- **Verification Status**:
  - **Backend Test Suite**: 18 files passed, 196 tests passed (100% pass rate)
  - **Frontend Test Suite**: 10 files passed, 61 tests passed (100% pass rate)
  - **Total Tests**: 257 passed, 0 failed
  - **TypeScript & Vite Builds**: Backend `tsc` code 0, Frontend `tsc && vite build` code 0

---

## 1. P0 — Quotation-to-Bill Transaction Integrity Refactor

### Problem Identified
Previously, converting a quotation locked the quotation row via `SELECT ... FOR UPDATE` inside a database transaction, but delegated the bill creation to `normalBillsService.createBill()` or `gstInvoicesService.createInvoice()`. Both of those methods acquired their own separate database connections and managed their own transactions (`BEGIN` ... `COMMIT`). If an error occurred between the bill commit and the quotation commit, or if the outer transaction rolled back, an orphaned official bill was committed while the quotation remained unconverted. Retrying conversion created duplicate bills with incremented bill numbers.

### Remediated Architecture
1. **Transactional Composition Methods**:
   - Implemented `createBillInTransaction(client: PoolClient, input: CreateNormalBillInput): Promise<NormalBillRecord>` in `NormalBillsService`.
   - Implemented `createInvoiceInTransaction(client: PoolClient, input: CreateGstInvoiceInput): Promise<GstInvoiceRecord>` in `GstInvoicesService`.
   - Neither method executes `BEGIN`, `COMMIT`, or `ROLLBACK`, nor do they upload PDFs to R2 or trigger side effects. They perform the sequential number allocation, financial calculations with `decimal.js`, and row insertions on the provided transaction client.
2. **Single Transaction Boundary in `QuotationsService.convertToBill`**:
   - Opens one client transaction: `BEGIN`.
   - Locks quotation with `SELECT * FROM quotations WHERE id = $1 FOR UPDATE`.
   - Validates that `status === 'accepted'` (or allows override if `force === true`), checks calendar expiration (`valid_until`), and verifies GST rate overrides for quotations without GST.
   - Calls `createBillInTransaction` or `createInvoiceInTransaction` inside the exact same transaction.
   - Updates the quotation atomically:
     ```sql
     UPDATE quotations
     SET status = 'converted',
         converted_normal_bill_id = $1,
         converted_gst_invoice_id = $2,
         updated_at = NOW()
     WHERE id = $3 AND status <> 'converted'
     ```
   - Commits: `COMMIT`.
   - Post-commit triggers non-blocking PDF generation and storage asynchronously in the background.

---

## 2. P1 — Financial Calculations, Schema Preservation & Migration 017

### Problem Identified
When converting quotations with fixed or percentage discounts to Normal Bills or GST Invoices, discount information was dropped because `normal_bills` and `gst_invoices` tables lacked columns for subtotal, discount type, discount value, and discount amount. In addition, PDF rendering did not reflect discount breakdowns on converted bills.

### Remediated Architecture
1. **Additive Database Migration `017_quotation_conversion_financial_fields.sql`**:
   - `normal_bills`: added `subtotal_amount NUMERIC(12,2)`, `discount_type VARCHAR(16)`, `discount_value NUMERIC(12,2)`, `discount_amount NUMERIC(12,2)`.
   - `gst_invoices`: added `subtotal_amount NUMERIC(12,2)`, `discount_type VARCHAR(16)`, `discount_value NUMERIC(12,2)`, `discount_amount NUMERIC(12,2)`.
   - `quotations`: added `customer_state VARCHAR(64)`, `customer_state_code VARCHAR(4)`.
   - `quotation_settings`: updated default support phone number to `9129654160`.
   - Registered `017_quotation_conversion_financial_fields.sql` into `EXPECTED_MIGRATIONS` across database configuration and security tests.
2. **Strict Financial Calculations**:
   - Subtotal is computed as `sum(quantity * rate)` using `Decimal.js` with `ROUND_HALF_UP`.
   - Discount amount is calculated accurately (percentage discount: `subtotal * (discountValue / 100)`; fixed discount: capped at subtotal).
   - In GST Invoices: `taxableAmount = subtotal - discountAmount`. GST taxes (CGST/SGST or IGST) are calculated on `taxableAmount`.
   - In Normal Bills: `totalAmount = subtotal - discountAmount`.
3. **PDF Generation Preserves Subtotal & Discount**:
   - Updated `gstInvoices.pdf.ts` to include Subtotal, Discount (with rate/type), and Taxable Amount in the bill total breakdown.
   - Updated `quotations.pdf.ts` to support dynamic company name, signatory title, and logo URL.

---

## 3. P1 — CSRF Blob Handling & Frontend API Client

### Problem Identified
Endpoints returning binary PDF streams (such as `/api/v1/quotations/preview-pdf` and `/api/v1/quotations/:id/pdf`) bypassed the standard `apiClient` to handle `res.blob()`. As a result, requests lacked CSRF protection headers (`X-CSRF-Token`), credentials were inconsistent, and token renewal on 403/401 was not handled.

### Remediated Architecture
1. **`apiClientBlob` in `frontend/src/lib/apiClient.ts`**:
   - Automatically injects `X-CSRF-Token` headers and `credentials: 'include'`.
   - Intercepts 403 `CSRF_TOKEN_INVALID` and attempts a transparent CSRF token refresh before retrying the blob request.
   - Throws structured errors with response body error messages when HTTP status is not ok.
2. **Quotation API & Preview**:
   - Updated `previewQuotationPdf` and `fetchSavedQuotationPdfBlob` in `quotationApi.ts` to use `apiClientBlob`.
   - Proper revocation of `URL.createObjectURL` object URLs inside `useEffect` cleanup in `QuotationPreview.tsx`.

---

## 4. P1 — Hardware Barcode Scanner Testing & Stream Lifecycle

### Problem Identified
The hardware barcode scanner test suite (`barcodeScanner.test.ts`) used artificial mocks that bypassed the actual React hook. In addition, the camera barcode scanner modal had race conditions where closing the modal did not promptly stop MediaStream tracks if the torch state changed.

### Remediated Architecture
1. **Real React Hook Integration Tests (`frontend/tests/barcodeScanner.test.ts`)**:
   - Integrated with Happy-DOM and React test container.
   - Tests rapid keystroke dispatching (<50ms intervals) terminating with Enter triggering `onScan`.
   - Tests that active inputs, textareas, and contenteditable elements bypass hardware scanner interception.
   - Tests that slow typing (>100ms between keys) resets the scanner buffer without triggering `onScan`.
   - Tests that disabling the hook removes listeners and short inputs below `minBarcodeLength` are ignored.
2. **Camera Stream Lifecycle**:
   - Fixed `stopCamera` in `BarcodeScannerModal.tsx` to stop all tracks directly on the active stream without depending on mutable torch state.
   - Added camera retry key to safely restart camera initialization without leaking video elements or tracks.

---

## 5. Verification & Test Logs Summary

### Backend Suites (`npm test --workspace=backend`):
```text
 ✓ tests/storage.service.test.ts (17 tests)
 ✓ tests/search.api.test.ts (9 tests)
 ✓ tests/khata.financial.test.ts (23 tests)
 ✓ tests/validators.unit.test.ts (9 tests)
 ✓ tests/migrator.retry.test.ts (7 tests)
 ✓ tests/logout.server-revocation.test.ts (3 tests)
 ✓ tests/session.errors.test.ts (4 tests)
 ✓ tests/session.expiry.test.ts (10 tests)
 ✓ tests/migrator.pool-cleanup.test.ts (3 tests)
 ✓ tests/products.test.ts (14 tests)
 ✓ tests/offlineBills.test.ts (9 tests)
 ✓ tests/products.barcode.test.ts (11 tests)
 ✓ tests/auth.session-concurrency.test.ts (4 tests)
 ✓ tests/pdf.formatting.test.ts (7 tests)
 ✓ tests/normalBills.test.ts (8 tests)
 ✓ tests/quotations.service.test.ts (14 tests)
 ✓ tests/gstInvoices.test.ts (15 tests)
 ✓ tests/auth.security.test.ts (34 tests)

 Test Files  18 passed (18)
      Tests  196 passed (196)
```

### Frontend Suites (`npm run test:frontend`):
```text
 ✓ frontend/tests/serviceWorker.test.ts (4 tests)
 ✓ frontend/tests/themeAccessibility.test.ts (3 tests)
 ✓ frontend/tests/imageCompressor.test.ts (4 tests)
 ✓ frontend/tests/quotations.test.ts (5 tests)
 ✓ frontend/tests/normalBilling.test.ts (3 tests)
 ✓ frontend/tests/apiClient.test.ts (15 tests)
 ✓ frontend/tests/barcodeScanner.test.ts (5 tests)
 ✓ frontend/tests/gstBilling.test.ts (5 tests)
 ✓ frontend/tests/protectedRoute.test.tsx (3 tests)
 ✓ frontend/tests/authProvider.test.tsx (14 tests)

 Test Files  10 passed (10)
      Tests  61 passed (61)
```

### Monorepo Builds:
- Backend: `tsc` succeeded with 0 errors.
- Frontend: `tsc && vite build` succeeded with 0 errors, generating production assets in `dist/`.
