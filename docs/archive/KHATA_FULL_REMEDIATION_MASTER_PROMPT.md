> [!NOTE] SUPERSEDED — NOT CURRENT OPERATING INSTRUCTIONS
> This document is an archived historical report/prompt preserved for audit trail purposes.
> Refer to the canonical documentation in docs/ and README.md for current operational instructions.

# MASTER AGENT PROMPT — KHATA APPLICATION FULL REMEDIATION

**Mission:** Repair and complete the existing Khata application in this repository in one coordinated implementation pass. Preserve all working code that is correct. Fix every verified blocker and security defect found in the prior audit. Complete the missing real Khata workflows, Neon PostgreSQL integration, optional/required Realtime integration, Android release signing, deployment configuration, and end-to-end verification. Do not merely write another report or claim completion: make the code changes, run the commands, inspect the outputs, and provide reproducible evidence.

**Repository:** The uploaded archive was `khata.zip`; its project root is the `khata/` directory. Work inside the existing repository root. Do not create a second project or a replacement application.

**Product:** A single-shopkeeper digital Khata notebook. It is NOT an ERP, multi-tenant SaaS, inventory system, supplier system, GST system, or CRM.

**Production architecture:**
- Frontend website: `https://khata.algions.in` — React + Vite, deployed to Vercel.
- Backend API: `https://api-khata.algions.in` — Node.js + Express, deployed to Render.
- Database: existing Neon PostgreSQL project, production branch, Singapore region as currently provisioned.
- Android: Capacitor application, package ID `in.algions.khata`, display name `Khata`, built from the same React frontend but bundled locally into the APK.
- Website and APK use the same backend and same database.
- Main company website `https://www.algions.in` must remain untouched.

**Existing Neon project context:** Organization ID `org-red-haze-69535662`; project ID `shy-mud-94919289`; branch `production`; services requested/provisioned: PostgreSQL and Realtime. Verify these values from the checked-in Neon configuration and Neon CLI/dashboard. Do not create a new project, new branch, or duplicate service unless a concrete issue requires it and is approved.

---

# 0. NON-NEGOTIABLE EXECUTION RULES

1. **Inspect first; change second.** Read the actual source files, package manifests, lockfiles, migrations, tests, Neon configuration, Render/Vercel configuration, Android Gradle configuration, and README. Do not rely only on the previous agent's report. Revalidate every reported defect and every reported pass.
2. **Preserve the existing useful authentication foundation.** Do not rewrite the whole application from scratch. Refactor only where necessary and keep existing working behavior.
3. **No fabricated success.** Never return seeded/demo/sample/fallback financial data from production routes. Never claim a live Neon, Realtime, Android, deployment, or device test passed unless it was actually run and output was captured.
4. **No unsafe shortcuts.** No hardcoded credentials, secrets, passwords, database URLs, API keys, signing passwords, sample owner credentials, or insecure production defaults. Do not bypass TypeScript errors, disable TLS verification, loosen CORS, remove CSRF, or weaken authentication just to make a test pass.
5. **No destructive database actions.** Do not drop the production database, truncate real tables, reset the production branch, or run destructive migrations. Use additive, reversible migrations. Use a separate test database/branch for destructive tests. Back up before any approved data migration.
6. **Do not print secrets.** Redact credentials, cookies, session IDs, tokens, environment values, private keys, and database URLs from terminal output, logs, reports, screenshots, test snapshots, and commits. The prior chat exposed database credentials and a Realtime secret: treat those old credentials as compromised. Never reuse them. The owner must rotate them in Neon and enter only the new values into local environment / Render environment settings.
7. **Do not deploy a paid service automatically.** The existing `render.yaml` reportedly requests Render `starter`, which may incur a charge. The owner's original preference was a low-cost/free deployment. Inspect the current Render plan options and update the configuration to the free plan only if supported and acceptable; otherwise stop before creating/upgrading a paid service and clearly report the required owner decision. Never silently deploy a paid Render instance. Keep an explicit cost note in the final report. Do not make changes to Vercel billing or DNS without owner authorization.
8. **Use current official documentation.** Check installed Neon agent skills and current official Neon docs for the exact CLI, Neon Realtime SDK, connection configuration, and supported APIs. Check current Capacitor/Android documentation for cookie behavior and release signing. Do not invent SDK methods, token formats, Neon endpoints, or configuration schemas. Record package versions and documentation links used.
9. **Use line-specific implementation evidence.** Line numbers in the archive are not stable. After editing, report the final file path and exact final line ranges for important changes, with short code excerpts or symbol names. Do not invent line numbers before the implementation.
10. **Use subagents when available.** Delegate bounded, non-conflicting work to specialists, but the lead agent owns integration and final acceptance. Suggested roles:
    - Database/schema/migrations specialist.
    - Backend business logic/API specialist.
    - Authentication/security specialist.
    - Frontend UX/state specialist.
    - Neon/Reatime specialist.
    - Android/Capacitor specialist.
    - Independent QA/security reviewer.
    Do not let two agents edit the same file concurrently. Define contracts first and have the lead agent merge/integrate. If subagents are unavailable, perform these workstreams sequentially.
11. **Keep scope exact.** No employee accounts, customer login, registration, multiple shops, stock quantities, warehouse, supplier, GST, invoices, reports, uploads, notifications, or unrelated modules unless an existing confirmed requirement demands it. There is exactly one shop owner account.
12. **Do not ask the owner to repeat known requirements.** Continue autonomously. Ask the owner only for an external credential, browser authorization, signing secret, or irreversible/cost-incurring decision that cannot safely be inferred. If something is blocked, complete all independent work first and document the exact blocker.

# 1. CONFIRMED PRODUCT REQUIREMENTS — SOURCE OF TRUTH

## 1.1 Navigation and user model

- Exactly one shop-owner login.
- Login ID is an Indian mobile number (10 digits, accept an optional `+91` prefix and normalize consistently).
- Password hash is configured in the backend environment; no public registration.
- No customer login, employee login, additional admins, or user-management module.
- Main app navigation has only two business areas: **Products** and **Khata**. Dashboard/landing may link to those two areas. Do not add a separate Customer Management or Payments module.
- Customer records are created automatically when the owner saves the customer's first Udhar entry. Phone number is optional.

## 1.2 Products

Each product has only:
- Product name.
- Buying price (the amount the shopkeeper paid / reference cost).

Owner can add, search, edit name, update buying price, and archive/delete a product safely. There is no stock, quantity-on-hand, inventory, purchase order, or automatic selling-price calculation. Buying price is reference-only. A transaction always uses a manually entered custom selling price.

Historical Udhar records must not change if the product name or buying price is later edited or the product is archived. Save product name and buying-price snapshots on each transaction item.

## 1.3 Khata dashboard and customer list

