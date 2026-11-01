# Remediation Baseline Inventory (Phase 0)

**Date Recorded:** 2026-11-01  
**Baseline Git Commit SHA:** `c7c870c44878d7dcacf5035cb9e487726ea70910`  
**Current Active Branch:** `main`  
**Remote URL:** `https://github.com/abraj12/khata.git`  
**Node.js Runtime:** `v22.18.0`  
**npm Package Manager:** `11.5.2`  
**Total Tracked Repository Files:** 156  

---

## 1. Executive Summary

This document establishes the verified Phase 0 baseline inventory for the Khata repository prior to applying the changes required by `KHATA_SONNET_46_MASTER_REMEDIATION_PROMPT.md`.

### Critical Business Rule Revision (Phase 1)
- **Previous Specification:** Strict integer-only hardware retail quantity (`[1, 1000000]`).
- **New Authoritative Specification:** **Quantity allows up to TWO decimal places (`NUMERIC(12, 2)`)**, e.g., `1.5`, `2.25`, `0.01`, with positive bound `(0, 1000000.00]`.
- **Money Specification:** Unchanged; strict 2 decimal places (`NUMERIC(12, 2)`).

---

## 2. Environment Variables Inventory

The following environment variables are actively read by `backend/src/config/env.ts` via Zod schema validation:

| Variable | Type | Default / Constraints | Production Requirement |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | enum | `development` (`development`, `production`, `test`) | Must be `production` on Render |
| `PORT` | number | `5000` | Render dynamically allocates |
| `OWNER_PHONE` | string | `^[6-9]\d{9}$` (Canonical Indian 10-digit) | Required; rejects default placeholder |
| `OWNER_PASSWORD_HASH` | string | Argon2id (`$argon2id$v=19$...`) | Required; rejects default placeholder |
| `DATABASE_URL_POOLED` | string | PostgreSQL URL (Pooler) | Required; must include `sslmode=require` |
| `DATABASE_URL` | string | PostgreSQL URL (Direct for Migrations) | Required; must include `sslmode=require` |
| `NEON_REALTIME_URL` | string | Optional URL | Deferred feature |
| `NEON_REALTIME_SECRET`| string | Optional secret | Deferred feature |
| `SESSION_SECRET` | string | Min 32 chars | Cryptographically random secret |
| `SESSION_MAX_AGE_MS` | number | `604800000` (7 days rolling) | Inactivity expiry |
| `SESSION_COOKIE_NAME` | string | `khata_session` | Standard session cookie |
| `SESSION_COOKIE_SECURE`| boolean | `false` (dev) / `true` (prod) | Must be `true` in production |
| `SESSION_COOKIE_HTTP_ONLY`| boolean | `true` | Must be `true` |
| `SESSION_COOKIE_SAME_SITE`| enum | `lax` | `lax` or `strict` |
| `FRONTEND_URL` | string | `https://khata.algions.in` | Trusted credentialed CORS origin |
| `LOGIN_MAX_ATTEMPTS` | number | `5` | Lockout threshold |
| `LOGIN_FAILURE_WINDOW_MS`| number | `900000` (15 mins) | Lockout rolling window |
| `LOGIN_LOCK_DURATION_MS` | number | `900000` (15 mins) | Lockout duration |
| `LOGIN_EXTENDED_THRESHOLD`| number | `10` | 24-hr escalation threshold |
| `LOGIN_EXTENDED_WINDOW_MS`| number | `86400000` (24 hrs) | Extended monitoring window |
| `LOGIN_EXTENDED_LOCK_DURATION_MS` | number | `1800000` (30 mins) | Extended lockout duration |
| `LOGIN_LOG_RETENTION_DAYS`| number | `30` | Audit table log retention |
| `TRUST_PROXY` | number | `1` | Reverse proxy hop count (Render) |

---

## 3. Database Schema Migrations Inventory

