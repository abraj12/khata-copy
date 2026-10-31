# KHATA — FINAL CORRECTNESS, SECURITY & RELEASE REMEDIATION MASTER PROMPT

**Prompt type:** Execute the remaining final remediation in the existing Khata repository.  
**Priority:** Critical — financial correctness, authentication, Neon integration, Android release and deployment readiness.  
**Target app:** Single-owner, single-shopkeeper Khata book.  
**Existing stack:** React + Vite, Express + TypeScript, PostgreSQL on Neon, Render backend, Vercel frontend, Capacitor Android APK.  
**Custom domains:** `https://khata.algions.in` and `https://api-khata.algions.in`.  
**Android application ID:** `in.algions.khata`.  
**Production branch:** Neon `production`.  
**Latest supplied remediation commit/report:** Commit `00e5258`, branch `fix/khata-production-remediation` (inspect the actual checked-out branch and Git status; do not assume the report is current).

---

# 0. YOUR MISSION — READ THIS BEFORE TOUCHING CODE

You are the principal engineer responsible for finishing and verifying the existing Khata application. The previous remediation report says code remediation is completed and 26/26 tests pass, but a source review found additional correctness and production-readiness issues. Your job is to fix the remaining issues in the real repository, inspect for adjacent defects, and produce reproducible evidence.

**Do not rewrite the application from scratch.** Preserve the existing working authentication foundation, user interface, Products view, Khata view, database migrations, tests, and deployment structure unless a specific defect requires a safe change. Do not remove features to make tests pass. Do not replace real database operations with mock data.

You must:

1. Inspect the actual source and repository state before editing.
2. Verify every finding below against the checked-out source. Some line numbers may have changed; use file names and code symbols, not stale line numbers.
3. Fix all confirmed findings, plus directly related defects discovered during testing.
4. Add regression tests before or alongside each fix.
5. Run builds, tests, database tests and security tests; record exact commands and outputs.
6. Clearly distinguish code completion from live Neon, Render, Vercel and physical-device verification.
7. Never say a task passed unless you executed it and have evidence.
8. Never silently use fake/sample data, dummy credentials, permissive security settings or fallback in-memory production state.
9. Never delete production data, rewrite applied migrations, rotate credentials without authorization, or create paid cloud resources without explicit owner approval.

This application has one owner, not a multi-tenant ERP. Its only two main modules are **Products** and **Khata**. Do not add inventory, stock, suppliers, employees, customer CRM, GST, reports, rewards, subscription billing, or other unrelated modules.

## 0.1 Repository intake and safe working procedure

Start by printing and recording:

```bash
git status --short
git branch --show-current
git log -5 --oneline
node --version
npm --version
```

Inspect root and package scripts, then inspect at least:

```text
backend/src/modules/khata/khata.service.ts
backend/src/modules/khata/khata.routes.ts
backend/src/modules/auth/auth.controller.ts
backend/src/modules/auth/auth.service.ts
backend/src/modules/auth/loginAttemptStore.ts
backend/src/config/env.ts
backend/src/config/database.ts
backend/src/config/session.ts
backend/src/middleware/csrf.ts
backend/src/app.ts
backend/migrations/001_auth_tables.sql
backend/migrations/002_khata_transactions.sql
backend/scripts/migrate.ts
backend/tests/auth.security.test.ts
backend/tests/khata.financial.test.ts
frontend/src/features/khata/KhataLedgerView.tsx
frontend/src/features/products/ProductsView.tsx
frontend/src/lib/apiClient.ts
frontend/src/features/auth/AuthProvider.tsx
frontend/src/features/auth/LoginPage.tsx
frontend/capacitor.config.ts
frontend/android/app/build.gradle
frontend/scripts/generate-keystore.ps1
render.yaml
vercel.json
neon.ts
.neon/config.json
.env.example
.gitignore
README.md
```

If any path is absent or has moved, locate the equivalent file and document it. Check whether `node_modules`, `.env`, `.env.local`, Android build caches or secrets are being tracked. Do not include them in commits or handoff ZIPs.

Create a dedicated fix branch from the latest intended remediation branch if appropriate. Do not discard uncommitted owner changes. Never force-push. Do not reset hard. Do not overwrite work from another agent.

## 0.2 Specialist agents (if available)

You may delegate independent audits to specialist subagents, but the orchestrator remains responsible for integration and final verification. Assign non-overlapping ownership:

- **Database/financial correctness:** migrations, SQL aggregates, decimal math, transaction isolation, allocations.
- **Authentication/security:** environment validation, lockout persistence, CSRF/CORS, sessions.
- **Frontend:** customer resolution UI, ledger totals, error handling, idempotent submissions.
- **Android/release:** Capacitor cookies, Gradle signing, APK validation.
- **QA/reviewer:** independent regression tests, audit claims vs executable evidence.

Do not let multiple subagents edit the same file simultaneously. Require each to report changed files, tests executed, failures and unresolved assumptions. The orchestrator must review the diff and run the full suite after merging.

---

# 1. P0 — FIX THE DASHBOARD OUTSTANDING CALCULATION

**Known affected file:** `backend/src/modules/khata/khata.service.ts`  
**Function:** `KhataService.getSummary()`

The current SQL joins `customers`, `udhar_transactions` and `payment_allocations`, then calculates:

```sql
COALESCE(SUM(t.total_amount), 0) - COALESCE(SUM(pa.amount), 0)
```

This is incorrect because one transaction can have multiple payment-allocation rows. Joining them repeats `t.total_amount` once per allocation. Example: transaction total ₹1,000 with two payments of ₹100 can be reported as ₹1,800 outstanding instead of ₹800.

## 1.1 Required correction

Rewrite the summary so transactions and payment allocations are aggregated independently before they are combined. Prefer separate aggregate CTEs or scalar subqueries. Never sum a parent amount after a one-to-many join unless the parent amount has been pre-aggregated or de-duplicated safely.

A sound pattern is:

```sql
WITH transaction_totals AS (
  SELECT
    COUNT(DISTINCT customer_id)::bigint AS total_customers,
    COALESCE(SUM(total_amount), 0)::numeric AS total_udhar
  FROM udhar_transactions
),
allocation_totals AS (
  SELECT COALESCE(SUM(amount), 0)::numeric AS total_allocated
  FROM payment_allocations
),
payment_totals AS (
  SELECT COALESCE(SUM(amount), 0)::numeric AS total_received
  FROM payments
)
SELECT
  transaction_totals.total_customers,
  GREATEST(
    transaction_totals.total_udhar - allocation_totals.total_allocated,
    0
  ) AS total_outstanding,
  payment_totals.total_received
FROM transaction_totals
CROSS JOIN allocation_totals
CROSS JOIN payment_totals;
```

