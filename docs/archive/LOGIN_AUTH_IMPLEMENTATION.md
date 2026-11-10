> [!NOTE] SUPERSEDED — NOT CURRENT OPERATING INSTRUCTIONS
> This document is an archived historical report/prompt preserved for audit trail purposes.
> Refer to the canonical documentation in docs/ and README.md for current operational instructions.

# Khata Owner Login & Authentication — Implementation Specification

> Scope note: this document covers the owner login/authentication system, its security controls, Neon PostgreSQL/Realtime integration, and the Capacitor Android authentication/build requirements. It does not ask the agent to invent or rebuild the separate Products, Khata ledger, Udhar, or payment business features unless those features are already present and need auth protection.

**Document status:** Agreed implementation baseline  
**Product:** Single-owner Khata application  
**Frontend domain:** `https://erp.algions.in`  
**Backend domain:** `https://api-erp.algions.in`  
**Database:** Neon PostgreSQL  
**Backend hosting:** Render  
**Web hosting:** Vercel or another compatible frontend host  
**Android:** Capacitor APK distributed directly; no Play Store publishing requirement

---

## 1. Purpose and scope

Implement one secure login system for a simple Khata book used by one shopkeeper. The application has exactly one owner account. The owner signs in using an Indian mobile number and password. The credentials are configured on the backend through environment variables.

The system must support:

- Browser access through `erp.algions.in`.
- Backend APIs through `api-erp.algions.in`.
- An Android APK built with Capacitor.
- One common owner identity and one server-side session system backed by PostgreSQL.
- Secure logout, session expiration, login abuse controls, CSRF defence and authorization on every protected API.

This is not a multi-tenant product, employee portal, customer login system, CRM or enterprise identity platform.

### Out of scope

Do not add public sign-up, forgot-password email flows, OTP, Google/social login, multiple users, employee accounts, roles, shop switching, JWT access tokens, refresh tokens, inventory, suppliers, GST, or unrelated modules.

---

## 2. Product context

After successful owner login, the owner accesses the existing Khata application. The main product has only two primary sections:

1. **Products** — product name and buying price for the owner's reference.
2. **Khata** — customers who actually take goods on credit, Udhar entries, and payments received.

Authentication work must protect the existing application and APIs without changing this product scope. No customer or employee should be able to log into the owner dashboard.

---

## 3. Domain, browser origin and cookie model

Use the following intended production setup:

| Purpose | URL |
|---|---|
| Web frontend | `https://erp.algions.in` |
| API backend | `https://api-erp.algions.in` |
| Main company website (unaffected) | `https://www.algions.in` |

The frontend and backend have different **origins**, so the browser needs credentialed CORS. They are expected to be **same-site** because both use HTTPS and share the registrable domain `algions.in`.

### Production cookie requirements

- Cookie name: configurable; recommended `khata_session`.
- `HttpOnly`: true.
- `Secure`: true.
- `SameSite`: `Lax`.
- `Path`: `/`.
- `Domain`: omit the attribute. This creates a host-only cookie for `api-erp.algions.in` instead of sharing the cookie with every `algions.in` subdomain.
- Expiry: 7-day inactivity expiry, configurable through `SESSION_MAX_AGE_MS`.
- No session identifier in JSON, localStorage, sessionStorage, logs, URLs or HTML.

Do not change the production cookie to `SameSite=None` merely to resolve a local development issue. First verify the actual production origins and browser behaviour.

### Frontend request settings

Use a central API client. For `fetch`, use `credentials: 'include'`. For Axios, use `withCredentials: true`. Do not set credentials individually in inconsistent ways across the app.

### Backend CORS

- Allow only the exact configured production frontend origin: `https://erp.algions.in`.
- Allow explicitly configured local-development origins only in development.
- Set `Access-Control-Allow-Credentials: true`.
- Never combine credentialed CORS with `Access-Control-Allow-Origin: *`.
- Support required preflight methods and headers, including the CSRF header.
- Include `Vary: Origin` where appropriate.
- Reject unapproved origins.

### Render reverse proxy

Configure Express proxy trust based on Render's actual proxy topology. The app must correctly detect HTTPS so `Secure` cookies work. Do not trust arbitrary forwarded headers from untrusted clients. Use the repository's existing deployment pattern and document the selected trust-proxy value.

---

## 4. Owner identity and credential configuration

There is exactly one owner. The backend reads:

- `OWNER_PHONE`: canonical 10-digit Indian mobile number.
- `OWNER_PASSWORD_HASH`: Argon2id hash of the owner's password.

The real password is never stored in a database, source file, frontend bundle, Android assets, or Git repository. Compare the submitted normalized phone number with `OWNER_PHONE`, and verify the submitted password using Argon2id against `OWNER_PASSWORD_HASH`.

### Phone input rules

Accept either:

- A 10-digit Indian mobile number; or
- `+91` followed by the same 10 digits (spaces/hyphens may be accepted only if deliberately normalized).