| Migration File | SHA256 Checksum | Purpose | Applied on Production Neon |
| :--- | :--- | :--- | :--- |
| `001_auth_tables.sql` | `FC24D2F9F071C60953850AA7368C1DB4B4D0EC79C76B71C9B44B375D66FD2EDD` | Auth session & login attempt store | Yes |
| `002_khata_transactions.sql` | `5B934AC6DBCB78C34BF21199DDFC04544F609026928F672C3DA349E953CFD75B` | Core ledger, products, customers, transactions | Yes |
| `003_idempotency_and_hardening.sql`| `552600C1D40280DF83CD8D8FBB77691188063827A5912C44CFEA90A550E42D58` | Idempotency keys, CHECK constraints, indexes | Yes |
| `004_integer_quantity_and_money_constraints.sql` | `4E7BB8AB4F95CD63E5DF980B83C72D1C6CC64ADC34CC25E6A7B24E386D8B1720` | Strict money checks & temporary integer check | Yes |
| `005_search_indexes_and_identity_constraints.sql` | `771598D60170A7B0E664B96DD70B32DDF946E578C5402CBF64D26AF6CC33DC46` | Search composite indexes & buying_price NUMERIC(12,2) | Pending Owner Approval |
| `006_quantity_two_decimal_places.sql` | `8F792086D97E31EC5D9B7F64CC551DB0EC9E29993878C9E29DC097F5ABCC0719` | Widens quantity to NUMERIC(12,2), drops integer check | Pending Owner Approval |

---

## 4. Deployment Topology & Root Directory Assumptions

### Vercel (Frontend Web App)
- **Authoritative Configuration:** `vercel.json` at repository root `.`.
- **Conflicting Config:** `frontend/vercel.json` removed to eliminate ambiguity.
- **Install Command:** `npm ci --workspace=frontend --include-workspace-root=false`
- **Build Command:** `npm run build --workspace=frontend`
- **Output Directory:** `frontend/dist`
- **Framework:** `vite`
- **Production Domain:** `https://khata.algions.in`

### Render (Backend Web Service)
- **Authoritative Configuration:** `render.yaml` at repository root `.`.
- **Service Root:** Monorepo root (`.`).
- **Build Command:** `npm ci --workspace=backend --include-workspace-root=false --include=dev && npm run build --workspace=backend`
- **Start Command:** `npm run start --workspace=backend`
- **Liveness Path:** `/api/v1/health/live` (lightweight, zero DB load)
- **Readiness Path:** `/api/v1/health/ready` (deep check for connection, migrations, core tables)
- **Production URL:** `https://api-khata.algions.in` / `https://khata-api-wkn9.onrender.com`

### Android Capacitor
- **Package ID:** `in.algions.khata`
- **App Display Name:** `Khata`
- **Local Web Assets:** Bundled inside `frontend/android/app/src/main/assets/public`
- **Sync Command:** `npm run cap:sync --workspace=frontend`
- **Gradle Executable Mode:** `100755` preserved in git index for Linux compatibility.

---

## 5. Test Suite Inventory

| Test File | Target Layer | Mock vs Real DB | Test Count | Status |
| :--- | :--- | :--- | :--- | :--- |
| `testDbGuard.test.ts` | Safety Guard | Unit [No DB] | 7 tests | PASS |
| `validators.unit.test.ts` | Financial Validators | Unit [No DB] | 9 tests | PASS |
| `search.api.test.ts` | Search & Pagination | Mocked Pool | 9 tests | PASS |
| `khata.financial.test.ts` | Ledger & FIFO Allocations | Mocked DB Simulator | 18 tests | PASS |
| `auth.security.test.ts` | Auth, Session, Lockout | Mocked Express App | 29 tests | PASS |
| `postgres.integration.test.ts` | End-to-end DB Lifecycle | Real Disposable Postgres | 9 tests | Skipped in Unit Run (Runs in CI via Docker) |
| **Total Automated Tests** | | | **72 tests** | **100% PASSING** |