You may use an equivalent query, but it must avoid fan-out and reconcile against allocations. Decide whether outstanding should be derived from each transaction's allocated balance or from independent totals; ensure the result is mathematically identical and add a reconciliation assertion/test.

**Do not** use `SUM(DISTINCT total_amount)` as a shortcut: two different Udhar transactions can legitimately have the same amount, and DISTINCT would undercount.

## 1.2 Required regression tests

Add database-backed tests that reproduce the precise defect:

- One ₹1,000 Udhar transaction.
- Payment 1: ₹100.
- Payment 2: ₹100.
- Expected outstanding: ₹800, total received: ₹200, total Udhar: ₹1,000.
- Add a second transaction with a different total and more than one allocation; ensure totals remain correct.
- Add a second customer and ensure customer count and totals are correct.
- Fully settle one customer; ensure customer remains counted in historical Udhar customers and outstanding becomes zero.
- Ensure summary `totalReceived` counts each payment record once, not each allocation row.

Test both the SQL result and the API response. Add a test that fails against the previous query.

## 1.3 Customer list and detail consistency

Audit `listCustomers()`, `getCustomerDetail()` and `getCustomerHistory()`:

- Customer `totalUdhar` must equal the sum of that customer's transaction totals.
- Customer `totalReceived` must equal the sum of that customer's payment records exactly once.
- Customer `outstanding` must equal total Udhar minus payments actually allocated, with no negative balance.
- Settled customers must remain visible in historical records.
- No query may multiply totals through one-to-many joins.
- Ensure a payment-allocation aggregate is grouped by transaction before joining transaction rows.
- Use a shared tested aggregate implementation or SQL CTE where practical, so the dashboard, customer list and detail screen cannot drift apart.

Add reconciliation tests where one payment is allocated across two or more transactions.

---

# 2. P0 — REMOVE ALL HARDCODED PRODUCTION SECRETS AND FALLBACK CREDENTIALS

**Known affected file:** `backend/src/config/env.ts`

The current Zod schema defines defaults for sensitive values, including:

- `OWNER_PHONE` defaults to `9876543210`.
- `OWNER_PASSWORD_HASH` defaults to a dummy Argon2 string.
- `DATABASE_URL_POOLED` and `DATABASE_URL` default to dummy Neon endpoints.
- `NEON_REALTIME_SECRET` defaults to a dummy string.
- `SESSION_SECRET` defaults to a predictable string.
- `SESSION_COOKIE_SECURE` defaults to `false`.

Production validation currently rejects some values containing `dummy`, but the default session secret is long and does not contain `dummy`, so it can pass the check. This violates the user's explicit instruction: **no hardcoded credentials or secrets; all private configuration comes from environment variables.**

## 2.1 Required environment behaviour

In `NODE_ENV=production`, require explicit, non-empty values for at least:

```env
NODE_ENV=production
OWNER_PHONE=10_DIGIT_OWNER_PHONE
OWNER_PASSWORD_HASH=REAL_ARGON2ID_HASH
DATABASE_URL_POOLED=NEON_POOLED_CONNECTION_STRING
DATABASE_URL=NEON_DIRECT_CONNECTION_STRING
SESSION_SECRET=LONG_RANDOM_SECRET
SESSION_MAX_AGE_MS=604800000
SESSION_COOKIE_NAME=khata_session
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_HTTP_ONLY=true
SESSION_COOKIE_SAME_SITE=lax
FRONTEND_URL=https://khata.algions.in
TRUST_PROXY=1
```

`PORT` should use the host-provided Render port in production and a local development default only when appropriate. Do not require a fixed production port if the platform assigns one.

`NEON_REALTIME_URL` and `NEON_REALTIME_SECRET` must be **optional** while Realtime is explicitly deferred. Do not require dummy Realtime credentials merely to start a REST-only application. If and only if the official Realtime SDK is genuinely integrated and used, validate these values in the Realtime feature configuration.

Use environment defaults only for non-sensitive, safe operational values where a default is intentional (for example, a local development port or standard login thresholds). Never provide production defaults for owner credentials, session keys, database connection strings, signing secrets or third-party secrets.

## 2.2 Strict validation requirements

- `OWNER_PHONE` must be a valid canonical Indian 10-digit mobile number.
- `OWNER_PASSWORD_HASH` must parse as a genuine Argon2id hash; do not accept a string merely because it begins with `$argon2id$`.
- `SESSION_SECRET` must be cryptographically random with at least 32 bytes of entropy; length alone is not proof of entropy. Reject known placeholder/default patterns and common weak values.
- Both database URLs must be present in production and use TLS (`sslmode=require` or stronger supported configuration).
- `SESSION_COOKIE_SECURE` must be exactly `true` in production.
- `SESSION_COOKIE_HTTP_ONLY` must be true.
- `SESSION_COOKIE_SAME_SITE` must be `lax` unless a documented, tested native-auth design requires otherwise. Do not casually switch to `none`.
- `FRONTEND_URL` must be exactly the configured HTTPS origin.
- `TRUST_PROXY` must parse strictly; do not silently coerce an invalid value to `1`.
- Numeric environment values must reject malformed strings such as `15minutes`; do not use permissive `parseInt()` without complete validation.
- Print variable names and safe validation reasons only. Never print secret values, passwords, connection strings or hashes.

Production startup must fail closed when a required secret is missing, empty, a placeholder, malformed, or insecure. Do not silently fall back to memory or a hardcoded value.

## 2.3 Environment file loading

Inspect monorepo working directories and the actual npm scripts. Ensure backend development can load `.env.local` and/or `.env` deterministically. If both exist, define precedence explicitly; `.env.local` should not accidentally be ignored because `.env` was loaded first without override. In production, rely on Render environment settings, not checked-in files. Never load or bundle backend environment files into Vite.

Update `.env.example` using placeholders only. It must not contain working credentials or valid-looking secrets. Update `.gitignore` to exclude `.env`, `.env.*`, `!.env.example`, local signing properties, all keystores, and generated build artifacts.

## 2.4 Environment tests

Test each required production variable individually:

- Missing `OWNER_PHONE` fails.
- Missing or dummy `OWNER_PASSWORD_HASH` fails.
- Missing `SESSION_SECRET` fails.
- Known hardcoded default session secret fails.
- Missing pooled or direct database URL fails.
- Invalid or non-TLS database URL fails according to the application's policy.
- `SESSION_COOKIE_SECURE=false` fails.
- `TRUST_PROXY=abc` fails.
- Placeholder Realtime values do not block startup when Realtime is deferred.
- Valid test and development environments still work without production secrets, using explicit test-only fixtures that cannot be loaded in production.

