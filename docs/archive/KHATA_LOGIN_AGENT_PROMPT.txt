MASTER CODING-AGENT PROMPT — KHATA OWNER LOGIN & AUTHENTICATION

ROLE
You are a senior full-stack engineer and application-security engineer. Your task is to inspect the existing Khata application repository and implement a complete, production-minded owner login and authentication system for the single-shopkeeper Khata application described in LOGIN_AUTH_IMPLEMENTATION.md.

PRIMARY OBJECTIVE
Implement the owner login UI, backend authentication, secure server-side sessions, environment-driven configuration, session persistence, login abuse protection, CSRF protection, CORS/cookie configuration for the production subdomains, Neon PostgreSQL and Realtime integration, and automated security tests. Ensure the website and a separately installable, locally bundled, properly signed Capacitor Android APK use the same owner account, backend and database. Do not build a general-purpose identity platform. This task is specifically the authentication/infrastructure work; do not invent or rebuild the separate Products, Khata ledger, Udhar and payment business features unless they already exist and need authentication protection.

MANDATORY FIRST ACTION — INSPECT THE REAL REPOSITORY
1. Inspect the repository tree, package manifests, lockfiles, existing frontend framework, backend framework, database layer, routing structure, deployment configuration, test setup, and Capacitor configuration (if present).
2. Identify the actual frontend and backend directories. Do not assume that this prompt's example paths match the repository.
3. Read existing authentication, database, API-client, routing, environment, and deployment code before changing anything.
4. Identify whether any authentication implementation already exists. Reuse and safely improve it rather than creating duplicate middleware, duplicate session stores, competing login pages, or another database connection pool.
5. Identify the actual production origins. The intended production URLs are:
   - Web frontend: https://khata.algions.in
   - API backend: https://api-khata.algions.in
   - Existing company website https://www.algions.in must remain unaffected.
6. Inspect the Android Capacitor app's actual WebView origin and networking approach. Do not assume that cookie behaviour in a desktop browser automatically works in an APK.
7. Before coding, write a short implementation plan in your work notes or final report that maps the requirements below to the actual files in this repository. Then proceed with implementation; do not stop after providing a plan.

SOURCE OF TRUTH
Read LOGIN_AUTH_IMPLEMENTATION.md completely. It is the detailed requirements document and acceptance checklist. Where repository reality conflicts with an example file path or library choice, adapt to the existing architecture while preserving the security requirements. If an essential decision cannot be implemented as specified, explain the exact reason and implement the safest compatible alternative. Do not silently omit requirements.

PRODUCT BOUNDARIES — DO NOT EXPAND SCOPE
- This is one simple Khata book for one shopkeeper and one shop.
- Exactly one owner identity is configured by backend environment variables.
- Login uses an Indian mobile number and password.
- No sign-up, public registration, customer login, employee login, multiple shops, roles, OAuth, Google login, OTP, or paid identity provider.
- Do not introduce JWT access tokens or refresh tokens. Use opaque server-side sessions.
- Do not add inventory, suppliers, GST, CRM, reporting, notifications, billing, or unrelated modules as part of this task.
- The dashboard/product/Khata features are outside the scope of this authentication task except that existing protected routes and APIs must be correctly guarded.

REQUIRED AUTHENTICATION DESIGN
A. Owner identity
- Read OWNER_PHONE and OWNER_PASSWORD_HASH only on the backend.
- OWNER_PASSWORD_HASH must be an Argon2id hash. Never store or compare a plaintext owner password.
- Normalize the submitted phone number to the configured canonical Indian 10-digit format. Accept the agreed input formats (10 digits, or +91 followed by the same 10 digits); reject malformed inputs. Do not transform arbitrary strings into valid phone numbers.
- Compare the normalized phone with OWNER_PHONE using a safe exact comparison. Verify the submitted password with the maintained Argon2 library against OWNER_PASSWORD_HASH. A phone mismatch must not bypass password verification or disclose account existence; use a generic authentication response.
- Do not create a users table just to represent this single env-configured owner unless the existing architecture genuinely requires one. Do not persist the plaintext password.

