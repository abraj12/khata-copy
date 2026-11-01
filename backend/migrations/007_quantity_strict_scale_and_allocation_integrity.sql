-- ==============================================================================
-- Khata Application Migration (007):
-- 1. Quantity Precision: Unconstrained NUMERIC with TRUNC(quantity, 2) scale check
--    Fixes PostgreSQL silent rounding on NUMERIC(12,2) and guarantees direct SQL rejection
-- 2. Payment Allocation Cross-Customer Integrity:
--    Composite foreign keys guaranteeing allocated transactions & payments belong to same customer
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Quantity Precision Enforcement
-- ------------------------------------------------------------------------------

-- Convert quantity column from fixed-scale NUMERIC(12,2) to unconstrained NUMERIC
-- This prevents PostgreSQL from silently rounding inputs like 1.234 to 1.23
ALTER TABLE "udhar_items"
  ALTER COLUMN "quantity" TYPE NUMERIC;

-- Drop previous constraints
ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "chk_udhar_items_quantity_scale";

ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "chk_udhar_items_quantity_positive";

-- Enforce positive quantity and upper bound (up to 1,000,000)
ALTER TABLE "udhar_items"
  ADD CONSTRAINT "chk_udhar_items_quantity_positive"
  CHECK ("quantity" > 0 AND "quantity" <= 1000000);

-- Enforce strict scale: TRUNC to 2 decimal places must strictly equal the unconstrained value.
-- Direct SQL input with >2 decimal places (e.g. 1.234) will be rejected instead of silently rounded.
ALTER TABLE "udhar_items"
  ADD CONSTRAINT "chk_udhar_items_quantity_scale"
  CHECK (TRUNC("quantity", 2) = "quantity");

-- ------------------------------------------------------------------------------
-- 2. Payment Allocation Cross-Customer Integrity
-- ------------------------------------------------------------------------------

-- Ensure payments has a composite unique constraint on (id, customer_id)
ALTER TABLE "payments"
  ADD CONSTRAINT "uq_payments_id_customer"
  UNIQUE ("id", "customer_id");

-- Ensure udhar_transactions has a composite unique constraint on (id, customer_id)
ALTER TABLE "udhar_transactions"
  ADD CONSTRAINT "uq_udhar_transactions_id_customer"
  UNIQUE ("id", "customer_id");

-- Add customer_id column to payment_allocations if it does not already exist
ALTER TABLE "payment_allocations"
  ADD COLUMN IF NOT EXISTS "customer_id" BIGINT;

-- Backfill customer_id in payment_allocations from the referenced payments table
UPDATE "payment_allocations" pa
SET "customer_id" = p."customer_id"
FROM "payments" p
WHERE pa."payment_id" = p."id"
  AND pa."customer_id" IS NULL;

-- Enforce NOT NULL on customer_id
ALTER TABLE "payment_allocations"
  ALTER COLUMN "customer_id" SET NOT NULL;

-- Drop legacy simple foreign keys if replacing with composite foreign keys
ALTER TABLE "payment_allocations"
  DROP CONSTRAINT IF EXISTS "fk_payment_allocations_payment_customer";

ALTER TABLE "payment_allocations"
  DROP CONSTRAINT IF EXISTS "fk_payment_allocations_transaction_customer";

-- Enforce composite foreign key linking payment_allocations (payment_id, customer_id) -> payments (id, customer_id)
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "fk_payment_allocations_payment_customer"
  FOREIGN KEY ("payment_id", "customer_id")
  REFERENCES "payments" ("id", "customer_id")
  ON DELETE CASCADE;

-- Enforce composite foreign key linking payment_allocations (transaction_id, customer_id) -> udhar_transactions (id, customer_id)
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "fk_payment_allocations_transaction_customer"
  FOREIGN KEY ("transaction_id", "customer_id")
  REFERENCES "udhar_transactions" ("id", "customer_id")
  ON DELETE RESTRICT;

-- Index for customer_id on payment_allocations for optimized customer ledger queries
CREATE INDEX IF NOT EXISTS "idx_payment_allocations_customer_id"
  ON "payment_allocations" ("customer_id");