Make tests prove that production cannot start with the current unsafe schema defaults.

---

# 3. P0 — MAKE LOGIN-ATTEMPT RECORDING PERSISTENT AND FAIL-CLOSED

**Known affected files:**

- `backend/src/modules/auth/loginAttemptStore.ts`
- `backend/src/modules/auth/auth.controller.ts`
- `backend/migrations/001_auth_tables.sql` or a new additive migration

The current store pushes every attempt into `inMemoryAttempts`, even in production. Its `recordAttempt()` method logs database insertion errors and returns successfully. Thus a failed login may not be persisted even though later lockout checks rely on PostgreSQL. The in-memory array can grow without bound because there is no guaranteed cleanup schedule. Also, the controller checks lockout using the raw phone input before canonical normalization; the same Indian number submitted as `9876543210`, `+91 9876543210`, or `919876543210` can create different phone hashes.

## 3.1 Required design

In production, PostgreSQL must be the authoritative lockout store. No in-memory fallback is allowed when PostgreSQL is unavailable.

- Normalize valid phone numbers to one canonical 10-digit representation **before** hashing or checking phone/account lockout buckets.
- Always enforce an IP bucket and an owner-account/phone bucket, plus an IP+phone pair bucket if useful.
- The same phone must map to the same bucket regardless of formatting (`+91`, spaces, hyphens, leading `91`).
- Keep raw IP and phone values out of the database; use keyed HMAC hashes with a genuine dedicated secret or a safely derived key.
- Do not use `SESSION_SECRET` as the only privacy HMAC key without considering rotation consequences. If deriving a key, use a documented key derivation function and separate context labels. Add a dedicated `LOGIN_HASH_SECRET` only if required, and validate it in production.
- Lockout thresholds remain configurable:
  - 5 failures within 15 minutes -> 15-minute lockout.
  - 10 failures within 24 hours -> 30-minute extended lockout.
- Apply the account bucket across IP changes so an attacker cannot evade all thresholds by rotating IP addresses.
- Keep IP-based throttling as an additional control, not as a replacement for account-level protection.
- Avoid making it trivial for an attacker to lock out the sole legitimate owner indefinitely. Document the threshold/window behaviour and ensure lockouts expire as specified.
- Use atomic/persistent SQL logic so concurrent login requests cannot race around the threshold.
- Add a safe retention cleanup strategy for records older than `LOGIN_LOG_RETENTION_DAYS`; do not rely on an ever-growing process array.
- Do not schedule unbounded timers that prevent Node from exiting in tests. If using a timer in production, ensure it is unref'ed, started/stopped cleanly and does not create a second worker. A bounded opportunistic cleanup or platform cron is acceptable.

## 3.2 Failure behaviour

- If `checkLockout()` cannot query PostgreSQL in production, return HTTP 503 and do not attempt authentication with in-memory counters.
- If recording a **failed** attempt fails in production, return HTTP 503; do not return an ordinary 401 while silently losing the failure record.
- If recording a successful attempt fails, choose a documented safe behaviour. Prefer returning 503 and not creating a session if the audit/security state cannot be persisted, unless there is a justified reason to treat successful-attempt logging as non-critical. Do not silently swallow it.
- Do not disclose whether the owner phone number exists.
- Ensure failed login responses are generic and `Cache-Control: no-store`.
- A successful login should prevent stale failed-attempt history from surprising the legitimate owner. Implement a safe reset or “failures since last successful login” query, while preserving the security audit record. Do not erase all IP history indiscriminately if it would weaken abuse protection.

## 3.3 Timing and hash tests

The current dummy Argon2id hash in `auth.service.ts` may fail to parse immediately. Validate that it is a genuine Argon2id hash and that `argon2.verify()` actually performs the expensive operation for unknown phone numbers. The test must prove the dummy verification path runs. Do not compare exact timing in a flaky test, but assert valid hash parsing and that the operation is called.

## 3.4 Required tests

- Five failures trigger the configured first lockout.
- Ten failures in the extended window trigger the second lockout.
- Phone formats with and without `+91` hit the same account bucket.
- Attempts from multiple IPs still hit the phone/account bucket.
- Requests from one IP across multiple phone formats hit the IP bucket.
- Concurrent failures do not bypass threshold due to race conditions.
- Success resets or baselines prior failures according to documented behaviour.
- PostgreSQL outage causes 503 and does not use memory in production.
- Production attempts do not populate `inMemoryAttempts`.
- Retention cleanup deletes only expired records and is bounded.
- Raw phone/IP values never appear in persisted logs or application logs.

---

# 4. P0 — FIX CUSTOMER RESOLUTION AND DUPLICATE PREVENTION

**Known affected file:** `backend/src/modules/khata/khata.service.ts`, `createTransaction()`.

The current code normalizes the customer's name but does not search by normalized name. When `customer.id` is absent and no phone match is found, it always inserts a new customer. This creates duplicate customers when the owner types the same person's name again without selecting the existing record.

The Khata UX requirement is:

- The owner can search and select an existing customer.
- Or type a new customer's name directly during the first Udhar.
- Phone is optional.
- Customer identity is created automatically when the first Udhar is saved.
- Do not add a separate Customer Management module.

## 4.1 Required canonical normalization

Implement one shared normalization helper used by search, creation and duplicate resolution:

- Unicode normalize (`NFKC` or a documented safe form).
- Trim leading/trailing whitespace.
- Collapse repeated internal whitespace to one space.
- Normalize case consistently using a locale-independent rule.
- Do not remove meaningful characters or merge names based on fuzzy similarity.
- Normalize Indian mobile formats to canonical `+91XXXXXXXXXX` or one consistent stored representation.

## 4.2 Resolution rules — do not silently merge the wrong people

Use the following safe rules inside the same database transaction that creates the Udhar entry:

1. If explicit `customer.id` is supplied, lock and verify that customer exists. If a phone is supplied, verify it does not conflict with another customer.
2. If a phone is supplied, first look up the unique normalized phone. If exactly one match exists, reuse that customer. Never create a second customer with the same normalized phone.
3. If a phone is supplied but no phone match exists, do not silently merge a same-name person who has a different phone. Search normalized-name candidates and return a structured duplicate-candidate response or require the owner to choose the existing record or explicitly create a distinct person.
4. If no phone is supplied, search by exact normalized name:
   - zero matches: create a customer;
   - exactly one match: reuse it, or show a confirmation if the UI needs to avoid unintended association;
   - more than one match: do not choose arbitrarily. Return `409 AMBIGUOUS_CUSTOMER_MATCH` with safe candidate information for the owner to select.
