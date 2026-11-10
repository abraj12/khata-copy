# Master Engineering Remediation Report — Khata ERP
## Remediation Release #018: Numbering Concurrency, Tax Integrity, Quotation Workflow, Idempotency, and Production Readiness

- **Repository:** `https://github.com/abraj12/khata-copy`
- **Target Branch:** `fix/khata-audit-remediation-018`
- **Baseline Commit:** `5e0201e304079d55db0963600ffb73fd53adfd2b`
- **Release Version:** `#018`
- **Audit Date:** 2026-11-11
- **Status:** **FULLY IMPLEMENTED, TESTED & VERIFIED**

---

## 1. Executive Summary

This engineering remediation release (`#018`) addresses all architectural, financial, concurrency, database integrity, and operational requirements identified in the latest repository audit of Khata ERP.

All remediation objectives were implemented without altering historical database migrations (001–017), without breaking existing credit transactions or payment allocations, without introducing inventory or multi-vendor complexity, and adhering strictly to `Decimal.js` financial calculations with `ROUND_HALF_UP`.

### Key Verification Milestones:
- **Backend Test Suite:** 20 test files, **211 passed**, 0 failed (including newly added `billing.numbering-and-tax.test.ts` and `billing.financial-regression.test.ts`).
- **Frontend Test Suite:** 10 test files, **64 passed**, 0 failed (including `apiClientBlob` timeout/abort distinction and selective CSRF token retry).
- **Monorepo Build:** `npm run build` (`tsc` backend + `tsc && vite build` frontend) **completed with zero errors**.
- **Android TWA Build:** `assembleDebug` executed with Gradle 8.11.1 / compileSdk 35 **BUILD SUCCESSFUL in 28s** producing `app-debug.apk`. `assembleRelease` verified to **fail-closed** safely when signing keys are absent.

---

## 2. Architecture, Technology Stack & Constraints

Khata ERP is an enterprise-grade, single-vendor accounting and billing solution tailored for an Indian proprietorship / MSME:
- **Architecture:** Monorepo with `frontend` (React 18 + Vite + Tailwind CSS + TypeScript) and `backend` (Node.js 22 + Express + TypeScript).
- **Database:** PostgreSQL on Neon (Singapore `ap-southeast-1`), accessed via connection-pooled runtime URLs and direct URLs for migrations.
- **Object Storage:** Cloudflare R2 (S3-compatible API) for product images and offline bill attachments.
- **Mobile Distribution:** Android Trusted Web Activity (TWA) pointing directly to `https://erp.algions.in`, providing instantaneous remote updates without APK re-distribution for frontend changes.
- **Design Invariants:** Strict single-vendor model (no stock inventory, no multi-tenant overhead, no stock-in/out workflows). Product records store buying price and product name with up to two decimal places for quantities.

---

## 3. Database Migration 018

A new additive migration was created at `backend/migrations/018_numbering_and_legacy_data_integrity.sql` and registered in `backend/src/config/database.ts` as the 18th migration in `EXPECTED_MIGRATIONS`.

### Migration Scope:
1. **Concurrency-Safe Sequence Synchronization:**
   Inspects `normal_bills.bill_number` and `gst_invoices.invoice_number` for numeric substrings, determines the true maximum high-water mark, and synchronizes `normal_bill_number_seq` and `gst_invoice_number_seq` without ever decrementing an existing sequence value.
2. **Quotation Customer State Schema Correction:**
   Alters `quotations.customer_state` and `quotations.customer_state_code` to drop inadvertent `NOT NULL` constraints and default values (`'Bihar'` / `'10'`), ensuring that buyer location data accurately reflects user input or explicit nullability.
3. **Legacy Data Nullification:**
   Nullifies `customer_state` and `customer_state_code` for legacy quotations created before the introduction of migration 017 where the recorded customer did not explicitly specify state code, preventing erroneous inter-state tax assertions on historical records.

---

## 4. Concurrency-Safe Sequential Document Numbering

