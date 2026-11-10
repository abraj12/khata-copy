> [!NOTE] SUPERSEDED — NOT CURRENT OPERATING INSTRUCTIONS
> This document is an archived historical report/prompt preserved for audit trail purposes.
> Refer to the canonical documentation in docs/ and README.md for current operational instructions.

# KHATA — FINAL CROSS-PLATFORM, SECURITY & PRODUCTION VERIFICATION REMEDIATION PROMPT

**Target project:** Existing single-shopkeeper Khata application  
**Source baseline:** Latest `khata(2).zip` / latest repository branch supplied by the owner  
**Deployment target:** Vercel frontend + Render backend + Neon PostgreSQL  
**Website:** `https://erp.algions.in`  
**API:** `https://api-erp.algions.in`  
**Android package:** `in.algions.khata`  
**Runtime target:** Node.js 22.x; Linux cloud builds must work (Vercel build environment and Render Linux runtime), as well as the owner's Windows development machine.

---

## ROLE AND MISSION

You are the lead engineer responsible for completing the final remediation of the existing Khata application. You have access to the repository, terminal, package manager, tests, and Android project. Your job is to **modify the source code, verify the modifications, and provide reproducible evidence**.

This is not a request to write another audit report, produce a plan without implementation, or claim success based on code inspection. Execute the work. Do not stop after finding issues. Do not create a new application or rewrite the project from scratch. Preserve all correct existing functionality and repair the actual code.

Use specialist subagents if available, but assign non-overlapping workstreams and have one lead integrate and test every change. Do not let parallel agents overwrite the same files without coordination.

### Required outcome

The project must:

1. Install and build reproducibly on Linux and Windows using the committed root workspace lockfile.
2. Deploy the frontend from the monorepo root to Vercel without Windows-only packages or local machine assumptions.
3. Build and run the Express backend on Render Linux using reproducible workspace commands.
4. Allow browser requests for Udhar and payments, including `Idempotency-Key`, through credentialed CORS preflight.
5. Enforce production secrets and cookie security without accepting hardcoded defaults.
6. Correctly persist owner login abuse records and clean up expired records without unbounded memory growth.
7. Check readiness against the actual database schema/migrations, not just `SELECT 1`.
8. Preserve the financial correctness of Udhar, payments, FIFO allocation, idempotency and historical snapshots.
9. Have real PostgreSQL integration tests, not only in-memory mocks.
10. Keep Neon Realtime explicitly deferred unless you implement the official supported SDK end-to-end. Do not invent a protocol.
11. Keep Render configured on its Free plan unless the owner explicitly authorizes a paid service.
12. Keep Android build tooling independent of Vercel; produce and verify a release APK only when the owner supplies/creates the permanent signing key. Test native cookies on a real device when one is available.

---

# PHASE 0 — SAFETY, SOURCE CONTROL AND BASELINE

Before editing files:

1. Run `git status --short --branch`, `git branch --show-current`, `git log -5 --oneline`, and `git remote -v`.
2. Record the current commit hash and create a dedicated remediation branch, for example `fix/khata-linux-deployment-and-final-qa`, unless already on an appropriate uncommitted remediation branch.
3. Preserve all owner changes. Do not run `git reset --hard`, `git clean -fdx`, force-push, delete branches, rewrite Git history, or overwrite existing environment files.
4. Inspect the actual current source. Do not assume line numbers from this prompt are still correct. Search by file and symbol, then edit the current code.
5. Do not print secret values in terminal output or reports. When scanning files, print only filenames and secret categories/redacted matches.
6. Do not deploy to production, run production migrations, change billing plans, or provision paid services without owner authorization. Build/test locally and in CI first.
7. Never use the exposed Neon connection string or Realtime secret from chat/archive. Treat them as compromised. Use only fresh credentials supplied by the owner after rotation.

Create a baseline report in `docs/FINAL_REMEDIATION_BASELINE.md` showing current commit, files, detected platform risks and baseline command results. Continue implementation even if baseline checks fail.

---

# PHASE 1 — FIX ROOT NPM WORKSPACES AND LINUX INSTALLATION

## 1.1 Inspect the monorepo

Inspect:

- `package.json`
- `package-lock.json`
- `backend/package.json`
- `frontend/package.json`
- `.npmrc` if present
- `.gitignore`
- `.vercelignore` if present
- `.node-version` / `.nvmrc` if present

The root is an npm workspace containing `backend` and `frontend`. The current root `package.json` has a direct development dependency on `@esbuild/win32-x64`. This package is restricted to Windows x64 and must not be a required direct dependency for Linux cloud installation.

## 1.2 Remove platform-specific direct dependency

In root `package.json`:

- Remove `@esbuild/win32-x64` from root `devDependencies`.
- Do not remove Vite's/esbuild's normal optional platform packages from the lockfile manually. Let npm regenerate the lockfile so the correct Linux optional binary is selected.
- Search the whole repository for `pg-mem` imports/usages. If it is genuinely unused, remove it. If an existing test genuinely needs it, put it only in the correct workspace's `devDependencies`; do not keep test-only packages as unnecessary root production dependencies.
- Search for any other `@esbuild/win32-*`, `@rollup/rollup-win32-*`, `@rollup/rollup-linux-*`, `@swc/core-win32-*` or manually pinned platform binary packages. Remove direct platform pins unless the package's official installation method explicitly requires them. Preserve packages that are legitimate optional dependencies managed by their parent.

