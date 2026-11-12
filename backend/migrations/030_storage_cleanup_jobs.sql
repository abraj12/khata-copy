-- ==============================================================================
-- Migration 030: Durable Cloudflare R2 Object Cleanup Job Queue
-- Author: ALGIONS AI LABS PRIVATE LIMITED
-- Provides a persistent, lease-safe cleanup retry queue for orphaned R2 objects
-- without polluting financial outbox events (app_outbox_events) and without
-- blocking future legitimate cleanups after a key completes or dead-letters.
-- Compatible with PostgreSQL 16+ (Neon Serverless) and PostgreSQL 18.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS storage_cleanup_jobs (
  id BIGSERIAL PRIMARY KEY,

  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  reason TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'processing',
        'failed',
        'completed',
        'dead_letter'
      )
    ),

  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),

  max_attempts INTEGER NOT NULL DEFAULT 10
    CHECK (max_attempts >= 1),

  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ NULL,

  last_error TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  dead_letter_at TIMESTAMPTZ NULL
);

-- Enforce one active cleanup job per object_key while allowing future cleanup
-- requests if the same key ever becomes orphaned again after completion/dead-letter.
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_cleanup_active_object
  ON storage_cleanup_jobs (object_key)
  WHERE status IN ('pending', 'processing', 'failed');

-- Index-friendly O(log N) lookup for ready pending jobs and next wakeup inspection
CREATE INDEX IF NOT EXISTS idx_storage_cleanup_pending_ready
  ON storage_cleanup_jobs (next_attempt_at ASC, id ASC)
  WHERE status = 'pending';

-- Index-friendly O(log N) lookup for retryable failed jobs below max_attempts
CREATE INDEX IF NOT EXISTS idx_storage_cleanup_failed_retryable
  ON storage_cleanup_jobs (next_attempt_at ASC, id ASC)
  WHERE status = 'failed' AND attempt_count < max_attempts;

-- Index-friendly lease recovery & processing wakeup probe (NULLS FIRST handles crashed null-lease rows)
CREATE INDEX IF NOT EXISTS idx_storage_cleanup_processing_wake
  ON storage_cleanup_jobs (lease_expires_at ASC NULLS FIRST, id ASC)
  WHERE status = 'processing';

-- Retention / operational auditing index for completed cleanup jobs
CREATE INDEX IF NOT EXISTS idx_storage_cleanup_completed_at
  ON storage_cleanup_jobs (completed_at ASC, id ASC)
  WHERE status = 'completed' AND completed_at IS NOT NULL;
