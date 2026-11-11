# Khata ERP — Release #026 Engineering Remediation Report
## Production Hardening, Financial Integrity, PDF Pagination, WebP Export, Performance & Reliability

- **Repository:** `https://github.com/abraj12/khata-copy`
- **Base Branch & Audited Commit:** `main` at `310f9c840d17f1393c33872ad787d7dbd7ab3e6a`
- **Feature Branch:** `fix/release-026-production-hardening`
- **Safety Boundaries Preserved:** Zero edits to historical migrations `001_*`–`025_*`; zero direct mutations to production Neon PostgreSQL, Render, frontend hosting, Cloudflare R2, or `main`.

---

## 1. Executive Summary of Remediated Defects

1. **Multi-Page PDFKit Rendering, Anti-Truncation & Page Numbering (`backend/src/utils/pdfLayout.ts`, `quotations.pdf.ts`, `gstInvoices.pdf.ts`):**
   - Extracted shared PDFKit helpers in `backend/src/utils/pdfLayout.ts` (`numberToIndianWords()`, `formatIndianMoney()`, `formatDecimalQty()`, `formatDateToIndian()`, `splitTextBlockToHeight()`, `stampPageNumbers()`).
   - Eliminated single-page crowding and truncation across quotations, GST tax invoices, and normal bills:
     - Dynamically splits oversized single-item descriptions (`1,600+` chars tested) across page boundaries using `splitTextBlockToHeight()` instead of clipping.
     - Removed previous short caps on quotation terms & conditions (`18+` lines tested cleanly across continuation pages) and raised invoice/bill line-item cap from `20` to **`100`** (`MAX_BILL_LINE_ITEMS = 100`, `.max(100)` backend schemas), verified with `1`, `15`, `20`, `25`, `32`, and `35` item PDF renders via `pdfjs-dist/legacy/build/pdf.mjs` without blank trailing pages.
     - Stamped `Page X of Y` and footer captions using `lineBreak: false` inside `stampPageNumbers()` so footers never inject blank overflow pages.
   - Normalized `POST /api/v1/quotations/preview-pdf` and `GET /api/v1/quotations/:id/pdf` (`quotations.routes.ts`, `quotationApi.ts`) returning binary `%PDF-` buffers cleanly.

2. **Configurable Company Jurisdiction (`026_company_jurisdiction.sql`):**
   - Added additive migration `backend/migrations/026_company_jurisdiction.sql` (`ALTER TABLE quotation_settings ADD COLUMN IF NOT EXISTS jurisdiction VARCHAR(200)`), registered in `EXPECTED_MIGRATIONS` (`backend/src/config/database.ts`).
   - Added optional `COMPANY_JURISDICTION` (`1..200` chars) env fallback (`backend/src/config/env.ts`).
   - Removed hardcoded `'Gopalganj Jurisdiction only'` across `companyTaxProfile.service.ts` (`row.jurisdiction?.trim() || env.COMPANY_JURISDICTION?.trim() || null`), PDF renderers, `QuotationsView.tsx` settings UI (`Jurisdiction Caption`), `GstBillingView.tsx`, `NormalBillingView.tsx`, and `MannatTaxInvoice.tsx` (falling back safely to `'Subject to seller jurisdiction.'` when unset).

3. **Financial Mapping Reconciliation & Tax Display Mutual Exclusion (`MannatTaxInvoice.tsx`, `gstInvoicesApi.ts`, `normalBillsApi.ts`):**
   - Fixed `mapNormalBillToInvoiceProps()` bug where `subtotal` previously received `record.total_amount` rather than pre-discount `record.subtotal_amount` (reconciling fixed/percentage discounts cleanly, e.g. `₹5,310.00` subtotal - `₹531.00` discount = `₹4,779.00` total).
   - Preserved optional `subtotal_amount`, `discount_type`, `discount_value`, and `discount_amount` fields cleanly across `GstInvoiceRecord` and `NormalBillRecord`.
   - Enforced Decimal.js math throughout `MannatTaxInvoice.tsx` summary rows and Indian currency words (`numberWords`), plus mutual exclusion between Intra-state (`CGST` + `SGST`) and Inter-state (`IGST`) tax rows.