Within Khata show:
- Number of distinct customers who have ever taken Udhar, including customers whose balance is now zero.
- Total amount currently to receive (sum of all outstanding balances).
- Total payments received over all time (sum of actual payments recorded; do not confuse with amount currently outstanding).
- Searchable customer list by name or phone.
- Each customer row: lifetime Udhar, lifetime received, remaining due.
- Fully settled customers remain visible in historical Khata.

Do not add separate navigation destinations for customers, payments, transactions, or items. They are screens/panels/workflows inside Khata.

## 1.4 New Udhar entry

- Owner can search/select an existing customer or enter a new customer name directly.
- Phone is optional.
- Add multiple products from the saved Products list.
- For each line, enter quantity and a custom selling price chosen by the shopkeeper.
- `line_total = quantity × custom_selling_price`.
- `transaction_total = sum(line_total for all lines)`.
- No manual override of the transaction total.
- Optionally record an initial payment received at the time of saving the Udhar.
- A customer is automatically created/reused according to the safe identity-matching rules in section 4.3.

Example that MUST be represented in tests:
- Fevicol: quantity 3 × ₹550 = ₹1,650.
- PVC Pipe: quantity 5 × ₹350 = ₹1,750.
- Total Udhar: ₹3,400.
- Initial payment: ₹1,000.
- Remaining due: ₹2,400.

Buying price must never override or calculate the custom selling price.

## 1.5 Payments and history

- Inside a customer's Khata detail, owner can record any partial or full payment at any time, multiple times.
- After payment, customer outstanding and dashboard totals update correctly.
- History shows every Udhar, item, quantity, custom price, date, transaction total, payment amount, and payment date.
- Preserve financial history. Do not silently delete or rewrite settled transactions or payments. Corrections must use an auditable reversal/adjustment mechanism or require a documented administrative correction process.
- Do not allow accidental overpayment to produce a negative outstanding balance unless a clearly designed advance-credit concept is explicitly approved. Advance credit is not part of the confirmed MVP.

## 1.6 Web and Android

- Same React frontend source for website and APK.
- Website build deployed to Vercel at `khata.algions.in`.
- Capacitor packages the frontend's compiled local assets in a native Android APK. Do NOT make the APK merely open/load the remote website URL.
- APK package ID `in.algions.khata`, app name `Khata`.
- APK has its own persistent Android signing identity. Debug signing is not production release signing.
- Both clients use the same backend APIs and Neon database.
- Do not put database secrets or Realtime signing secrets into Vite variables or APK assets.

# 2. FIRST PHASE — REPOSITORY INVENTORY AND BASELINE

Before modifying code:

1. Confirm project root and inspect the complete tree. Expected important paths from the archive include:

```text
khata/
  .env.example
  .gitignore
  .neon/config.json
  neon.ts
  render.yaml
  vercel.json
  README.md
  backend/
    package.json
    migrations/001_auth_tables.sql
    scripts/hash-owner-password.ts
    scripts/migrate.ts
    src/app.ts
    src/index.ts
    src/config/{env.ts,database.ts,session.ts}
    src/middleware/{csrf.ts,errorHandler.ts,requireOwnerSession.ts}
    src/modules/auth/{auth.controller.ts,auth.routes.ts,auth.service.ts,auth.validation.ts,loginAttemptStore.ts}
    src/modules/products/products.routes.ts
    src/modules/ledger/ledger.routes.ts
    src/modules/realtime/realtime.service.ts
    tests/auth.security.test.ts
  frontend/
    package.json
    capacitor.config.ts
    src/App.tsx
    src/lib/apiClient.ts
    src/features/auth/*
    src/features/products/ProductsView.tsx
    src/features/khata/KhataLedgerView.tsx
    src/components/{Navbar.tsx,ProtectedRoute.tsx}
    android/app/build.gradle
    android/app/src/main/AndroidManifest.xml
    scripts/generate-keystore.ps1
```

3. Check `git status`, current branch, tracked/untracked files, remotes, and recent commits. Create a new working branch such as `fix/khata-production-remediation` if a Git repository exists. Do not force-push or overwrite user changes. If no remote is configured, do not invent one.
4. Inspect all package scripts and lockfiles. Use the repository's package manager and lockfile. Do not copy platform-specific `node_modules` into deliverables. Install dependencies cleanly using `npm ci` (or the exact package manager/lockfile in the repo).
5. Reproduce the existing baseline tests and builds before edits. Capture failures. If the Linux archive cannot run a Windows-specific package/build, identify that accurately rather than attributing the failure to source code.
6. Produce a private internal map of each finding to file/symbol/line. The final output must include before/after summary and final line ranges.

# 3. DATABASE DESIGN — IMPLEMENT A REAL FINANCIAL KHATA

## 3.1 Migration strategy

- Keep `001_auth_tables.sql` intact unless a verified defect requires a new forward migration.
- Add forward-only, versioned SQL migration(s), for example:
  - `backend/migrations/002_khata_transactions.sql`
  - `backend/migrations/003_payment_allocations_and_indexes.sql` if needed.
- Do not modify a migration that may already have been applied in production. Check a migration tracking table first. Implement migration tracking (e.g. `schema_migrations`) if missing.
- Migrations must be transactional when PostgreSQL permits it, idempotent where appropriate, have explicit constraints/indexes, and be safe to run twice through a migration runner.
- Use a PostgreSQL advisory lock or equivalent to prevent concurrent migration runs.
- Use the **direct Neon connection** for migrations; use the **pooled Neon connection** for normal runtime queries and session store where compatible.
- Never perform migrations on a production database without first verifying the database/branch identity and reporting the target. Do not run DROP/TRUNCATE on production.

## 3.2 Required normalized model

Inspect existing types and preserve compatible IDs/FKs where possible. Use `BIGINT` consistently if current customers/products IDs are `BIGSERIAL`. Do not blindly mix UUID and BIGINT.

Required tables/entities:

### `products`
- `id` primary key.
- `name` non-empty trimmed text.
- `buying_price NUMERIC(12,2)` non-negative.
- `created_at`, `updated_at`.
- `archived_at` nullable (or equivalent safe archive marker).
- Index for active product name search.
- No stock or inventory columns.

### `customers`
- `id` primary key.
- `name` trimmed non-empty text.
- `normalized_name` for stable search/matching.
- `phone` nullable; `normalized_phone` nullable.
- `created_at`, `updated_at`, optional `archived_at` only if needed.
- Partial unique index on `normalized_phone` when it is not null. Handle duplicate phone attempts explicitly.
- Keep customers with historical transactions; never cascade-delete financial history.

### `udhar_transactions`
- `id` primary key.
- `customer_id` FK to customer with RESTRICT/NO ACTION semantics for history protection.
- `transaction_date` and `created_at`.
- `total_amount NUMERIC(12,2)` (server-generated from item lines, never client supplied as authoritative).
- optional `note` only if useful and consistent with existing UI; do not add arbitrary modules.
- status only if needed for reversal/void; preserve original record and require audit metadata.

