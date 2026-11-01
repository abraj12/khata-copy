-- ==============================================================================
-- Khata Application Migration (008):
-- Strict Fractional Scale Enforcement on udhar_items.quantity
-- ==============================================================================
-- Migration 007 converted quantity to unconstrained NUMERIC with TRUNC(quantity, 2) = quantity.
-- This forward-only migration tightens the constraint to enforce scale(quantity) <= 2,
-- ensuring that direct SQL inserts with trailing fractional precision like '1.2300' (scale = 4)
-- or excessive precision like '1.234' (scale = 3) are strictly rejected.

ALTER TABLE "udhar_items"
  DROP CONSTRAINT IF EXISTS "chk_udhar_items_quantity_scale";

ALTER TABLE "udhar_items"
  ADD CONSTRAINT "chk_udhar_items_quantity_scale"
  CHECK (scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");
