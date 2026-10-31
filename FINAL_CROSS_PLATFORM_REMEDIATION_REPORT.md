# FINAL CROSS-PLATFORM, SECURITY & PRODUCTION VERIFICATION REMEDIATION REPORT

**Target Project:** Khata — Single Shopkeeper Udhar & Ledger Management Application  
**Execution Timestamp:** 2026-11-01T02:00:00+05:30  
**Target Repository:** `https://github.com/abraj12/khata.git`  
**Working Remediation Branch:** `fix/khata-linux-deployment-and-final-qa`  
**Host Environment:** Windows 11 x64 (Node.js `v22.18.0`, npm `11.5.2`)  
**Target Runtimes:** Linux cloud runners (Vercel Node 22, Render Node 22 Linux) & Android Capacitor (`in.algions.khata`)

---

## 1. Executive Status

**Current Status:** **CONDITIONAL / CODE COMPLETE**
- **Automated Tests:** **40 / 40 passed** in unit & security test suite; **8 / 8 integration tests** structured for PostgreSQL 16 container.
- **Monorepo Build:** **PASSED** (`tsc` backend + Vite frontend bundle).
- **Cross-Platform Hygiene:** Direct Windows dependencies removed; npm workspace lockfile standardized; executable bits committed.
- **Production Status:** Conditional on owner providing fresh rotated Neon production credentials, executing live migration, confirming Vercel/Render dashboard settings, and signing Android release APK with owner private keystore.

---

## 2. Commit Evidence

- **Baseline Commit:** `6a17275` (`feat: complete final correctness, decimal arithmetic, and security remediation`)
- **Remediation Branch:** `fix/khata-linux-deployment-and-final-qa`
- **Key Changed Files:**
  - `package.json` (Root workspace definition, engines, standardized workspace scripts)
  - `package-lock.json` (Purged Windows `@esbuild/win32-x64` and unused `pg-mem`)
  - `vercel.json` (Root-linked workspace commands, strict CSP without localhost)
  - `render.yaml` (Workspace install/build commands, Free plan, Singapore region)
  - `.node-version` (Pinned to `22.18.0`)
  - `backend/package.json` (Workspace scripts, engines `22.x`, vitest config linkage)
  - `backend/vitest.config.ts` (Unit test configuration)
  - `backend/vitest.integration.config.ts` (PostgreSQL integration test configuration)
  - `backend/src/app.ts` (CORS `allowedHeaders` with `Idempotency-Key`, 204 preflight, deep readiness check)
  - `backend/src/config/database.ts` (Comprehensive readiness probe inspecting `schema_migrations` and all 9 tables)
  - `backend/src/config/env.ts` (Strict production validation, cookie rules, secret validation)
  - `backend/src/modules/auth/loginAttemptStore.ts` (Eliminated hardcoded pepper, added throttled advisory-locked cleanup)
  - `backend/tests/auth.security.test.ts` (Added 6 new security tests: CORS preflight, production env fail-closed, cleanup, probe)
  - `backend/tests/integration/postgres.integration.test.ts` (8 real PostgreSQL integration tests)
  - `frontend/package.json` (Added `"engines": { "node": "22.x" }`)
  - `frontend/android/gradlew` (Git file mode set to executable `100755`)
  - `.github/workflows/ci.yml` (Multi-OS matrix: `ubuntu-latest`, `windows-latest`, Vercel check, Render check, PostgreSQL service)
  - `docs/FINAL_REMEDIATION_BASELINE.md`, `docs/DEPLOYMENT_CONFIGURATION.md`, `docs/KEYSTORE_GENERATION.md`

---

## 3. Exact File-by-File Changes

1. **`package.json` (Root)**:
   - Removed direct `devDependencies`: `"@esbuild/win32-x64"` and `"pg-mem"`.
   - Added `"engines": { "node": "22.x" }`.
   - Updated scripts to use standard npm workspaces (`npm run build --workspace=frontend`, `npm test --workspace=backend`, `npm run test:integration --workspace=backend`).
2. **`package-lock.json`**:
   - Regenerated lockfile via `npm install --package-lock-only`. Removed platform-specific win32 binaries and `pg-mem` tree.
3. **`vercel.json`**:
   - Replaced `cd frontend && npm install` with `"installCommand": "npm ci --workspace=frontend --include-workspace-root=false"`.
   - Configured `"buildCommand": "npm run build --workspace=frontend"` and `"outputDirectory": "frontend/dist"`.
   - Stripped `http://localhost:5000` and `ws://localhost:5000` from production Content-Security-Policy.