## 1.3 Standardize scripts around npm workspaces

Replace root scripts that independently run `npm --prefix backend install` and `npm --prefix frontend install`. The root workspace lockfile must be the single source of dependency truth.

Use equivalent workspace scripts (adapt names if necessary, but preserve functionality):

```json
{
  "private": true,
  "workspaces": ["backend", "frontend"],
  "engines": { "node": "22.x" },
  "scripts": {
    "dev:backend": "npm run dev --workspace=backend",
    "dev:frontend": "npm run dev --workspace=frontend",
    "build:backend": "npm run build --workspace=backend",
    "build:frontend": "npm run build --workspace=frontend",
    "build": "npm run build:backend && npm run build:frontend",
    "test": "npm test --workspace=backend",
    "migrate": "npm run migrate --workspace=backend",
    "hash-password": "npm run hash-password --workspace=backend"
  }
}
```

Do not keep `install:all` as a script that creates separate workspace lockfiles. A normal clean install from the repository root must be `npm ci`.

Ensure workspace names in `backend/package.json` and `frontend/package.json` are unique and stable. Confirm root `package-lock.json` records both workspaces. Delete a nested `backend/package-lock.json` or `frontend/package-lock.json` only if it is an accidental conflicting lockfile and after confirming the root lockfile fully records all dependencies. Do not delete files merely because they look redundant.

## 1.4 Regenerate and validate the lockfile

Use Node.js 22.x and a compatible npm version. Run from repository root:

```bash
node --version
npm --version
npm install --package-lock-only
npm ci
npm ls --all
npm run build
npm test
```

If npm install regenerates the lockfile on Windows, do not assume it is Linux-compatible. A clean Linux CI job must run `npm ci` and the builds. If the local environment is Windows, use GitHub Actions `ubuntu-latest` as the authoritative Linux installation check.

Do not commit `node_modules`, compiled `dist`, Android build folders, or machine-specific caches.

---

# PHASE 2 — VERCEL FRONTEND CONFIGURATION FOR LINUX / MONOREPO

## 2.1 Vercel project root directory

The Vercel project must be linked to the repository root (the directory containing root `package.json`, root `package-lock.json`, and `vercel.json`), not to `frontend/`, because the build uses npm workspaces and the root lockfile.

Record the required dashboard setting in `docs/DEPLOYMENT_CONFIGURATION.md`:

- Root Directory: repository root (`.` / blank root setting).
- Framework Preset: Vite or Other with the explicit commands below.
- Node.js Version: `22.x`.
- Production domain: `erp.algions.in`.
- No backend database secrets in Vercel.

Do not claim you changed the Vercel dashboard unless you actually have dashboard access. Provide the owner the exact required setting if you cannot change it.

## 2.2 Update `vercel.json`

Replace the current command that does `cd frontend && npm install && npm run build`. It bypasses the root workspace installation and can resolve dependencies separately from the lockfile.

Use this configuration as the baseline when Vercel Root Directory is the repository root:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "npm ci --workspace=frontend --include-workspace-root=false",
  "buildCommand": "npm run build --workspace=frontend",
  "outputDirectory": "frontend/dist",
  "framework": "vite",
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; connect-src 'self' https://api-erp.algions.in; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
        }
      ]
    }
  ]
}
```

Important:

- Preserve any genuinely required existing headers, but remove `http://localhost:5000` and `ws://localhost:5000` from the production CSP.
- Realtime is currently deferred. Do not allow an invented Realtime host. If later implementing the official SDK, add only its documented endpoint and test it.
- Do not configure `VITE_DATABASE_URL`, `VITE_SESSION_SECRET`, `VITE_OWNER_PASSWORD_HASH`, `VITE_NEON_REALTIME_SECRET` or any server secret.
- `VITE_API_BASE_URL` may be `https://api-erp.algions.in` and is not secret.
- If the exact `npm ci --workspace=frontend --include-workspace-root=false` command fails under the current npm/workspace setup, diagnose it and select a proven root-lockfile-compatible command. Do not silently revert to `cd frontend && npm install`.

## 2.3 Verify Vercel build locally and on Linux

Run from root in a clean Linux environment:

```bash
npm ci --workspace=frontend --include-workspace-root=false
npm run build --workspace=frontend
 test -f frontend/dist/index.html
```

Also run `npm ci` and `npm run build` at the root in CI. Confirm that Vercel build output directory is exactly `frontend/dist` and SPA deep links resolve to `index.html`.

Do not run Android Gradle, PowerShell scripts, backend migrations, or database operations as part of the Vercel frontend build.

---

# PHASE 3 — RENDER BACKEND WORKSPACE AND NODE VERSION

## 3.1 Standardize Node version

Create or update root `.node-version` containing:

```text
22.18.0
```

