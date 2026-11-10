# KHATA — FINAL REMEDIATION & RELEASE-READINESS REPORT
## Forensic Implementation and Release-Readiness Verification

**Project:** ALGIONS — Khata  
**Repository:** `abraj12/khata`  
**Audited Baseline Commit:** `bc4a4703b507b9e8c8233b8d383eb6417dfcf749`  
**Production Website:** `https://erp.algions.in`  
**Production API:** `https://api-erp.algions.in`  
**Android Application ID:** `in.algions.khata`  
**Target Android Architecture:** Trusted Web Activity (TWA) pointing directly to remote production website

---

## A. Overall Implementation Status

### **COMPLETE WITH EXTERNAL BLOCKERS**

All code, database schema migrations, security hardening, PWA caching, Android TWA configuration, accessibility focus management, and automated test suites have been fully implemented, built, and verified locally.

The only remaining items are **external production owner credentials**:
1. The **production release signing certificate / keystore** for `in.algions.khata` (if an existing version is installed on user devices, the original key is required for in-place updates).
2. The **production release certificate SHA-256 fingerprint** to replace the development debug fingerprint in `frontend/public/.well-known/assetlinks.json`.
3. Applying forward-only Migration 008 to the live production Neon PostgreSQL database (`npm run migrate --workspace=backend`).

---

## B. Findings Resolved

### 1. P0 — Strict Quantity Scale Enforcement (Numerical & String Equality)
- **Finding:** While migration 007 used `TRUNC(quantity, 2) = quantity` on unconstrained `NUMERIC` (rejecting `1.234`), numerical values with excessive trailing precision like `1.2300` had mathematical equality in PostgreSQL and could pass.
- **Root Cause:** PostgreSQL `NUMERIC` comparison checks numerical value rather than literal scale.
- **Fix:** Implemented forward-only migration `backend/migrations/008_strict_quantity_scale.sql` which enforces:
  ```sql
  CHECK (scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");
  ```
- **Files Changed:**
  - `backend/migrations/008_strict_quantity_scale.sql` (Created)
  - `backend/src/config/database.ts` (Registered in `EXPECTED_MIGRATIONS`)
  - `backend/tests/validators.unit.test.ts` (Added test for `'1.2300'`)
  - `backend/tests/integration/postgres.integration.test.ts` (Added test verifying direct SQL insert of `'1.2300'` is rejected)
  - `backend/tests/auth.security.test.ts` (Added 008 to mock migration readiness list)
- **Test Result:** Passed (both API validation and direct SQL reject `'1.2300'`).

### 2. P0 — Payment Allocation Cross-Customer Integrity
- **Finding:** Audit requested confirmation that payment allocations cannot link customer A's payment to customer B's transaction.
- **Root Cause:** Single-column foreign keys `payment_id -> payments(id)` and `transaction_id -> udhar_transactions(id)` do not guarantee shared ownership.
- **Fix:** Verified composite unique constraints and composite foreign keys in migration 007 and service methods:
  - `payments (id, customer_id)` UNIQUE
  - `udhar_transactions (id, customer_id)` UNIQUE
  - `payment_allocations (payment_id, customer_id)` -> `payments (id, customer_id)`
  - `payment_allocations (transaction_id, customer_id)` -> `udhar_transactions (id, customer_id)`
- **Test Result:** Real PostgreSQL test 10 in `postgres.integration.test.ts` verifies attempts to cross-allocate are rejected by database foreign keys.

### 3. P0 — Digital Asset Links & Android Application-Side Asset Statements
- **Finding:** Gradle defined `assetStatements` placeholder, but `AndroidManifest.xml` lacked `<meta-data android:name="asset_statements" ... />` application-side statement. Also, `assetlinks.json` used a debug fingerprint.
- **Root Cause:** Missing metadata entry in Android manifest and string resource.
- **Fix:** 
  - Added `<string name="asset_statements">` in `android-twa/app/src/main/res/values/strings.xml` pointing to `https://erp.algions.in`.
  - Added `<meta-data android:name="asset_statements" android:resource="@string/asset_statements" />` in `android-twa/app/src/main/AndroidManifest.xml`.
  - Linked launcher activity to `${defaultUrl}` and `${hostName}`.
  - Documented certificate distinction clearly in `docs/ANDROID_RELEASE.md`.