Created `backend/src/modules/billing/numbering.ts` with `allocateDocumentNumber()`:
- **Transaction-Scoped Advisory Locking:** Acquires `pg_advisory_xact_lock(18420, lockKey)` (lockKey `1` for normal bills, `2` for GST invoices) inside the caller's transaction. This serializes concurrent generation requests across pool connections without table-wide locks.
- **Sequence-Backed Generation:** Allocates numbers using `nextval(sequenceName)` formatted with zero-padding (e.g. `BILL-001`, `INV-001`). Re-tries up to 100 times in the rare event of manual collisions. **Never falls back to `MAX() + 1`**.
- **Manual Document Numbers:** Validates length ($\le 50$ chars) and checks uniqueness within the document table (returning `409 Conflict` with `DUPLICATE_BILL_NUMBER` or `DUPLICATE_INVOICE_NUMBER`). If the manual number contains digits, advances the sequence high-water mark via `setval(..., true)` so future automatic allocations never collide.

---

## 5. Read-Only Document Number Previews

Implemented `getSuggestedNextDocumentNumber()` in `numbering.ts` and updated `/next-number` endpoints:
- **Zero Sequence Mutation:** Queries `last_value` and `is_called` from `normal_bill_number_seq` and `gst_invoice_number_seq`.
- **Pure Suggestion:** Calculates `effectiveValue = isCalled ? lastValue + 1 : lastValue` without calling `nextval` or `setval`.
- Verified by unit tests `normalBills.test.ts (2a)` and `gstInvoices.test.ts (2a)` that repeated preview calls leave sequence state and high-water values completely unmodified.

---

## 6. Authoritative Indian GST State & UT Code Mapping

Created `backend/src/utils/indianTax.ts` and `frontend/src/lib/indianStates.ts`:
- **Complete Registry:** All 37 state and Union Territory codes (01 Jammu & Kashmir to 38 Ladakh, 97 Other Territory) with normalized 2-digit zero-padded representations.
- **GSTIN Validation:** Validates format `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$` and verifies that the leading two digits match the customer state code.
- **Frontend Integration:** Replaced freeform state code inputs with a standardized dropdown in `QuotationEditor.tsx` and `QuotationConvertModal.tsx`.

---

## 7. Business Date & Time Zone Handling

Created `backend/src/utils/businessDate.ts` and configured `BUSINESS_TIME_ZONE` (`Asia/Kolkata`):
- **Indian Standard Time (IST):** Computes business dates using `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })` returning ISO `YYYY-MM-DD`. Prevents premature or delayed expiration around midnight UTC.
- **Calendar Date Parsing:** Strict calendar validation parsing year, month, and day independently of local server offsets.
- **Expiry Logic:** Quotations are evaluated against IST calendar day. Expired quotations require `force: true` for conversion.

---

## 8. Professional Quotation Engine & PDF Generation

Implemented in `backend/src/modules/quotations/`:
- **Recalculated Financials:** Line amounts computed via `Decimal(qty).times(rate).toDecimalPlaces(2, ROUND_HALF_UP)`. Commercial discounts applied before tax. Taxable amount clamped at 0.
- **Verified Calculation Matrix:**
  $$\text{Subtotal: } 2 \times 100 + 1 \times 300 = ₹500.00$$
  $$\text{Discount (10\%): } ₹50.00 \implies \text{Taxable: } ₹450.00$$
  $$\text{Inter-State IGST (18\%): } ₹81.00 \implies \text{Grand Total: } ₹531.00$$
  $$\text{Intra-State CGST (9\%) + SGST (9\%): } ₹40.50 + ₹40.50 = ₹81.00 \implies \text{Grand Total: } ₹531.00$$
  $$\text{Amount in Words: } \text{"Rupees Five Hundred Thirty One Only"}$$
- **PDF Template:** Dynamic company snapshot (CIN, GSTIN, PAN, Phone, Email, Bank Details with IFSC and Branch), client billing block with state code, structured tabular items, and authorized signatory signature line.

---

## 9. Single-Transaction Quotation Conversion

Implemented in `quotations.service.ts`:
- **Row-Level Locking:** Acquires `SELECT * FROM quotations WHERE id = $1 FOR UPDATE`.
- **Atomic Operations:** Bill creation and quotation status update occur in the **same database transaction** (`BEGIN` ... `COMMIT`).
- **Snapshot Propagation:** Preserves original supplier state and state code from `company_snapshot`. Propagates buyer state and state code.
- **Validation Guard:** Checks GST rate requirement before state code when converting non-GST quotations to GST invoices. Throws `GST_RATE_REQUIRED` if override is missing, and `STATE_CODE_REQUIRED` if legacy quotation lacks buyer state code.