Normalize to one canonical 10-digit value. Reject malformed, too-short, too-long, alphabetic or otherwise invalid inputs. Avoid overly clever normalization that could turn arbitrary strings into a valid number.

### Password rules

- The password is treated as an opaque string and verified using Argon2id.
- Never trim, lowercase, alter, or SQL-escape the password before hashing verification; those operations can change the password the owner intended.
- Enforce a reasonable maximum input length and request-body limit to prevent resource abuse. Do not silently truncate passwords.
- The login form should allow password managers and paste.
- Never log submitted passwords.

### Generic authentication failure

For an unknown phone number and for a wrong password, return the same HTTP status and generic response, such as:

`Invalid mobile number or password.`

Avoid different response shapes, messages or obvious timing behaviour that disclose whether the configured phone number exists. Where practical, perform a dummy Argon2 verification on unknown-phone attempts to reduce timing differences.

---

## 5. Password hash generation and rotation

Create a one-time local CLI script using the same maintained Argon2 library and Argon2id parameters as the backend.

Requirements for the script:

- Prompt for the password without echoing the characters.
- Do not accept the plaintext password as a command-line argument.
- Do not write the plaintext password into any file, log, environment file, source code or shell history.
- Print only the encoded Argon2id hash.
- Use library-supported, current Argon2id parameters and document them. Do not invent weak parameters.

The owner copies the generated hash into Render's backend environment variable `OWNER_PASSWORD_HASH` and redeploys. Password changes must also invalidate existing sessions, either by explicitly deleting session records or rotating the session secret / using a credential-version mechanism. Document the chosen procedure.

There is no public forgot-password endpoint. The recovery procedure is an owner-controlled environment update and redeployment.

---

## 6. Authentication architecture: opaque PostgreSQL-backed sessions

Use server-side sessions, not JWTs.

### Session lifecycle

1. Owner submits phone number and password over HTTPS.
2. Backend validates request shape and input limits.
3. Backend checks persistent login rate limits.
4. Backend normalizes the phone and verifies the configured owner credentials.
5. On success, backend regenerates the session ID to prevent session fixation.
6. Backend stores the authenticated owner marker in the server-side session and explicitly saves the session before returning success.
7. Browser receives an HttpOnly session cookie. The cookie contains only an opaque random session identifier.
8. Browser includes the cookie on subsequent credentialed API calls to the API host.
9. Backend session middleware loads and validates the server-side session before allowing protected routes.
10. Logout destroys the session in PostgreSQL and clears the cookie with the same cookie options.

### Session store

- Use PostgreSQL-backed session storage, such as a maintained Express session store compatible with the installed versions.
- Reuse one shared PostgreSQL connection pool.
- Do not use Express `MemoryStore` in production.
- Ensure session table creation/migration is deterministic and documented. Prefer a controlled migration in production over silently relying on runtime table creation.
- Add indexes and configure cleanup of expired sessions.
- Confirm store TTL is refreshed correctly if rolling expiration is enabled.

### Session settings

Recommended Express session settings:

- `resave: false`
- `saveUninitialized: false`
- `httpOnly: true`
- `secure: true` in production
- `sameSite: 'lax'`
- `path: '/'`
- No `domain` option
- Configured cookie name

The actual implementation may differ depending on the existing framework, but it must preserve these security properties.

### Seven-day expiry

The baseline is a **7-day inactivity timeout**, configured by:

`SESSION_MAX_AGE_MS=604800000`

If rolling sessions are enabled, valid activity refreshes the browser cookie and server-side store expiry consistently. The browser cookie must not outlive the server-side record. Document whether expiry is rolling or fixed. Do not describe a rolling inactivity timeout as a fixed seven-day maximum lifetime.

An absolute maximum lifetime can be added as a separate documented setting, but it is not a substitute for the configured seven-day inactivity timeout.

### Session invalidation

- Logout destroys the active session.
- Password rotation invalidates all prior sessions.
- A session missing from the server-side store must fail closed even if the browser still has an old cookie.
- Consider an owner-only “log out all sessions” operation only if it can be safely exposed to the authenticated owner; it is not a separate user-management feature.

---

## 7. Environment variables

All backend credentials, secrets and deployment-specific security settings must be read from backend environment variables. The frontend must not receive these values.

### Required production baseline