Set root `package.json` and workspace engines to a compatible Node 22 range, preferably `22.x` where accepted. Configure Render `NODE_VERSION=22.18.0` or rely on the committed `.node-version`, following current Render documentation. Record Vercel's Node.js project setting as `22.x` and ensure root `engines.node` is also `22.x` so it cannot silently use a different major.

## 3.2 Update `render.yaml`

Keep the service explicitly on Render Free unless the owner explicitly approves paid hosting. Keep Singapore region to align with the Neon Singapore region. The backend is a web service, not a worker.

Use root workspaces and root lockfile. Example commands with the repository root as the Render Root Directory:

```yaml
buildCommand: npm ci --workspace=backend --include-workspace-root=false && npm run build --workspace=backend
startCommand: npm run start --workspace=backend
```

Do not use `npm --prefix backend install` because it can create/use a separate backend installation instead of the committed root workspace lockfile.

Ensure:

- `plan: free` remains explicit.
- `region: singapore` remains explicit.
- `healthCheckPath: /api/v1/health/live` remains a lightweight liveness path that does not query Neon.
- `NODE_ENV=production`.
- Production secrets remain `sync: false` (or generated by Render only when appropriate). Never place real secret values in `render.yaml`.
- Do not add a separate paid cron/worker/Redis service.
- Do not run production migrations automatically on every deploy unless the owner explicitly approves a safe migration deployment process.

The owner must select/confirm the Free instance in the Render dashboard too. A YAML plan declaration is not proof the live service is actually on Free.

## 3.3 Start command and listening port

Confirm backend binds to `0.0.0.0` or the standard Node server default and uses `process.env.PORT` supplied by Render. Do not hardcode only port 5000 in production. Test that Render's `PORT` overrides the local default.

---

# PHASE 4 — FIX BROWSER CORS PREFLIGHT FOR IDEMPOTENCY

**Current confirmed problem:** `frontend/src/features/khata/KhataLedgerView.tsx` sends the `Idempotency-Key` request header for transaction and payment submissions. `backend/src/app.ts` currently does not include this header in `allowedHeaders`.

## 4.1 Update `backend/src/app.ts`

Find the `cors({ ... })` configuration and include `Idempotency-Key`:

```ts
allowedHeaders: [
  'Content-Type',
  'Authorization',
  'X-CSRF-Token',
  'X-Requested-With',
  'Idempotency-Key',
],
```

Keep `credentials: true`. Do not use `origin: '*'` with credentials. Keep a strict allowlist.

Ensure OPTIONS preflight is handled before routes and middleware that could reject it. The cors middleware should respond correctly to OPTIONS requests.

## 4.2 Origin policy

Allowed production origins should be restricted to the actual website and only the Android origins genuinely required by the packaged Capacitor app:

- `https://erp.algions.in`
- `capacitor://localhost`
- `https://localhost`

Do not allow arbitrary `null` origins in production. Do not allow localhost HTTP development origins in production. Keep local development origins only in development/test configuration.

`https://api-erp.algions.in` is the API origin; it should not be added as a browser frontend origin unless a real browser page is hosted there.

## 4.3 Add real preflight tests

Add tests that send an actual OPTIONS request to the API using:

- `Origin: https://erp.algions.in`
- `Access-Control-Request-Method: POST`
- `Access-Control-Request-Headers: content-type,x-csrf-token,idempotency-key`

Assert:

- Status is successful (normally 204).
- `Access-Control-Allow-Origin` is the exact allowed origin, not `*`.
- `Access-Control-Allow-Credentials: true` is present.
- `Access-Control-Allow-Headers` includes `Idempotency-Key` and `X-CSRF-Token`.

Also assert that an unapproved origin is rejected and that `http://localhost:5173` is rejected in production.

Then perform an end-to-end browser/API test that submits one Udhar and one payment with an idempotency key from `https://erp.algions.in`.

---

# PHASE 5 — PRODUCTION ENVIRONMENT VALIDATION AND SECRET HANDLING

Inspect and fix `backend/src/config/env.ts`, `.env.example`, `render.yaml`, `.gitignore`, `backend/src/config/session.ts`, and any code that falls back to secrets.

## 5.1 No production defaults for secrets

Current code has Zod `.default()` values for owner phone, dummy Argon2 hash, database URLs and session secret. A production validation layer must not accept these defaults.

Implement a clear environment loader:

- Development/test can have documented non-production defaults where safe.
- Production must validate the original `process.env` input and require explicitly set values.
- Production must fail startup if any mandatory value is missing, empty, malformed, or a placeholder.
- Do not merely parse a schema with defaults and then check selected strings for the word `dummy`.

Required production values:

- `NODE_ENV=production`
- `PORT` (platform-provided; parse strictly; default may be used only if deployment platform does not provide one)
- `OWNER_PHONE` (canonical Indian mobile, 10 digits)
- `OWNER_PASSWORD_HASH` (valid Argon2id encoded hash)
- `DATABASE_URL_POOLED` (real pooled PostgreSQL URL)
- `DATABASE_URL` (real direct PostgreSQL URL for migrations)
- `SESSION_SECRET` (cryptographically random, at least 32 bytes/characters as appropriate)
- `SESSION_COOKIE_SECURE=true`
- `SESSION_COOKIE_HTTP_ONLY=true`
- `SESSION_COOKIE_SAME_SITE=lax`
- `FRONTEND_URL=https://erp.algions.in`
- correct `TRUST_PROXY` configuration for Render

