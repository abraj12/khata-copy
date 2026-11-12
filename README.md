# Khata — Single-Shopkeeper Digital Ledger System

Khata is a production-grade, highly reliable digital ledger application engineered specifically for a single retail shopkeeper. It provides rapid recording of credit sales (*udhar*) with itemized product breakdowns, a fast-lookup product catalog, transparent customer debt tracking with mathematical FIFO (*First-In, First-Out*) payment settlement, and zero floating-point rounding drift.

The application operates as a unified multi-platform system:
- **Web Interface:** Responsive Progressive Web App (PWA) served from Vercel (`https://erp.algions.in`).
- **Android App:** Native Android Trusted Web Activity (TWA) pointing directly to the production website (`in.algions.khata`). Updates deployed to the web interface reflect immediately in the Android application without requiring an APK rebuild.
- **Backend API:** Express REST API running on Node.js 22 LTS on Render (`https://erp-api.algions.in`).
- **Database:** PostgreSQL (Neon Serverless / PostgreSQL 16–18) with strict ACID constraints and connection pooling, paired with MongoDB read-model projections (`product_search`, `customer_summaries`, `dashboard_snapshots`, `daily_analytics`, `recent_activity`) and app-data stores.

---

## 1. Prerequisites

- **Node.js:** `v22.18.0` LTS or later (enforced via `.node-version` and `"engines": { "node": "22.x" }`).
- **npm:** `v10.x` or `v11.x` (native npm workspaces support).
- **PostgreSQL:** `v16.x` (or Neon Serverless PostgreSQL).
- **Android Development (Optional for TWA APK builds):**
  - JDK 17.
  - Android SDK Platform 35 and Build Tools.

---

## 2. Quick Start & Monorepo Commands

Khata uses npm workspaces with packages located in `backend/` and `frontend/`.

```bash
# 1. Install all dependencies across all workspaces deterministically
npm ci

# 2. Compile both backend and frontend workspaces
npm run build

# 3. Execute automated unit test suites (405 backend tests)
npm test

# 4. Execute real PostgreSQL + MongoDB integration suite (requires TEST_DATABASE_URL / TEST_MONGODB_URI)
npm run test:integration

# 5. Execute Release 032 performance & EXPLAIN benchmark suite
npm run benchmark:release032

# 6. Validate Digital Asset Links configuration for TWA
node frontend/scripts/validate-assetlinks.js
```

---

## 3. Local Development Setup

### 3.1 Environment Configuration

Copy the example environment configuration into the backend workspace:

```bash
cp .env.example backend/.env
```

Ensure `backend/.env` contains valid local development values:

```env
PORT=5000
NODE_ENV=development
DATABASE_URL_POOLED=postgresql://postgres:postgres@localhost:5432/khata_dev
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/khata_dev
FRONTEND_URL=http://localhost:5173
OWNER_PHONE=9876543210
OWNER_PASSWORD_HASH=$argon2id$v=19$m=65536,t=3,p=4$dummyHashForDev
SESSION_SECRET=dev_session_secret_at_least_32_characters_long_for_security_1234567890
```

> [!WARNING]
> **Database Safety Safeguard:** Never point your local development `DATABASE_URL` or run tests against the production Neon database. The test suite includes a hardware-level safety guard (`backend/src/config/testDbGuard.ts`) that deliberately aborts if connected to production Neon hosts.

### 3.2 Database Migrations

Apply migrations against your target development database:

```bash
npm run migrate --workspace=backend
```

