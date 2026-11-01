-- ==============================================================================
-- Khata Application Migration (009):
-- 1. Optional Product Image Metadata (Cloudflare R2 Object Key & Properties)
-- 2. Offline Bill Document Records (Isolated document storage, zero financial impact)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Product Images Metadata
-- ------------------------------------------------------------------------------
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "image_object_key" TEXT,
  ADD COLUMN IF NOT EXISTS "image_content_type" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "image_size_bytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "image_updated_at" TIMESTAMPTZ;

-- ------------------------------------------------------------------------------
-- 2. Offline Bill Document Storage Table
-- ------------------------------------------------------------------------------
-- CRITICAL BUSINESS RULE: Offline Bill is purely a document-storage feature.
-- It is NOT a financial transaction, does NOT affect balances or ledger,
-- and does NOT automatically create records in the customers table.
CREATE TABLE IF NOT EXISTS "offline_bill_records" (
  "id" BIGSERIAL PRIMARY KEY,
  "customer_name" VARCHAR(255) NOT NULL,
  "customer_phone" VARCHAR(20) NOT NULL,
  "normalized_customer_phone" VARCHAR(20) NOT NULL,
  "image_object_key" TEXT NOT NULL,
  "image_content_type" VARCHAR(50) NOT NULL,
  "image_size_bytes" BIGINT NOT NULL,
  "original_filename" VARCHAR(255),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Search and sort indexes
CREATE INDEX IF NOT EXISTS "idx_offline_bills_normalized_phone"
  ON "offline_bill_records" ("normalized_customer_phone");

CREATE INDEX IF NOT EXISTS "idx_offline_bills_created_at"
  ON "offline_bill_records" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_offline_bills_customer_name"
  ON "offline_bill_records" (LOWER("customer_name"));