B. Sessions
- Use opaque, unpredictable server-side session IDs. No JWT and no refresh-token flow.
- Persist sessions in PostgreSQL, using the existing database pool and a maintained PostgreSQL session store (for example, connect-pg-simple if compatible with the installed Express stack). Never use Express MemoryStore in production.
- Use a single shared PostgreSQL pool; do not create a new connection pool per request.
- Configure HttpOnly, Secure, SameSite=Lax, Path=/, and a host-only cookie. Do not set Domain=.algions.in. Cookie name should be configurable (recommended khata_session).
- Configure credentials correctly on the frontend HTTP client and on the backend CORS policy. CORS must allow only the exact configured frontend origin, not '*', when credentials are enabled.
- Regenerate the session ID after successful login to prevent session fixation. Save the session before returning success. Destroy the server-side session on logout and clear the cookie using matching cookie options.
- Do not return the session ID in JSON, put it in localStorage/sessionStorage, or log it.
- Set Cache-Control: no-store on authentication/session responses.
- Configure proxy trust deliberately for the actual Render deployment so Secure cookies work behind the proxy. Do not blindly trust arbitrary forwarded headers.

C. Session expiration
- SESSION_MAX_AGE_MS is environment-driven and defaults must not be silently substituted in production.
- The agreed starting value is 604800000 milliseconds (7 days).
- Implement a clearly documented 7-day inactivity expiry using the session cookie and PostgreSQL store. If rolling expiry is enabled, verify that the session-store TTL is refreshed consistently on valid activity. Do not let the browser cookie live longer than the server-side session.
- Validate SESSION_MAX_AGE_MS as a safe positive integer. Reject invalid values at startup.
- If you add an absolute maximum lifetime as extra protection, make it a separate documented environment variable and do not confuse it with the 7-day inactivity timeout. Do not invent an arbitrary absolute lifetime without documenting it.

D. Login abuse protection
- Make login attempt tracking persistent/shared across backend restarts and instances. Do not rely solely on in-memory counters.
- Implement the agreed starting policy through environment settings:
  * 5 failed attempts within the configured failure window: temporary block for 15 minutes.
  * 10 failed attempts within the extended window: longer block for 30 minutes.
- Use separate IP-based and account-identifier-based buckets, and consider a combined IP + account bucket. Avoid allowing an attacker to permanently lock the one owner account from every device merely by repeatedly submitting the owner's phone number from arbitrary IPs. The implementation should limit attacks without creating an easy denial-of-service against the owner.
- Trust client IP data only according to the actual trusted proxy configuration. Do not trust arbitrary X-Forwarded-For input.
- Return HTTP 429 while rate-limited, with a generic retry message. Do not reveal whether the mobile number exists.
- Add safe cleanup/retention for old attempt records. Avoid storing raw passwords. Minimize retained IP/identifier data; prefer keyed hashes for rate-limit identifiers where practical.

E. CSRF and CORS
- CORS allowlist must contain only the production frontend origin and explicitly configured local-development origins. No wildcard origin with credentials.
- For the browser frontend, send credentials on API calls (fetch credentials: 'include' or Axios withCredentials: true).
- SameSite=Lax is appropriate for the intended HTTPS subdomains khata.algions.in and api-khata.algions.in because they are different origins but same-site under the same registrable domain and scheme. Keep the cookie host-only to api-khata.algions.in.
- SameSite is not a replacement for CSRF protection. Protect state-changing requests (POST, PUT, PATCH, DELETE) with a maintained CSRF implementation or a correctly implemented session-bound synchronizer token, plus strict Origin/Referer validation as defence in depth. Do not use deprecated CSRF packages without checking their maintenance status.
- If a CSRF token endpoint is used, document how the frontend obtains, holds, refreshes, and sends the token. Do not store the CSRF token persistently unless there is a compelling reason; in-memory state is preferred.
- Handle CORS preflight correctly and include Vary: Origin where appropriate.

F. Login API and authorization
- Implement or adapt endpoints following existing API conventions. At minimum support:
  * POST /api/v1/auth/login
  * GET /api/v1/auth/me (or /session) to verify the active session and return minimal owner-authenticated state
  * POST /api/v1/auth/logout
  * A CSRF bootstrap/token endpoint if required by the selected protection strategy
