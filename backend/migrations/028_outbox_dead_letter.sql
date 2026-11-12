-- ==============================================================================
-- Migration 028: Outbox Dead-Letter State & Audit Index
-- Author: ALGIONS AI LABS PRIVATE LIMITED
-- Extends app_outbox_events so permanently failing outbox events transition cleanly
-- to dead_letter after max_attempts rather than looping or failing check constraints.
-- ==============================================================================

ALTER TABLE app_outbox_events
  ADD COLUMN IF NOT EXISTS dead_letter_at TIMESTAMPTZ NULL;

ALTER TABLE app_outbox_events
  DROP CONSTRAINT IF EXISTS app_outbox_events_status_check;

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'app_outbox_events'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE app_outbox_events DROP CONSTRAINT IF EXISTS %I', constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE app_outbox_events
  ADD CONSTRAINT app_outbox_events_status_check
  CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter'));

CREATE INDEX IF NOT EXISTS idx_app_outbox_dead_letter
  ON app_outbox_events (dead_letter_at DESC, id DESC)
  WHERE status = 'dead_letter';
