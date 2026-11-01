# Remediation Baseline & Implementation Inventory

**Original Baseline Commit:** `e7d0421f3463f977e30bd5fb61717e4c079d676d`  
**Current Active Branch:** `main`  
**Remote URL:** `https://github.com/abraj12/khata.git`  
**Node.js Runtime:** `v22.18.0`  
**npm Package Manager:** `v10.x` / `v11.x`  
**Active Test Suites:** 5 suites / 77 passing tests  
**Production Endpoints:**
- Website: `https://khata.algions.in`
- Backend API: `https://api-khata.algions.in`
- Android Application ID: `in.algions.khata`

---

## 1. Evolution and State Distinctions

### 1.1 Original Baseline State (`e7d0421`)
- Introduced initial 2-decimal-place quantity policy at API layer and migration 006.
- 5 test files, 72 passing tests.
- Still utilized Capacitor with bundled frontend web assets inside `frontend/android`.
- PostgreSQL column `udhar_items.quantity` declared as `NUMERIC(12,2)` (subject to silent rounding on raw SQL inputs).
- `payment_allocations` lacked database-level composite foreign key enforcement across customers.
- `loginAttemptStore.ts` connection acquisition located outside `try/catch`.

### 1.2 Final Implementation State
1. **Database Correctness:**
   - Migration 007 (`007_quantity_strict_scale_and_allocation_integrity.sql`) applied.
   - Column `udhar_items.quantity` converted to unconstrained `NUMERIC` with `TRUNC(quantity, 2) = quantity` check (guaranteeing immediate SQL rejection of inputs with >2 decimal places such as `1.234`).
   - Composite foreign keys on `payment_allocations (payment_id, customer_id)` and `(transaction_id, customer_id)` guaranteeing cross-customer allocation is impossible at schema level.
   - Idempotency key duplicate uniqueness violations caught and resolved with saved responses rather than generic 500 errors.
   - Typed application error structure (`AppError`) implemented returning 400, 401, 403, 404, 409 status codes.
   - Login attempt store background cleanup connection acquisition wrapped inside error handling with safe 5-minute retry cooldown.
2. **Frontend Reliability & Accessibility:**
   - Auth state differentiated between 401 (actual logout) and 502/503/network outage (temporary connection issue with retry).
   - Stale search results eliminated using monotonic request IDs and `AbortController` in `ProductsView.tsx`, `KhataLedgerView.tsx`, and `useRemoteSearch.ts`.
   - CSS background gradient rendering bug corrected (`background: var(--khata-surface-raised)`).
   - Modal focus trapping, Escape key listener, and focus restoration implemented.
3. **Android TWA Migration:**
   - Progressive Web App implemented: `manifest.webmanifest`, `sw.js` (network-first for navigation), 192x192, 512x512, and maskable icons.
   - Digital Asset Links configured at `frontend/public/.well-known/assetlinks.json` with validator script `frontend/scripts/validate-assetlinks.js`.
   - Native Android TWA project created in `android-twa/` using `androidbrowserhelper:2.5.0` with application ID `in.algions.khata`.
   - Obsolete Capacitor dependencies (`@capacitor/*`), `capacitor.config.ts`, and legacy bundled directory `frontend/android` safely retired.
4. **Testing Suite:**
   - 77 automated tests passing cleanly across unit, financial, security, search, and database guard suites.
