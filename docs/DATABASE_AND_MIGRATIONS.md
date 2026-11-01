# Khata - Database Schema & Migrations Guide

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Database Engine:** PostgreSQL 16 (Neon Serverless)  
**Schema Version:** 006  

---

## 1. Connection Topology & Endpoints

Neon Serverless provides two distinct connection endpoints for optimal concurrency and migration execution:

```mermaid
graph LR
    subgraph ExpressApp["Backend Runtime"]
        API["Express API Server"]
        Migrator["Migration Script (scripts/migrate.ts)"]
    end

    subgraph NeonEndpoints["Neon PostgreSQL Endpoints"]
        PoolerHost["ep-aged-resonance-az771dby-pooler\n(PgBouncer Connection Pooler)"]
        DirectHost["ep-aged-resonance-az771dby\n(Direct PostgreSQL TCP Connection)"]
    end

    DB[(PostgreSQL Storage Engine)]

    API -->|DATABASE_URL (Port 5432)| PoolerHost
    Migrator -->|DIRECT_URL (Port 5432)| DirectHost
    PoolerHost --> DB
    DirectHost --> DB
```

> [!IMPORTANT]
> **Runtime Connection (`DATABASE_URL`):** Always points to the Neon connection pooler (`-pooler`) to support hundreds of serverless concurrent requests without exceeding connection limits.  
> **DDL Migration Connection (`DIRECT_URL`):** Always points to the direct unpooled Neon host. PgBouncer transaction-pooling mode does not support advisory locks and prepared statements required during schema migrations.

---

## 2. Migration Architecture

The migration runner is implemented in [backend/scripts/migrate.ts](file:///c:/Users/rajab/OneDrive/Desktop/khata/backend/scripts/migrate.ts).

### Migration History Table
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Applied Migrations
1. **`001_auth_tables.sql`**: Configures PostgreSQL sessions and brute-force login lockout tracking.
2. **`002_khata_transactions.sql`**: Configures product catalog, customer directory, Udhar credit transactions, payments, and FIFO payment allocations.
3. **`003_idempotency_and_hardening.sql`**: Adds idempotency store, performance indexes, and strict financial constraints.
4. **`004_integer_quantity_and_money_constraints.sql`**: Converts `udhar_items.quantity` to `INTEGER` [1, 1000000] and enforces strict 2-decimal scale checks across all money columns.
5. **`005_search_indexes_and_identity_constraints.sql`**: Adds composite search indexes for customers (`normalized_name, id`, `normalized_phone`), active products (`name, id`), and Udhar transactions (`customer_id, transaction_date DESC, id DESC`). Also widens `products.buying_price` to `NUMERIC(12, 2)` ensuring uniform financial precision across all tables.
6. **`006_quantity_two_decimal_places.sql`**: Widens `udhar_items.quantity` to `NUMERIC(12, 2)` allowing up to 2 decimal places (e.g. 1.5, 2.25, 0.01). Drops the integer-only constraint from migration 004 and adds positive value (`quantity > 0`) and 2-decimal scale checks (`ROUND(quantity, 2) = quantity`).

### Preflight Safety Audit & How to Run Migrations

```bash
# 1. Run read-only preflight check (verifies no fractional quantities exist):
npm run preflight:quantity --workspace=backend

# 2. Execute migrations with advisory lock:
npm run migrate --workspace=backend
```

### Migration Commands
```bash
# From repository root:
npm run migrate --workspace=backend

# Or directly inside backend workspace:
cd backend
npm run migrate
```

---

## 3. Core Tables Specification (9 Relational Tables)

### 3.1 `session`
Used by `connect-pg-simple` to maintain secure owner sessions.
- `sid` (VARCHAR, Primary Key)
- `sess` (JSONB, Not Null)
- `expire` (TIMESTAMPTZ, Not Null, Indexed)

### 3.2 `login_attempts`
Tracks IP and User-Agent authentication attempts for brute-force mitigation.
- `id` (SERIAL, Primary Key)
- `ip_hash` (VARCHAR(64), Not Null, Indexed)
- `attempt_count` (INT, Not Null DEFAULT 1)
- `locked_until` (TIMESTAMPTZ, Nullable)
- `last_attempt_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())
- `created_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())

### 3.3 `products`
Active and deactivated product catalog entries.
- `id` (UUID / VARCHAR, Primary Key)
- `name` (VARCHAR(150), Not Null)
- `unit` (VARCHAR(50), Not Null DEFAULT 'pcs')
- `default_price` (NUMERIC(12, 2), Not Null CHECK (default_price > 0))
- `is_active` (BOOLEAN, Not Null DEFAULT TRUE)
- `created_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())
- `updated_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())

