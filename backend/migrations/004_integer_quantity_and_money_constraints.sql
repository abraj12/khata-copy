-- ==============================================================================
-- Khata Application Migration (004): Integer Quantity & Money Constraints
-- - Hardware retail sells in whole units: changes udhar_items.quantity to INTEGER [1, 1000000]
-- - Enforces strict 2-decimal scale constraints on all financial columns
-- ==============================================================================

-- 1. Alter quantity column in udhar_items to INTEGER with whole number bounds
ALTER TABLE "udhar_items"
  ALTER COLUMN "quantity" TYPE INTEGER USING "quantity"::INTEGER;

ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "udhar_items_quantity_check",
  ADD CONSTRAINT "udhar_items_quantity_check" CHECK ("quantity" >= 1 AND "quantity" <= 1000000);

-- 2. Enforce strict 2-decimal money checks on udhar_items
ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "chk_udhar_items_selling_price_scale",
  ADD CONSTRAINT "chk_udhar_items_selling_price_scale" CHECK (ROUND("selling_price", 2) = "selling_price");

ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "chk_udhar_items_buying_price_scale",
  ADD CONSTRAINT "chk_udhar_items_buying_price_scale" CHECK (ROUND("buying_price_snapshot", 2) = "buying_price_snapshot");

ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "chk_udhar_items_line_total_scale",
  ADD CONSTRAINT "chk_udhar_items_line_total_scale" CHECK (ROUND("line_total", 2) = "line_total");

-- 3. Enforce strict 2-decimal money checks on udhar_transactions
ALTER TABLE "udhar_transactions"
  DROP CONSTRAINT IF EXISTS "chk_udhar_tx_total_amount_scale",
  ADD CONSTRAINT "chk_udhar_tx_total_amount_scale" CHECK (ROUND("total_amount", 2) = "total_amount");

-- 4. Enforce strict 2-decimal money checks on payments and allocations
ALTER TABLE "payments"
  DROP CONSTRAINT IF EXISTS "chk_payments_amount_scale",
  ADD CONSTRAINT "chk_payments_amount_scale" CHECK (ROUND("amount", 2) = "amount");

ALTER TABLE "payment_allocations"
  DROP CONSTRAINT IF EXISTS "chk_payment_allocations_amount_scale",
  ADD CONSTRAINT "chk_payment_allocations_amount_scale" CHECK (ROUND("amount", 2) = "amount");

-- 5. Enforce strict 2-decimal money checks on products catalogue
ALTER TABLE "products"
  DROP CONSTRAINT IF EXISTS "chk_products_buying_price_scale",
  ADD CONSTRAINT "chk_products_buying_price_scale" CHECK (ROUND("buying_price", 2) = "buying_price");