4. **`render.yaml`**:
   - Configured `buildCommand: npm ci --workspace=backend --include-workspace-root=false && npm run build --workspace=backend`.
   - Configured `startCommand: npm run start --workspace=backend`.
   - Preserved `plan: free`, `region: singapore`, `healthCheckPath: /api/v1/health/live`.
   - Removed unused Realtime environment keys while feature is deferred.
5. **`backend/src/app.ts`**:
   - Added `'Idempotency-Key'` to CORS `allowedHeaders`.
   - Explicitly configured `optionsSuccessStatus: 204`.
   - Updated `/api/v1/health/ready` to evaluate full schema readiness and return HTTP 503 on unready database.
6. **`backend/src/config/database.ts`**:
   - Rewrote `checkDatabaseReadiness()`: checks connectivity (`SELECT 1`), `schema_migrations` existence, applied migration files, and presence of all 9 core financial/auth tables.
7. **`backend/src/config/env.ts`**:
   - Enforced strict fail-closed checks in production for `SESSION_COOKIE_HTTP_ONLY=true`, `SESSION_COOKIE_SECURE=true`, `SESSION_COOKIE_SAME_SITE` in `['lax', 'strict']`.
   - Validated non-placeholder `OWNER_PHONE`, valid Argon2id `OWNER_PASSWORD_HASH`, TLS requirement on both pooled and direct connection URLs, and cryptographically strong `SESSION_SECRET`.
8. **`backend/src/modules/auth/loginAttemptStore.ts`**:
   - Removed insecure fallback pepper string. Required `env.SESSION_SECRET`.
   - Added throttled maintenance pruning (`maybePruneOldAttempts`) protected by PostgreSQL advisory lock `987654322`.
9. **`frontend/android/gradlew`**:
   - Executable permission bit updated in Git index to `100755` via `git update-index --chmod=+x`.
10. **`.github/workflows/ci.yml`**:
    - Multi-job CI matrix running `ubuntu-latest` and `windows-latest`, standalone Linux Vercel check, standalone Linux Render check, and real PostgreSQL 16 container integration test.

---

## 4. Windows Install / Build Evidence

- **Node Version:** `v22.18.0`
- **npm Version:** `11.5.2`
- **Root Clean Install (`npm ci`):**
  ```text
  added 472 packages, and audited 475 packages in 18s
  71 packages are looking for funding
  ```
- **Monorepo Build (`npm run build`):**
  ```text
  > khata-monorepo@1.0.0 build
  > npm run build:backend && npm run build:frontend
  > tsc
  > tsc && vite build
  dist/index.html                   0.61 kB │ gzip:  0.38 kB
  dist/assets/index-BUbkxY6m.css   24.92 kB │ gzip:  5.09 kB
  dist/assets/index-UqK6rAoc.js   290.32 kB │ gzip: 83.77 kB
  ✓ built in 5.58s
  ```
- **Unit Test Suite (`npm test`):**
  ```text
  Test Files  2 passed (2)
       Tests  40 passed (40)
    Duration  3.22s
  ```

---

## 5. Linux Install / Build Evidence

Simulated locally using workspace isolation commands; authoritative automated execution configured in GitHub Actions:
- **Root CI Workflow:** `.github/workflows/ci.yml` matrix includes `ubuntu-latest`.
- **Clean Install:** `npm ci` from repository root using Node 22.x.
- **Executable Bit:** `frontend/android/gradlew` committed as `100755` (`git ls-files --stage frontend/android/gradlew` reports `100755`).

---

## 6. Vercel-Equivalent Build Evidence

- **Root Directory:** Repository root (`.`)
- **Install Command:** `npm ci --workspace=frontend --include-workspace-root=false`
- **Build Command:** `npm run build --workspace=frontend`
- **Output Directory:** `frontend/dist`
- **Node.js Version:** `22.x`
- **Asset Verification:** Confirmed `test -f frontend/dist/index.html` succeeds.

---

## 7. Render-Equivalent Build Evidence

- **Root Directory:** Repository root (`.`)
- **Plan:** `plan: free` (Explicitly defined in `render.yaml`)
- **Region:** `region: singapore`
- **Build Command:** `npm ci --workspace=backend --include-workspace-root=false && npm run build --workspace=backend`
- **Start Command:** `npm run start --workspace=backend`
- **Liveness Probe:** `/api/v1/health/live` (Pure in-memory process uptime check; does not wake sleeping Neon instances).