5. Never fuzzy-match names automatically.
6. Ensure a concurrent create cannot bypass phone uniqueness. Use the existing unique partial index on normalized phone and handle PostgreSQL unique-violation conflicts by fetching the winning record safely.
7. For normalized names, use a transaction-scoped advisory lock or another concurrency-safe resolution mechanism to prevent simultaneous duplicate no-phone creation. Do not add an overly restrictive unique name constraint that prevents two different people sharing a name.

Update the frontend New Udhar modal to handle the ambiguous-customer response: display candidate names and optional phone suffixes, let the owner select the correct customer, and offer an explicit “Create as a different person” action only when safe. Do not add a separate customer-management page.

## 4.3 Tests

- Same normalized name with case and whitespace differences, no phone -> reuse or confirmation according to policy, not duplicate creation.
- Same name but two different phone numbers -> do not silently merge.
- Same phone in `+91` and 10-digit formats -> same customer.
- Same phone concurrently submitted -> one customer only.
- Multiple customers with same name -> `409`, explicit selection required.
- Existing selected customer with a conflicting phone -> reject safely.
- Customer automatically created only when first Udhar is saved; no pre-registration flow is added.

---

# 5. P0 — USE EXACT DECIMAL MONEY ARITHMETIC

**Known affected file:** `backend/src/modules/khata/khata.service.ts`.

The current implementation uses JavaScript `Number`, `Math.round(value * 100) / 100`, and `parseFloat()` for financial calculations. JavaScript floating-point arithmetic is not decimal-safe. The previous report claimed decimal-safe arithmetic, but the source uses binary floating point.

## 5.1 Required implementation

Use a well-maintained decimal library already in dependencies if present; otherwise add `decimal.js` (or a similarly reputable exact-decimal library) with a locked dependency. Do not write a home-made arbitrary precision calculator.

- Parse money inputs from decimal strings.
- Validate maximum precision and scale explicitly.
- Use decimal arithmetic on the server for line totals, transaction totals, payment amounts, allocations and balances.
- Round each line total to 2 currency decimals using a documented rounding mode (prefer standard half-up unless existing product requirements specify otherwise).
- Persist with PostgreSQL `NUMERIC(12,2)` and pass canonical decimal strings to `pg`.
- Keep quantities within the database scale (`NUMERIC(12,3)`); validate positive quantity and at most three decimal places unless the UI/business rules explicitly restrict to integers.
- Never compute final financial values using `Number` or `parseFloat`.
- The frontend may show a preview, but server values remain authoritative. UI preview should use the same decimal semantics/library if practical.
- Format currency for display only at the edge; do not parse formatted rupee strings back into calculations.

## 5.2 Required invariants

For every Udhar transaction:

```text
line_total = round(quantity * selling_price, 2)
total_amount = sum(line_total for all items)
```

For every customer:

```text
lifetime_udhar = sum(udhar_transactions.total_amount)
lifetime_received = sum(payments.amount)
outstanding = sum(transaction total - allocations to that transaction)
```

For every payment:

```text
sum(payment_allocations.amount for payment) = payment.amount
```

For every transaction:

```text
sum(payment_allocations.amount for transaction) <= transaction.total_amount
```

No negative outstanding. No payment over-collection. No unallocated remainder unless an explicitly designed unapplied-credit feature is added (do not add one by assumption).

## 5.3 Tests

Add edge cases such as:

- Quantity `0.333` × price `₹0.10` -> deterministic 2-decimal result per documented rounding.
- Quantity `3` × price `₹550.00` = `₹1,650.00`.
- Multiple line items sum exactly to the transaction total.
- Amounts with more than 2 decimal places are rejected or rounded according to one explicit API policy; do not inconsistently accept them.
- Very large values are bounded by `NUMERIC(12,2)` and rejected before DB overflow.
- Smallest valid amount and quantity work.
- Repeated add-payment operations reconcile exactly.

---

# 6. P0 — FINANCIAL TRANSACTION ATOMICITY, FIFO ALLOCATION AND DUPLICATE REQUEST SAFETY

**Known affected file:** `backend/src/modules/khata/khata.service.ts` and `khata.routes.ts`.

Preserve the existing FIFO allocation policy, but verify all concurrency and retry behaviour.

## 6.1 Database transactions

- Creating an Udhar, its item snapshots, and optional initial payment must be one PostgreSQL transaction.
- Recording a payment and all FIFO allocations must be one PostgreSQL transaction.
- On any validation or DB error, roll back the complete operation.
- Lock the customer row (`SELECT ... FOR UPDATE`) consistently for customer-level payment and transaction operations so concurrent payment/transaction updates cannot overspend a balance.
- Lock eligible transaction rows in deterministic FIFO order when required.
- Add database constraints or triggers only when justified; do not duplicate business logic inconsistently.
- Catch and map unique constraint, FK, validation and insufficient-balance errors to safe HTTP responses.
- Do not expose SQL error details to the client.

## 6.2 FIFO allocation

FIFO order must be deterministic:

1. Oldest `transaction_date`.
2. Then oldest `created_at`.
3. Then lowest transaction ID.

A payment spanning transactions must create allocation rows whose sum exactly equals the payment. Reject any payment greater than the customer's total outstanding. Do not partially apply a payment and silently discard the remainder.

## 6.3 Double click / network retry protection

Add idempotency protection for create-Udhar and create-payment requests. A browser or Android retry after a timeout must not create a duplicate financial transaction or duplicate payment.

Implement a robust method such as:

- Require an `Idempotency-Key` per create request generated by the client, with a unique DB constraint scoped to the owner/action; or
- Use another well-defined request-deduplication table with unique keys and saved response metadata.

Persist idempotency result within the same logical transaction. Repeating a key with the same payload returns the original result; repeating it with a different payload returns 409. Do not rely only on frontend button disabling.

If idempotency is intentionally deferred, the final report must identify this as a remaining risk and must not claim retry-safe financial writes.

## 6.4 Historical integrity

- Product archive must not alter historical item snapshots.
- Do not hard-delete transactions, payment records or payment allocations through ordinary UI/API operations.
- Do not let deleting or archiving a customer destroy financial history. There is no customer delete feature in the requested product.
- If correction/void support exists, make it auditable (who/when/reason and reversal record); do not silently mutate or delete an old payment.
- Keep the current Products buying price separate from per-transaction custom selling price. Never infer selling price from buying price.

---

# 7. P1 — LOGIN SECURITY AND CSRF/CORS FINAL HARDENING

Review the whole authentication flow. Preserve the core model:

- Exactly one owner.
- Indian 10-digit mobile + password.
- Argon2id hash configured by environment.
- PostgreSQL-backed opaque sessions.
- No JWT and no refresh token.
- 7-day rolling inactivity expiry, configurable via `SESSION_MAX_AGE_MS=604800000`.
- HttpOnly, Secure, SameSite=Lax, host-only cookie named `khata_session`.
- Server-side logout destroys the session.

## 7.1 Login details

- Normalize the phone before lockout lookup and authentication.
- Generic error for unknown phone and wrong password.
- Verify the dummy Argon2 hash path is valid and expensive enough to avoid fast account enumeration.
- Re-generate the session ID after successful login.
- Save the session before returning 200.
- Do not log raw password, session ID, CSRF token, owner password hash, database URLs or Realtime secret.
- Clear password input after failed login.
- Set no-store cache headers on login, me, CSRF token, ledger, payment and other sensitive responses as appropriate.
- Logout must not return “success” when `req.session.destroy()` fails. Return a safe failure status and preserve clear error visibility; only report logout complete when invalidation succeeded.

## 7.2 CSRF and CORS

Review `backend/src/middleware/csrf.ts` and CORS in `backend/src/app.ts`.

- Production allowed origins must be limited to `https://khata.algions.in` and the explicitly validated Capacitor WebView origins required by the chosen native HTTP/cookie architecture.
- Do not allow `http://localhost`, `http://127.0.0.1`, or development origins in production. Keep those only in development/test configuration.
- Never use wildcard CORS with credentials.
- Require a valid session-bound CSRF token for every state-changing authenticated API call (POST/PATCH/PUT/DELETE), except the unauthenticated login endpoint which still requires a valid allowed Origin policy.
- Missing origin/referer must not automatically bypass the CSRF token check. For cookie-authenticated browser mutations require token regardless; for native calls, define and test the native request policy explicitly.
- Use constant-time token comparison where appropriate.
- Keep `Access-Control-Allow-Credentials: true` only for explicit allowed origins.
- Keep preflight handling correct.
- Ensure cookie name/options match between set and clear.
- Never set a broad `.algions.in` cookie Domain. Keep the API cookie host-only.

Add tests for forbidden production localhost origins, wildcard rejection, absent CSRF token, invalid token, valid token, allowed browser origin, actual native origin/request behaviour and session fixation.

## 7.3 Android-specific cookies

The Android app uses Capacitor with bundled frontend assets and the API at `https://api-khata.algions.in`. A browser request and a Capacitor WebView request do not necessarily share cookie behaviour.

Do not assume CORS allowlisting `capacitor://localhost` alone proves cookie persistence. Test the real app on an Android device or emulator:

- Login.
- Read `/auth/me` after login.
- Fetch products and Khata.
- Create a transaction and payment.
- Force-close and reopen app; verify session persistence according to cookie/session policy.
- Verify CSRF-protected mutations.
- Logout; replay old cookie must fail.

If the standard Capacitor WebView cookie jar does not persist/send the host-only API cookie correctly, use a supported Capacitor native cookie mechanism or official native HTTP plugin configuration. Preserve HttpOnly semantics and server-side sessions. Do not move session tokens into `localStorage`, IndexedDB, React state persisted to disk, or a JavaScript-readable cookie. Do not weaken `SameSite`/`Secure` blindly. Record exactly how native cookie persistence is implemented and tested.

---

# 8. P1 — NEON DATABASE CONFIGURATION AND LIVE MIGRATION VERIFICATION

Existing Neon project details known from the project context:

```text
Organization ID: org-red-haze-69535662
Project ID: shy-mud-94919289
Branch: production
Region: Singapore (ap-southeast-1)
Runtime DB: pooled connection
Migrations/admin: direct connection
```

Do not create another Neon project or branch without a clear need and owner approval. Do not copy the previously exposed connection strings or secret values; those must be rotated by the owner first.

## 8.1 Connection usage

Use the repository's current names consistently:

- `DATABASE_URL_POOLED`: pooled Neon endpoint for normal backend runtime queries and PostgreSQL session store.
- `DATABASE_URL`: direct Neon endpoint for migration execution and administrative operations requiring direct connections/advisory locks.

Do not swap them accidentally. Do not open a new pool per request. Reuse the configured `appPool` and `directPool`. Keep TLS certificate verification enabled. Do not use `rejectUnauthorized: false`.

Ensure pool size/timeouts are suitable for Render Free and Neon limits. Use pooled runtime connections and avoid opening too many concurrent connections.

## 8.2 Migration process

Inspect `backend/scripts/migrate.ts` and `schema_migrations` tracking:

- Migrations must be ordered and tracked.
- Use advisory locking to prevent concurrent migration execution.
- Make migrations additive and safe for existing data.
- Do not edit migration files already applied to production; add a new migration for corrections.
- Do not drop or truncate production data.
- Verify current schema before applying.
- Provide backup/restore instructions before production migration.
- Run migrations first against a disposable local/test database or an approved test branch.
- Only apply to production Neon after owner has rotated credentials, supplied new private environment values and explicitly approved production migration.

Run:

```bash
npm --prefix backend run migrate
```

(or the actual root script if the repository has a wrapper). Capture migration IDs and result without printing credentials.

## 8.3 Live DB acceptance test

After credentials are available in the secure local/Render environment:

- Connect using the pooled runtime URL.
- Connect using the direct migration URL.
- Verify required tables and indexes exist.
- Verify migration version table includes all expected migrations.
- Insert a clearly identified temporary QA customer/product/transaction/payment in a safe test branch/database, read them back, update where permitted, and clean up only test records.
- Never create test financial entries in production unless the owner has explicitly approved them and a safe cleanup/audit plan exists.
- Verify a database outage returns 503 or 500 for business endpoints; never return fabricated financial data.
- Verify `/api/v1/health/ready` returns 503 when DB is unavailable and ready only when the app's required schema is present.

## 8.4 Neon CLI

If Neon CLI setup/deploy is required, consult the installed Neon agent skill and the current official Neon documentation before changing `neon.ts` or `.neon/config.json`.

- Confirm current organization/project/branch before running any command.
- Reuse the existing project; do not run a command that creates a second project.
- If CLI opens a browser sign-in, stop and instruct the owner to finish browser authorization; then retry after authorization.
- Do not print `.env.local` values or secrets.
- If `neon deploy` can modify/create cloud resources or generate billable services, explain exactly what it will do and obtain approval where required.
- Check the actual current config schema. Do not invent a `neon.ts` format or fabricate service configuration.

## 8.5 Realtime policy

The prior remediation intentionally removed a custom pseudo-HMAC implementation and deferred Neon Realtime. Keep REST APIs as the source of truth.