```env
# Application
NODE_ENV=production
PORT=5000

# Exactly one owner
OWNER_PHONE=1234567890
OWNER_PASSWORD_HASH=REPLACE_WITH_ARGON2ID_HASH

# Neon PostgreSQL (Neon CLI supplies these)
# Use the pooled URL for the long-running Render application runtime.
DATABASE_URL_POOLED=REPLACE_WITH_NEON_POOLED_POSTGRESQL_URL
# Use the direct URL for migrations and administrative database tasks.
DATABASE_URL=REPLACE_WITH_NEON_DIRECT_POSTGRESQL_URL

# Neon Realtime (server-side only)
NEON_REALTIME_URL=REPLACE_WITH_NEON_REALTIME_ENDPOINT
NEON_REALTIME_SECRET=REPLACE_WITH_ROTATED_NEON_REALTIME_SECRET

# Server-side sessions
SESSION_SECRET=REPLACE_WITH_LONG_RANDOM_SECRET
SESSION_MAX_AGE_MS=604800000
SESSION_COOKIE_NAME=khata_session
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_HTTP_ONLY=true
SESSION_COOKIE_SAME_SITE=lax

# Browser frontend origin
FRONTEND_URL=https://erp.algions.in

# Login-abuse protection
LOGIN_MAX_ATTEMPTS=5
LOGIN_FAILURE_WINDOW_MS=900000
LOGIN_LOCK_DURATION_MS=900000
LOGIN_EXTENDED_THRESHOLD=10
LOGIN_EXTENDED_WINDOW_MS=86400000
LOGIN_EXTENDED_LOCK_DURATION_MS=1800000
LOGIN_LOG_RETENTION_DAYS=30

# Reverse proxy (set according to verified Render topology)
TRUST_PROXY=1
```

### Meaning of the main values

| Variable | Meaning |
|---|---|
| `OWNER_PHONE` | The only owner's canonical 10-digit number |
| `OWNER_PASSWORD_HASH` | Argon2id hash, never plaintext |
| `DATABASE_URL_POOLED` | Neon pooled PostgreSQL URL for normal application queries and the shared runtime pool |
| `DATABASE_URL` | Neon direct PostgreSQL URL for migrations and administrative tasks; do not use it for each application request |
| `NEON_REALTIME_URL` | Neon Realtime endpoint used by the supported Realtime client/SDK |
| `NEON_REALTIME_SECRET` | Server-only secret used by the backend to seal/authorize live queries; never expose it to the frontend or APK |
| `SESSION_SECRET` | Long, cryptographically random server-only secret |
| `SESSION_MAX_AGE_MS` | Session inactivity lifetime; 604800000 ms = 7 days |
| `SESSION_COOKIE_NAME` | Opaque session cookie name |
| `SESSION_COOKIE_SECURE` | Must be true in production |
| `SESSION_COOKIE_HTTP_ONLY` | Must be true |
| `SESSION_COOKIE_SAME_SITE` | `lax` for the intended HTTPS subdomains |
| `FRONTEND_URL` | Exact browser frontend origin allowed by credentialed CORS |
| `LOGIN_MAX_ATTEMPTS` | Five failures in the configured failure window |
| `LOGIN_FAILURE_WINDOW_MS` | 900000 ms = 15 minutes |
| `LOGIN_LOCK_DURATION_MS` | 900000 ms = 15-minute initial block |
| `LOGIN_EXTENDED_THRESHOLD` | Ten failures for extended protection |
| `LOGIN_EXTENDED_WINDOW_MS` | 86400000 ms = 24 hours |
| `LOGIN_EXTENDED_LOCK_DURATION_MS` | 1800000 ms = 30-minute extended block |
| `LOGIN_LOG_RETENTION_DAYS` | Retention for old login-attempt metadata |
| `TRUST_PROXY` | Express trusted proxy setting, after verifying Render topology |

The backend must parse and validate all values at startup. Do not use JavaScript truthiness for string booleans (`"false"` is truthy). Validate URLs, enums, positive integer ranges, hash format and secret length. In production, fail startup if required variables are missing or insecure. Do not silently substitute a development secret or disable Secure cookies.

`.env.example` may contain placeholders only. Real `.env` files must be excluded from Git. Do not use `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_` or any client-exposed prefix for backend secrets.

---

### Neon CLI provisioning and service integration

The target Neon project has already been created in the Neon Console. Before running commands, inspect the repository root for `.neon`, `neon.ts`, `.env`, `.env.local`, existing migrations, and prior Neon setup. Do not overwrite existing config or env files blindly. Do not create a second Neon project or branch if the linked target already exists.

The intended Neon identifiers are:

- Organization: `org-red-haze-69535662`
- Project: `shy-mud-94919289`
- Branch: `production`
- Services declared: `postgres,realtime`

From the actual project root, follow this sequence if setup has not already been completed:

```bash
npm i -g neon@latest
# If global installation is blocked, use npx neon@latest instead of neon.
neon init -y --org-id org-red-haze-69535662 --project-id shy-mud-94919289 --branch production --services postgres,realtime
neon deploy
```

If a Neon command opens a browser sign-in, stop and tell the owner to finish the sign-in in that browser. If browser authentication times out or fails, ask the owner to run `neon login` in the project terminal, then retry the failed command. Do not claim provisioning succeeded until CLI output and Neon branch/service state confirm it.

`neon init` should link the repository to the intended project/branch, install or expose Neon agent tooling, create/update `neon.ts` declaring PostgreSQL and Realtime, and pull environment variables into `.env.local` (or `.env` if that file already exists). Review every file diff before proceeding. `neon deploy` applies the declared services and pulls the service environment variables. Preserve unrelated environment variables and never print secret values in logs or the final report.

