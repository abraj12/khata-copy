-- ==============================================================================
-- Migration 032: Cloudflare R2 Storage Cleanup Worker Claim Fencing
-- Author: ALGIONS AI LABS PRIVATE LIMITED
-- Release: 032
-- Adds claim_token UUID and claim_version BIGINT to storage_cleanup_jobs to
-- guarantee distributed worker fencing, preventing stale/expired workers from
-- renewing or completing claims acquired by newer worker instances.
-- Compatible with PostgreSQL 16+ (Neon Serverless) and PostgreSQL 18.
-- ==============================================================================

ALTER TABLE storage_cleanup_jobs
ADD COLUMN IF NOT EXISTS claim_token UUID;

ALTER TABLE storage_cleanup_jobs
ADD COLUMN IF NOT EXISTS claim_version BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_storage_cleanup_processing_claim
ON storage_cleanup_jobs (
  id,
  claim_token
)
WHERE status = 'processing';
