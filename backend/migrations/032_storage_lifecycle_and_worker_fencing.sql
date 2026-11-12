-- Release 032: Durable Storage Upload Lifecycle and Worker Claim Fencing
-- Authoritative financial and object-lifecycle coordination for Khata ERP.

-- 1. Create storage_upload_intents table
CREATE TABLE IF NOT EXISTS storage_upload_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    object_key TEXT NOT NULL UNIQUE,

    object_kind TEXT NOT NULL,
    folder TEXT NOT NULL,

    reference_type TEXT NOT NULL,
    reference_id TEXT NOT NULL,

    expected_content_type TEXT NOT NULL,
    expected_size_bytes BIGINT NULL,

    status TEXT NOT NULL DEFAULT 'issued'
      CHECK (
        status IN (
          'issued',
          'uploaded',
          'attached',
          'cleanup_pending',
          'cleaned',
          'failed'
        )
      ),

    upload_mode TEXT NOT NULL DEFAULT 'presigned'
      CHECK (
        upload_mode IN ('presigned', 'server')
      ),

    expires_at TIMESTAMPTZ NOT NULL,

    attached_at TIMESTAMPTZ NULL,
    cleaned_at TIMESTAMPTZ NULL,

    last_error TEXT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE storage_upload_intents
  ADD COLUMN IF NOT EXISTS folder TEXT NOT NULL DEFAULT 'products',
  ADD COLUMN IF NOT EXISTS upload_mode TEXT NOT NULL DEFAULT 'presigned',
  ADD COLUMN IF NOT EXISTS attached_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS cleaned_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_error TEXT NULL;

ALTER TABLE storage_upload_intents
  DROP CONSTRAINT IF EXISTS chk_storage_upload_intent_status;

ALTER TABLE storage_upload_intents
  ADD CONSTRAINT chk_storage_upload_intent_status
  CHECK (
    status IN (
      'issued',
      'uploaded',
      'attached',
      'cleanup_pending',
      'cleaned',
      'failed'
    )
  );

CREATE INDEX IF NOT EXISTS idx_storage_upload_intents_expiry
ON storage_upload_intents (expires_at ASC, id ASC)
WHERE status IN ('issued', 'uploaded');

CREATE INDEX IF NOT EXISTS idx_storage_upload_intents_object_status
ON storage_upload_intents (object_key, status);

-- 2. Add claim-token fencing columns to storage_cleanup_jobs
ALTER TABLE storage_cleanup_jobs
  ADD COLUMN IF NOT EXISTS claim_token UUID NULL,
  ADD COLUMN IF NOT EXISTS claim_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claim_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_processing_claim
  ON storage_cleanup_jobs (next_attempt_at ASC, id ASC)
  WHERE status IN ('pending', 'processing', 'failed');

-- 3. Add claim-token fencing columns to app_outbox_events
ALTER TABLE app_outbox_events
  ADD COLUMN IF NOT EXISTS claim_token UUID NULL,
  ADD COLUMN IF NOT EXISTS claim_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claim_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_app_outbox_processing_claim
  ON app_outbox_events (next_attempt_at ASC, id ASC)
  WHERE status IN ('pending', 'failed');
