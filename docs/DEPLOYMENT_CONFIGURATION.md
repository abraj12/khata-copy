# Khata Deployment Configuration Guide

## 1. Vercel Frontend Deployment (`https://khata.algions.in`)

### Project Settings
- **Project Name:** `khata`
- **Framework Preset:** Vite
- **Root Directory:** `./` (Repository root, blank / default)
  - *Rationale:* Vercel must build from the monorepo root to utilize the root npm workspace lockfile (`package-lock.json`).
- **Node.js Version:** `22.x`

### Build & Output Settings
- **Install Command:** `npm ci --workspace=frontend --include-workspace-root=false`
- **Build Command:** `npm run build --workspace=frontend`
- **Output Directory:** `frontend/dist`

### Environment Variables on Vercel
- `VITE_API_BASE_URL`: `https://api-khata.algions.in` (Public, non-secret API endpoint)
- **STRICT PROHIBITION:** Do **NOT** configure `DATABASE_URL`, `DATABASE_URL_POOLED`, `SESSION_SECRET`, `OWNER_PHONE`, or `OWNER_PASSWORD_HASH` on Vercel. Frontend bundles are completely public and static.

---

## 2. Render Backend Deployment (`https://api-khata.algions.in`)

### Service Specification
- **Type:** Web Service
- **Name:** `khata-api`
- **Environment:** Node
- **Plan:** `free` (Explicit zero cost; spins down after inactivity, resumes on HTTP ping)
- **Region:** `singapore` (Aligned with Neon Singapore region for low latency)
- **Root Directory:** `./` (Repository root)
- **Node Version:** `22.18.0` (Defined in `.node-version`)
- **Build Command:** `npm ci --workspace=backend --include-workspace-root=false && npm run build --workspace=backend`
- **Start Command:** `npm run start --workspace=backend`
- **Health Check Path:** `/api/v1/health/live` (Lightweight process check, does not query Neon or spin up DB)

### Required Environment Variables on Render Dashboard
- `NODE_ENV`: `production`
- `PORT`: (Supplied dynamically by Render, e.g. 5000 or 10000)
- `OWNER_PHONE`: `<Canonical 10-digit Indian Mobile Number>` (e.g. 9876543210)
- `OWNER_PASSWORD_HASH`: `<Argon2id Hash starting with $argon2id$v=19$>`
- `DATABASE_URL_POOLED`: `<Fresh Neon Pooled Connection String with ?sslmode=require>`
- `DATABASE_URL`: `<Fresh Neon Direct Connection String with ?sslmode=require>`
- `SESSION_SECRET`: `<Cryptographically random string, at least 32 characters>`
- `SESSION_MAX_AGE_MS`: `604800000` (7 days)
- `SESSION_COOKIE_NAME`: `khata_session`
- `SESSION_COOKIE_SECURE`: `true`
- `SESSION_COOKIE_HTTP_ONLY`: `true`
- `SESSION_COOKIE_SAME_SITE`: `lax`
- `FRONTEND_URL`: `https://khata.algions.in`
- `LOGIN_MAX_ATTEMPTS`: `5`
- `LOGIN_FAILURE_WINDOW_MS`: `900000` (15 minutes)
- `LOGIN_LOCK_DURATION_MS`: `900000` (15 minutes)
- `LOGIN_EXTENDED_THRESHOLD`: `10`
- `LOGIN_EXTENDED_WINDOW_MS`: `86400000` (24 hours)
- `LOGIN_EXTENDED_LOCK_DURATION_MS`: `1800000` (30 minutes)
- `LOGIN_LOG_RETENTION_DAYS`: `30`
- `TRUST_PROXY`: `1`

---

## 3. Database Migration Deployment Procedure
Migrations must **not** execute automatically on application boot to prevent deployment contention or migration failure crashes on sleeping instances.

### Safe Manual Migration Execution (Owner Run)
1. Ensure active database backup exists on Neon console (`shy-mud-94919289`).
2. Run migration runner from repository root or backend workspace against the direct connection URL:
   ```bash
   DATABASE_URL="postgresql://neondb_owner:<fresh-password>@ep-shy-mud-94919289.us-east-2.aws.neon.tech/neondb?sslmode=require" npm run migrate
   ```
3. Verify `/api/v1/health/ready` returns HTTP 200 with all core tables and applied migrations verified.