4. **Post-Commit R2 Storage Resilience & Retry-PDF Recovery (`gstInvoices`, `normalBills`, `storage.service.ts`):**
   - Preserved committed invoice/bill records with `r2_object_key = null` when background/post-commit Cloudflare R2 upload fails, exposing explicit `POST /api/v1/gst-invoices/:id/retry-pdf` (`retryInvoicePdf`) and `POST /api/v1/normal-bills/:id/retry-pdf` (`retryBillPdf`) endpoints.
   - Wired `'R2 Failed'` status visibility, retry state (`retryingPdfId` / `handleRetryPdf`), and `Retry` action directly into `GstBillingView.tsx` and `NormalBillingView.tsx` history and confirmation UI.
   - Hardened `StorageService` (`backend/src/services/storage.service.ts`): per-folder byte limits (`MAX_PRODUCT_IMAGE_BYTES = 5 MB`, `MAX_OFFLINE_BILL_BYTES = 10 MB`, `MAX_SUPPLIER_DOC_BYTES = 10 MB`), `assertSafeScopedObjectKey` path traversal/cross-folder rejection before SDK calls, `DeleteObjectCommand` cleanup on every `verifyObject` failure path, and `ContentType` binding in presigned `PutObjectCommand` requests.

5. **PDF.js Quotation Viewer, WebP Multi-Page Export & Deferred Blob Revocation:**
   - Rewrote `frontend/src/features/quotations/QuotationPreview.tsx` to replace `<iframe src="blob:...">` with lazy-loaded `pdfjs-dist` (`loadPdfJs()`) per-page canvas rendering, scroll-tracked `Page X of Y`, zoom in/out/fit-width controls, `ResizeObserver`, `AbortController`, `Retry` recovery on fetch failure, and unmount/close cleanup (`pdfDoc.cleanup()`, `loadingTask.destroy()`).
   - Added `frontend/src/utils/pdfImageExporter.ts` and `frontend/src/components/PdfImageExportModal.tsx` to render multi-page PDFs to compressed WebP images (`${safeBase}_page_01.webp`, falling back to PNG only if browser lacks WebP canvas encoding), release intermediate canvases (`width = 0; height = 0`), revoke preview object URLs cleanly, and share via `navigator.share({ files })` or fall back to individual downloads across Quotations, GST Invoices, and Normal Bills.
   - Created `frontend/src/utils/blobDownload.ts` (`downloadBlobSafely()` deferring `URL.revokeObjectURL()` by `60,000 ms`) and `frontend/src/lib/pdfFetch.ts` (`fetchAuthorizedBlob()`, `fetchPostPdfBlob()` with CSRF retry), replacing synchronous revocations across `QuotationPreview.tsx`, `QuotationsView.tsx`, `gstInvoicesApi.ts`, `normalBillsApi.ts`, `PurchaseBillsView.tsx`, and `suppliersApi.ts`.

6. **Quotation Cross-Field Date Validation & `draftKey` Autocomplete Concurrency (`QuotationEditor.tsx`, `quotations.validation.ts`):**
   - Added backend `.superRefine` validation rejecting `validUntil < quotationDate` with HTTP `400` in `createQuotationSchema`.
   - Added client-side date synchronization (`isValidUntilManuallyEdited`), inline `[role="alert"]` validation, `min={quotationDate}`, and disabled Save/Preview controls when dates invert; introduced stable `DraftQuotationItem.draftKey` keys with 250ms debounced `AbortController` per-row product searches and customer-search abort cleanup on clear/delete/unmount while stripping `draftKey` in `buildPayload()`.