Migrations list:
1. `001_auth_tables.sql`: Session table and brute-force login lockout tracking.
2. `002_khata_transactions.sql`: Products, customers, Udhar credit transactions, payments, and FIFO allocations.
3. `003_idempotency_and_hardening.sql`: Idempotency store and indexes.
4. `004_integer_quantity_and_money_constraints.sql`: Initial integer quantity and strict money bounds.
5. `005_search_indexes_and_identity_constraints.sql`: Search indexes and buying price widening.
6. `006_quantity_two_decimal_places.sql`: Fractional quantities support up to 2 decimal places.
7. `007_quantity_strict_scale_and_allocation_integrity.sql`: Unconstrained `NUMERIC` with `TRUNC` scale check (rejects silent rounding on SQL inputs) and composite foreign keys preventing cross-customer payment allocations.
8. `008_strict_quantity_scale.sql`: Enforces maximum two decimal places across quantity inputs.
9. `009_product_images_and_offline_bills.sql`: Cloudflare R2 image storage references and offline bill sync records.
10. `010_product_hsn_code.sql`: HSN code support on product catalog.
11. `011_gst_invoices.sql`: Full GST invoicing schema, sequences, and item breakdown.
12. `012_normal_bills.sql`: Non-GST cash/credit retail billing schema with sequential numbering.
13. `013_customer_address.sql`: Extended customer profiles with physical delivery and billing addresses.
14. `014_billing_quantity_and_sequences.sql`: Safe database sequences for invoice numbers and billing quantity constraints.
15. `015_product_barcode.sql`: Optional product barcode support with partial unique index on active products (`idx_products_barcode_active`).
16. `016_quotations.sql`: Corporate quotation management, quotation items, sequential numbering (`QT-001`), and configurable company settings.
17. `017_quotation_conversion_financial_fields.sql`: Quotation-to-bill discount and conversion financial tracking columns on normal bills and GST invoices.
18. `018_numbering_and_legacy_data_integrity.sql`: Quotation numbering sequence backfill and legacy data integrity hardening.
19. `019_customer_tax_integrity_and_idempotency.sql`: Customer state/tax metadata constraints, bill tax snapshot hardening, and idempotency key TTL expiry.
20. `020_supplier_management.sql`: Suppliers catalog (`uq_suppliers_active_*`), purchase bills, and supplier purchase item schemas.
21. `021_supplier_financial_integrity.sql`: Supplier payments, FIFO bill allocations, payment reversals, and allocation reversal ledger.
22. `022_supplier_operational_hardening.sql`: Supplier bill cancellation ledger and append-only audit mutation triggers.
23. `023_supplier_audit_truncate_guard.sql`: Statement-level `TRUNCATE` protection on append-only supplier audit tables.
24. `024_home_dashboard_profitability.sql`: Cost-of-goods snapshots on bill lines and `business_expenses` ledger.
25. `025_performance_reporting_hardening.sql`: Reporting date/timestamp indexes across customers, payments, transactions, and supplier audit tables.
26. `026_company_jurisdiction.sql`: Configurable company jurisdiction text on `quotation_settings`.
27. `027_outbox_events.sql`: Transactional `app_outbox_events` table and partial ready/lease/aggregate indexes for MongoDB synchronization.
28. `028_outbox_dead_letter.sql`: `dead_letter` status constraint, `dead_letter_at` timestamp, and dead-letter audit index.
29. `029_outbox_legacy_dead_letter_and_perf_indexes.sql`: Legacy exhausted outbox row backfill into `dead_letter`, selective unresolved index (`idx_app_outbox_unresolved_created`), and optional `pg_trgm` GIN search fallback indexes (`idx_products_active_name_trgm`, `idx_customers_active_name_trgm`).
30. `030_storage_cleanup_jobs.sql`: Durable Cloudflare R2 orphan-cleanup retry queue (`storage_cleanup_jobs`) with active partial unique deduplication and wakeup/lease/completion indexes.
31. `031_outbox_worker_search_indexes.sql`: Selective partial outbox wakeup indexes (`idx_app_outbox_*`), active B-tree barcode/HSN/customer search indexes, and privilege-guarded `pg_trgm` GIN fallback indexes.

### 3.3 Running Workspaces Locally

```bash
# Terminal 1: Start Backend API (runs on http://localhost:5000)
npm run dev --workspace=backend

# Terminal 2: Start Frontend Web Server (runs on http://localhost:5173)
npm run dev --workspace=frontend
```

---

## 4. Key Feature Modules

### 4.1 Barcode Management & Scanning
- **Partial Unique Index:** Enforces zero duplicates across active products (`WHERE barcode IS NOT NULL AND archived_at IS NULL`) while allowing archived products to release their barcodes.
- **Lookup & Assignment Endpoints:**
  - `GET /api/v1/products/barcode/:barcode` — Fast lookup for active products by barcode.
  - `PATCH /api/v1/products/:id/barcode` — Assigns or clears a product's barcode with duplicate validation.
- **Frontend Scanner Modal:**
  - Integrates `@zxing/browser` camera barcode scanner with back-camera preference, visual reticle overlay, torch toggle, and scan cooldown.
  - Manual barcode entry fallback.
  - Seamless unknown-barcode flow: prompt to assign to an existing product or launch the Add Product modal pre-filled with the barcode.
- **Hardware Scanner Support:** Reusable `useHardwareBarcodeScanner` hook detects high-speed keyboard input (<60ms interval ending with Enter) from USB / Bluetooth HID barcode scanners without intercepting standard form inputs.

### 4.2 Professional Quotation Module
- **Independent Schema:** Clean, dedicated tables for `quotations` and `quotation_items` with status workflow (`draft`, `sent`, `accepted`, `rejected`, `expired`, `converted`).
- **Sequential Concurrency-Safe Numbering:** Database-backed sequence generating formatted identifiers (e.g., `QT-001`, `QT-002`).
- **Company Settings Snapshot:** Configurable business identity (Algions AI Labs Private Limited, CIN, Address, Bank details, Terms) snapshotted into `company_snapshot JSONB` at quotation creation time, guaranteeing immutable audit trails.
- **Decimal.js Financial Engine:** Strict calculation of subtotals, percentage/fixed discounts, intra-state CGST/SGST vs. inter-state IGST, grand totals, and Indian currency amount in words.
- **Corporate PDF Generation:** Built with `pdfkit` featuring clean corporate typography, company branding, multi-page repeated table headers, page numbers ("Page X of Y"), financial summary boxes, terms & conditions, and authorized signatory blocks.
- **Atomic Bill Conversion:** Transactional conversion from accepted quotations to Normal Bills (`POST /api/v1/quotations/:id/convert/normal-bill`) or GST Invoices (`POST /api/v1/quotations/:id/convert/gst-invoice`) with `SELECT ... FOR UPDATE` row locking to prevent duplicate conversion.
- **Quotation UI Suite:** Complete dashboard with filtering, search, status badges, full-featured line-item editor, live PDF preview in modal, download, and native Web Share API / WhatsApp sharing.

