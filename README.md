# Khata — Single-Shopkeeper Owner Login & Authentication Architecture

Production-grade authentication, session management, and ledger application for a single shopkeeper, built according to `LOGIN_AUTH_IMPLEMENTATION.md` and `KHATA_LOGIN_AGENT_PROMPT.md`.

## System Overview

- **Owner Identity**: Exactly one owner configured via backend environment variables (`OWNER_PHONE` & `OWNER_PASSWORD_HASH`).
- **Opaque Server-Side Sessions**: Persisted in PostgreSQL using `connect-pg-simple`. No JWT or refresh tokens.
- **Session Security**: Host-only cookie (`khata_session`), `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 7-day rolling inactivity timeout (`SESSION_MAX_AGE_MS=604800000`).
- **CSRF & CORS**: Strict origin check matching `https://khata.algions.in` (and Capacitor origins), synchronizer tokens on state-changing requests, credentials enabled.
- **Persistent Abuse Protection**: PostgreSQL-backed `login_attempts` table. Tier 1: 5 failed attempts in 15 mins -> 15 min lock; Tier 2: 10 failed attempts in 24 hrs -> 30 min lock. Keyed HMAC-SHA256 identifiers.
- **Neon Integration**: Direct connection for migrations (`DATABASE_URL`), pooled connection for Render runtime & session store (`DATABASE_URL_POOLED`), Neon Realtime sealed query subscription module.
- **Android APK**: Native Capacitor app (`in.algions.khata`, display name `Khata`) with locally bundled web assets.

---

## Directory Structure

```text
khata/
├── backend/                  # Node.js + Express + TypeScript API server
│   ├── src/
│   │   ├── config/           # env.ts, database.ts, session.ts
│   │   ├── middleware/       # requireOwnerSession.ts, csrf.ts, errorHandler.ts
│   │   ├── modules/          # auth/, products/, ledger/, realtime/
│   │   ├── app.ts            # Express app assembly & CORS configuration
│   │   └── index.ts          # Server entrypoint
│   ├── migrations/           # 001_auth_tables.sql (session & lockout tables)
│   ├── scripts/              # hash-owner-password.ts, migrate.ts
│   └── tests/                # auth.security.test.ts (25+ automated security tests)
├── frontend/                 # Vite + React + TypeScript + Tailwind CSS
│   ├── src/
│   │   ├── features/auth/    # LoginPage, AuthProvider, authApi
│   │   ├── features/products/# ProductsView (confidential buying prices)
│   │   ├── features/khata/   # KhataLedgerView (customers, Udhar, payments)
│   │   └── lib/              # apiClient.ts (central credentialed client)
│   ├── capacitor.config.ts   # Android Capacitor configuration
│   └── android/              # Native Android project (in.algions.khata)
├── neon.ts                   # Neon CLI project configuration
├── render.yaml               # Render backend infrastructure deployment spec
├── vercel.json               # Vercel frontend deployment & CSP headers
└── .env.example              # Production environment variable baseline
```

---

## Generating the Argon2id Password Hash

Run the interactive hidden-input script:

```bash
cd backend
npm run hash-password
```

- Prompts securely for password without terminal echo.
- Computes Argon2id hash using 64MB memory, 3 passes, 4 parallel threads.
- Prints the hash for copying to Render. Plaintext password is never saved or logged.

---

## Running Automated Security Tests

```bash
cd backend
npm test
```

Verifies:
1. Valid credentials login & minimal JSON response
2. Generic 401 on wrong password (no disclosure)
3. Generic 401 on unknown phone (dummy argon2 timing defense)
4. SQL injection payloads treated as literal string values
5. Schema rejection of malformed phone inputs
6. XSS inert rendering
7. Protected APIs fail closed without session
8. Valid session accesses Products & Ledger
9. Logout destroys session & clears cookie
10. Session ID regeneration (fixation defense)
11. Host-only cookie flags (HttpOnly, SameSite=Lax, Path=/)
12. Indian phone normalization
13. CSRF token & Origin verification
14. CORS unapproved origin rejection
15. 5 failed attempts trigger 429 lockout
16. Malformed JSON returns 400 Bad Request
17. Startup failure if insecure settings in production
18. Android Capacitor WebView origin support
19. Zero secret leakage in API responses & client bundle
