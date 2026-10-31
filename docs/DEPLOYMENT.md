# Khata - Production Deployment & Hosting Guide

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Frontend URL:** `https://khata.algions.in` (Vercel)  
**Backend API URL:** `https://khata-api-wkn9.onrender.com` (Render)  
**Database:** Neon Serverless PostgreSQL (Singapore Region `ap-southeast-1`)  

---

## 1. Domain & DNS Configuration (`algions.in`)

To route the Khata frontend to Vercel without altering the existing root domain or `www.algions.in`:

| Type | Subdomain / Name | Value / Destination | TTL | Purpose |
|---|---|---|---|---|
| **CNAME** | `khata` | `cname.vercel-dns.com` | Auto / 300s | Routes `khata.algions.in` to Vercel CDN |
| **CNAME** | `api-khata` *(Optional)* | `khata-api-wkn9.onrender.com` | Auto / 300s | Custom backend domain on Render |

> [!NOTE]
> Modifying the `khata` CNAME record is isolated and has zero impact on `www.algions.in` or root apex `algions.in` DNS records.

---

## 2. Frontend Deployment on Vercel

### Option A: Subdirectory Import (Recommended)
1. In the Vercel Dashboard, import the repository `abraj12/khata`.
2. Configure project settings:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
   - **Install Command:** `npm ci`
3. **Environment Variables:**
   - `VITE_API_URL`: `https://khata-api-wkn9.onrender.com`
4. Add Domain: In Project Settings -> Domains, add `khata.algions.in`.

### Option B: Monorepo Root Import
- **Root Directory:** `./`
- **Build Command:** `npm run build --workspace=frontend`
- **Output Directory:** `frontend/dist`
- **Install Command:** `npm ci --workspace=frontend --include-workspace-root=false`

---

## 3. Backend Deployment on Render

Render builds and runs the Node 22 Express backend service.

### Service Settings
- **Service Type:** Web Service
- **Repository:** `https://github.com/abraj12/khata`
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

### Required Production Environment Variables
| Variable | Example Value | Description |
|---|---|---|
| `NODE_ENV` | `production` | Enables production cookie flags and error masking |
| `PORT` | `5000` | Port listened to by Express (Render sets internal routing) |
| `DATABASE_URL` | `postgresql://neondb_owner:***@ep-...-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` | **Pooled** Neon endpoint for API runtime queries |
| `DIRECT_URL` | `postgresql://neondb_owner:***@ep-....c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` | **Direct** Neon endpoint for DDL migrations |
| `FRONTEND_URL` | `https://khata.algions.in` | Bound origin for CORS and session cookies |
| `OWNER_USERNAME` | `owner` | Single shopkeeper username |
| `OWNER_PASSWORD_HASH` | `$argon2id$v=19$m=65536,t=3,p=4$...` | Argon2id hash of owner's password |
| `SESSION_SECRET` | `a-minimum-64-character-cryptographically-random-string` | Secret for signing session cookies |
| `COOKIE_SECRET` | `a-minimum-64-character-cryptographically-random-string` | Secret for signing CSRF tokens |

---

## 4. Database Migrations on Neon

Execute migrations using the direct Neon database URL:

```bash
# On local machine or deployment build step:
DATABASE_URL="postgresql://neondb_owner:***@ep-aged-resonance-az771dby.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require" \
npm run migrate --workspace=backend
```

### Verification Command
Verify database migration status via the live readiness endpoint:
```bash
curl -s https://khata-api-wkn9.onrender.com/api/v1/health/ready | jq .
```
Expected output: `"status": "ready"`, with 3 migrations found and 9 core tables verified.