Realtime variables must remain optional because Realtime is explicitly deferred. If the source still mounts a placeholder Realtime route, remove it or make its disabled state explicit; it must not force the owner to configure Realtime secrets.

## 5.2 Remove unsafe fallback secret code

Search all source files for:

- `super_secret`
- `dummyhash`
- `9876543210`
- `SESSION_SECRET ||`
- hardcoded PostgreSQL URL strings
- fallback owner credentials
- default Realtime signing secrets

Remove insecure production fallbacks. In particular, `LoginAttemptStore` must not use a fallback pepper if `SESSION_SECRET` is missing. The application should fail startup in production, not substitute a constant.

Do not delete development examples if they are clearly marked and impossible to use in production. Do not output actual secret values in audit reports.

## 5.3 Cookie enforcement

In production enforce:

- `HttpOnly=true`
- `Secure=true`
- `SameSite=Lax`
- `Path=/`
- no `Domain` attribute (host-only API cookie)
- seven-day configured inactivity expiry (`604800000` milliseconds), with the existing agreed rolling semantics

Fail startup if production has `SESSION_COOKIE_HTTP_ONLY=false`, `SESSION_COOKIE_SECURE=false`, or an incompatible SameSite value. Do not silently override and pretend the supplied configuration was valid; either fail or make the selected policy explicit and test it.

Cookie auth continues to require credentialed CORS and CSRF tokens on state-changing routes.

## 5.4 `.env.example`

Use placeholders only. Include names such as:

```env
NODE_ENV=development
PORT=5000
OWNER_PHONE=REPLACE_WITH_OWNER_PHONE
OWNER_PASSWORD_HASH=REPLACE_WITH_ARGON2ID_HASH
DATABASE_URL_POOLED=REPLACE_WITH_NEON_POOLED_URL
DATABASE_URL=REPLACE_WITH_NEON_DIRECT_URL
SESSION_SECRET=REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARS
SESSION_MAX_AGE_MS=604800000
SESSION_COOKIE_NAME=khata_session
SESSION_COOKIE_SECURE=false
SESSION_COOKIE_HTTP_ONLY=true
SESSION_COOKIE_SAME_SITE=lax
FRONTEND_URL=http://localhost:5173
TRUST_PROXY=0
LOGIN_MAX_ATTEMPTS=5
LOGIN_FAILURE_WINDOW_MS=900000
LOGIN_LOCK_DURATION_MS=900000
LOGIN_EXTENDED_THRESHOLD=10
LOGIN_EXTENDED_WINDOW_MS=86400000
LOGIN_EXTENDED_LOCK_DURATION_MS=1800000
LOGIN_LOG_RETENTION_DAYS=30
```

Do not put actual Neon values, owner phone, password hash, signing key, or session secret in this file.

## 5.5 Audit tracked files and Git history safely

Scan the current tracked tree for real credentials and secret patterns. Report filename/category only, redact values. Do not commit local `.env`, `.env.local`, signing properties, keystores, or private keys. If a real secret was previously committed, the correct response is rotation first; do not rewrite shared Git history without owner approval.

---

# PHASE 6 — LOGIN ATTEMPT STORAGE, LOCKOUT AND RETENTION

Inspect `backend/src/modules/auth/loginAttemptStore.ts`, `backend/src/modules/auth/auth.controller.ts`, and migration `001_auth_tables.sql`.

## 6.1 Keep persistent lockout as the production source of truth

Production must use PostgreSQL for login attempt records. Do not silently fall back to per-process memory when database operations fail. If the abuse-control database is unavailable, return a controlled 503 and do not report a successful login attempt without being able to persist required security state.

Keep test-only in-memory stores isolated behind an explicit test option. Do not instantiate and continually populate in-memory attempt arrays in production.

## 6.2 Canonical identifier handling

Before hashing, normalize the phone number to the same canonical 10-digit form. `+91 9876543210`, `+91-9876543210`, and `9876543210` must use the same account bucket.

Check and aggregate at minimum:

- IP bucket
- owner-account/phone bucket (across IPs)
- IP + account combined bucket

Retain generic login responses. Avoid creating an account enumeration oracle.

## 6.3 Cleanup expired login attempts

`pruneOldAttempts()` must actually be invoked by a bounded, production-safe maintenance mechanism. It currently exists but must not remain dead code.

Because Render Free does not require a separate paid worker, do not add Redis, a paid cron service, or a second backend. Implement safe cleanup using one of:

- a throttled cleanup call piggybacked on authenticated/attempt requests, protected by a database advisory lock; or
- another documented low-cost mechanism that works with sleeping/free instances.

Requirements:

- delete only rows older than `LOGIN_LOG_RETENTION_DAYS`;
- use indexed `created_at` access;
- cleanup failures must not turn a valid login into a misleading success if security invariants require the store;
- prevent unbounded in-memory collection growth;
- avoid cleanup on every request if it creates unnecessary database load.

