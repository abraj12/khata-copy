# Khata Remediation Baseline Report

**Execution Timestamp:** 2026-11-01T01:50:00+05:30  
**Branch:** `fix/khata-linux-deployment-and-final-qa`  
**Baseline Commit:** `6a17275` (`feat: complete final correctness, decimal arithmetic, and security remediation`)  
**Remote:** `https://github.com/abraj12/khata.git`  
**Host Environment:** Windows (Node v22.18.0, npm 11.5.2)

---

## 1. Initial State & Detected Platform Risks

| Risk / Component | Current Baseline State | Remediation Target |
|---|---|---|
| **Platform Pins in Root** | `@esbuild/win32-x64` pinned in root `devDependencies` | Remove from root `devDependencies`; let npm resolve optional platform binaries. |
| **Unused Root Dependencies** | `pg-mem` pinned in root `devDependencies`, not imported anywhere | Remove from root `devDependencies`. |
| **Root npm Scripts** | Scripts call `npm --prefix backend` and `npm --prefix frontend` independently | Migrate to standard npm workspaces: `--workspace=backend`, `--workspace=frontend`. |
| **Engines Declaration** | Missing `"engines": { "node": "22.x" }` in root and packages | Add `"engines": { "node": "22.x" }` and root `.node-version` (22.18.0). |
| **Vercel Configuration** | `buildCommand: "cd frontend && npm install && npm run build"` bypasses root lockfile; CSP contains `localhost` | Update `vercel.json` with `npm ci --workspace=frontend --include-workspace-root=false`, clean production CSP. |
| **Render Blueprint** | `render.yaml` uses `npm --prefix backend install` | Update `render.yaml` with workspace commands, remove unused Realtime secrets. |
| **CORS Preflight** | `backend/src/app.ts` excludes `Idempotency-Key` from CORS `allowedHeaders` | Add `Idempotency-Key` to `allowedHeaders` in `cors({...})` and add preflight tests. |
| **Readiness Probe** | `/api/v1/health/ready` only runs `SELECT 1` | Enhance check to verify database connectivity, `schema_migrations`, applied migration versions, and all 9 core tables. |
| **Lockout Pepper Fallback** | `LoginAttemptStore` falls back to `'khata_lockout_pepper_salt_value_123'` | Strictly enforce configured `env.SESSION_SECRET`. |
| **Expired Attempt Pruning** | `pruneOldAttempts()` exists but is never invoked | Implement throttled maintenance mechanism protected by DB advisory locks. |
| **Gradlew Permission** | `frontend/android/gradlew` git mode is `100644` (non-executable on Linux) | Update Git index mode to `100755` (`git update-index --chmod=+x`). |
| **Integration Testing** | Only in-memory simulated database tests (33 unit tests) | Add real PostgreSQL integration test suite using `pg` against PostgreSQL container. |
| **CI Workflows** | No multi-platform CI workflow with PostgreSQL service | Create `.github/workflows/ci.yml` matrix with `ubuntu-latest`, `windows-latest`, and PostgreSQL service. |

---

## 2. Command Baseline Execution

- `node --version`: `v22.18.0`
- `npm --version`: `11.5.2`
- `git branch --show-current`: `fix/khata-linux-deployment-and-final-qa`
- `backend/tests` (Vitest unit): 33 passed (33 tests total)
- `npm run build`: Success (`tsc` backend + Vite frontend)
