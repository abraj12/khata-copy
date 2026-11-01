-- ==============================================================================
-- Khata Application Migration (010):
-- Add optional HSN Code column to products table for retail & billing reference
-- ==============================================================================

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "hsn_code" VARCHAR(20) NULL;

-- Index for optional HSN lookup on active products
CREATE INDEX IF NOT EXISTS "idx_products_hsn_code"
  ON "products" ("hsn_code")
  WHERE "archived_at" IS NULL AND "hsn_code" IS NOT NULL;
