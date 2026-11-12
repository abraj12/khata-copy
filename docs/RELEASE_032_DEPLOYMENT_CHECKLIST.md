# Khata ERP — Release #032 Production Deployment Checklist & Runbook

## 1. Pre-Deployment Verification

Before triggering production deployments, ensure all preflight gates are green:

- [x] Backend Unit Test Suite: 37 test files, 405 tests passing (`npm test --workspace=backend`).
- [x] Integration Test Suite: Real PostgreSQL 18 & MongoDB 8 passing (`npm run test:integration --workspace=backend`).
- [x] TypeScript Compilation: Backend `tsc` succeeds with 0 errors (`npm run build --workspace=backend`).
- [x] Frontend Build: Vite production build succeeds (`npm run build --workspace=frontend`).
- [x] Digital Asset Links: Domain verification valid (`node frontend/scripts/validate-assetlinks.js`).
- [x] Android TWA: Gradle debug assembly builds cleanly (`cd android-twa && ./gradlew assembleDebug`).
- [x] Benchmarks: Scalability metrics verified on local databases (`npm run benchmark:release032`).

---

## 2. Environment Variables Checklist

Ensure the following variables are configured in production hosting environments:

### Backend (Render / Node.js 22):
- `NODE_ENV=production`
- `PORT=10000`
- `DATABASE_URL` (authoritative Neon PostgreSQL connection string with SSL)
- `DATABASE_URL_POOLED` (Neon pooled connection string)
- `MONGODB_ENABLED=true` (MANDATORY in production)
- `MONGODB_URI` (MongoDB Atlas SRV connection string with replica set)
- `MONGODB_DATABASE=khata_production`
- `OWNER_PHONE` (10-digit owner login phone number)
- `OWNER_PASSWORD_HASH` (Argon2id password hash)
- `SESSION_SECRET` (High-entropy secret >= 64 characters)
- `SESSION_COOKIE_SECURE=true`
- `COOKIE_DOMAIN=algions.in` (or `.algions.in` for multi-subdomain sessions)
- `CORS_ORIGIN=https://erp.algions.in`
- `R2_ACCOUNT_ID` (Cloudflare Account ID)
- `R2_ACCESS_KEY_ID` (Cloudflare R2 API Token Access Key)
- `R2_SECRET_ACCESS_KEY` (Cloudflare R2 API Token Secret)
- `R2_BUCKET_NAME` (Target Cloudflare R2 bucket)
- `R2_PUBLIC_BASE_URL` (Public CDN / worker URL for bucket assets)

### Frontend (Vercel):
- `VITE_API_BASE_URL=https://api.erp.algions.in`

---

## 3. Database Migration Execution Order

Migrations must be applied in sequential order. In Khata ERP, migrations run automatically on startup via `runMigrations()`, or can be executed via manual CLI:

```bash
npm run migrate --workspace=backend
```

New Release 032 Migrations:
1. `032_storage_cleanup_claim_fencing.sql`:
   - Adds `claim_token` UUID column to `storage_cleanup_jobs`.
   - Adds `claim_version` BIGINT column to `storage_cleanup_jobs`.
   - Adds partial index `idx_storage_cleanup_processing_claim`.
2. `033_storage_upload_intents.sql`:
   - Creates table `storage_upload_intents`.
   - Creates indexes `idx_storage_upload_intents_lookup` and `idx_storage_upload_intents_cleanup`.

Both migrations are safe, online, non-blocking, and idempotent.

---

## 4. Post-Deployment Smoke Verification

Execute the following HTTP checks against production:

1. **Liveness Probe:**
   ```bash
   curl -i https://api.erp.algions.in/api/v1/health/live
   # HTTP 200 { "status": "alive" }
   ```

2. **Readiness Probe:**
   ```bash
   curl -i https://api.erp.algions.in/api/v1/health/ready
   # HTTP 200 { "status": "ready", "services": { "postgres": "ready", "mongodb": "ready" } }
   ```

3. **CSRF Token Retrieval:**
   ```bash
   curl -i https://api.erp.algions.in/api/v1/auth/csrf-token
   # HTTP 200 { "success": true, "csrfToken": "..." }
   ```

4. **Digital Asset Links Verification:**
   ```bash
   curl -i https://erp.algions.in/.well-known/assetlinks.json
   # HTTP 200 Content-Type: application/json
   ```

---

## 5. Rollback Runbook

If an unexpected critical incident occurs during deployment:

1. **Backend Rollback:** In Render Dashboard, redeploy the previous release commit (`279a8d38f98a1cb04b74e8bd82980b97d13f1795`).
2. **Schema Compatibility:** Migrations 032 and 033 are purely additive (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`). Previous code ignores the new columns and table, requiring NO destructive database rollbacks.
3. **Storage Fallback:** R2 objects and signed URLs remain backward-compatible across releases.