Add tests proving cleanup is invoked, removes only expired records, and does not delete recent lockout evidence.

## 6.4 Abuse control tests

Verify five failures trigger a 15-minute lock and ten in the configured extended window trigger a 30-minute lock. Test across different source IPs for the same owner account and across phone formatting variants. Test production DB failure returns controlled 503. Test no production in-memory fallback.

---

# PHASE 7 — DATABASE READINESS, MIGRATIONS AND REAL POSTGRESQL TESTING

Inspect:

- `backend/src/config/database.ts`
- `backend/scripts/migrate.ts`
- `backend/migrations/001_auth_tables.sql`
- `backend/migrations/002_khata_transactions.sql`
- `backend/migrations/003_idempotency_and_hardening.sql`
- `backend/src/app.ts`
- `render.yaml`

## 7.1 Liveness versus readiness

Keep `/api/v1/health/live` lightweight and independent of Neon. It must confirm only that the Node process is running.

Improve `/api/v1/health/ready` so it checks:

1. Database connectivity using the pooled connection.
2. Presence of the `schema_migrations` table.
3. Required migrations have been applied (expected migration identifiers/checksums).
4. Required core tables exist: `session`, `login_attempts`, `products`, `customers`, `udhar_transactions`, `udhar_items`, `payments`, `payment_allocations`, and `idempotency_keys`.

If a required table/migration is missing or DB is unavailable, return HTTP 503 with sanitized information. Never expose connection strings, SQL internals, passwords or stack traces. Do not make liveness query Neon.

## 7.2 Migration runner

Keep direct `DATABASE_URL` for migrations and pooled `DATABASE_URL_POOLED` for normal runtime queries/session store. The migration runner must:

- use the direct connection;
- acquire a PostgreSQL advisory lock;
- track migration IDs/checksums;
- run each migration transactionally where possible;
- never mark a failed migration as applied;
- be safe to retry;
- work when invoked from repository root and from backend workspace;
- report names/status only, never print credential URLs;
- refuse unexpected destructive operations.

Do not run production migrations automatically on every server boot. Make migrations an explicit deployment/owner step after backup and after a verified build.

## 7.3 Real PostgreSQL integration tests — mandatory

The current 33 tests include mocked/custom in-memory database state. Keep them as unit tests, but add a separate real-PostgreSQL integration suite.

Create a GitHub Actions workflow using `ubuntu-latest`, Node.js 22, and a PostgreSQL service container (for example PostgreSQL 16). Run:

1. `npm ci` from root.
2. `npm run build`.
3. Unit tests.
4. Apply migrations 001, 002, 003 to the CI PostgreSQL service using the actual migration runner (or an explicit test runner that exercises the exact migration files).
5. Real DB integration tests that use `pg`, not mocked `Pool.query` calls.
6. Re-run readiness and verify it returns 503 before migrations and 200 only after all required migrations are applied.

Real database integration tests must cover:

- schema creation and migration tracking;
- session row persistence across a new session store/client instance;
- product create, search, update, archive;
- historical item snapshots after product rename/archive;
- customer creation and normalized phone match;
- ambiguous duplicate-name resolution returns 409;
- multi-item Udhar with server-side totals;
- initial payment allocation;
- multiple later partial payments;
- FIFO allocation across multiple transactions;
- overpayment rejection;
- concurrent payment attempts against the same customer/transactions with row locking;
- same idempotency key + same payload returns cached result without duplicate rows;
- same idempotency key + different payload returns 409;
- a forced exception halfway through a transaction rolls back all writes;
- aggregate summary remains correct with multiple payment allocations;
- cleanup of old login attempts;
- no customer/product cascade deletion destroys financial history.

A mocked `Pool.query`, SQL simulator, or memory-only test is not a substitute for this integration suite. Tests must be repeatable and isolated; use a fresh schema/database per test run or truncate tables transactionally.

## 7.4 Financial invariants

Preserve the current requirements:

- money in PostgreSQL `NUMERIC`, not floating-point columns;
- `decimal.js` for monetary calculation in Node;
- quantities can be decimal if the UI supports them, and use a documented precision;
- line total = quantity × custom selling price, rounded using one documented policy;
- transaction total = sum of line totals (server computed);
- initial payment cannot exceed the transaction total unless product requirements explicitly change;
- later payment cannot exceed customer outstanding balance;
- FIFO allocate customer payments to oldest unsettled transactions;
- payment and allocations must be atomic;
- duplicate network retries must not create duplicate transactions/payments;
- settled historical customers remain visible;
- total received is the all-time sum of successfully recorded payments;
- total outstanding is the sum of remaining balances;
- customer count includes distinct customers with historical Udhar, including settled customers;
- no silent deletion or mutation of historical financial records.

Do not change the owner's business rules without documenting and explaining why.

---

# PHASE 8 — IDEMPOTENCY AND FRONTEND REQUEST BEHAVIOUR

Inspect:

- `backend/src/modules/khata/khata.routes.ts`
- `backend/src/modules/khata/khata.service.ts`
- `backend/migrations/003_idempotency_and_hardening.sql`
- `frontend/src/features/khata/KhataLedgerView.tsx`
- `frontend/src/lib/apiClient.ts`

