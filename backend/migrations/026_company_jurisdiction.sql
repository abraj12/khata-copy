-- Migration 026: Configurable company jurisdiction text for invoices & quotations
ALTER TABLE quotation_settings
  ADD COLUMN IF NOT EXISTS jurisdiction VARCHAR(200);