If the Neon Realtime agent skill is not present after initialization, install/read the current official skill as supported by the CLI, for example:

```bash
neon skills -s neon-realtime
```

Read the installed Neon PostgreSQL and Neon Realtime skills before writing integration code. Use the currently documented Neon SDK APIs and versions; do not invent package names, adapters, or protocol details from memory. Official current references include:

- `https://neon.com/docs/cli/init`
- `https://neon.com/blog/neon-now-has-realtime`
- `https://neon.com/docs`

#### PostgreSQL driver and connection selection

This application is a long-running Node.js/Express backend on Render, not an edge/serverless function. Inspect existing ORM/query-builder/driver before adding anything. Reuse the existing data-access layer if sound. If no driver exists, use a conventional Node PostgreSQL pool (`pg`) against Neon's pooled endpoint for normal application runtime queries. Do not open a database connection or pool per request.

- Runtime application queries and the PostgreSQL session store: `DATABASE_URL_POOLED`.
- Schema migrations and administrative tasks: `DATABASE_URL` (direct connection).
- The Neon CLI's `DATABASE_URL` is the direct connection and `DATABASE_URL_POOLED` is the pooler URL; preserve these meanings. Do not silently swap the values or overwrite them with placeholders.
- Keep SSL/TLS enabled as required by Neon's connection string. Never disable certificate verification to work around a connection error.
- If the existing ORM has a documented Neon-compatible adapter, consult its current Neon skill and choose the correct adapter for the Render Node runtime. Explain the choice in the implementation report.
- Use one reusable application pool. Ensure the session store can safely use the selected connection strategy; if it has special PgBouncer requirements, follow the store's current documentation and verify with integration tests.

#### Neon Realtime integration

Realtime was explicitly requested as a provisioned Neon service. Wire it into the application using the official installed Neon Realtime skill and supported SDK, rather than treating the environment variables as sufficient by themselves.

- `NEON_REALTIME_URL` and `NEON_REALTIME_SECRET` are backend configuration. The secret must never appear in frontend code, Vite-exposed variables, source maps, logs, API responses, or APK assets.
- The backend must first authenticate the owner session, then create/seal only the approved live SQL queries needed by the Khata UI. Derive query parameters from authenticated server-side context; do not trust user-supplied owner identifiers.
- Return only the SDK's sealed query/subscription material to the authorized client. Never return the Realtime signing secret or a raw database connection string.
- Prefer live updates for the dashboard aggregates and the currently viewed Khata/customer ledger so changes made in the web app or APK are reflected on other connected clients. Do not expose unrelated tables or unnecessary personal data through subscriptions.
- Preserve ordinary authenticated REST endpoints as the source of truth and as a fallback. Realtime is a synchronization enhancement, not a replacement for authorization, validation, persistence, or error handling.
- Confirm whether the SDK supports the actual browser and Capacitor WebView environments. Test reconnect, disconnect, session expiry, logout and app restart. If Capacitor cannot safely use the browser subscription path, use a documented secure alternative or keep the APK on authenticated API refetch while keeping the web subscription; do not weaken cookie or CORS security globally.
- Realtime is currently a beta service according to Neon documentation. Isolate the integration behind a small module so it can be changed without rewriting the Khata data layer. Document beta limitations and do not make core ledger correctness depend on receiving a live event.
- Run a real end-to-end subscription test: subscribe to an approved test query, perform a committed write through the application or an isolated test fixture, verify the subscriber receives the updated result, then clean up test data. Do not mutate/delete real customer records for a smoke test. Prefer a non-production branch or disposable fixture where available.

#### Credential rotation and environment handling

Database and Realtime credentials previously pasted into chat must be treated as exposed. Do not copy those old literal values into source files, documentation, test fixtures, logs, or hosting configuration. Before production use, have the owner rotate the `neondb_owner` role password and the Realtime secret in Neon, then use the newly generated values from the CLI/Console. The agent must not display secrets in its output.

Keep real `.env`/`.env.local` files out of Git. Confirm `.gitignore` covers them. The frontend receives only a public API base URL (for example `VITE_API_BASE_URL=https://api-erp.algions.in`); never put `DATABASE_URL`, `DATABASE_URL_POOLED`, `NEON_REALTIME_SECRET`, `SESSION_SECRET`, or `OWNER_PASSWORD_HASH` behind any frontend-exposed prefix.

## 8. Brute-force and login abuse protection

Login attempts must be tracked in a persistent/shared store so protection remains effective across restarts and multiple backend instances.

### Agreed starting thresholds

- Five failed attempts within the 15-minute failure window: temporary block for 15 minutes.
- Ten failed attempts within the 24-hour extended window: longer block for 30 minutes.

### Required implementation considerations