### `udhar_items`
- `id` primary key.
- `transaction_id` FK.
- `product_id` nullable FK (use `ON DELETE SET NULL` if hard deletion is supported; archive is preferred).
- `product_name_snapshot` NOT NULL.
- `buying_price_snapshot NUMERIC(12,2)` NOT NULL.
- `quantity NUMERIC(12,3)` positive (or use an appropriate integer/decimal precision if the existing product UI is integer-only; validate consistently).
- `selling_price NUMERIC(12,2)` non-negative.
- `line_total NUMERIC(12,2)` server/database calculated from quantity × selling price with defined two-decimal rounding.
- Preserve snapshots even after product updates/archive.

### `payments`
- `id` primary key.
- `customer_id` FK.
- `amount NUMERIC(12,2)` strictly greater than zero.
- `received_at TIMESTAMPTZ` default current timestamp, but allow server-validated date only if the current UI needs it.
- optional short note/reference; do not force payment method unless it is actually required.
- immutable creation/audit timestamps.

### `payment_allocations`
- `id` primary key.
- `payment_id` FK.
- `transaction_id` FK.
- `amount NUMERIC(12,2)` greater than zero.
- Unique/constraint strategy preventing duplicate or over-allocated values.
- The sum allocated to a payment must equal the payment amount (or be explicitly represented if a future unapplied-credit feature is approved; do not silently create customer advances).

### Session and security tables
- Preserve the existing PostgreSQL session store and login-attempt table.
- Ensure all required migrations run before the server reports ready.

## 3.3 Payment allocation rule

The UI requirement is a customer-level payment action inside Khata, not a separate Payments module. Implement a deterministic, auditable allocation policy:

- Record one payment against the selected customer.
- Allocate it to that customer's oldest outstanding Udhar transaction first (FIFO by `transaction_date`, then `created_at`, then `id`). Continue to the next oldest outstanding transaction until the payment is fully allocated.
- Never allocate more than a transaction's current outstanding amount.
- Reject payment greater than the customer's total outstanding with a clear validation error. Do not create negative dues or invisible advance credits.
- Serialize concurrent payment writes for the same customer (e.g. lock the customer row `FOR UPDATE` inside a database transaction) to prevent over-allocation.
- Store each allocation row so the history can explain exactly which Udhar entries a payment settled.
- For initial payment during new Udhar creation, create the transaction, items, payment and allocation(s) atomically in one database transaction; initial payment cannot exceed that new transaction's total.
- Corrections must be auditable; don't edit/delete a payment silently.

Document this FIFO allocation rule in README and in the owner-facing UI help/confirmation text. If the existing UX clearly allocates payments to one selected transaction instead, retain that explicit selection but still support a single payment split across multiple transactions only if the UI states it; do not invent an undisclosed allocation behavior.

## 3.4 Calculation and data integrity rules

- All currency columns use PostgreSQL `NUMERIC(12,2)` (or larger precision if justified), never PostgreSQL `FLOAT`, JS floating-point arithmetic, or integer paise conversion that can overflow.
- Treat `pg` numeric values as strings. Do not call `Number()` to perform authoritative financial calculations.
- Calculate line/transaction totals in SQL or use a decimal arithmetic library in the server and persist numeric strings. Frontend totals are previews only; backend recalculates and validates all totals.
- The server ignores/rejects client-supplied transaction totals and line totals. Client can only supply product ID, quantity and custom selling price per line.
- Reject empty transactions, unknown/archived product IDs, invalid/negative quantity, negative selling price, malformed money, over-precision values, overlong notes, and oversized arrays.
- Use database transactions for customer resolution, transaction insert, items insert, payment insert, allocation insert and computed totals.
- Snapshot product name and buying price at time of Udhar creation. Changing a product later must not change historical lines.
- Add DB constraints and indexes for FKs, customer lookups, dates, and active products.
- Aggregate using SQL `SUM(NUMERIC)` and return money as decimal strings. Format currency in UI with `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })` only for presentation.

## 3.5 Customer identity and duplicate prevention

- Normalize Indian mobile input: accept 10 digits or `+91` + 10 digits; store a consistent normalized `+91XXXXXXXXXX` form. Reject invalid values.
- If a phone number is provided and matches an existing customer, use that customer only after the UI confirms/clearly shows the matched name; if phone conflicts with an explicitly selected different customer, return `409 CUSTOMER_IDENTITY_CONFLICT` and require user selection/correction.
- If no phone is supplied, never merge two similarly named people silently. Search and show matching customer choices; if exactly one normalized exact-name match exists, ask the owner to select that existing record; otherwise create a new customer. Keep a way for the owner to deliberately select an existing result.
- Customer creation occurs only as part of a successful Udhar transaction; do not expose a separate customer-management module or permit creating empty customers with no credit history.
- Prevent duplicate creation under concurrent requests with transaction-level locking/indexes where appropriate.

# 4. BACKEND API — IMPLEMENT REAL PERSISTENT WORKFLOWS

Use the current Express + TypeScript architecture and existing Zod conventions. Split routes into controller/service/repository/validation modules if it improves maintainability. Do not put SQL and financial logic in React components.

## 4.1 Auth endpoints to preserve

Maintain compatible endpoints unless current frontend contract requires a clean versioned change:
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `GET /api/v1/auth/csrf-token` (or the current documented CSRF-token endpoint)
- `POST /api/v1/auth/logout`

Required behavior:
- Exactly one owner configured by `OWNER_PHONE` and `OWNER_PASSWORD_HASH`.
- Password verified using Argon2id; never query the database using a password string.
- Generic invalid credentials response for unknown phone and wrong password.
- Dummy Argon2 verification on unknown phone to reduce enumeration timing differences.
- Strict request schema; accept 10-digit/`+91` normalized phone.
- Session ID regenerated after successful login.
- Server-side session stored in PostgreSQL.
- No JWT, refresh token, client localStorage auth flag or persistent JS-readable bearer token.
- Logout destroys server session and clears cookie.
- Protected APIs reject absent/invalid/expired sessions with 401.
- CSRF check on every state-changing cookie-authenticated request.

## 4.2 Products API

Implement/test at least:
- `GET /api/v1/products?search=` — active products, paginated or bounded.
- `POST /api/v1/products` — name + buyingPrice only.
- `PATCH /api/v1/products/:id` — edit name and/or buying price.
- `DELETE /api/v1/products/:id` or explicit archive endpoint — archive safely; never erase historical item snapshots.

Validation:
- name trimmed, non-empty, reasonable max length.
- buying price decimal, non-negative, max 2 decimals.
- all routes require owner session and CSRF for writes.
- archived products cannot be selected for new Udhar, but remain represented in past item snapshots.
- frontend must expose add/edit/archive and search. Confirm before archive. Never show stock fields.

## 4.3 Khata APIs

