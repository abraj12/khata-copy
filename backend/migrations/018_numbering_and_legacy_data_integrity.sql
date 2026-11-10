-- ==============================================================================
-- Khata Database Schema Migration 018: Numbering and Legacy Data Integrity
-- ==============================================================================

-- 1. Synchronize Document Number Sequences safely without moving backwards
DO $$
DECLARE
  v_max BIGINT;
  v_last BIGINT;
  v_called BOOLEAN;
  v_high_water BIGINT;
BEGIN
  -- NORMAL BILL SEQUENCE
  SELECT COALESCE(
    MAX(
      CASE
        WHEN bill_number ~ '^[0-9]+$' THEN bill_number::BIGINT
        WHEN regexp_replace(bill_number, '[^0-9]', '', 'g') <> '' THEN regexp_replace(bill_number, '[^0-9]', '', 'g')::BIGINT
        ELSE 0
      END
    ),
    0
  )
  INTO v_max
  FROM normal_bills;

  SELECT last_value, is_called
  INTO v_last, v_called
  FROM normal_bill_number_seq;

  v_high_water := GREATEST(
    v_max,
    CASE
      WHEN v_called THEN v_last
      ELSE v_last - 1
    END
  );

  IF v_high_water <= 0 THEN
    PERFORM setval('normal_bill_number_seq', 1, false);
  ELSE
    PERFORM setval('normal_bill_number_seq', v_high_water, true);
  END IF;

  -- GST INVOICE SEQUENCE
  SELECT COALESCE(
    MAX(
      CASE
        WHEN invoice_number ~ '^[0-9]+$' THEN invoice_number::BIGINT
        WHEN regexp_replace(invoice_number, '[^0-9]', '', 'g') <> '' THEN regexp_replace(invoice_number, '[^0-9]', '', 'g')::BIGINT
        ELSE 0
      END
    ),
    0
  )
  INTO v_max
  FROM gst_invoices;

  SELECT last_value, is_called
  INTO v_last, v_called
  FROM gst_invoice_number_seq;

  v_high_water := GREATEST(
    v_max,
    CASE
      WHEN v_called THEN v_last
      ELSE v_last - 1
    END
  );

  IF v_high_water <= 0 THEN
    PERFORM setval('gst_invoice_number_seq', 1, false);
  ELSE
    PERFORM setval('gst_invoice_number_seq', v_high_water, true);
  END IF;
END $$;

-- 2. Quotation Buyer State Legacy Integrity: Remove artificial defaults and make nullable
ALTER TABLE quotations
  ALTER COLUMN customer_state DROP NOT NULL,
  ALTER COLUMN customer_state_code DROP NOT NULL,
  ALTER COLUMN customer_state DROP DEFAULT,
  ALTER COLUMN customer_state_code DROP DEFAULT;

-- Nullify pre-migration-017 quotation buyer state so unknown buyer location is explicit
DO $$
DECLARE
  v_legacy_cutoff TIMESTAMPTZ;
BEGIN
  SELECT applied_at
  INTO v_legacy_cutoff
  FROM schema_migrations
  WHERE version = '017_quotation_conversion_financial_fields.sql';

  IF v_legacy_cutoff IS NOT NULL THEN
    UPDATE quotations
    SET
      customer_state = NULL,
      customer_state_code = NULL
    WHERE created_at < v_legacy_cutoff;
  END IF;
END $$;
