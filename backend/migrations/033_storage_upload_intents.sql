-- ==============================================================================
-- Migration 033: Presigned Storage Upload Intents Tracking
-- Author: ALGIONS AI LABS PRIVATE LIMITED
-- Release: 032
-- Provides durable PostgreSQL tracking for presigned Cloudflare R2 upload intents,
-- preventing race conditions where cleanup workers delete freshly uploaded objects
-- before the client's completion API endpoint attaches them to business records.
-- Compatible with PostgreSQL 16+ (Neon Serverless) and PostgreSQL 18.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS storage_upload_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  object_key TEXT NOT NULL UNIQUE,

  object_kind VARCHAR(40) NOT NULL,

  reference_type VARCHAR(50) NOT NULL,

  reference_id TEXT NOT NULL,

  expected_content_type VARCHAR(150),

  expected_size_bytes BIGINT,

  status VARCHAR(20) NOT NULL DEFAULT 'issued',

  expires_at TIMESTAMPTZ NOT NULL,

  completed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_storage_upload_intent_status
    CHECK (
      status IN (
        'issued',
        'completed',
        'expired',
        'failed'
      )
    ),

  CONSTRAINT chk_storage_upload_intent_size
    CHECK (
      expected_size_bytes IS NULL
      OR expected_size_bytes > 0
    )
);

CREATE INDEX IF NOT EXISTS idx_storage_upload_intents_active_expiry
ON storage_upload_intents (expires_at, object_key)
WHERE status = 'issued';

CREATE INDEX IF NOT EXISTS idx_storage_upload_intents_reference
ON storage_upload_intents (
  reference_type,
  reference_id,
  status
);