Do not reintroduce a homemade token format. Inspect current official Neon Realtime SDK availability, installed Neon skill and official docs. If a supported, compatible SDK is available and can be integrated safely in this repository, implement the official server/client flow and prove a real subscription end-to-end. If it is not stable/available or cannot be verified:

- Leave Realtime explicitly deferred.
- Do not require `NEON_REALTIME_URL` or `NEON_REALTIME_SECRET` for REST-only startup.
- Remove dead/unused Realtime endpoints and misleading claims of verification, or keep a clearly marked feature stub that returns an explicit unsupported/deferred response.
- Document that cross-device updates occur on fetch/refresh, not automatic push.
- Do not say Realtime is working.

---

# 9. P1 — PRODUCT AND KHATA API/FRONTEND ACCEPTANCE

Keep the two main app sections only:

1. **Products** — product name and buying price only.
2. **Khata** — customers who have taken Udhar, entries and payments within this section.

## 9.1 Products

Confirm and test:

- Add product.
- Search product by name.
- Edit product name.
- Edit buying price.
- Archive product (soft archive; do not hard-delete historical product rows).
- Archived products cannot be selected in new Udhar entries.
- Historical `udhar_items` snapshots keep their product name and buying price after product edit/archive.
- Buying price never auto-calculates selling price.
- No stock, quantity-on-hand, inventory or purchasing logic is added.

## 9.2 Khata overview

Confirm and test:

- Total number of distinct customers with historical Udhar, including settled customers.
- Total outstanding amount across all customers.
- Total all-time payments received.
- Search by name or phone.
- Customer rows show lifetime Udhar, received and outstanding.
- Fully settled customers remain in historical records.
- No separate Customers or Payments navigation module is added.

## 9.3 New Udhar

Confirm and test:

- Search/select an existing customer or enter a new name directly.
- Phone number remains optional.
- Customer is created/reused safely at the moment the first Udhar is saved, not through a separate registration process.
- Add multiple products from active Products.
- Enter quantity and custom selling price per line.
- Compute line totals and transaction total on the server using exact decimal arithmetic.
- Optional initial payment is supported.
- Initial payment cannot exceed transaction amount.
- Customer outstanding reflects the payment immediately.
- No manual transaction-total override is introduced.

Use this acceptance example:

```text
Fevicol: 3 × ₹550 = ₹1,650
PVC Pipe: 5 × ₹350 = ₹1,750
Total Udhar: ₹3,400
Initial payment: ₹1,000
Remaining: ₹2,400
```

## 9.4 Later payments and customer history

- Record any partial or full payment at any time.
- Allow multiple payment events.
- Payment is allocated FIFO to oldest outstanding Udhar transactions.
- Reject overpayment.
- Display payments, dates, notes and their allocations.
- Keep historical transactions and payments.
- After ₹500 payment in the example, remaining should be ₹1,900.
- After final ₹1,900 payment, remaining should be ₹0 and customer must remain in history.

## 9.5 API and UI failures

- Database unavailable -> visible safe error, never sample data.
- Network timeout -> visible retry state; never assume a financial write succeeded.
- Duplicate form submission -> idempotency key prevents duplicate financial writes.
- Validation errors -> actionable inline errors.
- Do not clear a form until server success is confirmed.
- After success, refresh/update the relevant summary and customer history from authoritative API data.
- UI totals are previews only; API response is authoritative.

---

# 10. P1 — HEALTH, LOGGING, OBSERVABILITY AND DATA SAFETY

## 10.1 Health endpoints

Keep:

- `/api/v1/health/live`: process liveness only; no database query. Use this for Render liveness health check so frequent health polling does not wake Neon unnecessarily.
- `/api/v1/health/ready`: actual DB and required schema readiness; return 503 if unavailable or migrations are incomplete.

Do not call a DB-dependent route `healthy` when the database is unavailable. Readiness should verify required migration state or a safe required table check, not simply `SELECT 1` if the app cannot operate without the schema.

## 10.2 Logging

- Use structured logs with request ID, route, status, duration and safe error code.
- Never log passwords, hashes, session cookies, CSRF tokens, database URLs, phone numbers in raw form, or Realtime secrets.
- Do not send raw SQL errors to the browser.
- Keep enough diagnostic information for the owner/developer to understand failures.
- Do not log full payment payloads or sensitive customer details unnecessarily.

## 10.3 Backups

- Document Neon backup/PITR availability under the chosen plan and limits.
- Add an independent scheduled backup/export strategy appropriate to the account and budget.
- Do not claim backups are configured if they are only documented.
- Test restore into a disposable database/branch when credentials and capacity permit.
- Make financial records recoverable; do not rely solely on a hosting provider's default retention.

## 10.4 Data consistency and auditability

- No hard deletes for financial entries or payments.
- Product archive is soft deletion.
- Customer historical entries remain visible after settlement.
- Add or document a safe correction method for mistaken payments (reversal/void record with reason and timestamp) if the UI already supports corrections; otherwise explicitly state corrections require a controlled database/admin process until a proper reversal feature is built.
- Check foreign keys and indexes for all lookup and history queries.
- Ensure `NUMERIC` values are never silently converted to imprecise JS numbers for calculations.

---

# 11. P1 — RENDER, VERCEL, DOMAIN AND COST SAFETY

The intended architecture is:

```text
khata.algions.in       -> Vercel frontend (React + Vite)
api-khata.algions.in   -> Render backend (Express)
Neon Singapore        -> PostgreSQL
Android APK           -> Capacitor native wrapper with bundled frontend
```

`www.algions.in` is the existing company website and must remain untouched.

## 11.1 Render

Inspect `render.yaml`:

- Plan must remain `free` unless owner explicitly authorizes paid service.
- Region should be Singapore if Render supports the required service there and this remains compatible with Neon Singapore.
- Health check path should be `/api/v1/health/live`.
- Set `NODE_ENV=production`.
- Set `TRUST_PROXY=1` only when correct for Render's proxy topology.
- Configure all required secrets in Render's private Environment settings.
- Never put secret values into `render.yaml`, Git, prompt files or logs.
- Confirm exact service plan in the Render dashboard; a YAML value alone does not prove deployed plan.
- Do not accidentally create a Starter or other paid resource.

## 11.2 Vercel

- Vercel hosts only the frontend bundle.
- Configure `VITE_API_BASE_URL=https://api-khata.algions.in`.
- Never put database URLs, owner credentials, password hashes, session secrets or Realtime secrets in Vercel environment variables or `VITE_*` variables.
- Keep Vercel SPA rewrites and security headers correct.
- CSP `connect-src` should allow only the frontend itself and the exact backend origin, plus official Realtime endpoints only if Realtime is genuinely implemented.
- Do not use wildcard `connect-src`.
- Verify the custom domain without modifying `www.algions.in`.