### 3.4 `customers`
Customer details and contact records.
- `id` (UUID / VARCHAR, Primary Key)
- `name` (VARCHAR(150), Not Null)
- `phone` (VARCHAR(15), Not Null, Unique)
- `address` (TEXT, Nullable)
- `notes` (TEXT, Nullable)
- `created_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())
- `updated_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())

### 3.5 `udhar_transactions`
Credit transactions recorded against customers.
- `id` (UUID / VARCHAR, Primary Key)
- `customer_id` (VARCHAR, Foreign Key -> `customers.id` ON DELETE RESTRICT)
- `total_amount` (NUMERIC(12, 2), Not Null CHECK (total_amount > 0))
- `remaining_amount` (NUMERIC(12, 2), Not Null CHECK (remaining_amount >= 0 AND remaining_amount <= total_amount))
- `transaction_date` (DATE, Not Null)
- `status` (VARCHAR(20), Not Null CHECK (status IN ('UNPAID', 'PARTIAL', 'PAID')))
- `notes` (TEXT, Nullable)
- `created_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())
- `updated_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())
- *Index:* `idx_udhar_cust_unpaid ON udhar_transactions(customer_id, remaining_amount, transaction_date)`

### 3.6 `udhar_items`
Individual line items belonging to a credit transaction.
- `id` (UUID / VARCHAR, Primary Key)
- `udhar_transaction_id` (VARCHAR, Foreign Key -> `udhar_transactions.id` ON DELETE CASCADE)
- `product_id` (VARCHAR, Nullable, Foreign Key -> `products.id` ON DELETE SET NULL)
- `item_name` (VARCHAR(150), Not Null)
- `quantity` (NUMERIC(12, 2), Not Null CHECK (quantity > 0 AND ROUND(quantity, 2) = quantity)) — supports up to 2 decimal places (e.g. 1.5, 2.25, 0.01)
- `unit_price` (NUMERIC(12, 2), Not Null CHECK (unit_price > 0))
- `subtotal` (NUMERIC(12, 2), Not Null CHECK (subtotal > 0))
- `created_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())

### 3.7 `payments`
Cash and electronic payments received from customers.
- `id` (UUID / VARCHAR, Primary Key)
- `customer_id` (VARCHAR, Foreign Key -> `customers.id` ON DELETE RESTRICT)
- `amount` (NUMERIC(12, 2), Not Null CHECK (amount > 0))
- `payment_mode` (VARCHAR(30), Not Null CHECK (payment_mode IN ('CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE')))
- `payment_date` (TIMESTAMPTZ, Not Null DEFAULT NOW())
- `notes` (TEXT, Nullable)
- `reference_number` (VARCHAR(100), Nullable)
- `created_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())

### 3.8 `payment_allocations`
Audit record linking payments to specific `udhar_transactions` under FIFO allocation.
- `id` (UUID / VARCHAR, Primary Key)
- `payment_id` (VARCHAR, Foreign Key -> `payments.id` ON DELETE CASCADE)
- `udhar_transaction_id` (VARCHAR, Foreign Key -> `udhar_transactions.id` ON DELETE RESTRICT)
- `amount_allocated` (NUMERIC(12, 2), Not Null CHECK (amount_allocated > 0))
- `created_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())

### 3.9 `idempotency_keys`
Protects against network replay of mutating financial requests.
- `key` (VARCHAR(255), Primary Key)
- `request_hash` (VARCHAR(64), Not Null)
- `response_body` (JSONB, Not Null)
- `status_code` (INT, Not Null)
- `created_at` (TIMESTAMPTZ, Not Null DEFAULT NOW())
- `expires_at` (TIMESTAMPTZ, Not Null)

---

## 4. Backup, Point-in-Time Recovery & Protection

1. **Neon Instant Branching:** Neon provides zero-overhead copy-on-write database branches. Prior to any major schema change, create a snapshot branch in the Neon Console.
2. **PostgreSQL Standard Dump (`pg_dump`):**
   ```bash
   pg_dump "postgres://neondb_owner:***@ep-aged-resonance-az771dby.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require" \
     --format=custom \
     --file=khata_backup_$(date +%Y%m%d).dump
   ```
3. **Destructive Guard:** `backend/src/config/testDbGuard.ts` strictly prohibits running automated tests against Neon hostnames (`*.neon.tech`). Tests will abort immediately if attempted on non-local test databases.