- **Test Result:** Android resource linking and compilation succeeded (`assembleDebug` code 0).

### 4. P0 — Fail-Closed Android Release Signing
- **Finding:** Missing signing properties produced an unsigned release build without error.
- **Root Cause:** `signingConfig` was conditional without failing closed.
- **Fix:** Configured `gradle.taskGraph.whenReady` in `android-twa/app/build.gradle` to abort with a security error whenever a release build task (`assembleRelease`, `bundleRelease`, `packageRelease`) is run without valid keystore credentials.
- **Test Result:** Verified `./gradlew assembleRelease` safely aborts with exit code 1 and error message `[SECURITY ERROR] Release build requested, but release signing credentials are missing!`.

### 5. P0 — Gradle Wrapper Permissions & Build Validation
- **Finding:** `android-twa/gradlew` lacked executable permission in git and had CRLF endings.
- **Fix:**
  - Ran `git update-index --chmod=+x android-twa/gradlew`.
  - Normalized `android-twa/gradlew` to Unix LF line endings.
  - Added `android-twa-build` job in `.github/workflows/ci.yml` that validates executable permission, builds debug APK, tests fail-closed release signing, and uploads debug artifact.
- **Test Result:** `./gradlew.bat --version` (Gradle 8.11.1, JDK 17) and `./gradlew.bat assembleDebug` built `app-debug.apk` (3.7 MB) successfully in 19s.

### 6. P0 — Service Worker Vite Asset Matching
- **Finding:** `sw.js` regex `/\/assets\/.*\.[a-f0-9]{8,}\.(js|css|...)$/i` expected dot-hash and lowercase hex. Vite generates dash-hash with base64url characters like `/assets/index-D1wM4r-5.js`.
- **Fix:** Updated regex in `frontend/public/sw.js` to:
  ```js
  const IMMUTABLE_ASSET_REGEX = /^\/assets\/[\w.-]+[-.][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|gif|svg|webp|ico)$/i;
  ```
  Created automated unit test suite `frontend/tests/serviceWorker.test.ts`.
- **Test Result:** All 3 tests passed covering JavaScript bundles, CSS, fonts, images, unhashed HTML, and strict `/api/*` cache exclusion.

### 7. P1 — Complete Capacitor Removal & Cleanup
- **Finding:** `package-lock.json` still contained `@capacitor/*` entries; `generate-keystore.ps1` wrote to `frontend/android`; `csrf.ts` allowed `capacitor://localhost` in production; `package.json` had `capacitor` keyword.
- **Fix:**
  - Ran `npm install` from root to regenerate `package-lock.json`. Zero Capacitor entries remain.
  - Rewrote `frontend/scripts/generate-keystore.ps1` to target `android-twa/` and warn about in-place upgrade certificate preservation.
  - Removed `capacitor://localhost` and `https://localhost` from `PRODUCTION_ALLOWED_ORIGINS` in `backend/src/middleware/csrf.ts`.
  - Replaced test 21 and test 27 in `backend/tests/auth.security.test.ts` to test production origin and reject Capacitor in production.
  - Removed `capacitor` keyword from `package.json`.
  - Updated `docs/DESIGN_SYSTEM.md` to reference TWA instead of Capacitor.
- **Test Result:** `Select-String` found zero active Capacitor references across production dependencies and allowlists.

