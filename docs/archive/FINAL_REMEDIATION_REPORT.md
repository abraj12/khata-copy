> [!NOTE] SUPERSEDED — NOT CURRENT OPERATING INSTRUCTIONS
> This document is an archived historical report/prompt preserved for audit trail purposes.
> Refer to the canonical documentation in docs/ and README.md for current operational instructions.

# Khata Application — Final Remediation Report

**Date:** 2026-11-01  
**Repository:** `https://github.com/abraj12/khata.git`  
**Branch:** `fix/khata-final-correctness-remediation`  
**Monorepo Path:** `C:\Users\rajab\OneDrive\Desktop\khata`  
**Node Version:** `v22.18.0` | **npm Version:** `11.5.2` | **Vitest:** `v2.1.9`  

---

## A. Executive Status

**`CODE COMPLETE — LIVE VERIFICATION PENDING`**

- **Code & Correctness Gates:** All P0 and P1 findings from `KHATA_FINAL_REMEDIATION_PROMPT.md` have been fixed with executable evidence.
- **Automated Tests:** 33 / 33 automated tests passing cleanly across both test suites (11 financial & decimal tests, 22 auth & application security tests).
- **Builds:** TypeScript and Vite production builds complete with 0 errors.
- **Live Cloud / Hardware Status:** Live Neon database operations and physical Android device tests remain explicitly pending owner credentials rotation and device connection.

---

## B. Findings Fixed

### 1. Dashboard Outstanding Aggregate Fan-Out (P0)
- **Files Changed:** `backend/src/modules/khata/khata.service.ts` (`getSummary()`, `listCustomers()`, `getCustomerDetail()`)
- **Fix:** Eliminated the multi-table join that repeated parent `t.total_amount` rows once per allocation. Replaced with independent pre-aggregation CTEs (`transaction_totals`, `allocation_totals`, `payment_totals`).
- **Regression Test:** `7. Multi-Allocation Dashboard Regression: Single transaction with 2 separate payments does not inflate total outstanding`
- **Result:** PASSED (Outstanding: ₹800.00, Received: ₹200.00 on a ₹1,000 transaction with two ₹100 payments).

### 2. Hardcoded Production Secrets and Fallback Credentials (P0)
- **Files Changed:** `backend/src/config/env.ts`, `.env.example`
- **Fix:** In `NODE_ENV=production`, all defaults are rejected. Startup fails closed if `OWNER_PHONE`, `OWNER_PASSWORD_HASH`, `DATABASE_URL_POOLED`, `DATABASE_URL`, or `SESSION_SECRET` are missing, empty, or contain dummy/default placeholder values. Made Realtime credentials optional while Realtime is deferred. Added strict numeric string validation rejecting strings like `15minutes`.
- **Regression Test:** `19. Production startup validation fails closed if SESSION_COOKIE_SECURE is false`, `28. Production environment startup fails closed on default placeholder SESSION_SECRET`
- **Result:** PASSED.

### 3. Persistent and Fail-Closed Login Attempt Recording (P0)
- **Files Changed:** `backend/src/modules/auth/auth.controller.ts`, `backend/src/modules/auth/loginAttemptStore.ts`
- **Fix:** Normalized user phone numbers to canonical 10-digit format **before** hashing so `+91 9876543210`, `9876543210`, and `+91-9876543210` hit the exact same lockout bucket. Removed unbounded in-memory array population in production. When inserting a login attempt fails in production, the system throws HTTP 503 instead of silently losing the abuse record.
- **Regression Test:** `26. Phone formats with "+91", spaces, and dashes map to the same account lockout bucket`
- **Result:** PASSED (5th failure locks out 6th attempt regardless of formatting differences).

### 4. Customer Resolution & Duplicate Prevention (P0)
- **Files Changed:** `backend/src/modules/khata/khata.service.ts` (`normalizeName()`, `normalizeCustomerPhone()`, `createTransaction()`)
- **Fix:** Implemented Unicode NFKC whitespace-collapsed canonical name normalization. Safe resolution logic:
  - If phone matches existing customer, reuses that customer.
  - If no phone provided and exact 1 name match exists, safely reuses existing customer.
  - If multiple customers share the same name, rejects with HTTP 409 `AMBIGUOUS_CUSTOMER_MATCH` returning candidate records.