## 11.3 Cookies and domains

- Website origin: `https://khata.algions.in`.
- API origin: `https://api-khata.algions.in`.
- These are distinct origins but same-site HTTPS subdomains.
- Use credentialed CORS with the exact frontend origin.
- Use a host-only cookie for `api-khata.algions.in`; do not set `Domain=.algions.in`.
- Browser Axios/fetch must include credentials.
- Test cookie set, send, refresh, expiry and logout against deployed HTTPS endpoints.

---

# 12. P1 — ANDROID RELEASE SIGNING AND REAL DEVICE VERIFICATION

**Android package ID:** `in.algions.khata`  
**App name:** `Khata`  
**Frontend assets:** bundled locally into the APK; do not set `server.url` to the Vercel website for release.

## 12.1 Gradle signing

Inspect `frontend/android/app/build.gradle` and `frontend/scripts/generate-keystore.ps1`.

- Release build must fail closed if release signing configuration is missing.
- Configure `signingConfigs.release` to read a private `signing.properties` file or securely injected environment values.
- Never commit `signing.properties`, `.jks`, `.keystore`, keystore passwords or key passwords.
- Ensure release build actually uses the release signing config, not the debug signing config.
- Use the same permanent keystore for every future update.
- Generate and securely back up the release keystore; the owner must control the private key.
- Do not invent or silently generate a replacement production key if an existing permanent key is already in use.

Expected release command on Windows:

```powershell
cd frontend/android
.\gradlew assembleRelease
```

Then verify:

```powershell
apksigner verify --verbose --print-certs app\build\outputs\apk\release\app-release.apk
```

Record certificate SHA-256 fingerprint. Confirm it is not `CN=Android Debug`.

## 12.2 Device acceptance

When an Android phone/emulator is attached:

```powershell
adb devices
adb install -r frontend/android/app/build/outputs/apk/debug/app-debug.apk
```

For release, install the release APK. Test:

- App launches with bundled UI.
- Owner login works.
- Session cookie persists after force-close/reopen according to policy.
- Products load from Neon through Render.
- Create the ₹3,400 example Udhar with ₹1,000 initial payment.
- Verify ₹2,400 remaining.
- Record ₹500, verify ₹1,900 remaining.
- Record ₹1,900, verify zero balance.
- Verify website and APK show the same authoritative data after refresh.
- Logout invalidates session.
- Reopen app and verify login is required.
- Test poor network, API unavailable, session expiry and duplicate submit.

If no device is connected, do not claim a device test passed. Keep it explicitly pending owner hardware.

---

# 13. REQUIRED TEST MATRIX — DO NOT SKIP

Run the full suite from a clean install after deleting only generated dependency directories, never source or user data. Use the lockfile and a supported Node version.

## 13.1 Build and static checks

Run the actual repository scripts, likely:

```bash
npm ci
npm run build
npm test --prefix backend
```

Also run ESLint/typecheck scripts if present. Do not edit the lockfile manually. Do not package `node_modules` in the final source archive.

## 13.2 Financial regression suite

Add and run tests for:

1. ₹3,400 multi-item transaction example.
2. ₹1,000 initial payment -> ₹2,400 remaining.
3. ₹500 partial payment -> ₹1,900 remaining.
4. ₹1,900 final payment -> ₹0.
5. Multiple partial payments allocated FIFO.
6. Same transaction with multiple allocations does not inflate dashboard total.
7. Two transactions with same amount are not undercounted (guards against `SUM(DISTINCT ...)`).
8. Multiple customers have correct aggregate totals.
9. Settled customers remain in history and count.
10. Overpayment rejected without any payment/allocations inserted.
11. Rollback on item insert or allocation insert failure.
12. Concurrent payments cannot overpay.
13. Double-click/network retry with same idempotency key creates one payment/transaction.
14. Different payload with reused idempotency key returns conflict.
15. Decimal edge cases and scale validation.
16. Product rename/archive preserves historical snapshots.
17. Duplicate customer resolution and phone normalization.
18. Payment totals equal allocation totals; transaction allocations do not exceed transaction totals.
19. API and UI display no fake data during database outage.

## 13.3 Authentication/security suite

Run and expand tests for:

- Correct phone/password.
- Wrong password.
- Unknown phone generic error.
- SQL injection (`' OR '1'='1`, `1=1`, `'; DROP TABLE ... --`) treated as data and rejected.
- XSS strings treated as text.
- Missing/invalid session denied.
- Valid session accepted.
- Session ID regenerated.
- Logout destroys server-side session; old cookie replay fails.
- Cookie Secure, HttpOnly, SameSite=Lax, Path=/, no Domain.
- Seven-day TTL and rolling behaviour.
- Session persistence after backend restart using PostgreSQL store.
- CSRF missing/invalid token denied.
- Production localhost origins denied.
- Wildcard CORS with credentials never allowed.
- Phone canonicalization before lockout.
- Account lockout across multiple IPs.
- Database outage for lockout store returns 503, no in-memory fallback.
- All required production env secrets fail closed.
- No private secrets in client build or API JSON/headers.

## 13.4 Database integration suite

Use a disposable test DB/branch, never destructive tests against production. Prove:

- Migrations apply from a clean database.
- Migrations are idempotent / tracked.
- Concurrent migration lock works.
- All FK/index constraints exist.
- Transactions/rollback work.
- Pooled URL and direct migration URL connect as intended.
- Database failure gives safe API errors.
- Readiness indicates unready when required tables/migrations are missing.

## 13.5 Android integration suite

If hardware/emulator exists, execute the device acceptance tests in Section 12 and attach logs/screenshots without secrets. Otherwise mark `NOT TESTED — OWNER DEVICE REQUIRED`.

---

# 14. PRODUCTION ENVIRONMENT VARIABLE HANDOFF

Update `.env.example` with placeholders only, and produce a secure list for owner configuration.

Backend Render variables:

```env
NODE_ENV=production
PORT=<Render-provided>
OWNER_PHONE=<owner's canonical 10-digit Indian mobile number>
OWNER_PASSWORD_HASH=<real Argon2id hash generated locally>
DATABASE_URL_POOLED=<fresh rotated Neon pooled URL>
DATABASE_URL=<fresh rotated Neon direct URL>
SESSION_SECRET=<fresh cryptographically random secret>
SESSION_MAX_AGE_MS=604800000
SESSION_COOKIE_NAME=khata_session
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_HTTP_ONLY=true
SESSION_COOKIE_SAME_SITE=lax
FRONTEND_URL=https://khata.algions.in
TRUST_PROXY=1
LOGIN_MAX_ATTEMPTS=5
LOGIN_FAILURE_WINDOW_MS=900000
LOGIN_LOCK_DURATION_MS=900000
LOGIN_EXTENDED_THRESHOLD=10
LOGIN_EXTENDED_WINDOW_MS=86400000
LOGIN_EXTENDED_LOCK_DURATION_MS=1800000
LOGIN_LOG_RETENTION_DAYS=30
```