7. **Frontend Lazy Vendor Bundle Optimization (`frontend/vite.config.ts`):**
   - Isolated `pdfjs-dist` into lazy chunk `pdfjs-vendor` (`501.31 kB` raw / `149.92 kB` gzip) and bundled worker (`pdf.worker.min.mjs`, `1,271.92 kB`) so initial landing boot in `frontend/dist/index.html` preloads only `index` (`108.32 kB` / `25.50 kB` gz), `react-vendor` (`223.22 kB` / `69.24 kB` gz), `icons-vendor` (`42.08 kB` / `8.85 kB` gz), and `math-vendor` (`32.22 kB` / `12.98 kB` gz) — total `~405.83 kB` raw / `116.57 kB` gzip.

---

## 2. Verification Matrix (Post-Code-Edit Observed Results)

| Check | Command / Environment | Observed Output | Status |
|---|---|---|---|
| **Backend Build** | `npm run build:backend` (`tsc`) | Exited `0` with zero TypeScript errors | **PASS** |
| **Frontend Build & Bundle** | `npm run build:frontend` (`tsc && vite build`) | Exited `0` (`2353` modules transformed in `24.52s`); `pdfjs-vendor` & `@zxing` split from `index.html` preloads | **PASS** |
| **Backend Unit & PDF/R2 Suite** | `npm test --workspace=backend` | **`24` test files passed**, **`278` tests passed**, `0` failed, `0` skipped (`15.75s`), incl. `release026.remediation.test.ts` (`15` tests), `gstInvoices.test.ts`, `normalBills.test.ts`, `auth.security.test.ts` (`34` tests) | **PASS** |
| **Frontend DOM & Component Suite** | `npm run test:frontend` (`vitest run frontend/tests`) | **`14` test files passed**, **`113` tests passed**, `0` failed, `0` skipped (`35.87s`), incl. `release026.frontend.test.ts` (`7` tests), `gstBilling.test.ts` (`7` tests, 100-item stress pass), `normalBilling.test.ts` (`5` tests, 100-item stress pass), `quotations.test.ts` (`7` tests) | **PASS** |
| **Real PostgreSQL 18 Migrations (`001`–`026`)** | `npm run migrate -- "postgresql://postgres@localhost:55432/khata_mig_test"` | Exited `0`; `[MIGRATION COMPLETE] Successfully applied 26 pending migration(s).` | **PASS** |
| **Real PostgreSQL 18 Integration Suite** | `npm run test:integration --workspace=backend` (`khata_integration_test`) | **`1` file passed**, **`33` tests passed**, `0` failed, `0` skipped (`14.03s`), incl. **`Test 33`** (`026_company_jurisdiction.sql` schema, `getCompanyTaxProfile` jurisdiction set/blank reset, 25-item GST invoice & ₹531 discount Normal Bill) | **PASS** |
| **TWA Digital Asset Links Check** | `node frontend/scripts/validate-assetlinks.js` | Exited `0` (`in.algions.khata` SHA-256 fingerprints valid) | **PASS** |
| **Android TWA Debug & Signed Release Guard** | `android-twa\gradlew.bat assembleDebug --no-daemon` / `assembleRelease --no-daemon` | `assembleDebug` exited `0` (`BUILD SUCCESSFUL in 25s`); unsigned `assembleRelease` failed closed with exit `1` (`[SECURITY ERROR] Release build requested, but release signing credentials are missing!`) | **PASS** |
| **Migration Immutability & Whitespace Check** | `git diff --name-only origin/main -- backend/migrations/` & `git diff --check` | Zero diffs on `001`–`025`; `git diff --check` exited `0` | **PASS** |
| **Local PostgreSQL Cleanup** | `pg_ctl.exe stop -m fast` + `pg_isready.exe -h 127.0.0.1 -p 55432` | `127.0.0.1:55432 - no response` (`PG_ISREADY_EXIT=2`) | **PASS** |