Use a single Khata domain; route naming can be adapted to the existing `/ledger` contract, but keep it understandable and consistent. Suggested endpoints:

- `GET /api/v1/khata/summary` — total distinct Udhar customers (including fully settled), total outstanding, all-time total received.
- `GET /api/v1/khata/customers?search=&cursor=` — customer list/search with `totalUdhar`, `totalReceived`, `outstanding` per customer.
- `GET /api/v1/khata/customers/:customerId` — customer profile + balance summary.
- `GET /api/v1/khata/customers/:customerId/history` — paginated Udhar transactions and payment history, preserving chronological order and allocations.
- `POST /api/v1/khata/transactions` — create one Udhar transaction with one or more item lines and optional initial payment.
- `GET /api/v1/khata/transactions/:transactionId` — full transaction + items + allocation/payment detail.
- `POST /api/v1/khata/customers/:customerId/payments` — record a customer-level partial/full payment and allocate deterministically according to section 3.3.

Every endpoint must:
- Require valid owner session.
- Validate request using Zod.
- Use parameterized SQL.
- Apply CSRF to state-changing operations.
- Return stable typed response shapes.
- Return proper 400/401/403/404/409/422/429/503 status codes.
- Never return mock data or hide a database failure.
- Bound result sizes and implement pagination where history can grow.

## 4.4 Transaction-create request/response contract

Use a request conceptually equivalent to:

```json
{
  "customer": {
    "id": null,
    "name": "Ramesh Kumar",
    "phone": "9876543210"
  },
  "items": [
    { "productId": 1, "quantity": "3", "sellingPrice": "550.00" },
    { "productId": 2, "quantity": "5", "sellingPrice": "350.00" }
  ],
  "initialPayment": "1000.00"
}
```

The agent must adapt field naming to existing TS types, but maintain this semantic contract. The client MUST NOT be allowed to set authoritative `totalAmount`, `lineTotal`, `outstanding`, `buyingPriceSnapshot`, `productNameSnapshot` or customer balance. Server loads product snapshots from PostgreSQL and calculates all totals.

Expected persisted result for the example:
- item line totals 1650.00 and 1750.00.
- transaction total 3400.00.
- payment 1000.00.
- outstanding 2400.00.

## 4.5 Dashboard summary SQL correctness

Write integration tests proving:
- Customer count includes every customer with at least one valid historical Udhar, even if outstanding equals zero.
- Customer count excludes any customer record without a transaction (normally impossible through the UI, but enforce query semantics).
- Total outstanding = sum of transaction totals − sum of allocated payments, never negative.
- Total received = sum of all accepted payments, not merely payment allocated in the current month.
- Per-customer values reconcile with global totals.
- Archived products do not erase historical totals.

# 5. FRONTEND — COMPLETE THE OWNER WORKFLOWS

Retain React + Vite + current styling approach. Keep the design simple and usable on desktop and mobile. No separate CRM/payment pages.

## 5.1 Login and app shell

Inspect and preserve the existing login design if it is good. Verify:
- 10-digit Indian mobile input, with optional `+91` normalization.
- Password input with accessible show/hide control if present.
- Generic invalid credential message.
- Lockout countdown based on server `remainingMs`, not client-only timer state.
- Loading state prevents duplicate submissions.
- No credential or auth flag in localStorage/sessionStorage.
- On startup call `/auth/me`; show LoginPage if unauthenticated.
- On logout call server, destroy session, clear in-memory owner state and navigate to login.
- Proper 401/403/429/503 error handling.
- Responsive/accessible labels, keyboard navigation, focus management, and screen-reader feedback.

## 5.2 Products view

File to inspect: `frontend/src/features/products/ProductsView.tsx`.

Implement:
- Product list with product name and buying price.
- Search by product name.
- Add product form.
- Edit product form/modal.
- Archive/delete confirmation.
- Validation errors shown next to the relevant fields.
- Pending/success/error states.
- Refresh state after create/update/archive.
- No inventory count or automatically derived selling price.

## 5.3 Khata view

File to inspect: `frontend/src/features/khata/KhataLedgerView.tsx`.

Complete these views within Khata, not as new navigation modules:

### A. Khata overview
- KPI: total Udhar customers.
- KPI: total amount to receive.
- KPI: total payments received (all time).
- Searchable customer list by name/phone.
- Per row: total Udhar / received / remaining.
- Show settled customers with zero outstanding and preserve their history.
- Empty state should say no Udhar customers yet; it must not fabricate records.

### B. New Udhar form
- Customer selector/search that can select an existing customer.
- New customer name entry if none selected.
- Optional phone.
- Add/remove multiple product lines.
- Product search/select from active Products.
- Quantity input.
- Custom selling price input for every line (independent of buying price).
- Live preview calculations using decimal-safe arithmetic; backend remains authoritative.
- Display the line total and transaction total.
- Optional initial payment received.
- Show calculated outstanding after initial payment.
- Submit disabled until valid; show server validation errors.
- Do not offer manual total override.

### C. Customer detail and payment
- Customer name and optional phone.
- Total Udhar, total received and outstanding.
- Full historical Udhar list, each transaction date and amount.
- Expand transaction to see product name snapshots, quantity, custom selling price, line totals and transaction total.
- Payment history with payment dates and amounts.
- Payment form to record a partial or full payment. Show the resulting balance.
- If FIFO allocations are used, show which historical transactions were settled by that payment in a simple detail view.
- Do not add a separate global Payments page.

### D. UX integrity
- Use request states: idle/loading/submitting/success/error.
- Avoid stale balance display after a payment; refetch summary and customer detail after successful writes.
- Do not optimistic-update totals unless rollback is correct; server result is the source of truth.
- Avoid sample fixture values in production builds.
- Do not silently hide network or database errors.

## 5.4 Frontend API client

Inspect `frontend/src/lib/apiClient.ts`, `authApi.ts`, and all API wrappers:
- Use a single base URL from `VITE_API_BASE_URL`.
- Include `credentials: 'include'` for cookie sessions.
- Acquire/refresh the CSRF token using the backend contract; keep it in memory only.
- Attach `X-CSRF-Token` to state-changing methods.
- Handle `401` consistently by clearing auth state; don't redirect on a temporary `503` as if logged out.
- Never contain database credentials, `NEON_REALTIME_SECRET`, `OWNER_PASSWORD_HASH`, or `SESSION_SECRET` in frontend files or Vite environment.
- Do not log full API payloads containing private customer data in production.

# 6. AUTHENTICATION AND SECURITY REMEDIATION

Inspect and repair the existing files:
- `backend/src/config/env.ts`
- `backend/src/config/database.ts`
- `backend/src/config/session.ts`
- `backend/src/modules/auth/auth.service.ts`
- `backend/src/modules/auth/auth.controller.ts`
- `backend/src/modules/auth/loginAttemptStore.ts`
- `backend/src/middleware/csrf.ts`
- `backend/src/middleware/requireOwnerSession.ts`
- `backend/src/middleware/errorHandler.ts`
- `backend/src/app.ts`
- `backend/tests/auth.security.test.ts`