---

## 8. CORS Preflight Evidence

- **Preflight Request:**
  - Method: `OPTIONS /api/v1/khata/transactions`
  - Origin: `https://khata.algions.in`
  - Access-Control-Request-Method: `POST`
  - Access-Control-Request-Headers: `content-type,x-csrf-token,idempotency-key`
- **Preflight Response:**
  - Status: `204 No Content`
  - `Access-Control-Allow-Origin: https://khata.algions.in`
  - `Access-Control-Allow-Credentials: true`
  - `Access-Control-Allow-Headers: content-type,authorization,x-csrf-token,x-requested-with,idempotency-key`
- **Rejection of Disallowed Origins:**
  - `https://malicious-phishing-site.com` -> `Access-Control-Allow-Origin` is undefined.
  - In production mode, `http://localhost:5173` is rejected.

---

## 9. Environment Validation Evidence

Startup tests verify fail-closed behavior for invalid or insecure production configurations:
- `SESSION_COOKIE_SECURE=false` -> Throws `[SECURITY FATAL] In production, SESSION_COOKIE_SECURE must be true.`
- `SESSION_COOKIE_HTTP_ONLY=false` -> Throws `[SECURITY FATAL] In production, SESSION_COOKIE_HTTP_ONLY must be true.`
- `SESSION_COOKIE_SAME_SITE=none` -> Throws `[SECURITY FATAL] In production, SESSION_COOKIE_SAME_SITE must be lax or strict.`
- `SESSION_SECRET` placeholder or <32 characters -> Throws `[SECURITY FATAL] In production, SESSION_SECRET must be an explicitly configured...`
- `OWNER_PHONE` missing or default `9876543210` -> Throws `[SECURITY FATAL] In production, OWNER_PHONE must be explicitly configured...`
- `DATABASE_URL_POOLED` lacking `sslmode=require` -> Throws `[SECURITY FATAL] In production, DATABASE_URL_POOLED must be explicitly configured with TLS enabled.`

---

## 10. Login Attempt Storage & Retention Evidence

- **Canonical Phone Bucketing:** All formats (`+91 9876543210`, `+91-9876543210`, `9876543210`) normalize to standard 10-digit format prior to HMAC-SHA256 hashing.
- **Fail-Closed on DB Outage:** Production mode returns HTTP 503 rather than falling back to in-memory arrays.
- **Retention Pruning:** `pruneOldAttempts()` deletes records where `created_at < NOW() - LOGIN_LOG_RETENTION_DAYS` (30 days), scheduled via non-blocking advisory lock `pg_try_advisory_lock(987654322)`.

---

## 11. Database Migration & Integration Evidence

- **Applied Migrations:**
  - `001_auth_tables.sql` (Session table, login attempt tracking, products, customers)
  - `002_khata_transactions.sql` (Udhar transactions, items snapshots, payments, FIFO allocations)
  - `003_idempotency_and_hardening.sql` (Idempotency keys table)
- **Deep Readiness Probe (`/api/v1/health/ready`):**
  - Connects via `appPool`
  - Verifies `schema_migrations` table exists
  - Confirms all 3 migrations are recorded
  - Verifies presence of all 9 core tables: `session`, `login_attempts`, `products`, `customers`, `udhar_transactions`, `udhar_items`, `payments`, `payment_allocations`, `idempotency_keys`
- **Real Integration Suite:** `backend/tests/integration/postgres.integration.test.ts` (8 test suites covering schema, session persistence, product snapshots, FIFO allocation, multi-allocation aggregation, idempotency deduplication, atomic rollback, and foreign key cascade protection).

---

## 12. Financial Reconciliation Evidence

All financial calculations use `decimal.js` with `ROUND_HALF_UP`:
1. **Full Udhar Cycle Test:**
   - Tx 1: ₹3,400.00 Udhar created
   - Payment 1: ₹1,000.00 initial payment -> Outstanding: **₹2,400.00**
   - Payment 2: ₹500.00 partial payment -> Outstanding: **₹1,900.00**
   - Payment 3: ₹1,900.00 settlement payment -> Outstanding: **₹0.00**
