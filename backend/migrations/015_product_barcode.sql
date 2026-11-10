-- ==============================================================================
-- Khata Application Migration (015):
-- Add optional barcode column to products table with active product uniqueness
-- ==============================================================================

-- 1. Add barcode column (VARCHAR(64), nullable)
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "barcode" VARCHAR(64) NULL;

-- 2. Partial unique index to enforce that no two ACTIVE products share the same barcode.
-- Archived products (archived_at IS NOT NULL) do not prevent barcode reuse.
-- Null barcodes are ignored by uniqueness checks.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_products_barcode_active"
  ON "products" ("barcode")
  WHERE "barcode" IS NOT NULL AND "archived_at" IS NULL;

-- 3. Lookup index for efficient search & scanning queries on products by barcode
CREATE INDEX IF NOT EXISTS "idx_products_barcode"
  ON "products" ("barcode")
  WHERE "barcode" IS NOT NULL;