Requirements:

1. Every create-Udhar/payment action generates one unique UUID idempotency key for the logical user action.
2. Retry after network timeout reuses the same key and same payload.
3. A new user action uses a new key.
4. Backend stores the key, operation/scope, canonical payload hash and result.
5. Same key + same canonical payload returns the original response without additional financial writes.
6. Same key + different payload returns HTTP 409.
7. Unique database constraints prevent race conditions.
8. The key must be scoped correctly (operation/customer/owner as appropriate) and must not be treated as authorization.
9. Do not generate a new key for every retry automatically in the HTTP interceptor.
10. Test double-clicks, browser retries and timeouts.

Ensure CORS allows `Idempotency-Key` as described in Phase 4.

---

# PHASE 9 — FRONTEND AND DOMAIN/CSP VERIFICATION

Review all frontend pages and APIs to ensure they continue to meet the owner's scope:

- exactly two main modules: Products and Khata;
- no inventory, stock, suppliers, multiple shop, employee accounts, GST or extra enterprise modules;
- Products stores product name and buying price only; it does not derive selling price;
- Khata customer is created/reused only when first Udhar is saved;
- phone remains optional;
- each Udhar can contain multiple saved products, quantity and custom selling price;
- transaction totals are computed server-side and previewed in UI;
- initial and later payments update the ledger;
- customer search works by name/phone;
- all paid customers remain visible in history;
- errors from API are shown clearly; do not hide financial errors or show fake success;
- no mock customer/product/financial fallback appears in production UI.

Check frontend API base URL uses `VITE_API_BASE_URL` and the actual API subdomain. Do not hardcode a localhost production URL.

Check Vercel CSP allows `https://api-erp.algions.in` and does not allow localhost HTTP/WS in production. If REST-only mode is in use, no WebSocket or Realtime host is required.

Confirm same-site cookie expectations: `erp.algions.in` and `api-erp.algions.in` are different origins but same-site over HTTPS. CORS must still allow the exact frontend origin and credentials. Use host-only `api-khata` cookie; do not set `Domain=.algions.in`.

---

# PHASE 10 — NEON REALTIME STATUS: KEEP IT HONEST

The current report explicitly defers Neon Realtime and uses authenticated REST endpoints as the authoritative source of truth. This is acceptable for the current MVP.

Do not:

- invent an HMAC protocol and call it Neon Realtime;
- return fake subscription tokens;
- require `NEON_REALTIME_URL` or `NEON_REALTIME_SECRET` when the feature is deferred;
- expose any Realtime secret in Vite/frontend/Android assets;
- claim live synchronization works without a real subscription test.

Either:

**Option A (recommended for this remediation):** keep Realtime deferred, remove pseudo-implementation/dead routes, document that clients must refresh/refetch after mutations, and ensure REST behavior is correct.

**Option B (only if official SDK integration is straightforward and available):** implement using the current official Neon Realtime SDK and documented query-sealing/subscription APIs. Pin a compatible SDK version, sign/seal server-side only, authenticate subscription permissions, subscribe from the client, handle reconnects, test actual changes from a second independent client, and update CSP only for the official endpoint. Provide a real end-to-end proof. Do not choose Option B merely to mark a checkbox.

---

# PHASE 11 — ANDROID / CAPACITOR / LINUX GRADLE HYGIENE

Inspect:

- `frontend/capacitor.config.ts`
- `frontend/android/gradlew`
- `frontend/android/gradlew.bat`
- `frontend/android/local.properties`
- `frontend/android/app/build.gradle`
- `frontend/scripts/generate-keystore.ps1`
- `.gitignore`

Requirements:

1. Vercel frontend build must not require JDK, Android SDK, Gradle, `keytool`, PowerShell or an APK signing key.
2. `frontend/android/local.properties` must remain untracked/ignored. It contains a developer-machine SDK path and must not be committed.
3. Ensure `frontend/android/gradlew` has executable Git mode (`100755`) so Linux CI can run `./gradlew`. Commit the permission bit.
4. Keep `gradlew.bat` for Windows developers.
5. The PowerShell keystore script is Windows-specific and is not a Vercel build dependency. If desired, add a cross-platform documented `keytool` procedure; do not run the `.ps1` script in Linux CI.
6. Ensure `signing.properties`, `*.jks`, `*.keystore`, keystore passwords and private signing materials are ignored and never committed.
7. Keep local web assets bundled into Capacitor APK (`server.url` must remain unset for release config unless an explicit live-server mode is a separate development profile).
8. App ID stays `in.algions.khata`; app name stays `Khata`.
9. Fix and test Capacitor cookie/session behavior on an actual Android device or emulator. A Supertest request with a spoofed Origin header is not proof of WebView cookie persistence.
10. Verify release Gradle signing reads protected signing properties/environment and fails closed if missing. Never create a debug-signed APK and call it a release APK.
11. If no owner keystore is available, build debug APK only and mark release signing NOT TESTED/PENDING. Do not generate or replace the permanent owner signing key without owner authorization.

Android release commands on Linux (after setting up SDK/JDK and owner signing credentials):