- **Regression Test:** `9. Customer Phone Normalization`, `10. Ambiguous Customer Resolution`
- **Result:** PASSED.

### 5. Exact Decimal Money Arithmetic (P0)
- **Files Changed:** `backend/package.json`, `backend/src/modules/khata/khata.service.ts`
- **Fix:** Installed and integrated `decimal.js`. All money calculations (line totals, transaction totals, initial payments, allocations, balances) are executed using exact decimal arithmetic with half-up rounding to 2 decimal places. Floating-point `Number` and `Math.round(val * 100) / 100` have been eliminated from the financial service.
- **Regression Test:** `11. Decimal Precision: Floating-point edge cases round half-up to deterministic 2-decimal money`
- **Result:** PASSED.

### 6. Transaction Atomicity, FIFO Allocation & Idempotency Protection (P0)
- **Files Changed:** `backend/migrations/003_idempotency_and_hardening.sql`, `backend/src/modules/khata/khata.service.ts`, `backend/src/modules/khata/khata.routes.ts`, `frontend/src/features/khata/KhataLedgerView.tsx`
- **Fix:** Created `idempotency_keys` table. Both `createTransaction` and `recordPayment` accept an `Idempotency-Key` header/parameter. Retrying with identical payload returns the cached result without double-writing; retrying with a different payload returns HTTP 409 Conflict. Locked customer row `FOR UPDATE` during writes.
- **Regression Test:** `8. Idempotency: Retrying create-transaction with same idempotency key returns cached result; differing payload returns 409`
- **Result:** PASSED.

### 7. CSRF/CORS Hardening and Logout Failure Status (P1)
- **Files Changed:** `backend/src/middleware/csrf.ts`, `backend/src/modules/auth/auth.controller.ts`
- **Fix:** In `NODE_ENV=production`, `ALLOWED_ORIGINS` strictly forbids `http://localhost*` and `http://127.0.0.1*`. Only `https://khata.algions.in` and native Capacitor origins (`capacitor://localhost`, `https://localhost`) are permitted. In `logout`, if `req.session.destroy` fails, an HTTP 500 error is returned instead of false success.
- **Regression Test:** `27. Production origin validator rejects http://localhost and dev origins`
- **Result:** PASSED.

---

## C. Files Changed

| File | Purpose |
| :--- | :--- |
| `backend/migrations/003_idempotency_and_hardening.sql` | Migration adding `idempotency_keys` table for network retry deduplication. |
| `backend/package.json` | Added `decimal.js` dependency for arbitrary-precision decimal money arithmetic. |
| `backend/src/config/env.ts` | Strict production validation failing closed on missing/dummy secrets; optional Realtime config. |
| `backend/src/middleware/csrf.ts` | Strict production origin allowlist rejecting localhost; timing-safe CSRF token comparison. |
| `backend/src/modules/auth/auth.controller.ts` | Canonical phone pre-normalization for lockout; fail-closed logout error handling. |
| `backend/src/modules/auth/loginAttemptStore.ts` | Fail-closed DB attempt recording; eliminated unbounded in-memory array in production. |
| `backend/src/modules/khata/khata.service.ts` | Exact decimal arithmetic via `Decimal.js`; CTE-based summary; safe customer resolution; idempotency support. |
| `backend/src/modules/khata/khata.routes.ts` | Idempotency key extraction and propagation for transactions and payments. |
| `backend/scripts/migrate.ts` | Dynamic directory lookup supporting migration execution from both repo root and backend directory. |
| `backend/tests/khata.financial.test.ts` | 11 comprehensive financial, FIFO, idempotency, and decimal precision tests. |
| `backend/tests/auth.security.test.ts` | 22 comprehensive security, lockout canonicalization, origin restriction, and fail-closed tests. |
| `frontend/src/features/khata/KhataLedgerView.tsx` | Attached unique idempotency keys to Udhar creation and payment recording. |
| `.env.example` | Updated template with strict placeholders and documented configuration instructions. |

---

## D. Database Migration Status

