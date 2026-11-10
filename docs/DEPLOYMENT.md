# Khata - Production Deployment & Hosting Guide

**Document Status:** Canonical & Implemented (Release #018)  
**Last Verified:** 2026-11-11  
**Frontend URL:** `https://erp.algions.in` (Vercel)  
**Backend API URL:** `https://erp-api.algions.in` (Render Custom Domain -> `khata-api-m17b.onrender.com`)  
**Database:** Neon Serverless PostgreSQL (Singapore Region `ap-southeast-1`)  

---

## 1. Domain & DNS Configuration (`algions.in`)

To route the Khata ERP frontend to Vercel and backend to Render without altering the existing root apex domain or other subdomains:

| Type | Subdomain / Name | Value / Destination | TTL | Purpose |
|---|---|---|---|---|
| **CNAME** | `erp` | `e60db4a7794dc449.vercel-dns-017.com.` (or `cname.vercel-dns.com`) | Auto / 3600s | Routes `erp.algions.in` to Vercel CDN |
| **CNAME** | `erp-api` | `khata-api-m17b.onrender.com.` | Auto / 3600s | Routes `erp-api.algions.in` to Render Backend Service |

> [!NOTE]
> Modifying the `erp` and `erp-api` CNAME records is completely isolated and has zero impact on `www.algions.in` or root apex `algions.in` DNS records.

---

## 2. Frontend Deployment on Vercel

### Project Settings
1. In the Vercel Dashboard, import the repository `abraj12/khata-copy`.
2. Configure project settings:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
   - **Install Command:** `npm ci`
3. **Environment Variables:**
   - `VITE_API_BASE_URL`: `https://erp-api.algions.in`
   - `VITE_API_URL`: `https://erp-api.algions.in`
4. **Domains:** Add `erp.algions.in` in Project Settings -> Domains.

---

## 3. Backend Deployment on Render

Render builds and runs the Node 22 Express backend service with zero charges on the Free tier.

### Service Settings
- **Service Type:** Web Service
- **Repository:** `https://github.com/abraj12/khata-copy`
- **Branch:** `main`
- **Runtime:** Node
- **Build Command:**
  ```bash
  npm ci --workspace=backend --include-workspace-root=false --include=dev && npm run build --workspace=backend
  ```
- **Start Command:**
  ```bash
  npm run start --workspace=backend
  ```
- **Health Check Path:** `/api/v1/health/live`

### Required Production Environment Variables
| Variable | Example Value | Description |
|---|---|---|
| `NODE_ENV` | `production` | Enables secure production cookie flags and error masking |
| `PORT` | `5000` | Internal port listened to by Express |
| `DATABASE_URL_POOLED` | `postgresql://neondb_owner:***@ep-...-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` | Pooled Neon endpoint for API runtime queries |
| `DATABASE_URL` | `postgresql://neondb_owner:***@ep-....c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` | Direct Neon endpoint for DDL migrations |
| `FRONTEND_URL` | `https://erp.algions.in` | Bound origin for CORS and session cookies |
| `BUSINESS_TIME_ZONE` | `Asia/Kolkata` | Canonical business time zone for dates and validity |
| `OWNER_PHONE` | `9876543210` | Single shopkeeper phone number |
| `OWNER_PASSWORD_HASH` | `$argon2id$v=19$m=65536,t=3,p=4$...` | Argon2id hash of owner's password |
| `SESSION_SECRET` | `a-minimum-64-character-cryptographically-random-string` | Secret for signing session cookies |
| `COOKIE_SECRET` | `a-minimum-64-character-cryptographically-random-string` | Secret for signing CSRF tokens |
| `TRUST_PROXY` | `1` | Enables reverse-proxy IP and secure cookie pass-through |
| `R2_ACCOUNT_ID` | `***` | Cloudflare R2 Account ID for media storage |
| `R2_ACCESS_KEY_ID` | `***` | Cloudflare R2 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | `***` | Cloudflare R2 Secret Access Key |
| `R2_BUCKET_NAME` | `khata-production-media` | Cloudflare R2 Bucket Name |
| `R2_ENDPOINT` | `https://***.r2.cloudflarestorage.com` | Cloudflare R2 S3-compatible API endpoint |

---

## 4. Database Migrations on Neon

Execute migrations using the direct Neon database URL:

```bash
# On deployment build step or operator terminal:
npm run migrate --workspace=backend
```

The migrator tracks applied migrations in `schema_migrations` across all 18 migration files (`001_auth_tables.sql` through `018_numbering_and_legacy_data_integrity.sql`).

### Verification Command
Verify backend health and readiness via:
```bash
curl -s https://erp-api.algions.in/api/v1/health/ready
```
Expected response:
```json
{
  "status": "ready",
  "timestamp": "2026-11-11T..."
}
```
*(Internal schema details and migration inventories remain concealed to prevent information disclosure).*
