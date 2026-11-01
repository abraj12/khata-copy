# Khata — Single-Shopkeeper Digital Ledger System

Khata is a production-grade, highly reliable digital ledger application engineered specifically for a single retail shopkeeper. It provides rapid recording of credit sales (*udhar*) with itemized product breakdowns, a fast-lookup product catalog, transparent customer debt tracking with mathematical FIFO (*First-In, First-Out*) payment settlement, and zero floating-point rounding drift.

The application operates as a unified multi-platform system:
- **Web Interface:** Responsive Progressive Web App (PWA) served from Vercel (`https://khata.algions.in`).
- **Android App:** Native Android Trusted Web Activity (TWA) pointing directly to the production website (`in.algions.khata`). Updates deployed to the web interface reflect immediately in the Android application without requiring an APK rebuild.
- **Backend API:** Express REST API running on Node.js 22 LTS on Render (`https://api-khata.algions.in`).
- **Database:** PostgreSQL 16 on Neon Serverless with strict ACID constraints and connection pooling.

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

# 3. Execute automated test suites (77 tests: financial, auth lockout, idempotency, search, database guard)
npm test

# 4. Validate Digital Asset Links configuration for TWA
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

### 3.3 Running Workspaces Locally

```bash
# Terminal 1: Start Backend API (runs on http://localhost:5000)
npm run dev --workspace=backend

# Terminal 2: Start Frontend Web Server (runs on http://localhost:5173)
npm run dev --workspace=frontend
```

---

## 4. Android TWA Application

The Android app is located in `android-twa/` and uses Google's `androidbrowserhelper` (TWA) to render the production web application (`https://khata.algions.in`) in standalone full-screen mode.

- **Package ID:** `in.algions.khata`
- **Target URL:** `https://khata.algions.in`
- **Asset Links:** Served at `https://khata.algions.in/.well-known/assetlinks.json`

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

## 5. Canonical Documentation Suite

| Document | Purpose & Contents |
|---|---|
| [docs/ARCHITECTURE.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/ARCHITECTURE.md) | High-level topology, single-shopkeeper data flow, TWA architecture, and security design |
| [docs/DATABASE_AND_MIGRATIONS.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/DATABASE_AND_MIGRATIONS.md) | Schema specification (all 7 migrations), FIFO payment allocation, and composite foreign keys |
| [docs/ANDROID_RELEASE.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/ANDROID_RELEASE.md) | TWA build guide, keystore signing configuration, and Digital Asset Links verification |
| [docs/ACCESSIBILITY_AND_THEMES.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/ACCESSIBILITY_AND_THEMES.md) | 9 tactile neumorphic appearance presets, CSS gradient rendering, and keyboard accessibility |
| [docs/REMEDIATION_REPORT.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/REMEDIATION_REPORT.md) | Verification and audit reconciliation report with full test evidence |
| [docs/REMEDIATION_BASELINE.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/REMEDIATION_BASELINE.md) | Audit trail from baseline commit `e7d0421` to current implementation |
