-- ==============================================================================
-- Khata Application Migration (005): Search Indexes & Query Performance Hardening
-- Adds composite and performance indexes for fast paginated customer/product search
-- ==============================================================================

-- 1. Ensure customer search and deterministic pagination indexes
CREATE INDEX IF NOT EXISTS "idx_customers_search_composite"
  ON "customers" ("normalized_name", "id" ASC);

CREATE INDEX IF NOT EXISTS "idx_customers_phone_active"
  ON "customers" ("normalized_phone")
  WHERE "normalized_phone" IS NOT NULL;

-- 2. Ensure product search index on active products with deterministic tie-breaking
CREATE INDEX IF NOT EXISTS "idx_products_search_active"
  ON "products" ("name" ASC, "id" ASC)
  WHERE "archived_at" IS NULL;

-- 3. Udhar transactions customer activity index for fast ledger ordering
CREATE INDEX IF NOT EXISTS "idx_udhar_tx_activity_composite"
  ON "udhar_transactions" ("customer_id", "transaction_date" DESC, "id" DESC);

-- 4. Payment allocations customer integrity check support index
CREATE INDEX IF NOT EXISTS "idx_payment_alloc_lookup"
  ON "payment_allocations" ("transaction_id", "payment_id");