- Rate-limit by IP and by a normalized account identifier, with a combined bucket where useful.
- Use only a proxy-derived client IP that is trustworthy under the configured deployment topology.
- Do not trust arbitrary client-provided `X-Forwarded-For` values.
- A remote attacker must not be able to permanently lock the owner's account from every device simply by submitting the owner's phone number repeatedly. Use IP-specific/combined locks and a carefully designed account-level progressive delay rather than a global permanent lock.
- If the owner is temporarily blocked, provide a clear generic retry message and a safe recovery path after the configured period.
- Use HTTP 429 for rate-limited requests.
- Do not store passwords or full request bodies in attempt records.
- Prefer keyed hashes for phone/IP rate-limit identifiers where practical. Avoid retaining raw IP addresses longer than necessary.
- Add indexes and retention cleanup for attempt metadata.
- Ensure concurrent login attempts cannot race around the thresholds; use atomic database updates/transactions or a reliable shared limiter.

The thresholds are configurable. Do not treat them as a reason to permanently disable the owner account.

---

## 9. SQL injection, XSS and input validation

### SQL injection

All database access must use parameterized queries or safe ORM/query-builder methods. Never interpolate user input into SQL strings. Never compare the password in SQL. Argon2id checks the submitted password in application code.

Examples of malicious password strings that must be treated as ordinary invalid password input:

```text
1=1
' OR '1'='1
' OR 1=1 --
admin' --
'; DROP TABLE products; --
```

None of these values may bypass login, alter queries, or modify database contents.

### Validation

- Use a schema-validation library already in the repository, or add a maintained one if needed.
- Validate phone number, password type and maximum size on the backend.
- Reject malformed JSON, wrong content types, unexpected types, unexpected fields and oversized bodies.
- Do not rely on frontend-only validation.
- Avoid returning internal validation, SQL or stack-trace details to users.

### XSS

- Use React's normal escaped rendering.
- Do not use `dangerouslySetInnerHTML` for user-controlled values.
- Configure a suitable Content Security Policy at the frontend hosting layer as well as applicable backend security headers. Helmet on the API does not automatically set CSP for static HTML served by Vercel.
- Do not weaken CSP with broad unsafe directives just to make a build pass. Inspect actual build/runtime resource requirements.

---

## 10. CSRF protection

SameSite=Lax is useful but is not a complete CSRF defence.

For state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`):

1. Use a maintained CSRF implementation compatible with the existing framework, or a correctly implemented session-bound synchronizer token.
2. Provide a documented way for the frontend to obtain the CSRF token.
3. Send the token in a custom header such as `X-CSRF-Token`.
4. Validate the token server-side against the active session.
5. Validate `Origin` against the exact allowed frontend origin. Use `Referer` as a carefully implemented fallback where appropriate.
6. Reject unsafe requests with missing/invalid token or invalid origin.
7. Ensure login and logout flows are handled correctly by the chosen CSRF design, including token bootstrap and session regeneration.

Do not rely only on checking a custom header, only on SameSite, or only on CORS. Do not add a deprecated or unmaintained CSRF dependency without evaluating its maintenance and compatibility.

---

## 11. Backend API contract

Use the repository's existing API versioning and response conventions. At minimum, implement equivalent functionality to:

### `POST /api/v1/auth/login`

Request:

```json
{
  "phone": "9876543210",
  "password": "owner-entered-password"
}
```

Success:

- HTTP 200.
- Session is regenerated and saved server-side.
- Opaque HttpOnly cookie is set.
- JSON contains only minimal state, for example:

```json
{
  "authenticated": true,
  "owner": {
    "role": "OWNER"
  }
}
```

Do not return a user password, hash, cookie value or session identifier.

Failure:

```json
{
  "message": "Invalid mobile number or password."
}
```

Use the same failure response for unknown phone and incorrect password. Use 429 for active rate limits.

### `GET /api/v1/auth/me`

- Requires valid server-side session.
- Returns minimal owner-authenticated state.
- Returns 401 when no valid session exists.

### `POST /api/v1/auth/logout`

- Applies required CSRF/Origin checks.
- Destroys the server-side session.
- Clears the cookie with matching name/path/security options.
- Returns a simple success response.

### Protected routes

Every protected API must use server-side session middleware. Never rely on the React route guard or a client-side boolean. Check all existing routes, not just the dashboard endpoint.

Use `Cache-Control: no-store` for auth/session responses.

---

## 12. Frontend login screen

Build a clean and professional login page that matches the existing Khata application design.

### Required content

- Khata app name/brand.
- Heading: **Owner Login**.
- Mobile number field with a 10-digit Indian mobile hint; support optional `+91` only if normalization is implemented consistently.
- Password field with show/hide control.
- Primary **Login** button.
- Loading state while the request is in progress.
- Accessible inline error feedback for invalid credentials, network errors and rate limiting.

### Must not appear

- Create account / Sign up.
- Customer login.
- Employee login.
- Google or social login.
- OTP login.
- Public forgot-password flow.

### UX and accessibility

- Responsive on mobile, tablet and desktop.
- Labels are programmatically associated with inputs.
- Keyboard navigation and visible focus state.
- Appropriate colour contrast.
- Input autocomplete attributes are appropriate (`tel` for phone and `current-password` for password).
- Prevent accidental double submission.
- Do not reveal whether the phone or password was incorrect.
- Do not retain the password after a failed attempt unnecessarily.
- Do not store auth state as a trusted localStorage flag.

### Frontend session bootstrap

On app start or page refresh, call `/auth/me` using credentials. Render protected routes only after the server confirms a valid session. Handle loading, authenticated, unauthenticated and network-error states distinctly. On logout, call the backend, clear in-memory frontend state and navigate to the login page.

---

## 13. Capacitor Android APK considerations

The Android WebView may use a local/custom origin rather than `https://erp.algions.in`. A request from a local Capacitor origin to `api-erp.algions.in` may be cross-site, which can change `SameSite=Lax` cookie behaviour.

