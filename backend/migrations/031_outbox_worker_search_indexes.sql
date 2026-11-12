-- ==============================================================================
-- Migration 031: Outbox Worker Wakeup/Lease Indexes & Fallback Search Indexes
-- Author: ALGIONS AI LABS PRIVATE LIMITED
-- 1. Adds selective partial indexes on app_outbox_events so backlog wakeup probes
--    and lease recovery operate in O(log N) even with 100k+ processed rows.
-- 2. Adds active B-tree lookup/prefix indexes and guarded pg_trgm GIN indexes for
--    PostgreSQL fallback product (name, HSN, barcode) & customer (name, phone)
--    searches when MongoDB read models are unavailable or bypassed.
-- Compatible with PostgreSQL 16+ (Neon Serverless) and PostgreSQL 18.
-- ==============================================================================

-- 1. Outbox wakeup & lease recovery indexes
CREATE INDEX IF NOT EXISTS idx_app_outbox_pending_wake
  ON app_outbox_events (next_attempt_at ASC, id ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_app_outbox_failed_retryable
  ON app_outbox_events (next_attempt_at ASC, id ASC)
  WHERE status = 'failed' AND attempt_count < max_attempts;

CREATE INDEX IF NOT EXISTS idx_app_outbox_processing_wake
  ON app_outbox_events (lease_expires_at ASC NULLS FIRST, id ASC)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_app_outbox_processed_at
  ON app_outbox_events (processed_at ASC, id ASC)
  WHERE status = 'processed' AND processed_at IS NOT NULL;

-- 2. Standard B-tree indexes (available regardless of pg_trgm privileges)
CREATE INDEX IF NOT EXISTS idx_products_active_barcode_prefix
  ON products (LOWER(barcode) text_pattern_ops, id ASC)
  WHERE archived_at IS NULL AND barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_active_hsn_prefix
  ON products (LOWER(hsn_code) text_pattern_ops, id ASC)
  WHERE archived_at IS NULL AND hsn_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_active_normalized_name_id
  ON customers (normalized_name ASC, id ASC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_customers_active_phone_digits
  ON customers (normalized_phone ASC, id ASC)
  WHERE archived_at IS NULL AND normalized_phone IS NOT NULL;

-- 3. Optional pg_trgm GIN indexes for product HSN/barcode & customer phone searches
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_active_hsn_trgm ON products USING gin (hsn_code gin_trgm_ops) WHERE archived_at IS NULL AND hsn_code IS NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_active_barcode_trgm ON products USING gin (barcode gin_trgm_ops) WHERE archived_at IS NULL AND barcode IS NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_active_phone_trgm ON customers USING gin (phone gin_trgm_ops) WHERE archived_at IS NULL AND phone IS NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_active_normalized_phone_trgm ON customers USING gin (normalized_phone gin_trgm_ops) WHERE archived_at IS NULL AND normalized_phone IS NOT NULL';
  END IF;
END $$;