*Note on Image Compression Test:* `compressImageFile` verification in `frontend/tests/release026.frontend.test.ts` validates downscaling (`4000x3000 -> 1200x900 -> 900x675`) and multi-pass `maxSizeBytes` enforcement via mocked `HTMLCanvasElement` / `toBlob` callbacks inside `happy-dom` (real hardware camera GPU encoding bytes vary by browser codec).

---

## 3. Changed Files Inventory

- **Database Migration & Backend Config:**
  - `backend/migrations/026_company_jurisdiction.sql` (new)
  - `backend/src/config/database.ts`
  - `backend/src/config/env.ts`
- **Backend Services, Utilities, Routes & PDF Engines:**
  - `backend/src/utils/pdfLayout.ts` (new)
  - `backend/src/services/companyTaxProfile.service.ts`
  - `backend/src/services/storage.service.ts`
  - `backend/src/modules/quotations/quotations.pdf.ts`
  - `backend/src/modules/quotations/quotations.routes.ts`
  - `backend/src/modules/quotations/quotations.service.ts`
  - `backend/src/modules/quotations/quotations.validation.ts`
  - `backend/src/modules/gstInvoices/gstInvoices.pdf.ts`
  - `backend/src/modules/gstInvoices/gstInvoices.routes.ts`
  - `backend/src/modules/gstInvoices/gstInvoices.service.ts`
  - `backend/src/modules/normalBills/normalBills.routes.ts`
  - `backend/src/modules/normalBills/normalBills.service.ts`
- **Frontend Core, Utilities, PDF Viewer & Feature Modules:**
  - `frontend/package.json` & root `package-lock.json`
  - `frontend/vite.config.ts`
  - `frontend/src/lib/pdfFetch.ts` (new)
  - `frontend/src/utils/blobDownload.ts` (new)
  - `frontend/src/utils/pdfImageExporter.ts` (new)
  - `frontend/src/utils/billingLimits.ts`
  - `frontend/src/components/PdfImageExportModal.tsx` (new)
  - `frontend/src/components/MannatTaxInvoice/MannatTaxInvoice.tsx`
  - `frontend/src/features/bills/gstInvoicesApi.ts`
  - `frontend/src/features/bills/normalBillsApi.ts`
  - `frontend/src/features/bills/GstBillingView.tsx`
  - `frontend/src/features/bills/NormalBillingView.tsx`
  - `frontend/src/features/quotations/quotation.types.ts`
  - `frontend/src/features/quotations/quotationApi.ts`
  - `frontend/src/features/quotations/QuotationEditor.tsx`
  - `frontend/src/features/quotations/QuotationPreview.tsx`
  - `frontend/src/features/quotations/QuotationsView.tsx`
  - `frontend/src/features/suppliers/PurchaseBillsView.tsx`
  - `frontend/src/features/suppliers/suppliersApi.ts`
- **Automated Tests & Documentation:**
  - `backend/tests/release026.remediation.test.ts` (new)
  - `backend/tests/auth.security.test.ts`
  - `backend/tests/gstInvoices.test.ts`
  - `backend/tests/normalBills.test.ts`
  - `backend/tests/integration/postgres.integration.test.ts`
  - `frontend/tests/release026.frontend.test.ts` (new)
  - `frontend/tests/gstBilling.test.ts`
  - `frontend/tests/normalBilling.test.ts`
  - `docs/RELEASE_026_REMEDIATION_REPORT.md` (new)

---

## 4. Rollout Notes

1. Run `npm run migrate --workspace=backend` against production PostgreSQL before rolling out backend/frontend builds so `026_company_jurisdiction.sql` is applied prior to readiness probes (`checkDatabaseReadiness()`).
2. Optionally set `COMPANY_JURISDICTION` in backend environment variables or update **Jurisdiction Caption** in Quotation Company Settings via the UI.
