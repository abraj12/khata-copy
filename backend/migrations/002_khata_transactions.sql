-- ==============================================================================
-- Khata Application Normalized Financial Schema Migration (002)
-- Implements auditable Udhar transactions, item snapshots, payments & FIFO allocations
-- ==============================================================================

-- 1. Ensure archived_at column on products
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS "idx_products_active_name" ON "products" ("name") WHERE "archived_at" IS NULL;

-- 2. Update customers table with normalized fields and partial unique index
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "normalized_name" VARCHAR(255);
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "normalized_phone" VARCHAR(20);
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ NULL;

UPDATE "customers" SET "normalized_name" = LOWER(TRIM("name")) WHERE "normalized_name" IS NULL;
ALTER TABLE "customers" ALTER COLUMN "normalized_name" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_customers_normalized_name" ON "customers" ("normalized_name");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_customers_normalized_phone" ON "customers" ("normalized_phone") WHERE "normalized_phone" IS NOT NULL;

-- 3. Udhar Transactions
CREATE TABLE IF NOT EXISTS "udhar_transactions" (
  "id" BIGSERIAL PRIMARY KEY,
  "customer_id" BIGINT NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "transaction_date" DATE NOT NULL DEFAULT CURRENT_DATE,
  "total_amount" NUMERIC(12, 2) NOT NULL CHECK ("total_amount" > 0),
  "note" TEXT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_udhar_transactions_customer_date" ON "udhar_transactions" ("customer_id", "transaction_date", "created_at");

-- 4. Udhar Line Items (Preserving product snapshots)
CREATE TABLE IF NOT EXISTS "udhar_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "transaction_id" BIGINT NOT NULL REFERENCES "udhar_transactions"("id") ON DELETE CASCADE,
  "product_id" BIGINT NULL REFERENCES "products"("id") ON DELETE SET NULL,
  "product_name_snapshot" VARCHAR(255) NOT NULL,
  "buying_price_snapshot" NUMERIC(12, 2) NOT NULL CHECK ("buying_price_snapshot" >= 0),
  "quantity" NUMERIC(12, 3) NOT NULL CHECK ("quantity" > 0),
  "selling_price" NUMERIC(12, 2) NOT NULL CHECK ("selling_price" >= 0),
  "line_total" NUMERIC(12, 2) NOT NULL CHECK ("line_total" >= 0)
);
CREATE INDEX IF NOT EXISTS "idx_udhar_items_transaction_id" ON "udhar_items" ("transaction_id");

-- 5. Customer Payments
CREATE TABLE IF NOT EXISTS "payments" (
  "id" BIGSERIAL PRIMARY KEY,
  "customer_id" BIGINT NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "amount" NUMERIC(12, 2) NOT NULL CHECK ("amount" > 0),
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "note" TEXT NULL
);
CREATE INDEX IF NOT EXISTS "idx_payments_customer_received" ON "payments" ("customer_id", "received_at");

-- 6. Payment Allocations (Linking payments to specific Udhar transactions via FIFO)
CREATE TABLE IF NOT EXISTS "payment_allocations" (
  "id" BIGSERIAL PRIMARY KEY,
  "payment_id" BIGINT NOT NULL REFERENCES "payments"("id") ON DELETE CASCADE,
  "transaction_id" BIGINT NOT NULL REFERENCES "udhar_transactions"("id") ON DELETE RESTRICT,
  "amount" NUMERIC(12, 2) NOT NULL CHECK ("amount" > 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_payment_allocations_payment_id" ON "payment_allocations" ("payment_id");
CREATE INDEX IF NOT EXISTS "idx_payment_allocations_transaction_id" ON "payment_allocations" ("transaction_id");