- Use strict request schemas and server-side validation. Reject unknown fields where appropriate, malformed JSON, oversized payloads, invalid content types, and unexpected types.
- Use the same generic message for unknown phone and wrong password: “Invalid mobile number or password.”
- Do not expose stack traces, SQL errors, password hashes, secrets, session IDs, or account-existence clues to clients.
- Every protected backend route must check the authenticated server-side session. Frontend route guards are user experience only and are never a substitute for backend authorization.
- Ensure the auth middleware fails closed when the session is missing, invalid, expired, or destroyed.

LOGIN PAGE — UI REQUIREMENTS
Create a polished, responsive, minimal owner login screen consistent with the existing Khata app design. Inspect the existing visual system and reuse its components, typography, colours, spacing, logo and layout conventions rather than inventing an unrelated design.

The login screen must include:
1. A clear Khata identity/title and concise “Owner Login” heading.
2. Mobile number input with a clear 10-digit Indian mobile hint. If +91 is displayed as a prefix, ensure the actual submitted value is normalized correctly and not double-prefixed.
3. Password input with show/hide control, accessible label, and correct autocomplete attributes.
4. A primary “Login” button with disabled/loading state while the request is in progress.
5. Inline, accessible error feedback for invalid credentials, network issues, and rate limiting. Use a generic invalid-credentials message; do not reveal which field was incorrect.
6. Keyboard accessibility, visible focus, mobile responsiveness, appropriate contrast, and screen-reader labels.
7. No “Create account”, “Sign up”, “Customer login”, social login, OTP, or public “Forgot password” flow. Password rotation is an owner/deployment operation using the environment hash.
8. Do not store passwords in browser storage. Clear the password field after failed login if appropriate.
9. Do not trust a frontend-only “logged in” flag. On app startup, call the backend session endpoint and render the protected app only when the backend confirms a valid session.
10. On logout, call the backend, destroy the session, clear client auth state, and navigate to login.

