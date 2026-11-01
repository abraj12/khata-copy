# Khata — Database Schema & Migrations Guide

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Database Engine:** PostgreSQL 16 (Neon Serverless)  
**Schema Version:** 009  

---

## 1. Migration History

Migrations are executed sequentially via `backend/scripts/migrate.ts` using direct unpooled connections with PostgreSQL advisory locks (`pg_advisory_lock(987654321)`).

| Migration | File | Description |
|---|---|---|
| **001** | `001_auth_tables.sql` | `session`, `login_attempts`, `products`, `customers`, `ledger_entries`. |
| **002** | `002_khata_transactions.sql` | Normalized schema: `udhar_transactions`, `udhar_items`, `payments`, `payment_allocations`. |
| **003** | `003_idempotency_and_hardening.sql` | `idempotency_keys` table and performance indexes. |
| **004** | `004_integer_quantity_and_money_constraints.sql` | Initial integer quantity constraints and money scale checks. |
| **005** | `005_search_indexes_and_identity_constraints.sql` | Normalized phone & name indexes; `products.buying_price` widened to `NUMERIC(12,2)`. |
| **006** | `006_quantity_two_decimal_places.sql` | Quantity widened to allow fractional quantities up to 2 decimal places. |
| **007** | `007_quantity_strict_scale_and_allocation_integrity.sql` | Unconstrained NUMERIC with TRUNC scale check and **composite foreign keys** ensuring payment allocations cannot cross customer ownership. |
| **008** | `008_strict_quantity_scale.sql` | **Strict scale enforcement**: Enforces `scale(quantity) <= 2 AND TRUNC(quantity, 2) = quantity` to strictly reject direct SQL inputs with trailing zeros or excess precision (e.g. `1.2300` and `1.234`). |
| **009** | `009_product_images_and_offline_bills.sql` | Adds nullable Cloudflare R2 image metadata columns to `products` (`image_object_key`, `image_content_type`, `image_size_bytes`, `image_updated_at`) and creates `offline_bill_records` table with search indexes. |

---

## 2. Quantity Precision Enforcement (Migrations 007 & 008)

### Problem & Solution
PostgreSQL columns declared `NUMERIC(12,2)` automatically round values like `1.234` to `1.23` during type coercion before executing CHECK constraints.
Migration 007 converted `udhar_items.quantity` to unconstrained `NUMERIC`.
Migration 008 tightened the scale constraint to enforce both `scale(quantity) <= 2` and `TRUNC(quantity, 2) = quantity`:

```sql
ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "chk_udhar_items_quantity_scale";

ALTER TABLE "udhar_items"
  ADD CONSTRAINT "chk_udhar_items_quantity_scale"
  CHECK (scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");
```

### Verification Matrix:
- `1`: `scale = 0`, `TRUNC(1, 2) = 1` -> **Accepted**
- `1.2`: `scale = 1`, `TRUNC(1.2, 2) = 1.2` -> **Accepted**
- `1.25`: `scale = 2`, `TRUNC(1.25, 2) = 1.25` -> **Accepted**
- `0.01`: `scale = 2`, `TRUNC(0.01, 2) = 0.01` -> **Accepted**
- `1.2300`: `scale = 4 > 2` -> **Rejected**
- `1.234`: `scale = 3 > 2` -> **Rejected**
- `0`: Rejected by `quantity > 0`
- `-1`: Rejected by `quantity > 0`
- `1000001`: Rejected by `quantity <= 1000000`

---

## 3. Payment Allocation Cross-Customer Integrity (Migration 007)

To prevent any possibility of a payment belonging to Customer A being allocated to a transaction belonging to Customer B, composite unique constraints and foreign keys are enforced:
```sql
ALTER TABLE "payments" ADD CONSTRAINT "uq_payments_id_customer" UNIQUE ("id", "customer_id");
ALTER TABLE "udhar_transactions" ADD CONSTRAINT "uq_udhar_transactions_id_customer" UNIQUE ("id", "customer_id");

ALTER TABLE "payment_allocations" ADD COLUMN "customer_id" BIGINT NOT NULL;

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "fk_payment_allocations_payment_customer"
  FOREIGN KEY ("payment_id", "customer_id")
  REFERENCES "payments" ("id", "customer_id")
  ON DELETE CASCADE;

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "fk_payment_allocations_transaction_customer"
  FOREIGN KEY ("transaction_id", "customer_id")
  REFERENCES "udhar_transactions" ("id", "customer_id")
  ON DELETE RESTRICT;
```

---

## 4. Product Images & Offline Bill Documents (Migration 009)

### 4.1 Product Image Metadata
Existing products continue working seamlessly without images. Four nullable columns store the server-controlled Cloudflare R2 object reference:
```sql
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "image_object_key" TEXT,
  ADD COLUMN IF NOT EXISTS "image_content_type" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "image_size_bytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "image_updated_at" TIMESTAMPTZ;
```

### 4.2 Non-Financial Offline Bill Documents
`offline_bill_records` is strictly isolated from core Khata accounting tables. It contains zero foreign keys to `customers` or `udhar_transactions`:
```sql
CREATE TABLE IF NOT EXISTS "offline_bill_records" (
  "id" BIGSERIAL PRIMARY KEY,
  "customer_name" VARCHAR(255) NOT NULL,
  "customer_phone" VARCHAR(20) NOT NULL,
  "normalized_customer_phone" VARCHAR(10) NOT NULL,
  "image_object_key" TEXT NOT NULL,
  "image_content_type" VARCHAR(50) NOT NULL,
  "image_size_bytes" BIGINT NOT NULL,
  "original_filename" VARCHAR(255),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_offline_bill_records_phone"
  ON "offline_bill_records" ("normalized_customer_phone");

CREATE INDEX IF NOT EXISTS "idx_offline_bill_records_created"
  ON "offline_bill_records" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_offline_bill_records_name"
  ON "offline_bill_records" (LOWER("customer_name"));
```

---

## 5. Running Migrations in Production

To apply forward-only migrations safely to Neon PostgreSQL:
```bash
npm run migrate --workspace=backend
```
Migration script uses advisory locking (`pg_advisory_lock(987654321)`) and transaction rollback on failure. Zero data loss.