Before implementing the APK session mechanism:

1. Inspect `capacitor.config.*`, Android configuration and the actual production WebView origin.
2. Determine whether API calls are made through browser `fetch`/Axios or native HTTP.
3. Build and run the actual APK, not only the browser app.
4. Test cookie acceptance, cookie sending, persistence after app restart, session expiry and logout.
5. Do not globally change the browser cookie to `SameSite=None` without a security analysis.
6. Do not embed backend secrets, owner password/hash, session secret or database URL in the APK.
7. Do not save session tokens in localStorage.

If ordinary HttpOnly cookie authentication cannot work reliably with the packaged origin, design a secure native transport for the same opaque server-side session system. Use a maintained Capacitor-compatible native HTTP and secure-storage approach, with Android Keystore protection as appropriate. The server must still validate/revoke sessions in PostgreSQL. Do not silently replace the session model with long-lived JWTs or refresh tokens.

Document the final Android design and its security trade-offs. If an actual APK test cannot be run, mark it **NOT TESTED** and do not claim that Android authentication is complete.

---

### Android app identity, packaging and release signing

The Android APK is a separately installable native Android application that packages the same React frontend build with Capacitor. It is not merely a browser bookmark or a remote website wrapper. It shares the Render API and Neon database with the website.

- Inspect the existing Capacitor configuration and Android project before changing it. Preserve an existing application ID, app name, icon, signing setup and versioning unless there is a documented reason to change them.
- If Capacitor is absent, add it using the current official Capacitor guidance and the repository's existing frontend build output. Bundle the built frontend assets locally in the APK; do not make the production APK depend on loading the entire UI from a remote `server.url` unless the owner explicitly approves that architecture.
- If no application ID exists, propose `in.algions.khata` as the default and document it before applying it. Use `Khata` as the default display name only if no app name already exists.
- Produce a debug APK for functional testing and a release APK for direct installation when the Android toolchain is available.
- A release APK must be signed with a dedicated release keystore. Reuse an existing valid app-signing key if one exists. If none exists, explain that creating a new keystore establishes the app's signing identity; future updates must use the same key. Never invent or hardcode keystore passwords.
- Keep the keystore outside the repository (for example in the owner's private Android signing directory or a protected CI secret store). Add keystore files and signing property files to `.gitignore`. Never commit the keystore, passwords, private keys, or signing credentials.
- Configure Gradle signing through protected environment variables or a private, ignored properties file. Do not expose signing credentials to Vite, the JavaScript bundle, the APK assets, logs, or source control.
- If keystore creation or signing requires a password, use a secure interactive prompt or ask the owner to configure protected secrets. Do not put passwords in shell command arguments or print them in the report.
- Verify the release artifact with Android build tools (for example `apksigner verify --verbose --print-certs <release.apk>`). Report the package/application ID, version name/code, APK path, signer certificate fingerprint, and exact verification output, but never report the keystore password or private key.
- Document how to back up the keystore securely. Losing or changing the signing key can prevent existing direct-install users from updating the installed app in place.
- Test installation and update behaviour on a real Android device or emulator where available. If no device/emulator is available, mark that test NOT TESTED rather than claiming success.

The APK uses its own packaged frontend and signing identity, but must authenticate as the same single owner against the same backend. Validate Capacitor WebView/native HTTP cookie behaviour rather than assuming desktop browser cookies work. Keep the opaque server-side PostgreSQL session model; do not add JWT or refresh tokens just to work around WebView cookies. If a secure native session transport is necessary, use a maintained Capacitor-compatible implementation and protect any native-held session material with Android Keystore-backed storage where appropriate.

## 14. Suggested repository file responsibilities

The agent must adapt these responsibilities to actual repository structure; do not create duplicates when an equivalent module already exists.

| Responsibility | Example file |
|---|---|
| Environment parsing/validation | `backend/src/config/env.ts` |
| Shared PostgreSQL pool | `backend/src/config/database.ts` |
| Session store and cookie config | `backend/src/config/session.ts` |
| Login/me/logout routes | `backend/src/modules/auth/auth.routes.ts` |
| Request/response handling | `backend/src/modules/auth/auth.controller.ts` |
| Phone normalization and Argon2 | `backend/src/modules/auth/auth.service.ts` |
| Request schema | `backend/src/modules/auth/auth.validation.ts` |
| Protected-route middleware | `backend/src/middleware/requireOwnerSession.ts` |
| CSRF protection | `backend/src/middleware/csrf.ts` |
| Persistent login attempts | `backend/src/modules/auth/loginAttemptStore.ts` |
| Hidden password-hash generator | `backend/scripts/hash-owner-password.ts` |
| Auth integration tests | `backend/tests/auth.integration.test.ts` |
| Login page | `frontend/src/features/auth/LoginPage.tsx` |
| Auth provider/bootstrap | `frontend/src/features/auth/AuthProvider.tsx` |
| Auth API functions | `frontend/src/features/auth/authApi.ts` |
| Credentialed API client | `frontend/src/lib/apiClient.ts` |
| Client route guard | `frontend/src/components/ProtectedRoute.tsx` |
| Example environment placeholders | `.env.example` |
| Secret exclusions | `.gitignore` |

---

## 15. Recommended implementation sequence

### Phase 1 — Audit

- Inspect project tree, dependencies, architecture and tests.
- Map existing authentication and database code.
- Identify actual Capacitor origin and hosting config.
- Produce exact file mapping and implementation plan.

### Phase 2 — Environment

- Implement validated environment loading.
- Add `.env.example` placeholders.
- Update `.gitignore` to protect real secrets.
- Add hidden-input Argon2id hash-generation script.
- Verify no secrets are exposed to frontend or APK.

### Phase 3 — PostgreSQL stores

- Reuse one PostgreSQL connection pool.
- Create/migrate the session table.
- Create persistent login-attempt tracking storage.
- Add indexes, expiry cleanup and retention cleanup.
- Ensure concurrency-safe updates.

### Phase 4 — Backend auth

- Implement phone normalization and password verification.
- Implement login, session regeneration, session save, `/me`, logout and protected middleware.
- Implement generic errors and no-store headers.
- Ensure all existing protected API routes use the middleware.

### Phase 5 — Security layers

- Exact-origin credentialed CORS.
- Host-only HttpOnly Secure Lax cookie.
- 7-day inactivity expiry from environment.
- Render proxy trust.
- CSRF token and Origin/Referer validation.
- Persistent login rate limiting and lockout.
- Strict validation, body-size limit, security headers and safe errors.

### Phase 6 — Frontend

- Implement responsive owner login UI.
- Implement central credentialed API client.
- Implement `/me` session bootstrap and protected routes.
- Implement logout and expiry/network states.

### Phase 7 — Android

- Verify actual Capacitor WebView origin.
- Implement secure session handling for the APK.
- Build APK and test on emulator/device.

### Phase 8 — Verification

- Run tests, lint, typecheck and production builds.
- Execute security test cases below.
- Review changes for regressions and unsafe shortcuts.
- Document test evidence and any remaining limitations.

---

## 16. Acceptance tests and attack simulations

The authentication work is not complete until the following are tested or explicitly marked not tested.

### Login correctness

- Correct configured phone + correct password succeeds.
- Wrong password fails.
- Unknown phone fails with the same generic message/status.
- `+91` and 10-digit formats normalize as intended.
- Malformed phone numbers are rejected.
- Empty, non-string, oversized and malformed JSON inputs are rejected.

### SQL injection

Try each as the password, and where sensible as the phone input:

```text
1=1
' OR '1'='1
' OR 1=1 --
admin' --
'; DROP TABLE products; --
```

Expected: no authentication bypass, no SQL modification, no data loss, no database error leakage. These are values, not executable SQL. All database calls must be parameterized or safely built by the ORM.

### XSS

Try:

```html
<script>alert(1)</script>
```

Expected: rejected or rendered inertly as text. It must never execute. No unsafe HTML rendering of untrusted values.

### Session security

- Session ID changes after successful login.
- Cookie is HttpOnly, Secure, SameSite=Lax and Path=/ in production.
- Cookie has no Domain attribute.
- Missing, invalid, expired or revoked sessions cannot access protected APIs.
- Valid session accesses only permitted owner routes.
- Logout destroys the server-side session; replaying the old cookie fails.
- Session storage persists across backend restart, subject to expiry.
- Seven-day expiry and rolling behaviour match the documented policy and PostgreSQL TTL.
- Password rotation invalidates old sessions.

### CSRF and CORS

- Allowed frontend origin can make credentialed requests.
- Unapproved origins are rejected.
- Wildcard origin is never used with credentials.
- Missing/invalid CSRF token is rejected for unsafe methods.
- Invalid Origin is rejected.
- Login and logout work correctly with CSRF bootstrap/regeneration.

### Login abuse protection

- Five failures in the configured window trigger the 15-minute initial protection.
- Ten failures in the extended window trigger 30-minute extended protection.
- Rate limits remain effective after process restart and across instances.
- Changing spoofed `X-Forwarded-For` does not bypass limits.
- One attacker cannot trivially lock the owner out from all devices forever.
- Old attempt records are cleaned up according to retention settings.

### Configuration and deployment

- Missing production secrets cause startup failure.
- Invalid numeric, boolean, URL or enum settings cause startup failure.
- Production `SESSION_COOKIE_SECURE=false` is rejected.
- Real `.env` files are ignored by Git.
- No backend secret appears in the built frontend or APK.
- Main company website configuration is unchanged.

### Android

- Login succeeds in the actual APK.
- Authenticated API calls work.
- Session survives app restart according to documented policy.
- Logout revokes the session.
- Expiry is enforced.
- CSRF and origin/native transport protections are validated.

---

### Neon PostgreSQL and Realtime acceptance

- The linked `.neon` context points to the requested organization, project and `production` branch.
- `neon.ts` declares PostgreSQL and Realtime, and `neon deploy` completes successfully (or any blocker is reported with actual output).
- The runtime connects using `DATABASE_URL_POOLED`; migration tooling connects using direct `DATABASE_URL`.
- Database query, insert, update and rollback/cleanup are verified end to end without exposing credentials.
- The application reuses a single pool and does not open a new pool per request.
- Realtime is enabled on the intended branch and a real subscription receives a committed update.
- The Realtime signing secret remains server-only and is absent from frontend bundles and APK assets.
- Web and Android behaviour is separately tested; any unsupported path is marked NOT TESTED and a safe fallback is documented.
- `npm run build` passes, and each provisioned/wired service is tested end to end. Report the exact commands and unedited relevant output, redacting all secrets.
- Any service that is provisioned but intentionally not used by the application is clearly identified with a reason; do not claim it is integrated merely because its environment variable exists.

## 17. Operational deployment checklist

Before production deployment:

1. Configure `erp.algions.in` to the frontend host using its assigned DNS target.
2. Configure `api-erp.algions.in` to the Render backend using its assigned DNS target.
3. Wait until HTTPS certificates are active for both hostnames.
4. Set production environment variables in Render; do not upload the local `.env` file.
5. Generate the Argon2id password hash locally with the hidden-input script.
6. Configure the exact frontend origin in `FRONTEND_URL`.
7. Verify Render proxy trust and secure cookie behaviour.
8. Run migrations for session and login-attempt tables.
9. Deploy backend and frontend.
10. Verify browser login, refresh, logout, session expiry and rejected malicious requests.
11. Build and test the Android APK separately.
12. Set up independent PostgreSQL backups and periodically test restoration.
13. Confirm `neon.ts`, `.neon`, `.env.example`, lockfile and application code are committed as appropriate; never commit real `.env`/`.env.local` credentials.
14. Confirm Neon Realtime subscription behaviour and beta limitations are documented.

Do not assume a free hosting plan guarantees continuous availability. Authentication must handle backend sleep/restarts and transient network errors gracefully without losing valid server-side sessions.

---

## 18. Final agent report format

At completion, report:

### A. Repository audit
- Existing framework and key directories.
- Existing auth/session code reused or removed.
- Actual Capacitor origin and networking method.

### B. Files changed
- List every created/modified file and its purpose.

### C. Implemented behaviour
- Login, `/me`, logout, sessions, expiry, persistent store, CSRF, CORS, rate limits and protected routes.

### D. Environment setup
- Exact environment variable names and which values the owner must enter in Render.
- Hash-generation and password-rotation instructions.

### E. Verification results
- Test commands and actual pass/fail counts.
- Lint/typecheck/build results.
- APK build/device/emulator results.
- Manual test evidence.

### F. Security acceptance checklist
Use one of:
- **PASS** — verified with test/evidence.
- **FAIL** — requirement is not satisfied.
- **NOT TESTED** — no evidence was obtained.

### G. Remaining risks
List any unresolved issue. Do not claim production readiness if critical authentication, CSRF, cookie, session-store or Android requirements are unverified.

---

## 19. Definition of done

The task is complete only when:

- The owner can log in through the designed login page.
- Only the configured owner credentials are accepted.
- The backend uses Argon2id and opaque PostgreSQL-backed sessions.
- No JWT or refresh-token flow has been added.
- Session expiry is configurable and set to seven days as agreed.
- Browser cookies, CORS and CSRF are configured securely for the two production subdomains.
- All protected APIs reject unauthenticated access.
- Login rate limiting and persistent abuse tracking work.
- SQL injection and XSS tests do not bypass security.
- Secrets are environment-only and absent from client bundles and Git.
- Logout and password rotation revoke old sessions.
- The actual Android APK session approach has been tested, or clearly marked as not tested with the blocker stated.
- Tests and build results are reported honestly.

**The agent must implement the requirements in the existing repository, not merely return a plan or a code sample.**
