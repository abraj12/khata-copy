-- ==============================================================================
-- Khata Database Schema Migration 003: Idempotency Keys and Hardening
-- ==============================================================================

CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "key" VARCHAR(255) PRIMARY KEY,
  "action" VARCHAR(50) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "response_status" INTEGER NOT NULL,
  "response_body" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_idempotency_keys_created_at" ON "idempotency_keys" ("created_at");
