# Khata — Single-Shopkeeper Digital Ledger System

Khata is a production-grade, offline-capable digital ledger application engineered specifically for a single retail shopkeeper. It provides rapid recording of credit sales (*udhar*) with itemized product breakdowns, a fast-lookup product catalog, transparent customer debt tracking with mathematical FIFO (*First-In, First-Out*) payment settlement, and zero floating-point rounding drift. The system runs as a responsive web application and as an Android native APK via Capacitor.

---

## 1. Prerequisites

- **Node.js:** `v22.18.0` LTS or later (enforced via `.node-version` and `"engines": { "node": "22.x" }`).
- **npm:** `v10.x` or `v11.x` (native npm workspaces support).
- **PostgreSQL:** `v16.x` (or a Neon Serverless PostgreSQL database).
- **Android Development (Optional for APK builds):**
  - JDK 17 or JDK 21.
  - Android Studio with Android SDK Platform 34+ and Build Tools.

---

## 2. Quick Start & Monorepo Commands

Khata uses npm workspaces with packages located in `backend/` and `frontend/`.

```bash
# 1. Install all dependencies across all workspaces deterministically
npm ci

# 2. Compile both backend and frontend workspaces
npm run build

# 3. Execute automated test suites (47 tests: financial, auth, database guard)
npm test
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
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/khata_dev
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/khata_dev
FRONTEND_URL=http://localhost:5173
OWNER_USERNAME=owner
OWNER_PASSWORD_HASH=$argon2id$v=19$m=65536,t=3,p=4$dummyHashForDev
SESSION_SECRET=dev_session_secret_at_least_64_characters_long_for_security_1234567890
COOKIE_SECRET=dev_cookie_secret_at_least_64_characters_long_for_security_1234567890
```

> [!WARNING]
> **Database Safety Notice:** Never point your local development `DATABASE_URL` or run tests against the production Neon database. The test suite includes a hardware-level safety guard (`backend/src/config/testDbGuard.ts`) that will deliberately abort if connected to production Neon hosts.

### 3.2 Database Migrations

Run database migrations against your target development database:

```bash
npm run migrate --workspace=backend
```

### 3.3 Running Workspaces Locally

Open two terminal sessions or run the workspaces independently:

```bash
# Terminal 1: Start Backend API (runs on http://localhost:5000)
npm run dev --workspace=backend

# Terminal 2: Start Frontend Web Server (runs on http://localhost:5173)
npm run dev --workspace=frontend
```

---

## 4. Android Build & Capacitor Sync

```bash
# 1. Build the production web bundle
npm run build --workspace=frontend

# 2. Sync web bundle and offline Montserrat fonts to the Android native shell
cd frontend
npx cap sync android

# 3. Open in Android Studio or compile APK via Gradle
cd android
./gradlew assembleDebug
```

---

## 5. Canonical Technical Documentation Suite

Comprehensive architecture, contracts, design rules, and operational guides are documented in the `docs/` directory:

| Document | Description |
|---|---|
| [docs/PRODUCT_REQUIREMENTS.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/PRODUCT_REQUIREMENTS.md) | Exact product workflows, business rules, financial validations, and non-goals. |
| [docs/ARCHITECTURE.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/ARCHITECTURE.md) | High-level system architecture, technology stack, sequence diagrams, and data flows. |
| [docs/API_CONTRACT.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/API_CONTRACT.md) | Canonical REST routes, request/response JSON schemas, and 2-decimal string formatting. |
| [docs/DATABASE_AND_MIGRATIONS.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/DATABASE_AND_MIGRATIONS.md) | Relational database schema (9 tables), migrations runner, indexes, and connection pooling. |
| [docs/SECURITY.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/SECURITY.md) | Argon2id auth, host-only cookies, CSRF protection, rate limits, and test DB guards. |
| [docs/DESIGN_SYSTEM.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/DESIGN_SYSTEM.md) | Locally bundled Montserrat font, 9 tactile neumorphic presets, and text scale architecture. |
| [docs/DEPLOYMENT.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/DEPLOYMENT.md) | Vercel CDN frontend, Render Node.js backend, Neon DB, and DNS CNAME settings. |
| [docs/ANDROID_RELEASE.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/ANDROID_RELEASE.md) | Capacitor synchronization, release keystore generation, and signing configurations. |
| [docs/TESTING_AND_RELEASE.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/TESTING_AND_RELEASE.md) | Test matrix (47 tests), financial edge cases, and release acceptance gates. |
| [docs/OPERATIONS_AND_BACKUPS.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/docs/OPERATIONS_AND_BACKUPS.md) | Health check monitoring, Neon backups, PITR recovery, and emergency password resets. |
| [CHANGELOG.md](file:///c:/Users/rajab/OneDrive/Desktop/khata/CHANGELOG.md) | Chronological release and remediation notes. |

---

## 6. License & Ownership

Proprietary software developed for Algions Technologies. All rights reserved.