---

## 5. Android TWA Application

The Android app is located in `android-twa/` and uses Google's `androidbrowserhelper` (TWA) to render the production web application (`https://erp.algions.in`) in standalone full-screen mode.

- **Package ID:** `in.algions.khata`
- **Target URL:** `https://erp.algions.in`
- **Asset Links:** Served at `https://erp.algions.in/.well-known/assetlinks.json`

### Build TWA APK:

```bash
cd android-twa

# Build debug APK for local device testing:
./gradlew assembleDebug

# Build release APK (requires signing.properties):
./gradlew assembleRelease
```

Because the application is a Trusted Web Activity, ordinary frontend updates deployed to Vercel become visible immediately in the Android app upon refresh or reopen without requiring an APK rebuild.

---

## 6. Canonical Documentation Suite

| Document | Purpose & Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | High-level topology, single-shopkeeper data flow, TWA architecture, and security design |
| [docs/DATABASE_AND_MIGRATIONS.md](docs/DATABASE_AND_MIGRATIONS.md) | Schema specification (all 31 migrations), FIFO payment allocation, and composite foreign keys |
| [docs/MONGODB_ARCHITECTURE.md](docs/MONGODB_ARCHITECTURE.md) | MongoDB read-model synchronization, outbox worker, cursor pagination, and indexing architecture |
| [docs/ANDROID_RELEASE.md](docs/ANDROID_RELEASE.md) | TWA build guide, keystore signing configuration, and Digital Asset Links verification |
| [docs/ACCESSIBILITY_AND_THEMES.md](docs/ACCESSIBILITY_AND_THEMES.md) | 9 tactile neumorphic appearance presets, CSS gradient rendering, and keyboard accessibility |
| [docs/RELEASE_031_REMEDIATION_REPORT.md](docs/RELEASE_031_REMEDIATION_REPORT.md) | Release #031 remediation findings, mandatory MongoDB architecture, storage lifecycle & verification report |
| [docs/RELEASE_031_PERFORMANCE_BENCHMARKS.md](docs/RELEASE_031_PERFORMANCE_BENCHMARKS.md) | Reproducible 1k–100k outbox claim, backlog probe, cleanup & MongoDB read model benchmarks |
| [docs/RELEASE_031_STORAGE_LIFECYCLE.md](docs/RELEASE_031_STORAGE_LIFECYCLE.md) | Cloudflare R2 transactional cleanup, distributed advisory locks & reference safety |
| [docs/RELEASE_031_MONGODB_AVAILABILITY.md](docs/RELEASE_031_MONGODB_AVAILABILITY.md) | Mandatory MongoDB architecture, connection supervisor, state machine & fail-closed read models |
| [docs/RELEASE_030_REMEDIATION_REPORT.md](docs/RELEASE_030_REMEDIATION_REPORT.md) | Release #030 remediation findings, verification matrix, and 22-section engineering report |
| [docs/RELEASE_030_PERFORMANCE_BENCHMARKS.md](docs/RELEASE_030_PERFORMANCE_BENCHMARKS.md) | Reproducible `1k`–`100k` PostgreSQL 18.6 (`EXPLAIN`) & MongoDB 8.2.4 benchmarks |
| [docs/RELEASE_029_REMEDIATION_REPORT.md](docs/RELEASE_029_REMEDIATION_REPORT.md) | Prior Release #029 remediation findings and verification report |
| [docs/RELEASE_029_PERFORMANCE_BENCHMARKS.md](docs/RELEASE_029_PERFORMANCE_BENCHMARKS.md) | Prior Release #029 benchmark baseline report |
| [docs/ALGORITHM_AND_COMPLEXITY_REVIEW.md](docs/ALGORITHM_AND_COMPLEXITY_REVIEW.md) | Search tokenization, keyset pagination, outbox coalescing, and theoretical vs observed complexity review |
| [docs/REMEDIATION_REPORT.md](docs/REMEDIATION_REPORT.md) | Earlier baseline audit reconciliation report with verification evidence |
| [docs/REMEDIATION_BASELINE.md](docs/REMEDIATION_BASELINE.md) | Audit trail from baseline commit to current implementation |
