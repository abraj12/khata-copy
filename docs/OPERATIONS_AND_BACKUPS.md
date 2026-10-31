# Khata - Operations, Monitoring & Disaster Recovery Guide

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Target Audience:** System Administrators, DevOps, Shopkeeper  

---

## 1. Health Monitoring & Probes

Khata exposes two standard HTTP health probes:

| Probe | Endpoint | Recommended Interval | Purpose |
|---|---|---|---|
| **Liveness** | `GET /api/v1/health/live` | Every 30 seconds | Validates that Node.js event loop is responsive. |
| **Readiness** | `GET /api/v1/health/ready` | Every 2–5 minutes | Validates PostgreSQL connection pool, schema migrations, and table presence. |

### Automated Uptime Monitoring
Configure an external uptime monitor (e.g., BetterStack, UptimeRobot, or Render Cron) pointing to:
```text
https://khata-api-wkn9.onrender.com/api/v1/health/live
```
This keeps the Render service warm and prevents cold-start delays.

---

## 2. Neon Database Backups & Point-in-Time Restore (PITR)

Neon Serverless provides enterprise-grade storage architecture with built-in Point-in-Time Recovery.

### 2.1 Automated Cloud Snapshots & Branches
1. Neon automatically retains a continuous WAL (Write-Ahead Log) history.
2. In the event of catastrophic data corruption or accidental table modification:
   - Navigate to the Neon Console -> **Branches**.
   - Create a new branch pointing to an exact timestamp *prior* to the incident.
   - Point Render's `DATABASE_URL` and `DIRECT_URL` environment variables to the restored branch.

### 2.2 Manual Offline Logical Backup (`pg_dump`)
Run weekly or before major migrations:

```bash
# Take binary compressed dump
pg_dump "$DIRECT_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="khata_backup_$(date +%Y%m%d_%H%M%S).dump"
```

### 2.3 Restoring from Logical Dump (`pg_restore`)
```bash
# Restore into an empty or target database
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="$DIRECT_URL" \
  "khata_backup_YYYYMMDD_HHMMSS.dump"
```

---

## 3. Emergency Operations & Credential Recovery

### 3.1 Owner Password Reset
If the shopkeeper forgets their password or credentials are compromised:

1. Generate a fresh Argon2id hash locally:
   ```bash
   node -e "
   const argon2 = require('argon2');
   argon2.hash('NewStrongPassword123!', {
     type: argon2.argon2id,
     memoryCost: 65536,
     timeCost: 3,
     parallelism: 4
   }).then(console.log);
   "
   ```
2. Log into the Render Dashboard -> `khata-api-wkn9` -> **Environment**.
3. Update `OWNER_PASSWORD_HASH` with the newly generated hash string.
4. Save changes; Render will redeploy the service with the updated password within 60 seconds.

### 3.2 Emergency Session Invalidation
To force logout all active sessions across all devices:

```sql
-- Connect via psql using DIRECT_URL:
TRUNCATE TABLE session;
```
All users will be required to re-authenticate with their credentials.

### 3.3 Emergency Lockout Reset
To clear active brute-force lockouts without waiting for the expiration timer:

```sql
-- Connect via psql:
DELETE FROM login_attempts WHERE locked_until IS NOT NULL;
```