- **Migration 001:** `001_auth_tables.sql` (`session`, `login_attempts`, `products`, `customers`, `ledger_entries`)
- **Migration 002:** `002_khata_transactions.sql` (`products.archived_at`, `customers.normalized_phone`, `udhar_transactions`, `udhar_items`, `payments`, `payment_allocations`)
- **Migration 003:** `003_idempotency_and_hardening.sql` (`idempotency_keys`)
- **Local/Unit State:** Verified against SQL unit simulator and transaction boundaries.
- **Live Neon Production Migration:** Pending owner rotation of exposed credentials.

---

## E. Build & Test Evidence

### Monorepo Build Output
```powershell
npm run build
# Backend tsc: 0 errors
# Frontend tsc && vite build: 0 errors (built in 4.67s)
```

### Monorepo Test Output
```powershell
npm test
# Vitest v2.1.9
# tests/khata.financial.test.ts (11 tests) - 22ms
# tests/auth.security.test.ts (22 tests) - 1821ms
# Tests: 33 passed (33)
# Duration: 3.21s
```

---

## F. API and Financial Reconciliation Evidence

Verified through test suite:

```text
Udhar total: ₹3,400.00 (3 Fevicol @ ₹550 = ₹1,650 + 5 PVC Pipe @ ₹350 = ₹1,750)
Initial payment: ₹1,000.00
Due after initial payment: ₹2,400.00
Later payment: ₹500.00
Due after later payment: ₹1,900.00
Final payment: ₹1,900.00
Final due: ₹0.00 (Customer remains visible in ledger with settled status)
```

Multi-Allocation Dashboard Regression:
```text
Transaction Total: ₹1,000.00
Payment 1: ₹100.00
Payment 2: ₹100.00
Dashboard Total Customers: 1
Dashboard Total Outstanding: ₹800.00 (NOT inflated to ₹1,800)
Dashboard Total Received: ₹200.00
```

---

## G. Security Verification

- **Secret Leak Scan:** Verified `dist/assets/index-*.js`: 0 matches for `postgres`, `argon2id`, `SESSION_SECRET`, `KhataOwner`, `neondb_owner`.
- **Argon2id Verification:** Verified against canonical Argon2id hashes with constant-time dummy verification for non-existent users.
- **Fail-Closed Env Validation:** Verified in test 28 that production startup halts if default placeholder secrets are used.
- **Phone Canonicalization:** Verified in test 26 that `+91 9876543210` and `9876543210` share the exact same lockout counter.
- **Origin Rejection:** Verified in test 27 that `http://localhost:5173` is rejected in production.

---

## H. Neon & Deployment Status

- **Architecture:**
  - `https://khata.algions.in` -> Vercel frontend
  - `https://api-khata.algions.in` -> Render backend (Singapore, `plan: free`)
  - Neon PostgreSQL -> Project `shy-mud-94919289`, Region Singapore
- **Realtime Status:** DEFERRED. REST endpoints are the single authoritative source of truth.

---

## I. Android Status

- **Package ID:** `in.algions.khata`
- **Application Name:** `Khata`
- **Local Asset Bundling:** `dist` assets copied directly into native APK via `npx cap sync android`.
- **Debug APK:** Built successfully at `frontend/android/app/build/outputs/apk/debug/app-debug.apk` (4,206,836 bytes, SHA-256: `8134A6194E64BA470EA5CA6F598480F2E164E3A5BD7E801C72D9EA5137123B4A`).
- **Release Signing Safeguard:** Verified that `gradlew assembleRelease` fails closed if `signing.properties` is missing.
- **Physical Device Test:** `NOT TESTED — OWNER DEVICE REQUIRED` (No ADB hardware attached).

---

## J. Remaining Blockers & Next Actions for Owner

1. **Rotate Neon Password:** In the Neon Console for project `shy-mud-94919289`, reset the password for `neondb_owner` and set rotated connection strings in Render's environment settings.
2. **Execute Database Migration on Live Neon:** Run `npm --prefix backend run migrate`.
3. **Generate Android Release Key:** Run `frontend/scripts/generate-keystore.ps1`, configure `frontend/android/signing.properties`, and execute `cd frontend/android; .\gradlew assembleRelease`.
4. **Connect Physical Device:** Run `adb install frontend/android/app/build/outputs/apk/debug/app-debug.apk` to test native session persistence on live Android hardware.