## 6.1 Environment validation

Use Zod or the existing env-validation approach. In production, startup must fail if any required value is missing, invalid, or still an obvious placeholder. Do not use `.default()` for production secrets or production owner credentials.

Recommended names (adapt only if the actual code uses equivalent names consistently):

```env
NODE_ENV=production
PORT=5000
TRUST_PROXY=1

OWNER_PHONE=<10-digit-owner-phone>
OWNER_PASSWORD_HASH=<argon2id-hash>

# Runtime pooled Neon PostgreSQL connection
DATABASE_URL_POOLED=<new-rotated-pooled-connection-string>
# Direct Neon PostgreSQL connection for migrations only
DATABASE_URL=<new-rotated-direct-connection-string>

SESSION_SECRET=<new-random-32-plus-byte-secret>
SESSION_MAX_AGE_MS=604800000
SESSION_COOKIE_NAME=khata_session
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_HTTP_ONLY=true
SESSION_COOKIE_SAME_SITE=lax

FRONTEND_URL=https://khata.algions.in
VITE_API_BASE_URL=https://api-khata.algions.in

LOGIN_MAX_ATTEMPTS=5
LOGIN_FAILURE_WINDOW_MS=900000
LOGIN_LOCK_DURATION_MS=900000
LOGIN_EXTENDED_THRESHOLD=10
LOGIN_EXTENDED_WINDOW_MS=86400000
LOGIN_EXTENDED_LOCK_DURATION_MS=1800000
LOGIN_LOG_RETENTION_DAYS=30

# Only required if actual Neon Realtime SDK is implemented
NEON_REALTIME_URL=<current-url-from-Neon-console>
NEON_REALTIME_SECRET=<new-rotated-secret>
```

Rules:
- `SESSION_MAX_AGE_MS=604800000` = seven days.
- Make the configured semantics explicit: seven-day inactivity expiry with rolling expiry on authenticated activity, if this remains the intended implementation. If the code instead implements an absolute seven-day expiry, document that clearly and keep it consistent across DB TTL and cookie maxAge.
- Never hardcode real values into `.env.example`; placeholders only.
- Local development may load `.env` and `.env.local` explicitly and safely. Inspect Neon CLI behavior: if `neon deploy` writes `.env.local`, backend must either intentionally load that file in development or the user must explicitly map its values. Do not silently assume `.env.local` is loaded by Node.
- Render values must be entered in Render's Environment settings; never commit production `.env` files.
- Vercel only needs public `VITE_API_BASE_URL`, not backend secrets.
- The APK must contain no server secrets.

## 6.2 Session and cookie behavior

- Use `express-session` and `connect-pg-simple` (or current PostgreSQL session store already installed).
- No MemoryStore in production.
- Store opaque session IDs server-side; no JWT or refresh tokens.
- `HttpOnly=true`, `Secure=true`, `SameSite=Lax`, `Path=/`, no `Domain` attribute (host-only cookie for `api-khata.algions.in`).
- Strict credentialed CORS origin allowlist for `https://khata.algions.in`. Add the Capacitor origins only after verifying the actual native app request origin. Never use wildcard origin with credentials.
- `app.set('trust proxy', 1)` or equivalent only for the known Render reverse-proxy hop; do not trust arbitrary forwarded IP headers without a trusted proxy boundary.
- Regenerate session ID on successful login.
- Destroy session on logout and clear cookie with matching name/path/sameSite/secure options.
- Set `Cache-Control: no-store` for auth/private ledger responses.
- Make session DB readiness part of backend readiness. Do not serve protected routes if the session store cannot function.

## 6.3 CSRF / CORS / Origin

- Continue synchronizer-token CSRF protection for cookie-authenticated POST/PATCH/PUT/DELETE.
- Ensure the login flow, CSRF token bootstrap, and logout have a well-defined Origin/Referer policy.
- Validate `Origin` against exact allowlisted origins; use carefully documented fallback for native requests that legitimately omit `Origin`. Do not treat arbitrary missing Origin as trusted browser traffic.
- Ensure cross-origin requests use `credentials: include` client-side and `credentials: true` server-side with exact origin.
- Same root site subdomains `khata.algions.in` and `api-khata.algions.in` are cross-origin but same-site over HTTPS. Do not confuse same-site with same-origin.
- Confirm cookies are sent in Chrome/Edge browser using DevTools, and in actual Android WebView separately.

## 6.4 SQL injection / XSS / input validation

- Every SQL query with user-supplied input must use placeholders (`$1`, `$2`, etc.). Never string-interpolate values into SQL.
- Static SQL identifiers (sort columns/order) must be allowlisted; never accept raw client SQL or arbitrary field names.
- Use strict Zod validation for every API body, query and path param.
- Reject unknown/unexpected fields where practical.
- Use React's normal escaping; do not use `dangerouslySetInnerHTML` for customer/product/user content. If rich text is introduced (not expected), sanitize with a maintained sanitizer.
- Limit JSON body to 10kb or a justified larger limit for the known request shape.
- Helmet/security headers and CSP must allow only actual required API and Realtime endpoints; avoid broad `*` sources.
- Production error handler returns safe generic errors and an error ID; stack traces and SQL errors only in server logs with secrets and customer details redacted.

## 6.5 Persistent brute-force controls

Fix the issues in `loginAttemptStore.ts`:
- Persistent PostgreSQL attempt/lockout records; no in-memory fallback in production.
- Protect by both normalized owner account identifier and source IP (or HMAC hashes of those identifiers). Use keyed HMAC, never store raw passwords, and avoid exposing phone number in logs.
- Apply documented policy consistently: 5 failed attempts in 15 minutes → 15-minute lock; 10 failures in 24 hours → 30-minute extended lock. Be precise whether threshold triggers on 5th or 6th attempt; tests and UI must agree. Prefer lock immediately when the configured threshold is reached.
- Do not permanently lock the owner account and enable attackers to deny service. Use bounded, expiring locks and safe recovery.
- Bound storage growth with indexed cleanup/retention and a scheduled or opportunistic bounded cleanup query. Avoid unbounded in-memory arrays.
- If the database is unavailable, return 503 for login rather than bypassing persistent controls.
- Ensure `phone_hash` is actually used in queries/thresholds or remove the unused field.
- Test attacks from multiple IPs and repeated owner-identifier attempts.

## 6.6 Database TLS

- Remove `rejectUnauthorized: false`.
- Use Neon-supported connection settings with TLS verification enabled. Prefer the connection string's required SSL mode and standard certificate verification.
- Never disable certificate verification to suppress a connection error. Resolve the correct CA/driver/runtime issue instead.

# 7. NEON SETUP AND REALTIME

## 7.1 Neon CLI and project