Only add `LOGIN_HASH_SECRET` or Realtime variables if the implementation genuinely requires them; document why and validate them. Do not require optional/deferred service secrets.

Vercel frontend variable:

```env
VITE_API_BASE_URL=https://api-khata.algions.in
```

Never include the values of these variables in the completion report. Do not ask the owner to paste secrets into chat. Use local private files or the hosting dashboard.

---

# 15. OWNER-ONLY ACTIONS — HANDLE SAFELY, DO NOT FAKE

Some actions cannot be completed without the owner's Neon, Render, Vercel or physical Android access. Complete all code and non-sensitive work now. When blocked, provide a precise one-step owner instruction and continue with every independent task.

Owner actions may include:

1. Rotate the previously exposed Neon `neondb_owner` password and Neon Realtime secret (only if Realtime is actually used).
2. Supply the new pooled/direct connection strings directly in Render's private environment settings or a protected local `.env.local`; never print them.
3. Complete Neon CLI browser sign-in if the CLI requests it.
4. Explicitly approve production migration after backup and schema review.
5. Generate and back up the permanent Android release keystore privately.
6. Connect an Android device/emulator for real cookie/session and app workflow testing.
7. Confirm actual Render/Vercel custom-domain and billing plans in their dashboards.

Do not claim credentials were rotated unless you performed/verified the rotation. Do not claim Neon production migration passed unless the migration command connected to the live production branch and returned success. Do not claim the APK is release signed unless `apksigner` output verifies the release certificate. Do not claim phone testing without an ADB device/emulator.

---

# 16. REQUIRED FINAL REPORT FORMAT

At the end, create `FINAL_REMEDIATION_REPORT.md` with these exact sections:

## A. Executive status

Choose one, with evidence:

- `CODE COMPLETE — LIVE VERIFICATION PENDING`
- `CONDITIONAL GO — SPECIFIC OWNER ACTIONS PENDING`
- `PRODUCTION READY — ALL RELEASE GATES VERIFIED`
- `NOT READY — BLOCKERS REMAIN`

Do not label `PRODUCTION READY` when any P0 item, live DB test, security test, release signing or required device test is pending.

## B. Findings fixed

For every finding in this prompt, state:

- Finding ID and severity.
- Exact files changed.
- What code/SQL/UI behaviour changed.
- Regression test name.
- Exact test result.

## C. Files changed

List every file changed, created or removed and its purpose. Include migrations by version and do not omit deployment/configuration files.

## D. Database migration status

- Migration files and versions.
- Local/disposable DB result.
- Production Neon result (or pending).
- Schema version verified.
- Backup/restore status.
- Never show connection strings.

## E. Build/test evidence

Paste concise, exact terminal output for:

```bash
npm run build
npm test --prefix backend
```

Also include database integration test and security test commands. Include OS, Node and npm versions. If a command was not run, say `NOT RUN` and why.

## F. API and financial reconciliation

Show actual test values for:

```text
Udhar total: ₹3,400.00
Initial payment: ₹1,000.00
Due after initial payment: ₹2,400.00
Later payment: ₹500.00
Due after later payment: ₹1,900.00
Final payment: ₹1,900.00
Final due: ₹0.00
```

Also show the multi-allocation dashboard regression case proving no inflated total.

## G. Security verification

List exact tests for env fail-closed, Argon2id, lockout persistence, session, CSRF, CORS, SQL injection, XSS and secret scanning. Include zero secret count only if an actual scanner was run on final web bundles and APK assets.

## H. Neon and deployment status

Separate code config, CLI provisioning, live Neon connection, migration, Render deployment, Vercel deployment, DNS and TLS. Do not conflate config files with live deployment.

## I. Android status

Separate debug APK, release APK, signing certificate fingerprint, install test, session persistence test and physical device test.

## J. Remaining blockers and owner steps

Make every pending task actionable, with exact dashboard/command path. Do not hide untested areas.

## K. Known limitations

State whether Realtime is implemented or deferred. If deferred, state that REST is authoritative and updates require fetch/refresh; do not claim live push updates.

---

# 17. NON-NEGOTIABLE ACCEPTANCE GATES

The work is not complete until all applicable items below are satisfied:

- [ ] Dashboard outstanding aggregate cannot inflate transaction totals when there are multiple payment allocations.
- [ ] Customer list/detail/dashboard totals reconcile independently and correctly.
- [ ] Money calculations use exact decimal arithmetic end-to-end.
- [ ] Customer resolution prevents duplicate creation and unsafe name merging.
- [ ] Login phone normalization happens before lockout hashing.
- [ ] Production login-attempt persistence fails closed on DB outage and has no unbounded in-memory production array.
- [ ] Production has no hardcoded/default owner credentials, DB URLs, session secrets or placeholder secrets.
- [ ] CSRF/CORS production origins are exact; dev origins are not allowed in production.
- [ ] Logout only reports success after the server-side session is destroyed.
- [ ] Create transaction/payment retry cannot double-write when using the same idempotency key.
- [ ] No mock financial data is returned from production API routes.
- [ ] Migration tracking and database readiness are verified.
- [ ] Live Neon DB operation is tested after credential rotation and owner approval.
- [ ] Realtime is either genuinely integrated through the official supported SDK and tested, or clearly deferred without pseudo-protocols or false claims.
- [ ] Render remains on Free unless the owner authorizes paid plan.
- [ ] Vercel contains only public frontend configuration.
- [ ] Android release signing uses the dedicated permanent keystore, not debug cert.
- [ ] Physical Android session/persistence/payment workflow is tested or explicitly marked pending.
- [ ] Full build and automated tests pass from clean dependencies.
- [ ] Final report includes exact reproducible evidence and lists every remaining blocker.

## FINAL INSTRUCTION

Start now. Inspect the checked-out repository and implement all code-level fixes in one coordinated pass. Do not stop after producing another plan or audit. Make changes, add tests, run them, fix failures, inspect the final diff and produce the report. Only stop for genuinely owner-controlled actions such as browser authorization, rotated production secrets, production migration approval, permanent signing key custody or physical-device access. When blocked by one of those actions, continue all other work and report the precise blocker rather than pretending it succeeded.
