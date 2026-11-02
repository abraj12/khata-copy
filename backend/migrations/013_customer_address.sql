-- ==============================================================================
-- Khata Application Migration (013):
-- Add customer address support for billing autofill and customer directory
-- ==============================================================================

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "address" TEXT NULL;