- Inspect `neon.ts`, `.neon/config.json`, and installed Neon CLI/agent skill before running any init/deploy command.
- Read the installed Neon agent skill and current official docs. Determine the exact current schema for `neon.ts` and service declarations; the current repository's config may be wrong. Do not assume a plain object export is supported if the current CLI requires `defineConfig()` or another documented format.
- Verify organization/project/branch exactly: org `org-red-haze-69535662`, project `shy-mud-94919289`, branch `production`.
- Verify that the production branch is in the expected Singapore region. Use the current Neon Console/CLI values; do not hardcode endpoint hostnames from the previous report.
- If the user is not authenticated and CLI opens a browser, tell the user to complete browser sign-in. If it times out, request that they run `neon login`; do not claim deploy succeeded.
- Do not rerun init if the configured existing project is already initialized; prevent accidental duplicate resources.
- Run `neon deploy` only after config inspection and target verification. Capture redacted output.

## 7.2 Runtime vs direct connections

- `DATABASE_URL_POOLED` (or one equivalent consistent variable) is used by backend runtime API queries and PostgreSQL session store if supported by the chosen driver.
- `DATABASE_URL` is direct and used by migrations/administrative commands.
- Use a single shared connection pool per backend process; never create a new pool for each request.
- Set pool max, idle timeout, connection timeout and SSL explicitly with conservative values for Render Free/small instance and Neon's pooler limits.
- Add readiness endpoint that verifies a lightweight DB query and session store dependency; separate liveness (process alive) from readiness (dependencies available).
- Never log the connection string.

## 7.3 Migrations and health

- Update the migration runner so it reads the direct connection variable, acquires an advisory lock, checks migration history, runs unapplied migrations transactionally, records checksums/version, and exits non-zero on failure.
- Add a command such as `npm run migrate` to backend package scripts.
- Add a non-destructive DB integration test that connects to a dedicated test database/branch, writes/reads/updates/deletes test fixture records in a transaction or isolated schema and cleans them safely. Do not use production data for destructive tests.
- Do not mark readiness healthy if DB/session dependencies are down.

## 7.4 Neon Realtime: implement the real SDK or explicitly defer it

The prior `realtime.service.ts` appears to create a custom HMAC token, not a proven Neon subscription. Do not retain fake/custom protocol code as if it were working.

1. Read the current Neon Realtime skill/docs and SDK package docs. Confirm the exact package, method signatures, endpoint format, supported backend runtime, and supported client integration at implementation time.
2. Use the official supported Neon Realtime SDK/API. Do not invent an endpoint, `seal` format, HMAC payload, WebSocket protocol, or client hook.
3. Backend must create/seal only an allowlisted set of queries. Do not permit the browser to submit arbitrary SQL. Realtime secret is backend-only.
4. Query scope must be restricted to data this one authenticated owner may access. A signed query/subscription must not allow access to other projects/branches or arbitrary database tables.
5. Frontend subscribes only to the required Khata totals/customer/ledger updates. A Realtime notification should cause safe refetch via the authenticated REST API or use the officially supported live query result. It must not bypass the normal auth/data validation layer.
6. Reconnect, unsubscribe on component unmount/logout, handle stale/duplicate events, and fall back to normal REST refetch if realtime is unavailable.
7. Verify an end-to-end real change: create a test Udhar or payment in one client, observe an update in another browser/APK session without manual refresh. Capture timestamps and evidence.
8. If the current Neon Realtime product/SDK does not support the app's required query/runtime or cannot be tested, do not fake it. Remove/deactivate the custom pseudo-integration, leave REST as reliable source of truth, document Realtime as deferred, and state exactly why. Do not block core Khata operation on Realtime.

# 8. ANDROID / CAPACITOR — REAL SIGNED APK

Inspect:
- `frontend/capacitor.config.ts`
- `frontend/android/app/build.gradle`
- `frontend/android/app/src/main/AndroidManifest.xml`
- `frontend/scripts/generate-keystore.ps1`
- `frontend/package.json`
- `.gitignore`

## 8.1 Local bundled frontend

- `capacitor.config.ts` must not set `server.url` to `https://khata.algions.in` for the release build. Local build assets must be synchronized into Android assets (`npx cap sync android`).
- Build flow: frontend production build → Capacitor asset copy/sync → Android Gradle build.
- The APK should launch the locally bundled frontend even if offline; API operations can show a clear offline/network state.
- Android uses `VITE_API_BASE_URL=https://api-khata.algions.in`; this is public API URL only.
- Confirm no `.env`, secrets, source maps with secrets, source `.git`, or signing artifacts are bundled in APK assets.

## 8.2 Cookie/session compatibility

- Do not claim native cookie auth works based only on a Supertest Origin header test.
- Verify Capacitor's real WebView origin, cookie jar, `CapacitorCookies`, `CapacitorHttp`/native HTTP behavior and credential forwarding using the installed Capacitor version's official docs.
- Preserve the opaque server-side session architecture and HttpOnly protections. Do not silently move the session ID to localStorage or a JS-readable token.
- Test on an actual Android device or emulator: login, `/auth/me` after app restart, protected Products request, create Udhar, record payment, logout, and replay of old session must fail.
- If cookie behavior is incompatible, design the smallest secure native-specific bridge using the platform cookie store while keeping secrets inaccessible to JS. Do not introduce JWT/refresh tokens without documenting the incompatibility and obtaining owner approval.
- Configure exact allowed native origins only when confirmed. Do not allow arbitrary custom schemes/origins.

## 8.3 Release signing

- The existing debug APK is not an acceptable production deliverable. Create the Gradle `signingConfig` for release and wire it to secure local `signing.properties` or environment variables.
- Keep `signing.properties`, `.jks`, `.keystore`, key passwords and private signing material out of Git and ZIP distributions.
- Do not generate a permanent owner signing key automatically in the shared/cloud workspace. Ask the owner to create or provide the release key securely if not already available.
- Ensure the Gradle release build fails if required release signing config is absent; do not silently fall back to debug signing for release.
- Provide a script for owner-controlled key generation, explain backup/restore, and never print the key password.
- Build `assembleRelease`, locate the release APK, run `apksigner verify --verbose --print-certs`, confirm certificate is the expected release cert (not `CN=Android Debug`), record SHA-256 checksum and file size.
- Future APK updates must use exactly the same signing identity. Document the critical risk of losing the keystore.

# 9. HOSTING CONFIGURATION AND COST SAFETY

## 9.1 Render

Inspect `render.yaml` carefully. The prior audit found `plan: starter` in the archive, which can generate a bill.