ANDROID / CAPACITOR REQUIREMENT — MUST TEST, NOT GUESS
The APK may use a different WebView origin (for example capacitor://localhost or https://localhost) from the hosted web frontend. That can change SameSite cookie behaviour. Inspect capacitor.config and actual Android networking before finalizing the cookie configuration.
- Do not weaken the browser cookie policy globally merely to make the APK work.
- Do not place a long-lived JWT or session secret in the APK, source code, assets, or localStorage.
- Prefer a secure, documented solution that keeps server-side opaque sessions. Depending on the actual app configuration, this may mean a carefully configured same-site hosted origin, or a native secure session transport backed by Android Keystore and the same PostgreSQL session store.
- If using native secure storage or native HTTP, use a maintained Capacitor-compatible solution and do not make secrets readable to general page JavaScript unnecessarily.
- Build and run the actual APK. Verify login, cookie/session persistence, authenticated API calls, logout, app restart, expiry, and CSRF behaviour on a real Android device or emulator.
- Document any platform difference. If a fully secure APK session path cannot be validated, report it as a blocker rather than claiming success.

ENVIRONMENT VARIABLES
Implement a single validated backend configuration module. Names should follow the existing repo's conventions, but support at least the following settings (do not add secrets to frontend environment variables):

NODE_ENV=production
PORT=5000
OWNER_PHONE=<canonical 10-digit owner number>
OWNER_PASSWORD_HASH=<Argon2id hash; never plaintext>
DATABASE_URL=<Neon direct PostgreSQL URL for migrations/admin tasks>
DATABASE_URL_POOLED=<Neon pooled PostgreSQL URL for Render runtime queries and session store>
NEON_REALTIME_URL=<Neon Realtime endpoint; backend configuration>
NEON_REALTIME_SECRET=<rotated Neon Realtime signing secret; backend-only>
SESSION_SECRET=<cryptographically random secret, preferably 32+ random bytes>
SESSION_MAX_AGE_MS=604800000
SESSION_COOKIE_NAME=khata_session
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_HTTP_ONLY=true
SESSION_COOKIE_SAME_SITE=lax
FRONTEND_URL=https://khata.algions.in
LOGIN_MAX_ATTEMPTS=5
LOGIN_FAILURE_WINDOW_MS=900000
LOGIN_LOCK_DURATION_MS=900000
LOGIN_EXTENDED_THRESHOLD=10
LOGIN_EXTENDED_WINDOW_MS=86400000
LOGIN_EXTENDED_LOCK_DURATION_MS=1800000
LOGIN_LOG_RETENTION_DAYS=30
TRUST_PROXY=1

Treat the above as the agreed production baseline, not values to hardcode. Validate booleans, enums, URLs, and integers. In production, fail startup if a required secret/configuration is absent, malformed, too short, or insecure (for example, SESSION_COOKIE_SECURE=false). Local development may use explicitly documented local-only values; never silently fall back in production.

Create/update .env.example with placeholders only. Ensure .env, .env.* real secrets, generated credential files, and local database files are ignored by Git. Do not put backend variables in VITE_*, NEXT_PUBLIC_*, REACT_APP_*, Android assets, or client bundles. Add a secret-leak check if the repository already has one.

NEON POSTGRESQL + REALTIME — REQUIRED INFRASTRUCTURE SETUP
The owner has already created the Neon project and provided these target identifiers:
- Organization ID: org-red-haze-69535662
- Project ID: shy-mud-94919289
- Branch: production
- Requested services: postgres,realtime

First inspect the repository root for `.neon`, `neon.ts`, `.env`, `.env.local`, current migrations, database driver and existing Neon setup. Do not overwrite existing config, duplicate the project, or replace existing local env files without reviewing and preserving their contents.

If Neon CLI setup has not already been completed, run from the project root:

```bash
npm i -g neon@latest
# If global installation fails, use npx neon@latest instead of neon.
neon init -y --org-id org-red-haze-69535662 --project-id shy-mud-94919289 --branch production --services postgres,realtime
neon deploy
```

Use `npx neon@latest <command>` when the global binary is unavailable. If a command opens browser sign-in, pause and tell the owner to finish sign-in in that browser. If that times out or fails, ask the owner to run `neon login` from the project terminal, then retry. Do not claim success without verifying command output and the actual branch services.

Review the generated `.neon`, `neon.ts`, `.env.local` or `.env`, package/lockfile changes, and agent tooling. `neon init` should link the requested project/branch and declare Postgres + Realtime in `neon.ts`; `neon deploy` should provision the declared services and pull their environment variables. Read installed Neon agent skills before coding. If the Realtime skill is missing, install it using the current supported CLI command (for example `neon skills -s neon-realtime`). Use current skill guidance for the exact packages, adapters and API imports.

DATABASE DRIVER AND ENVIRONMENT MAPPING
- This app uses a long-running Node.js/Express backend on Render. Inspect existing DB code first. Reuse a correct existing ORM/driver. If no driver exists, use a normal Node PostgreSQL pool (`pg`) for this runtime rather than reflexively selecting an edge/serverless-only adapter.
- Use `DATABASE_URL_POOLED` for the backend runtime's normal PostgreSQL queries and PostgreSQL-backed session store.
- Use direct `DATABASE_URL` for migrations and administrative operations. Neon CLI convention here is `DATABASE_URL` = direct and `DATABASE_URL_POOLED` = pooled; do not swap meanings.
- Reuse one pool; never create one pool per request. Keep TLS enabled. Do not disable certificate checking to fix connection issues.
- If an existing ORM requires a Neon-specific adapter, follow the installed Neon PostgreSQL skill and document why that driver is correct for Render's long-running Node process.
- Validate required env vars at startup. Do not print full connection URLs or secrets in command output/report. Add placeholders to `.env.example`; never commit `.env`/`.env.local`.

NEON REALTIME INTEGRATION
- `NEON_REALTIME_URL` and `NEON_REALTIME_SECRET` must remain backend-only. Never expose the secret in `VITE_*`, browser JS, source maps, API responses, logs, test snapshots, or APK assets.
- Implement Realtime using the installed official Neon Realtime skill and current SDK, not guessed imports or a hand-rolled protocol.
- Authenticated backend endpoints should seal only approved live queries after validating the owner's server-side session. Query parameters must come from trusted backend context, not client-supplied owner identifiers.
- Subscribe to the useful Khata views (dashboard totals and current customer/ledger view) so a committed write from web or APK can update another open client. Preserve authenticated REST APIs as source of truth and fallback. Realtime must not become the only way to read or write ledger data.
- Test web and Capacitor separately. If the APK cannot securely support the browser subscription path, document the reason and use authenticated API refetch for APK rather than weakening cookie/CORS/CSRF protections.
- Realtime is currently beta. Encapsulate it in a dedicated module and document beta limitations; the core Khata ledger must remain correct if a subscription drops.
- Prove end-to-end with a real subscription and committed test write, then clean up the fixture. Do not modify/delete real customer data to test. Prefer a development branch or disposable test fixture.

SECRET ROTATION WARNING
The Neon database URL/password and Realtime secret were pasted into chat previously and must be treated as exposed. Do not reuse those previously shared literal secrets. Ask the owner to rotate the `neondb_owner` password and Realtime secret in Neon before production use, then use the new generated values. Never repeat secrets in terminal logs or the final report.

NEON VERIFICATION / REQUIRED REPORTING
- Verify `.neon` points to org-red-haze-69535662, project shy-mud-94919289, branch production.
- Verify `neon.ts` declares Postgres + Realtime and `neon deploy` succeeds.
- Verify app can query and write PostgreSQL using the pooled URL; verify migrations/admin tasks can use the direct URL.
- Verify a Realtime subscription receives an actual committed update.
- Verify secrets are absent from frontend build output and APK assets.
- Run `npm run build`, start the app, and test each wired service end to end. Include exact commands and relevant actual output, with secrets redacted. Never fabricate a passing result.
- If a command/browser auth requires user interaction, stop at that point and clearly tell the owner what they must do; do not pretend it was completed.

PASSWORD HASH GENERATION
Provide a safe one-time local CLI/script for generating OWNER_PASSWORD_HASH using the same Argon2id parameters used by the backend. It must prompt for the password without echoing it, never log the plaintext, never write the password into source control, and print only the resulting hash for the owner to add to Render's backend environment settings. Do not accept the password as a command-line argument, because command arguments may be visible in process listings or shell history. Document how to rotate the hash and invalidate existing sessions.

SUGGESTED FILE MAPPING — ADAPT TO THE ACTUAL REPOSITORY
Do not blindly create this exact structure if equivalent modules already exist. Map each responsibility to the current codebase:

Backend examples:
- src/config/env.(js|ts): validated environment parsing
- src/config/database.(js|ts): existing PostgreSQL pool
- src/config/session.(js|ts): express-session and PostgreSQL store
- src/modules/auth/auth.routes.(js|ts): login/me/logout routes
- src/modules/auth/auth.controller.(js|ts): HTTP request/response handling
- src/modules/auth/auth.service.(js|ts): phone normalization and Argon2 verification
- src/modules/auth/auth.validation.(js|ts): request schemas
- src/middleware/requireOwnerSession.(js|ts): server-side session guard
- src/middleware/csrf.(js|ts): CSRF validation
- src/modules/auth/loginAttemptStore.(js|ts): persistent lockout tracking
- scripts/hash-owner-password.(js|ts): hidden-input hash generator
- tests/auth.integration.test.(js|ts): integration and security tests

Frontend examples:
- src/features/auth/LoginPage.(jsx|tsx): login UI
- src/features/auth/AuthProvider.(jsx|tsx): server-confirmed auth state
- src/features/auth/authApi.(js|ts): login/me/logout/CSRF API calls
- src/lib/apiClient.(js|ts): centralized credentialed HTTP client
- src/components/ProtectedRoute.(jsx|tsx): navigation guard
- src/features/auth/auth.types.(ts): typed API models if TypeScript is used

Documentation/deployment examples:
- LOGIN_AUTH_IMPLEMENTATION.md: retain/update the supplied source-of-truth document
- .env.example: placeholders only
- .gitignore: protect secrets
- deployment config: CORS, proxy, CSP and custom-domain settings as appropriate

ANDROID APK PACKAGING AND RELEASE SIGNING — REQUIRED
- The Android app must be a real, separately installable Capacitor APK, not merely a shortcut or a remote browser view.
- Inspect existing Capacitor/Android configuration first. Preserve the current application ID, display name, app icon, signing setup and versioning where present.
- Bundle the React build inside the APK using the project's actual Capacitor `webDir`. Do not make the release APK load its entire UI remotely through `server.url` unless the owner explicitly approves it.
- If Capacitor is absent, add it using current official guidance. If no application ID exists, propose `in.algions.khata` and document it before applying; use `Khata` as display name only if none exists.
- Build a debug APK for functional testing and a release APK when the Android SDK/Gradle toolchain is available.
- Reuse an existing valid signing keystore. If none exists, explain that generating a new dedicated keystore fixes the app's signing identity for future updates. Do not invent passwords; ask for secure interactive input or protected owner-provided secrets when needed.
- Keep `.jks`/`.keystore` and signing property files outside source control; update `.gitignore`. Configure Gradle signing using protected environment variables or ignored local properties only. Never place keystore passwords or private keys in JS, Vite variables, APK assets or logs.
- Verify the release signature using `apksigner verify --verbose --print-certs`. Report the package ID, version, artifact path and certificate fingerprint, with no secret values.
- Test install, app restart, login, authenticated API use, logout, session persistence and update behaviour on a real device/emulator if available. Otherwise mark those items NOT TESTED.
- Document secure keystore backup. Future updates to the installed APK must use the same signing identity.
- Follow the complete Android session/cookie requirements in section 13 of LOGIN_AUTH_IMPLEMENTATION.md. Never weaken server-side session security or add JWT/refresh tokens just to make WebView authentication work.

IMPLEMENTATION ORDER — COMPLETE ALL STAGES
STAGE 1 — Repository audit
- Inspect actual architecture, dependencies, code paths and deployment configs.
- Record the real file mapping and any current security gaps.

STAGE 2 — Environment and secrets
- Add typed/validated environment loading.
- Add placeholders to .env.example and update .gitignore.
- Add the Argon2id hidden-password hash generator.
- Verify no backend secrets are present in frontend bundles or committed files.

STAGE 2A — Neon project/service setup
- Inspect existing Neon config and do not duplicate or overwrite it.
- Run the requested Neon CLI init/deploy steps if not already completed.
- Read the installed Neon PostgreSQL and Realtime skills.
- Verify the requested production branch and declared services.
- Configure direct and pooled connection variables correctly.
- Implement and test the Neon Realtime integration as specified above.

STAGE 3 — Database and persistent stores
- Reuse the PostgreSQL pool.
- Add/create the PostgreSQL session table using the selected session-store mechanism.
- Add a persistent login-attempt/lockout table or an equally robust shared store.
- Add safe indexes and retention cleanup for auth-attempt records.
- Use parameterized queries or safe ORM APIs everywhere.

STAGE 4 — Backend authentication
- Implement phone normalization, Argon2id verification, generic errors, session regeneration, session save, /me, logout and protected-route middleware.
- Ensure a server restart does not invalidate valid sessions unexpectedly unless intended by the security design.
- Ensure logout revokes the server-side session.

STAGE 5 — CORS, cookies and CSRF
- Configure exact-origin credentialed CORS.
- Configure host-only cookie flags and 7-day inactivity expiry.
- Configure trusted proxy behaviour for Render.
- Implement CSRF protection and Origin/Referer checks.
- Verify browser requests from https://khata.algions.in to https://api-khata.algions.in.

STAGE 6 — Login UI and frontend auth state
- Implement the login screen and validation.
- Implement central API client with credentials enabled.
- On startup, ask /me; do not infer auth from cached flags.
- Protect client routes and implement logout.
- Provide loading, error, locked, expired-session and network states.

STAGE 7 — Android/Capacitor
- Inspect app origin and native networking.
- Implement a safe Android session strategy compatible with opaque server sessions.
- Build the APK and execute the specified tests. Do not claim APK coverage if no build/device test was run.

STAGE 8 — Automated and manual security testing
- Add unit, integration and end-to-end tests using the project's existing test stack.
- Test the attack payloads and cases in LOGIN_AUTH_IMPLEMENTATION.md.
- Test both the hosted browser flow and Android APK flow.
- Verify all protected APIs reject unauthenticated requests.

STAGE 9 — Final code review
- Search the codebase for unsafe SQL interpolation, localStorage/sessionStorage auth tokens, hardcoded secrets, permissive CORS, wildcard origins, MemoryStore, insecure cookies, missing session checks, unvalidated inputs, dangerouslySetInnerHTML, and exposed error details.
- Run formatting, lint, typecheck, unit tests, integration tests, production build and Android build where supported.
- Fix all issues introduced by this task.

REQUIRED SECURITY TEST CASES
At minimum, test:
1. Correct phone + correct password succeeds.
2. Wrong password fails with generic error.
3. Unknown phone fails with exactly the same generic error.
4. Password values such as `1=1`, `' OR '1'='1`, `' OR 1=1 --`, `admin' --`, and `'; DROP TABLE products; --` are treated only as password strings and never bypass login or alter the database.
5. SQL injection payloads in all user-controlled login fields are rejected safely; no SQL is built by concatenating user input.
6. `<script>alert(1)</script>` is displayed as text or rejected and never executed.
7. Missing/invalid session cannot access protected APIs.
8. Valid session can access protected APIs.
9. Logout invalidates the session; replaying the old cookie fails.
10. Session ID changes after login.
11. Cookie has HttpOnly, Secure, SameSite=Lax and Path=/ in production; no Domain attribute is set.
12. Session expires after the configured 7-day idle period; store TTL and browser cookie expiry agree.
13. Sessions remain correctly persisted across backend restart, subject to expiry.
14. CSRF token/Origin checks reject forged unsafe requests.
15. CORS rejects an unapproved origin and never responds with wildcard origin plus credentials.
16. Five failures trigger the configured temporary protection; ten failures in the extended window trigger the longer protection; legitimate-owner recovery is possible and not trivially denied by arbitrary remote IPs.
17. Attempt tracking works across process restarts and instances.
18. Oversized/malformed JSON and unexpected input types are rejected.
19. Missing production secrets or insecure production cookie settings cause startup failure.
20. Frontend bundles and APK contain no database URL, session secret, password hash, or plaintext owner password.
21. Android login, session persistence, app restart, API access, logout and expiry work on the actual APK configuration.
22. Neon CLI init/deploy state matches the requested org/project/production branch and declares PostgreSQL + Realtime.
23. The application successfully queries and writes through DATABASE_URL_POOLED; migrations use direct DATABASE_URL.
24. A Neon Realtime subscriber receives a committed test change end to end; test data is cleaned up safely.
25. NEON_REALTIME_SECRET and database credentials are absent from frontend bundles, logs and APK assets.

SQL INJECTION RULE
Never write login SQL like:
  `SELECT ... WHERE phone = '${phone}' AND password = '${password}'`
Never compare a plaintext password in SQL. The phone is compared to the one configured owner identity, and the password is checked with Argon2id. All database operations use parameterized queries or safe ORM APIs.

DELIVERABLES
When finished, provide:
1. A concise repository audit summary and the exact files changed/created.
2. A description of the final login flow and session lifecycle.
3. The final environment variable list with which values are required, which are safe defaults, and which must be configured on Render.
4. Instructions to generate the Argon2id hash and add it to Render without exposing the plaintext password.
5. DNS/hosting/CORS/cookie configuration needed for khata.algions.in and api-khata.algions.in.
6. How to test login, logout, session expiry and rate limiting manually.
7. Automated test, lint, typecheck, production build and APK build results. Include actual command results; never fabricate passing tests.
8. Any unresolved limitations, especially Android cookie/session behaviour or tests that could not be run.
9. Neon CLI command results, generated config changes, direct/pooled DB verification and Realtime subscription test results, with all secrets redacted.
10. A final security checklist with PASS / FAIL / NOT TESTED for every acceptance item.
11. Android APK details: package ID, display name, version, debug/release APK paths, `apksigner` verification output, certificate fingerprint, device/emulator test status, and keystore backup instructions. Never disclose signing secrets.

STRICT WORKING RULES
- Implement the system in the existing repository; do not merely write advice or pseudocode.
- Do not overwrite unrelated functionality or redesign the whole application.
- Do not add public registration, extra roles, customer authentication, JWTs or refresh tokens.
- Do not hardcode production secrets, owner credentials, hostnames or security settings where they belong in environment configuration.
- Do not make the frontend authoritative for authentication.
- Do not use localStorage for session identifiers or long-lived credentials.
- Do not use Express MemoryStore in production.
- Do not disable CSRF, CORS, certificate validation, CSP or security checks to make tests pass.
- Do not claim security or test success without evidence.
- Preserve existing database data and migrations. Make schema changes reversible and safe.
- If a requirement cannot be met, explain why, implement the safest alternative, and list it as a limitation.

START NOW: inspect the repository, read LOGIN_AUTH_IMPLEMENTATION.md, map the current files, and implement the complete system through all stages.