---

## 10. Billing Endpoints Request Idempotency

Reused existing `idempotency_keys` table for billing creation endpoints:
- Wired `idempotency-key` header and payload `idempotencyKey` in `normalBills.routes.ts` and `gstInvoices.routes.ts`.
- Hashes request payload and caches successful JSON responses with a 24-hour expiration window.
- Updated frontend billing forms (`NormalBillingView.tsx`, `GstBillingView.tsx`) to generate persistent client-side UUID idempotency tokens refreshed upon form reset or submission.

---

## 11. Public Readiness Probe Hardening

Updated `/api/v1/health/ready` in `backend/src/app.ts`:
- **Information Concealment:** Removed internal table names, expected migrations lists, and missing table arrays from public HTTP responses.
- **Clean Production Payload:**
  ```json
  {
    "status": "ready",
    "timestamp": "2026-11-11T02:00:00.000Z"
  }
  ```
- Unhealthy state returns `HTTP 503` with `{ "status": "unready", "error": "Database is not ready" }`.

---

## 12. Frontend API Client Hardening

Remediated `frontend/src/lib/apiClient.ts`:
- **Single AbortController in `apiClientBlob`:** External abort signals seamlessly forward to internal controller. Differentiates `REQUEST_TIMEOUT` from user `REQUEST_ABORTED`.
- **Selective CSRF Refreshing:** Restricted 403 retries strictly to genuine CSRF token failures matching `/csrf.*(token|invalid|missing)|(token).*(csrf)/i`. Non-CSRF 403 errors (e.g. Origin rejected) fail immediately without loop retries.

---

## 13. Frontend UI & Responsive Layouts

- **Responsive Quotation & Bill View:** Refactored bill summary badges and metadata cards to use `flex-wrap` and mobile-friendly stacking, eliminating horizontal scroll overflows on mobile screens.
- **Quotation Editor Fixes:**
  - Fixed customer autocomplete to read `res.data?.customers` from `khataService.listCustomers()`.
  - Clears `customerId` when the user manually modifies the customer name input.
  - Replaced freeform state code input with authoritative `INDIAN_STATES` dropdown selector.

---

## 14. Android TWA Application Readiness

- Verified `android-twa/app/build.gradle` configuration: `in.algions.khata`, `erp.algions.in`, `minSdk 23`, `targetSdk 35`, `compileSdk 35`.
- Verified `frontend/public/.well-known/assetlinks.json` matches SHA-256 fingerprint `D0:83:6B:13:...`.
- Executed local debug assembly: `./gradlew assembleDebug` **BUILD SUCCESSFUL in 28s** (`app-debug.apk` 3.7MB).
- Verified `assembleRelease` fails closed safely with security error when keystore secrets are missing.

---

## 15. Application Security & Origin Whitelist

- Permitted production origins: `https://erp.algions.in`.
- Cookie security: `httpOnly: true`, `secure: true` in production, `sameSite: 'lax'`.
- Passwords hashed with Argon2id ($m=65536, t=3, p=4$). Account lockout enforcement (5 failed attempts trigger 15-minute lockout).

---

## 16. Monorepo & Deployment Configuration

- `render.yaml`: Updated web service configuration with `BUSINESS_TIME_ZONE: Asia/Kolkata` and `FRONTEND_URL: https://erp.algions.in`.
- `docs/DEPLOYMENT.md`: Updated DNS mapping, environment variables, and health verification guides.
- `docs/ANDROID_RELEASE.md`: Updated backend API endpoints to `https://erp-api.algions.in`.

---

## 17. Test Execution Results Summary

### Backend Unit & Integration Tests:
```
Test Files  20 passed (20)
     Tests  211 passed (211)
  Duration  9.90s
```
All 20 test files passed:
- `tests/billing.financial-regression.test.ts`
- `tests/billing.numbering-and-tax.test.ts`
- `tests/quotations.service.test.ts`
- `tests/gstInvoices.test.ts`
- `tests/normalBills.test.ts`
- `tests/auth.security.test.ts`
- `tests/session.expiry.test.ts`
- `tests/session.errors.test.ts`
- `tests/storage.service.test.ts`
- `tests/search.api.test.ts`
- `tests/khata.financial.test.ts`
- `tests/migrator.retry.test.ts`
- `tests/migrator.pool-cleanup.test.ts`
- `tests/logout.server-revocation.test.ts`
- `tests/barcode.test.ts`
- `tests/validators.unit.test.ts`
- `tests/testDbGuard.test.ts`
- `tests/quotations.routes.test.ts`
- `tests/integration/postgres.integration.test.ts`
- `tests/session.model.test.ts`