- Do not deploy `starter` without explicit owner approval.
- Prefer the Render Free plan if currently supported and consistent with owner intent. Verify current Render Blueprint syntax and free-plan limitations before changing it. Document sleep/cold-start implications.
- Align Render region with Neon Singapore if currently available and if it does not cause a paid upgrade; verify actual region slug from current Render docs/dashboard.
- Define all required backend environment variables without putting literal secrets in YAML. Use Render's secret/environment mechanism.
- Define health check path that reflects readiness, not only process alive. Avoid a health-check loop that constantly queries the DB and prevents Neon autosuspend unless necessary.
- Do not create extra Redis/worker services. This is a small modular monolith.

## 9.2 Vercel

- Keep the SPA fallback and security headers in `vercel.json` but fix the CSP so only actual API and documented Realtime hosts are permitted.
- Public environment variable only: `VITE_API_BASE_URL=https://api-khata.algions.in`.
- Never put server secrets in Vercel.
- Note Vercel Hobby plan commercial-use limitations; do not assert Hobby is appropriate for a commercial business workflow without checking current terms. Do not upgrade billing automatically.
- Do not change `www.algions.in` routing or its existing project.

## 9.3 DNS and SSL

Document required DNS mapping only; do not change DNS records without permission:
- `khata.algions.in` → Vercel target provided by Vercel.
- `api-khata.algions.in` → Render target provided by Render.
- `www.algions.in` remains as is.
Use HTTPS for both. Do not invent provider DNS target values. TLS certificates are provisioned by hosting providers after correct DNS verification.

# 10. TEST PLAN — MUST RUN AND CAPTURE REAL EVIDENCE

Create a dedicated test plan and actually execute what can be executed. Mark unavailable external/device tests as NOT RUN, not PASS.

## 10.1 Static/build checks

- Backend: `npm ci`, `npm run typecheck` if present, `npm run build`.
- Frontend: `npm ci`, `npm run typecheck` if present, `npm run build`.
- Run lint and formatter scripts if present.
- Verify lockfiles are committed and no cross-platform cached node_modules are relied upon.

## 10.2 Auth/security tests

Test at least:
1. Correct owner phone + correct password succeeds.
2. Wrong password returns generic 401.
3. Unknown phone returns indistinguishable generic 401.
4. `1=1`, `' OR '1'='1`, `admin' --`, `'; DROP TABLE ...` in password/phone fields never bypass auth or execute SQL.
5. Script/XSS input never executes or becomes HTML.
6. Missing session → 401 on every protected endpoint.
7. Invalid/expired session → 401.
8. Session ID changes after successful login.
9. Session remains valid across backend restart because it is PostgreSQL-backed.
10. Logout destroys session; replay old cookie returns 401.
11. CSRF absent/invalid token rejects write methods.
12. Unapproved Origin rejected; allowed browser origin works with credentials.
13. Lockout triggers on exactly the configured threshold and works across backend restart and multiple IPs/account buckets.
14. DB down means login/API returns safe 503, never uses in-memory or sample fallback.
15. Missing production env secrets causes startup failure.
16. No secret appears in client build, API responses, headers or logs.
17. Malformed/oversized JSON rejected.
18. Security headers present.
19. TLS verification remains enabled.

## 10.3 Products tests

1. Add a product.
2. Search exact/partial product name.
3. Update name.
4. Update buying price.
5. Archive product.
6. Archived product cannot be selected for new Udhar.
7. Historical items still show original product name/buying price after product edit/archive.
8. Negative, malformed, too-precise price rejected.

## 10.4 Khata financial correctness tests

1. Save the Fevicol/PVC example and assert total 3400.00.
2. Record initial payment 1000.00; assert due 2400.00.
3. Record further payment 500.00; assert due 1900.00.
4. Settle remaining 1900.00; assert customer due 0 and customer remains in history/customer count.
5. Add multiple Udhar transactions for one customer; verify lifetime totals.
6. Make a payment that spans two oldest transactions; verify FIFO allocations exactly.
7. Reject payment greater than total outstanding.
8. Reject empty item array, zero/negative quantity and invalid custom selling price.
9. Verify buying price is never auto-used as selling price.
10. Verify client-provided line/transaction totals cannot be tampered with.
11. Verify customer phone normalization and duplicate collision behavior.
12. Verify two concurrent payments cannot over-allocate or produce negative due.
13. Verify database error returns 503/500 and never fake fixture data.
14. Verify deleted/archived product and customer history remains intact.
15. Dashboard global totals equal the sum of individual customer balances and all-time payment history.

## 10.5 Neon integration tests

Against a dedicated test branch/database (not production destructive operations):
- Connect using pooled runtime URL and execute basic `SELECT 1`.
- Connect using direct URL and run migrations.
- Confirm migration history and all expected tables/indexes/constraints exist.
- Create/read/update/archive a product.
- Create customer + Udhar + items + initial payment atomically.
- Read ledger and totals.
- Record partial/full payment.
- Restart API and prove session persistence.
- Simulate DB unavailable and prove safe failure.
- Realtime test (only if implementation is real): subscribe from Client A, write from Client B, observe an event/refetch without manual reload; test cleanup/reconnect and authorization.
- Capture redacted command output, database branch name, timestamp and exact test names.

## 10.6 Android tests

If an emulator/device is attached:
- Build and install signed release APK (or debug first for test, then release verification).
- Verify package ID/name.
- Login; session cookie persists after app restart as designed.
- Call `/auth/me` and protected APIs.
- Create transaction, inspect it in website browser.
- Record payment on website, verify it appears in APK.
- Logout and verify protected API denied.
- Verify offline launch and clear offline operation error.
If no device/emulator is available, state exactly that Android runtime authentication remains NOT TESTED and provide the command the owner should execute. Do not report it as passing.

# 11. TEST FIXTURES AND DATA SAFETY

- Unit/integration tests must use isolated test fixtures and never seed fake names/products into a production database.
- Use test-only DB URL or test schema. Add safeguards preventing test scripts when `NODE_ENV=production` or when database URL points to the production Neon branch.
- Remove production fallback arrays (including names such as Ramesh Kumar, Suresh Sharma, Anil Verma and hardcoded totals). Test fixtures belong only under test directories or explicit development seed scripts that are never automatically run in production.
- Ensure test runner cannot accidentally contact production Neon.

# 12. CODE QUALITY AND IMPLEMENTATION DETAILS

- Use clear TypeScript types for API request/response contracts shared between frontend/backend if repository supports it.
- Keep financial business logic in backend service/repository layer.
- Keep route handlers thin.
- Use parameterized SQL and explicit transactions.
- Use consistent API error format, for example `{ code, message, requestId, details? }`; never leak DB internals.
- Validate numeric strings before SQL; define maximum amount and quantity constraints to prevent overflow.
- Use database-generated timestamps in UTC (`TIMESTAMPTZ`); format dates in the UI using the user's local timezone only for display.
- Use stable sorting and pagination.
- Add indexes for `customers.normalized_name`, `customers.normalized_phone`, transaction `customer_id/date`, payment `customer_id/received_at`, allocation FKs, and active product search.
- Keep auditability: do not silently delete/alter financial rows. Use archival and correction/reversal records.
- Avoid overengineering: no microservices, Redis, queue worker, Kubernetes, R2, or additional infrastructure for this MVP.

