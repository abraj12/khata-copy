## Summary

Describe the change, affected modules, and verification scope.

## Release & Migration Review Checklist

- [ ] If any file in `backend/migrations/` was added:
  - [ ] Historical migrations (`001`–previous) are completely unmodified.
  - [ ] Migration is idempotent and verified on **both** clean install and upgrade from the prior schema version using a disposable PostgreSQL instance (never production Neon).
  - [ ] Audit triggers and financial constraints are covered by automated tests.
- [ ] All CI checks pass (`Build & Test (ubuntu-latest)`, `Build & Test (windows-latest)`, `Vercel Frontend Build (Linux)`, `Render Backend Build (Linux)`, `PostgreSQL Integration Tests (Real DB)`, `Android TWA Debug Build & Security Check`).
- [ ] No secrets, keystores, `signing.properties`, `.env`, or production URLs are included.

## Production Rollout Notice

> **Production Deployment Gate:** Merging to `main` or rolling out database migrations, backend (Render), frontend (Vercel), or signed Android TWA builds requires **explicit repository owner (`@abraj12`) approval** after reviewing migration impact and verifying all required CI checks.