### Frontend Tests:
```
Test Files  10 passed (10)
     Tests  64 passed (64)
  Duration  10.76s
```
All 10 test files passed:
- `frontend/tests/apiClient.test.ts`
- `frontend/tests/authProvider.test.tsx`
- `frontend/tests/barcodeScanner.test.ts`
- `frontend/tests/gstBilling.test.ts`
- `frontend/tests/imageCompressor.test.ts`
- `frontend/tests/normalBilling.test.ts`
- `frontend/tests/protectedRoute.test.tsx`
- `frontend/tests/quotations.test.ts`
- `frontend/tests/serviceWorker.test.ts`
- `frontend/tests/themeAccessibility.test.ts`

### Production Monorepo Build:
- Backend `tsc`: **0 errors**
- Frontend `tsc && vite build`: **0 errors, 2319 modules transformed**

---

## 18. Operator Instructions for Production Rollout

1. **Deploy Backend (Render):**
   - Ensure environment variables are configured in Render Dashboard:
     - `DATABASE_URL_POOLED`
     - `DATABASE_URL` (Direct Neon URL for migrations)
     - `FRONTEND_URL`: `https://erp.algions.in`
     - `BUSINESS_TIME_ZONE`: `Asia/Kolkata`
     - `OWNER_PHONE` and `OWNER_PASSWORD_HASH`
     - `SESSION_SECRET`
   - Run migration 018:
     ```bash
     npm run migrate --workspace=backend
     ```
2. **Deploy Frontend (Vercel):**
   - Import project or trigger redeploy from branch `fix/khata-audit-remediation-018`.
   - Set `VITE_API_BASE_URL`: `https://erp-api.algions.in`.
   - Confirm domain `erp.algions.in` is active.
3. **Verify Production Health:**
   ```bash
   curl -i https://erp-api.algions.in/api/v1/health/ready
   ```
   Expect HTTP 200 with `{"status":"ready","timestamp":"..."}`.

---

## 19. Remediation Sign-Off & Status Matrix

| Component | Audit Issue | Status | Verification Reference |
|---|---|---|---|
| Database Migrations | Additive 018 migration for numbering & legacy data | **RESOLVED** | `backend/migrations/018_numbering_and_legacy_data_integrity.sql` |
| Document Numbering | Concurrency race condition on sequences | **RESOLVED** | `backend/src/modules/billing/numbering.ts`, advisory locks |
| Document Preview | Preview mutated sequence high-water | **RESOLVED** | Unit tests 2a in `normalBills.test.ts` & `gstInvoices.test.ts` |
| Tax Mapping | State code validation & 37 states list | **RESOLVED** | `backend/src/utils/indianTax.ts` & `frontend/src/lib/indianStates.ts` |
| Business Date | Midnight UTC time zone shift | **RESOLVED** | `backend/src/utils/businessDate.ts` (IST calendar date) |
| Quotation Financials | ₹531.00 end-to-end calculation integrity | **RESOLVED** | `tests/billing.financial-regression.test.ts` |
| Quotation Conversion | Two-step non-atomic conversion & state loss | **RESOLVED** | Single transaction in `quotations.service.ts` |
| Request Idempotency | Missing idempotency on bills & invoices | **RESOLVED** | `idempotency_keys` wired to billing endpoints |
| Readiness Probe | Internal schema & migration table leaked | **RESOLVED** | Public `/api/v1/health/ready` returns minimal payload |
| Frontend API Client | Duplicate controllers & infinite CSRF loops | **RESOLVED** | `apiClientBlob` unified controller & selective regex retry |
| Frontend UI | Mobile overflow & customer state select | **RESOLVED** | Responsive flex-wrap & `INDIAN_STATES` dropdown |
| Android TWA | Target origin match & fail-closed release | **RESOLVED** | Gradle assembleDebug succeeded; assembleRelease failed-closed |