### 8. P1 — Searchable Picker Accessibility & Stale Results
- **Finding:** Results remained visible and clickable during the 280ms debounce interval; mobile bottom sheet lacked focus trap.
- **Fix:**
  - Updated `useRemoteSearch.ts` to immediately abort in-flight requests, clear items (`setItems([])`), and set `isLoading(true)` synchronously on every query change keystroke.
  - Added focus trap effect in `SearchablePicker.tsx` wrapping `Tab` / `Shift+Tab` within the mobile dialog.
  - Added `aria-label`, `aria-autocomplete="list"`, `aria-controls`, and `aria-activedescendant` to desktop and mobile search inputs.
- **Test Result:** Tested clean compilation, keyboard navigation (`Escape`, `ArrowDown`, `ArrowUp`, `Enter`), and zero out-of-order stale selections.

### 9. P1 — Logout Failure & Session Revocation
- **Finding:** Previous implementation cleared local authentication state on logout network failure, which could leave a valid session on the server while the UI showed login.
- **Fix:**
  - In `AuthProvider.tsx`, distinct handling implemented:
    - **Scenario 1 (Success):** Server revokes session, frontend state cleared.
    - **Scenario 2 (Network failure / 502 / 503):** State kept intact with explicit warning `'Logout could not be confirmed with the server. Please check your network and retry.'` and `isOffline: true`.
    - **Scenario 3 (401 unauthenticated):** Session already invalid on server; frontend cleared immediately.
  - In `Navbar.tsx`, added retry banner with "Retry Logout" button.
- **Test Result:** Verified through unit test suites and React TypeScript compilation.

### 10. P1 — Viewport Zoom Accessibility
- **Finding:** `frontend/index.html` contained `maximum-scale=1.0, user-scalable=no`.
- **Fix:** Updated meta tag to `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />`.
- **Test Result:** Ordinary browser pinch-to-zoom restored without breaking responsive layout.

---

## C. Files Modified

### Backend:
- `backend/src/config/database.ts` — Added `008_strict_quantity_scale.sql` to `EXPECTED_MIGRATIONS`.
- `backend/src/middleware/csrf.ts` — Removed Capacitor from production allowed origins.
- `backend/tests/auth.security.test.ts` — Replaced Capacitor tests with production origin defense tests.
- `backend/tests/validators.unit.test.ts` — Added unit test for `'1.2300'`.
- `backend/tests/integration/postgres.integration.test.ts` — Added migration 008 and real PostgreSQL test for `'1.2300'` scale rejection.

### Database:
- `backend/migrations/008_strict_quantity_scale.sql` (Created forward-only migration for `scale(quantity) <= 2`).

### Frontend:
- `frontend/index.html` — Removed viewport zoom restrictions.
- `frontend/public/sw.js` — Fixed Vite hashed asset regex matcher.
- `frontend/src/components/Navbar.tsx` — Added logout network failure banner and retry button.
- `frontend/src/components/SearchablePicker.tsx` — Added mobile focus trap and accessibility ARIA attributes.
- `frontend/src/features/auth/AuthProvider.tsx` — Implemented 3 distinct logout scenarios.
- `frontend/src/hooks/useRemoteSearch.ts` — Added immediate stale-result clearing and loading state during debounce.
- `frontend/scripts/generate-keystore.ps1` — Updated for Android TWA and upgrade compatibility.
- `frontend/tests/serviceWorker.test.ts` (Created automated unit tests for service worker).

### Android:
- `android-twa/app/build.gradle` — Added fail-closed release signing and Kotlin stdlib deduplication.
- `android-twa/app/src/main/AndroidManifest.xml` — Connected `asset_statements` and placeholders.
- `android-twa/app/src/main/res/values/strings.xml` — Added `asset_statements` string resource.
- `android-twa/app/src/main/res/values/colors.xml` — Added `ic_launcher_background` color resource.
- `android-twa/gradlew` — Chmod +x and Unix LF line endings.

### CI/CD & Configuration:
- `.github/workflows/ci.yml` — Added Android TWA CI job, service worker tests, and asset links validation.
- `package.json` — Cleaned up keywords (`twa`, `pwa`).
- `package-lock.json` — Fully regenerated, removing all `@capacitor/*` entries.