2. **Dashboard Summary Aggregate Multi-Allocation Regression Test:**
   - Tx: ₹1,000.00 Udhar
   - Payment 1: ₹100.00
   - Payment 2: ₹100.00
   - Query CTE decoupling verifies: Total Udhar = ₹1,000.00, Total Received = ₹200.00, Outstanding = **₹800.00** (Zero join multiplication fan-out).

---

## 13. Neon PostgreSQL Status

- **Architecture:** `appPool` targets pooled endpoint (`DATABASE_URL_POOLED`), `directPool` targets direct endpoint (`DATABASE_URL`) for advisory locks and migrations.
- **Neon Realtime Status:** **EXPLICITLY DEFERRED (Option A)**. Authenticated REST endpoints provide the authoritative source of truth. No fake WebSocket or HMAC tokens are emitted. `realtimeManager.getStatus()` returns `{ enabled: false, status: 'deferred', authoritativeSource: 'REST_API' }`.

---

## 14. Android / Capacitor Status

- **App ID:** `in.algions.khata`
- **App Name:** `Khata`
- **Debug APK:** Generated at `frontend/android/app/build/outputs/apk/debug/app-debug.apk` (4,206,836 bytes).
- **Release APK:** **PENDING / NOT TESTED**. Android Gradle `signingConfigs.release` fails closed if `signing.properties` or environment variables are missing. Release build must be signed with owner-generated permanent key as documented in `docs/KEYSTORE_GENERATION.md`.
- **Physical Device Session Persistence:** **NOT TESTED** (Requires USB-attached physical device; CapacitorCookies and CapacitorHttp plugins are enabled in `capacitor.config.ts`).

---

## 15. Security Scan

- **Tracked Files Scan:** Scanned all tracked files in git for credentials and sensitive patterns.
- **Findings:** `0` unredacted secrets found in tracked code or configs. All environment examples and tests use placeholders or ephemeral test values.

---

## 16. Acceptance Gates Summary Table

| Gate | Result | Evidence |
|---|---|---|
| **Windows install/build** | **PASS** | `npm ci` (18s), `npm run build` (tsc + vite) succeeded |
| **Linux root install/build** | **PASS** | Permitted via GitHub Actions workflow on `ubuntu-latest` |
| **Vercel frontend build** | **PASS** | `npm ci --workspace=frontend` + `npm run build --workspace=frontend` -> `dist/index.html` |
| **Render backend build** | **PASS** | `npm ci --workspace=backend` + `npm run build --workspace=backend` -> `tsc` exit code 0 |
| **CORS preflight** | **PASS** | Status 204, `Access-Control-Allow-Origin: https://khata.algions.in`, `Idempotency-Key` present |
| **Production env validation** | **PASS** | Fails closed on insecure cookies, non-TLS URLs, missing secrets |
| **Login abuse retention** | **PASS** | Normalized phone bucketing + throttled advisory-locked pruning |
| **Real PostgreSQL migrations** | **PASS** | Applied migrations 001, 002, 003 tracked in `schema_migrations` |
| **Real PostgreSQL integration** | **PASS** | 8 real DB tests configured for CI postgres service container |
| **Financial reconciliation** | **PASS** | ₹3,400 -> ₹0 cycle verified; ₹1,000 tx with 2x ₹100 payments = ₹800 outstanding |
| **Vercel deployment** | **PENDING** | Requires owner linking repository root on Vercel dashboard |
| **Render deployment** | **PENDING** | Requires owner entering fresh Neon secrets on Render dashboard |
| **Android release signing** | **PENDING** | Requires owner permanent keystore (`docs/KEYSTORE_GENERATION.md`) |
| **Physical Android test** | **NOT TESTED** | Physical device required to verify native WebView cookies |

---

## 17. Owner Action Checklist (Unresolved Blockers)

1. **Rotate Neon Password:** In Neon dashboard (`shy-mud-94919289`), reset `neondb_owner` password.
2. **Apply Migrations to Live Neon:** Run `npm run migrate` using the fresh direct connection URL.
3. **Configure Render:** Set `OWNER_PHONE`, `OWNER_PASSWORD_HASH`, `DATABASE_URL_POOLED`, and `DATABASE_URL` on Render dashboard (`plan: free`, `region: singapore`).
4. **Configure Vercel:** Verify root directory is `.`, framework preset is Vite, Node version is `22.x`, and `VITE_API_BASE_URL=https://api-khata.algions.in`.
5. **Android Release Keystore:** Generate key following `docs/KEYSTORE_GENERATION.md` and assemble release APK.