# 13. DOCUMENTATION AND ENVIRONMENT HANDOFF

Update `README.md` with:
1. Architecture diagram and domain mapping.
2. Prerequisites and supported Node/Java/Android SDK versions.
3. Local setup commands from clean checkout.
4. How to create Argon2id owner password hash using the existing interactive CLI. Do not put the plain password in docs or command history.
5. Exact `.env` vs `.env.local` behavior and how Neon CLI writes/uses them.
6. Environment variable table with purpose, whether public/server-only, and where configured (local, Render, Vercel).
7. Neon CLI login/init/deploy steps using the existing project only; no secret values.
8. Database migration/rollback/backup procedure.
9. Render deployment and cost plan warning.
10. Vercel deployment and custom domains.
11. Capacitor sync/build/install steps.
12. Release keystore creation and secure backup process.
13. Test commands and expected evidence.
14. Known limitations and tests not run.

`.env.example` must be updated with placeholders only. `.gitignore` must exclude:
- `.env`, `.env.*` except `.env.example` (if appropriate),
- `*.jks`, `*.keystore`, `signing.properties`,
- `node_modules/`, `dist/`, build/cache outputs,
- Android `local.properties`,
- logs, coverage, test result artifacts containing sensitive data.

Do not place credentials in `render.yaml`, `vercel.json`, source code, README or ZIP.

# 14. REQUIRED IMPLEMENTATION ORDER

Complete in this order to reduce integration conflicts:

**Phase A — baseline / architecture / environment**
- Audit repo, preserve branch/changes, inspect all existing contracts.
- Correct environment schema and safe config.
- Fix DB pools/TLS and readiness.
- Fix migration tracking and Neon project config.

**Phase B — database model**
- Add normalized transaction/items/payments/allocation schema.
- Add constraints/indexes.
- Add safe customer resolution and allocation service contracts.
- Run migrations on a dedicated test branch first.

**Phase C — backend business logic**
- Implement product CRUD/archive.
- Implement Khata summary, customer list/history, transaction creation, payments and FIFO allocation.
- Remove all production sample/fallback data.
- Add safe errors and strict validation.

**Phase D — authentication hardening**
- Fix env hardcoded defaults, lockout logic, TLS, session and CSRF details.
- Add persistent DB-backed auth tests and multi-IP tests.

**Phase E — frontend completion**
- Complete product edit/archive UX.
- Complete customer selector + auto-create and multi-line Udhar form.
- Complete customer detail, payment and history UI.
- Reconcile all totals with server responses.

**Phase F — Neon Realtime**
- Implement using official current SDK or remove the fake integration and document deferral.
- Prove real event-driven update end-to-end.

**Phase G — Android and hosting**
- Fix native cookie/session behavior and test device/emulator.
- Implement release signing config and generate/verify release APK only with owner-provided secure key.
- Correct Render plan/region/cost and Vercel CSP/env configuration.

**Phase H — independent verification**
- Run all builds and tests from a clean install.
- Independent QA/security agent reviews actual diff and attempts to falsify every claimed PASS.
- Resolve all P0 defects before any production release recommendation.

# 15. FINAL ACCEPTANCE GATES — CANNOT CLAIM COMPLETE UNTIL ALL MET

## P0 — Release blocking
- [ ] Real products CRUD/archive works against Neon.
- [ ] Real customer creation/reuse works during first Udhar.
- [ ] Multiple item lines with custom selling price work.
- [ ] Transaction totals are server-computed with NUMERIC-safe arithmetic.
- [ ] Initial and subsequent payments work and reconcile correctly.
- [ ] Customer history remains complete and settled customers remain visible.
- [ ] No sample/fallback financial responses in any production route.
- [ ] Required production secrets have no hardcoded defaults.
- [ ] DB migrations and connection have been tested against the intended Neon project/branch.
- [ ] Auth/CSRF/CORS/rate-limiting tests pass with real PostgreSQL-backed stores.
- [ ] No secrets are included in frontend bundle or APK assets.
- [ ] Release Gradle config is valid and permanent release signing is verified.
- [ ] No unapproved paid Render service is created or configured for deployment.

## P1 — Required before broad use
- [ ] Actual Android device/emulator session persistence, login/logout and financial workflow tested.
- [ ] Website ↔ Android data consistency tested.
- [ ] Realtime works with official SDK end-to-end, or is clearly deferred with REST fallback functioning.
- [ ] Backups/restore procedure documented and tested on a non-production copy.
- [ ] Monitoring/readiness/error handling verified.

# 16. FINAL RESPONSE FORMAT — REPORT FACTS, NOT PROMISES

When finished, return a detailed implementation report with these sections:

1. **Executive result:** Completed / Partially completed / Blocked. Do not use “production ready” unless every P0 gate is proven.
2. **Files changed:** table of file path, exact change, and final line ranges.
3. **Database schema:** tables, constraints, indexes, migrations and exact Neon branch used (redacted).
4. **Backend APIs:** method/path, request/response contract and authorization.
5. **Frontend:** login, products, Khata overview, new Udhar, customer detail/payment flows implemented.
6. **Authentication/security:** cookie settings, session TTL semantics, CSRF, rate limiting, TLS and secret handling.
7. **Neon:** CLI commands run, project/branch verified, direct/pooled connection tests, Realtime result.
8. **Android:** package ID, local asset bundling, debug/release status, keystore/signature verification, APK path, SHA-256; device test result.
9. **Hosting/cost:** Render plan/region configuration, Vercel config, custom-domain status, any paid service risk. State whether any paid resource was created (must be no unless approved).
10. **Commands and actual outputs:** exact commands with relevant redacted output for `npm ci`, typecheck, builds, tests, migration, DB integration and Android build/signing.
11. **Acceptance checklist:** PASS / FAIL / NOT RUN for every P0/P1 gate, with evidence links/paths.
12. **Remaining blockers:** every uncompleted task and the exact action/credential/device/approval required from owner.
13. **Security note:** confirm old exposed Neon credentials were rotated; if not confirmed, state production use remains blocked.

Never say “all tests pass” if only mocked/unit tests ran. Distinguish unit tests, DB integration tests, live Neon tests, browser tests, Android emulator tests and physical device tests. Attach sanitized logs/results under `reports/` if the repo convention allows it. Do not include secrets in the report.

---

# START NOW

Begin with repository inventory and baseline reproduction. Then execute Phases A–H in order. Use subagents for bounded work if available, but integrate everything into one coherent, working application. Make code changes—not just recommendations. Preserve the single-owner Khata requirements exactly. Do not stop after authentication; the core purpose is a functioning Khata book with accurate customer balances, Udhar items and payments. Finish by running the full acceptance suite and returning the evidence-based report described above.