```bash
chmod +x frontend/android/gradlew
cd frontend/android
./gradlew assembleRelease
```

Verify the result with `apksigner verify --verbose --print-certs <release-apk>`. Record signer SHA-256 digest, but do not publish private keystore information.

---

# PHASE 12 — CI MATRIX: WINDOWS + LINUX + REAL POSTGRES

Create/update `.github/workflows/ci.yml` so a clean push/PR runs reproducible checks.

At minimum include:

### Job 1: Cross-platform install/build

Matrix:

- `ubuntu-latest`
- `windows-latest`

Use Node 22. Install from root lockfile with `npm ci`. Run `npm run build` and unit tests. This catches OS-specific dependencies and scripts.

### Job 2: Linux frontend-only Vercel-equivalent build

On `ubuntu-latest`:

```bash
npm ci --workspace=frontend --include-workspace-root=false
npm run build --workspace=frontend
 test -f frontend/dist/index.html
```

This is the relevant check for Vercel's frontend deployment. The actual Vercel deployment is an additional confirmation, not a substitute for this job.

### Job 3: Linux backend workspace build

On `ubuntu-latest`:

```bash
npm ci --workspace=backend --include-workspace-root=false
npm run build --workspace=backend
```

### Job 4: PostgreSQL integration

Start a disposable PostgreSQL service container and run actual migrations plus real-db integration tests. Never connect CI to the owner's production Neon database.

Avoid duplicate/contradictory jobs if one full root install/test job already covers the same checks, but preserve separate evidence for frontend-only install, full monorepo, and real DB tests.

Do not add paid CI services or commit secrets.

---

# PHASE 13 — VERIFY CURRENT CONFIGURATION AND REMOVE MACHINE-SPECIFIC ARTIFACTS

Inspect `.gitignore`, the actual Git index, and tracked paths. Ensure the repository does not track:

- `node_modules/`
- `frontend/dist/`
- `backend/dist/`
- `frontend/android/.gradle/`
- `frontend/android/local.properties`
- `frontend/android/app/build/`
- `.env`, `.env.local`, `.env.*` except `.env.example`
- `frontend/android/signing.properties`
- `*.jks`, `*.keystore`
- machine-specific Windows SDK paths

Do not blindly delete an APK if the owner deliberately stores release artifacts elsewhere; source repository should not contain debug build/cache folders.

Check `.git` history only for credential indicators. If actual secrets are found in current commit, remove the file from the current tree and tell the owner to rotate them. Do not echo the values. Any history rewrite needs explicit owner approval.

---

# PHASE 14 — REQUIRED COMMANDS AND ACCEPTANCE GATES

Run the following commands and capture genuine output. If a tool/dependency/network is unavailable, record the exact error and do not invent success.

## A. Root clean install (Linux)

```bash
node --version
npm --version
npm ci
```

## B. Complete builds

```bash
npm run build
```

## C. Unit tests

```bash
npm test
```

## D. Frontend Vercel-equivalent build

```bash
npm ci --workspace=frontend --include-workspace-root=false
npm run build --workspace=frontend
 test -f frontend/dist/index.html
```

Run in a fresh Linux job/container.

## E. Backend Render-equivalent build

```bash
npm ci --workspace=backend --include-workspace-root=false
npm run build --workspace=backend
```

Run in a fresh Linux job/container.

## F. Real PostgreSQL integration

```bash
npm run test:integration
```

This script must connect to disposable CI PostgreSQL and apply migrations. It must not run against production Neon by default.

## G. CORS preflight

Run actual OPTIONS preflight test with `Idempotency-Key`. Verify response headers and exact origin allowlist.

## H. Security/config validation

Run explicit production-env validation tests proving startup fails when each required production secret/security setting is missing or unsafe. Ensure reports redact values.

## I. Vercel configuration validation

Use the current Vercel CLI or schema validation if available. Run `vercel build` only if project linking/credentials are available and it will not deploy. A local Vite build alone does not prove the Vercel project dashboard's Root Directory/Node version settings.

## J. Render configuration validation

Validate YAML and confirm Free plan, Singapore region, root lockfile commands, correct Node 22 runtime, port handling, and health path. Do not trigger a production deploy unless owner authorizes it.

## K. Android

- At least compile debug APK if Android SDK/JDK available.
- Physical device login/session/payment test only when device connected.
- Release signing only with owner-created permanent key.
- Clearly label unperformed steps.

### Final acceptance criteria

The code-remediation phase is complete only when:

- Windows and Linux clean installs pass.
- Vercel-equivalent frontend install/build passes on Linux.
- Render-equivalent backend install/build passes on Linux.
- CORS preflight for idempotency headers passes.
- Production secrets/cookie validation tests pass.
- Login abuse storage/cleanup tests pass.
- All 33 current unit tests still pass, plus newly added tests.
- Real PostgreSQL migration/integration tests pass.
- Financial summary multi-allocation test reports ₹800 outstanding for ₹1,000 transaction with two ₹100 payments.
- Idempotency prevents duplicate financial writes.
- No real secrets enter frontend bundles or Git.
- Render blueprint remains explicitly Free and no additional paid service is provisioned.
- Realtime is accurately marked deferred unless actually proven end-to-end.
- Android debug/release/device status is accurately reported.