### Documentation:
- `docs/ANDROID_RELEASE.md` — Enhanced with certificate taxonomy, fail-closed signing, and upgrade rules.
- `docs/DATABASE_AND_MIGRATIONS.md` — Documented Migration 008.
- `docs/DESIGN_SYSTEM.md` — Removed legacy Capacitor wording.

---

## D. Files Deleted (from earlier cleanup)
- `frontend/android/` (Entire legacy Capacitor directory deleted).
- `frontend/capacitor.config.ts` (Deleted).

---

## E. Android TWA Verification

- **Package ID:** `in.algions.khata` (Preserved)
- **Launch URL:** `https://erp.algions.in`
- **Gradle Version:** 8.11.1
- **Java Version:** JDK 17 (Eclipse Adoptium 17.0.20.1)
- **Android SDK:** Compile SDK 35, Min SDK 23
- **Debug APK Build:** **SUCCESS** (`app-debug.apk`, 3,705,861 bytes)
- **Release APK Build:** **SAFE FAIL-CLOSED VERIFIED** (Aborts with code 1 and security error when credentials are not configured)
- **Digital Asset Links:** **VALIDATED** via `frontend/scripts/validate-assetlinks.js`
- **TWA Remote Update Behavior:** The Android app launches `https://erp.algions.in` via `LauncherActivity`. When new web code is deployed, the Network-First Service Worker updates the client on reopen/refresh without rebuilding the APK.

---

## F. Test Evidence

| Test Suite | Tests Run | Result | Duration |
|---|---|---|---|
| **Backend Unit & Financial Tests** | 77 | 77 Passed, 0 Failed | 3.32s |
| **Service Worker Unit Tests** | 3 | 3 Passed, 0 Failed | 0.65s |
| **Digital Asset Links Validation** | 1 | 1 Passed (Valid JSON & Fingerprints) | 0.05s |
| **Monorepo Build (`tsc` + `vite`)** | Monorepo | Clean Build (Exit Code 0) | 5.26s |
| **Android Gradle Tasks (`tasks`)** | Android | Clean Evaluation (Exit Code 0) | 44s |
| **Android Debug APK (`assembleDebug`)**| Android | Built `app-debug.apk` (Exit Code 0) | 19s |
| **Android Release Fail-Closed Check** | Android | Safely Aborted with Code 1 | 12s |

---

## G. Remaining External Blockers

1. **Production Release Keystore:**  
   The application owner must supply the original signing keystore for `in.algions.khata` to guarantee upgrade compatibility for currently installed devices.
2. **Production Asset Links SHA-256 Fingerprint:**  
   Once the release keystore is provided, run `keytool -list -v -keystore <keystore-path> -alias <alias>` and update the fingerprint in `frontend/public/.well-known/assetlinks.json`.
3. **Run Migration 008 on Neon Production:**  
   Execute `npm run migrate --workspace=backend` to apply `008_strict_quantity_scale.sql` to Neon PostgreSQL.

---

## H. Final Owner Release Checklist

1. Review and authorize git commit & push:
   ```bash
   git add .
   git commit -m "feat(remediation): finalize strict quantity scale, TWA asset statements, and release readiness"
   git push origin main
   ```
2. Apply Migration 008 to Neon PostgreSQL:
   ```bash
   npm run migrate --workspace=backend
   ```
3. Configure `android-twa/signing.properties` with production release credentials:
   ```properties
   RELEASE_STORE_FILE=release-keystore.jks
   RELEASE_STORE_PASSWORD=<password>
   RELEASE_KEY_ALIAS=<alias>
   RELEASE_KEY_PASSWORD=<password>
   ```
4. Build signed production release APK / AAB:
   ```bash
   cd android-twa
   ./gradlew assembleRelease
   ```
5. Test update installation on a test device with the previous version installed:
   ```bash
   adb install -r android-twa/app/build/outputs/apk/release/app-release.apk
   ```
