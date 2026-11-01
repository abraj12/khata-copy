# Khata - Changelog

All notable changes to the Khata project are documented in this file.

---

## [1.4.0] - 2026-11-01

### Added
- **Accessible Searchable Combobox Pickers:** Introduced `frontend/src/components/SearchablePicker.tsx` replacing native select dropdowns in the New Udhar form for both Customer selection and Product selection. Features search icon, clear query button, keyboard navigation (Up/Down/Enter/Escape), ARIA live region, desktop popover dropdown, and mobile bottom sheet with body scroll-lock.
- **Debounced Remote Search Hook (`useRemoteSearch`):** Implemented `frontend/src/hooks/useRemoteSearch.ts` with 280ms debouncing, in-flight cancellation via `AbortController`, monotonic request ID tracking against race conditions, bounded pagination ("Load More"), and error/retry states.
- **Server-Side Search & Bounded Pagination APIs:**
  - `GET /api/v1/khata/customers`: supports `search`, `limit`, and `offset` with Indian phone digits normalization and composite indexes.
  - `GET /api/v1/products`: supports `search`, `limit`, and `offset` with wildcard escaping and pagination metadata.
- **Database Migration 005:** Added `backend/migrations/005_search_indexes_and_identity_constraints.sql` introducing composite indexes on `customers (normalized_name, id)`, `customers (normalized_phone)`, `products (name, id)`, and `udhar_transactions (customer_id, transaction_date DESC, id DESC)`.
- **Backend & Readiness Security Hardening:**
  - Checked out single dedicated PostgreSQL client for advisory lock acquisition and release in `loginAttemptStore.ts`.
  - Propagated CSRF session save failures with HTTP 503 in `auth.controller.ts`.
  - Masked raw database traces, passwords, and connection strings in `errorHandler.ts` and `/api/v1/health/ready`.
  - Added production guard in `env.ts` rejecting `sslmode=disable`.
- **Search API Automated Test Suite:** Added 9 automated tests in `backend/tests/search.api.test.ts` verifying case-insensitive product search, bounded pagination, wildcard escaping, phone normalization, stable ordering, default parameters, and aggregate independence. All 58 backend tests passing.

---

## [1.3.0] - 2026-11-01

### Added
- **Hardware Retail Integer Quantity Enforcement:** Strictly constrained hardware item quantities to whole numbers ($1 \le \text{quantity} \le 1,000,000$). Rejects any fractional/decimal inputs (`1.5`, `0.5`, `2.00`) with explicit error message: `"Quantity must be a whole number."`
- **Strict Money Precision Validation:** Enforced maximum 2 decimal places (`/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/`) across buying prices, selling prices, and payments in both frontend and backend. Rejects exponential notation, excess precision, and negative values.
- **Database Migration 004 & Preflight Audit Script:** Added `backend/migrations/004_integer_quantity_and_money_constraints.sql` and `backend/scripts/preflight-quantity-check.ts` to audit `udhar_items` for fractional quantities before applying type conversion to `INTEGER`.
- **Dual Custom Domain CSP & Client Configuration:** Updated `vercel.json` and `frontend/vercel.json` CSP `connect-src` to permit both `https://api-khata.algions.in` and `https://khata-api-wkn9.onrender.com`. Configured `frontend/src/lib/apiClient.ts` to support both `VITE_API_BASE_URL` and `VITE_API_URL`.

---

## [1.2.0] - 2026-11-01

### Added
- **Canonical Documentation Suite:** Complete overhaul and consolidation of all technical documentation under `docs/`:
  - [PRODUCT_REQUIREMENTS.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/PRODUCT_REQUIREMENTS.md)
  - [ARCHITECTURE.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/ARCHITECTURE.md)
  - [API_CONTRACT.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/API_CONTRACT.md)
  - [DATABASE_AND_MIGRATIONS.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/DATABASE_AND_MIGRATIONS.md)
  - [SECURITY.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/SECURITY.md)
  - [DESIGN_SYSTEM.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/DESIGN_SYSTEM.md)
  - [DEPLOYMENT.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/DEPLOYMENT.md)
  - [ANDROID_RELEASE.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/ANDROID_RELEASE.md)
  - [TESTING_AND_RELEASE.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/TESTING_AND_RELEASE.md)
  - [OPERATIONS_AND_BACKUPS.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/OPERATIONS_AND_BACKUPS.md)
- **Local Montserrat Typography:** Fully bundled `@fontsource/montserrat` (weights 400, 500, 600, 700), eliminating external Google Fonts CDN reliance and ensuring 100% offline Android support.
- **Layout-Safe Text Scaling:** Introduced `--khata-text-scale` token (100%, 115%, 130%, 145%) while pinning root `html` font-size to 16px to prevent layout and padding distortion.
- **Nine Tactile Neumorphic Presets:** Added full support for 9 themes including Classic Light, Modern Dark, Warm Clay, Soft Teal, Elegant Violet, Neumorphic Concave, Neumorphic Convex, High Contrast Light, and High Contrast Dark.
- **Customer Ledger Race-Condition Protection:** Added `AbortController` and request-ID tracking in `KhataLedgerView.tsx` to prevent rapid customer switching from rendering stale transactions.
- **Mobile Responsive Layout:** Updated navbar to wrap gracefully into a 2-row layout on screens $<640\text{px}$ with minimum $\ge 44\text{px}$ touch targets. Stacked form fields on mobile viewports.

### Fixed
- **P0 Payment Allocation Row Locking:** Separated `FOR UPDATE` row lock query from grouped aggregation queries in `khata.service.ts`, resolving PostgreSQL syntax error when allocating payments.
- **Canonical API Envelope:** Standardized all API responses to `{ success: true, data: { ... } }` or `{ success: false, error: { ... } }`.
- **Viewport Accessibility:** Removed restrictive `maximum-scale=1.0, user-scalable=no` meta tags in `frontend/index.html` to respect user zoom preferences.
- **Surface Linear Gradient Rendering:** Updated `.neu-card` to use shorthand `background: var(--khata-surface-raised)` so concave and convex gradients render with full depth.

### Security
- **Destructive Test Guard:** Added `assertSafeTestDatabaseUrl` in `backend/src/config/testDbGuard.ts`, blocking automated test runs against Neon production databases or cloud endpoints.
- **Archived Obsolete Prompts:** Moved superseded audit and prompt documents into `docs/archive/` with clear archival warnings.

---

## [1.1.0] - 2026-10-31

### Added
- Throttled brute-force lockout pruning using non-blocking PostgreSQL advisory locks.
- Deep health check endpoint (`/api/v1/health/ready`) verifying database connectivity, migrations, and core tables.
- Cross-platform npm workspaces scripts in root `package.json`.
- Strict Decimal.js financial arithmetic engine preventing 64-bit IEEE 754 floating-point drift.

### Fixed
- Idempotency key handling in CORS preflight options.
- Windows/Linux line endings and path separators across build scripts.
- Executable bit permission on Android `gradlew` script.

---

## [1.0.0] - 2026-10-30

### Initial Release
- Single-shopkeeper digital khata system.
- Argon2id password authentication with session cookies.
- Products catalog, customer directory, Udhar recording, and FIFO payment settlement.
- Neon Serverless PostgreSQL database with migrations 001, 002, 003.
- Capacitor Android shell configuration (`in.algions.khata`).
