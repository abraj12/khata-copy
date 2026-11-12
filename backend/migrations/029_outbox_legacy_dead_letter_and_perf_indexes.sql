-- ==============================================================================
-- Migration 029: Legacy Outbox Dead-Letter Migration & Query Performance Indexes
-- Author: ALGIONS AI LABS PRIVATE LIMITED
-- 1. Migrates legacy Release-027 exhausted ('failed' with attempt_count >= max_attempts)
--    outbox rows into explicit 'dead_letter' state so status counts and dead-letter
--    inspection/retry agree cleanly without full-table predicates.
-- 2. Adds selective partial index on unresolved outbox events for O(log N) backlog age
--    and next-wake inspection, plus trigram indexes on products & customers to accelerate
--    PostgreSQL fallback ILIKE searches when MongoDB read models are disabled or unavailable.
-- Compatible with PostgreSQL 16+ (Neon Serverless) and PostgreSQL 18.
-- ==============================================================================

-- 1. Backfill any legacy exhausted rows from Release 027 into dead_letter
UPDATE app_outbox_events
SET status = 'dead_letter',
    dead_letter_at = COALESCE(dead_letter_at, updated_at, NOW()),
    updated_at = NOW()
WHERE status = 'failed'
  AND attempt_count >= max_attempts;

-- 2. Fast unresolved outbox index for inspectRetryableBacklogDelay & status age queries
CREATE INDEX IF NOT EXISTS idx_app_outbox_unresolved_created
  ON app_outbox_events (created_at ASC, id ASC)
  WHERE status IN ('pending', 'processing', 'failed');

-- 3. Enable pg_trgm (if permitted by role/extensions) for PostgreSQL fallback ILIKE queries
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_active_name_trgm ON products USING gin (name gin_trgm_ops) WHERE archived_at IS NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_customers_active_name_trgm ON customers USING gin (normalized_name gin_trgm_ops) WHERE archived_at IS NULL';
  END IF;
END $$;
