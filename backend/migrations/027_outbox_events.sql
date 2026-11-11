-- ==============================================================================
-- Migration 027: Transactional Outbox Events for MongoDB Read-Model Synchronization
-- Author: ALGIONS AI LABS PRIVATE LIMITED
-- Preserves existing financial/core schema; enables reliable Neon -> MongoDB sync
-- without periodic polling against idle PostgreSQL databases.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS app_outbox_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_version BIGINT NOT NULL DEFAULT 1,
  business_date TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts >= 1),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  processed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_outbox_pending_ready
  ON app_outbox_events (next_attempt_at ASC, id ASC)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_app_outbox_processing_lease
  ON app_outbox_events (lease_expires_at ASC)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_app_outbox_aggregate_lookup
  ON app_outbox_events (aggregate_type, aggregate_id, created_at DESC);
