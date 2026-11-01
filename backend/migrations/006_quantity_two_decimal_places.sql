-- ==============================================================================
-- Khata Application Migration (006): Quantity → NUMERIC(12,2) with up to 2 decimal places
-- Business rule change: Quantity is no longer integer-only.
-- Allows fractional quantities (e.g. 1.5 kg, 2.25 m) with up to 2 decimal places.
-- Removes the integer-only CHECK constraint added in migration 004.
-- Adds a new positive-value constraint for NUMERIC(12,2) precision.
-- ==============================================================================

-- 1. Widen quantity column from INTEGER to NUMERIC(12, 2)
--    Existing integer values are implicitly cast to NUMERIC without data loss.
ALTER TABLE "udhar_items"
  ALTER COLUMN "quantity" TYPE NUMERIC(12, 2) USING "quantity"::NUMERIC(12, 2);

-- 2. Drop integer-only range constraint added by migration 004
--    (allowed only [1, 1,000,000] integers — now widened to positive NUMERIC)
ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "udhar_items_quantity_check";

-- 3. Drop any legacy floor-check constraint (in case it exists under an alternate name)
ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "chk_udhar_items_qty_integer";

ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "chk_udhar_items_quantity_integer";

-- 4. Add new CHECK: quantity must be positive (> 0) and within NUMERIC(12,2) range
--    Upper bound 1,000,000 is enforced at API layer; DB constraint ensures positivity only.
ALTER TABLE "udhar_items"
  ADD CONSTRAINT "chk_udhar_items_quantity_positive" CHECK ("quantity" > 0);

-- 5. Add CHECK: quantity scale cannot exceed 2 decimal places at DB level
--    (ROUND to 2 places must equal itself)
ALTER TABLE "udhar_items"
  ADD CONSTRAINT "chk_udhar_items_quantity_scale" CHECK (ROUND("quantity", 2) = "quantity");
