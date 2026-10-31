# Khata - Security Architecture & Threat Controls

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Scope:** Authentication, Session Security, CSRF, Rate Limiting, Threat Mitigation  

---

## 1. Authentication Engine (Argon2id)

Khata uses **Argon2id** (via the `argon2` native package), the state-of-the-art memory-hard password hashing algorithm recognized by OWASP and RFC 9106.

### Recommended Hashing Parameters
- **Type:** Argon2id (`argon2.argon2id`)
- **Memory Cost:** 65,536 KiB (64 MiB)
- **Time Cost:** 3 iterations
- **Parallelism:** 4 threads

The owner's password hash is stored exclusively in the backend production environment (`OWNER_PASSWORD_HASH`). Plaintext passwords are never committed, logged, or cached.

---

## 2. Session Management & Host-Only Cookies

Sessions are persisted in PostgreSQL via `connect-pg-simple` and identified by a cryptographically secure session ID (`sid`).

### Cookie Security Attributes
| Attribute | Production Value | Purpose |
|---|---|---|
| `httpOnly` | `true` | Prevents access to the session cookie via client-side JavaScript (mitigates XSS token theft). |
| `secure` | `true` | Enforces transmission exclusively over HTTPS encrypted connections. |
| `sameSite` | `'lax'` | Protects against cross-site request forgery while allowing top-level link navigations. |
| `Domain` | *Omitted (Host-Only)* | Prevents subdomain leakage across unrelated applications hosted under `algions.in`. |
| `maxAge` | 30 Days (2,592,000,000 ms) | Provides persistent single-shopkeeper convenience with automatic expiration. |

---

## 3. Cross-Site Request Forgery (CSRF) Protection

Khata implements the **Double-Submit Cookie Pattern**:

1. Upon successful authentication or page load, the server issues a `csrf-token` cookie (`httpOnly: false`, `secure: true`, `sameSite: 'lax'`).
2. Client-side fetch wrappers ([frontend/src/services/api.ts](file:///c:/Users/rajab/OneDrive/Desktop/khata/frontend/src/services/api.ts)) extract the `csrf-token` value and inject it into the `X-CSRF-Token` HTTP header.
3. Express middleware verifies that `req.headers['x-csrf-token']` matches the cookie token on all mutating requests (`POST`, `PUT`, `DELETE`, `PATCH`).
4. Requests with missing or mismatched CSRF tokens are rejected immediately with `403 Forbidden`.

---

## 4. Brute-Force Defense & Login Rate Limiting

The authentication service protects against credential stuffing and brute-force attacks via multi-tiered controls:

### Multi-Tiered Defense Architecture
1. **Network Rate Limiting:** `express-rate-limit` caps login attempts to 10 requests per 15 minutes per IP address.
2. **Exponential Backoff & Account Lockout:**
   - Client identifier is hashed via SHA-256 with `SESSION_SECRET` as a cryptographic pepper: $\text{Hash} = \text{SHA256}(\text{IP} + \text{UserAgent} + \text{pepper})$.
   - Failed attempts are logged in the `login_attempts` table.
   - 5 consecutive failures trigger a 15-minute account lockout.
   - Additional failures apply exponential backoff penalties.
3. **Throttled Maintenance Pruning:**
   - Expired attempts are purged using non-blocking PostgreSQL advisory locks (`pg_try_advisory_xact_lock(0x4B48415441)`).
   - Pruning executes without stalling concurrent requests.

---

## 5. Destructive Test Guard (`testDbGuard.ts`)

To eliminate the catastrophic risk of running automated test suites against production databases, Khata enforces a hardware-level guard in [backend/src/config/testDbGuard.ts](file:///c:/Users/rajab/OneDrive/Desktop/khata/backend/src/config/testDbGuard.ts):

```typescript
export function assertSafeTestDatabaseUrl(url: string | undefined): void {
  // 1. Must be defined
  // 2. Prohibits Neon production hosts (*.neon.tech)
  // 3. Prohibits AWS, Supabase, Render, Heroku cloud DB hosts
  // 4. Requires database name or URL to include 'test' or 'localhost'/'127.0.0.1'
  // Throws fatal error if any violation is detected.
}
```

This guard is invoked automatically before test suites initialize connections, verified by 7 unit tests in `backend/tests/testDbGuard.test.ts`.

---

## 6. Content Security Policy & Network Security

### Vercel Frontend CSP
Configured in `vercel.json` and `frontend/vercel.json`:
- `default-src 'self'`
- `script-src 'self'`
- `style-src 'self' 'unsafe-inline'` (required for runtime Tailwind dynamic styles)
- `img-src 'self' data: https:`
- `connect-src 'self' https://khata-api-wkn9.onrender.com https://api-khata.algions.in`
- `font-src 'self' data:` (all Montserrat fonts served locally from bundled assets)
- `frame-ancestors 'none'` (clickjacking prevention)
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