Production readiness requires more than code tests: fresh Neon credentials, live migration, Vercel/Render dashboard confirmation, and actual device testing must be completed by the owner or under explicit authorization.

---

# PHASE 15 — FINAL REPORT FORMAT (MANDATORY)

At completion, write `FINAL_CROSS_PLATFORM_REMEDIATION_REPORT.md` with these sections:

1. **Executive status:** Code complete / Conditional / Blocked. Do not use “production ready” unless every production gate is actually met.
2. **Commit evidence:** branch, before/after commit hashes, changed files.
3. **Exact file-by-file changes:** path, symbols/sections changed, reason.
4. **Windows install/build evidence:** exact commands and relevant output.
5. **Linux install/build evidence:** exact commands and relevant output.
6. **Vercel-equivalent build evidence:** root directory assumption, install command, build command, output directory and Node version.
7. **Render-equivalent build evidence:** root directory, build/start commands, Node version, Free plan setting.
8. **CORS evidence:** exact OPTIONS request and response header names/status; redact cookies/tokens.
9. **Environment validation evidence:** which missing/unsafe variables caused startup to fail; never print values.
10. **Login attempt evidence:** canonical phone bucket, DB failure behavior, cleanup test.
11. **Database migration/integration evidence:** actual PostgreSQL version, migrations applied, real tests, rollback/idempotency/session evidence.
12. **Financial reconciliation evidence:** ₹3,400 transaction, ₹1,000 initial payment, ₹2,400 due, ₹500 subsequent payment, ₹1,900 due, ₹1,900 settlement, ₹0 due; multi-payment aggregate regression ₹800 outstanding.
13. **Neon status:** pooled/direct usage, real live test status, Realtime deferred/implemented (with evidence).
14. **Android status:** debug APK path and signature type, release APK path and signer digest if generated, physical device test status.
15. **Security scan:** secret scan result by filename/category only; do not reveal values.
16. **Unresolved blockers:** owner actions and anything not tested.
17. **No fabricated claims:** state exactly which commands you personally executed and which were only reported by CI/owner.

Include a concise table:

| Gate | Result | Evidence |
|---|---|---|
| Windows install/build | PASS/FAIL/NOT RUN | command/log |
| Linux root install/build | PASS/FAIL/NOT RUN | command/log |
| Vercel frontend build | PASS/FAIL/NOT RUN | command/log |
| Render backend build | PASS/FAIL/NOT RUN | command/log |
| CORS preflight | PASS/FAIL/NOT RUN | response |
| Production env validation | PASS/FAIL/NOT RUN | test |
| Login abuse retention | PASS/FAIL/NOT RUN | test |
| Real PostgreSQL migrations | PASS/FAIL/NOT RUN | DB log |
| Real PostgreSQL integration | PASS/FAIL/NOT RUN | test |
| Financial reconciliation | PASS/FAIL/NOT RUN | test |
| Vercel deployment | PASS/FAIL/NOT RUN | deployment URL/log |
| Render deployment | PASS/FAIL/NOT RUN | deployment URL/log |
| Android release signing | PASS/FAIL/NOT RUN | apksigner |
| Physical Android test | PASS/FAIL/NOT RUN | device evidence |

Commit all source/config/test/docs changes on the remediation branch. Push only if repository credentials/access are configured and the owner has authorized pushing. Never force-push.

---

# SPECIAL RULES — DO NOT VIOLATE

1. Do not rewrite the whole app. Fix the existing project.
2. Do not change the user's simple single-shopkeeper product scope.
3. Do not add a customer login, staff accounts, multi-tenancy, stock/inventory, suppliers, GST, notifications, Redis, workers, microservices or other unrequested modules.
4. Do not substitute fake data when Neon/API fails. Return a clear sanitized error.
5. Do not use floating-point arithmetic for money.
6. Do not use SQL string concatenation with user input.
7. Do not expose session/database/owner/realtime secrets in Vite, browser, APK, logs or Git.
8. Do not claim a mocked test proves PostgreSQL integration.
9. Do not claim Supertest proves Android WebView cookie behavior.
10. Do not call a debug-signed APK a release APK.
11. Do not use `npm install` inside `frontend/` or `backend/` to create separate lockfiles when the monorepo root lockfile is authoritative.
12. Do not keep a Windows-only package as a direct required dependency for Linux deployment.
13. Do not remove required esbuild/Rollup optional dependencies manually; let npm resolve correct platform binaries.
14. Do not add localhost endpoints to production CSP/CORS.
15. Do not invent Neon Realtime protocol or mark it done without true end-to-end proof.
16. Do not select a paid Render plan or provision paid add-ons without owner approval.
17. Do not run production migrations until the owner has rotated credentials, confirmed a backup, and approved the operation.
18. If a command fails, diagnose and fix it. If blocked by missing credentials/device/network, report the exact blocker and continue all independent work.
19. Do not stop after writing this report. Implement, test, and then report.
20. The final verdict must be based on evidence, not optimism.

**Begin now with Phase 0 and proceed through every phase.**
