-- ==============================================================================
-- Khata Application Migration (014):
-- Enforce 2-decimal scale standard on billing item quantities and synchronize sequences
-- ==============================================================================

DO $$
DECLARE
  v_max_gst BIGINT;
  v_max_normal BIGINT;
  v_invalid_gst_count INT;
  v_invalid_normal_count INT;
BEGIN
  -- 1. Historical Quantity Precision Safety Guard
  -- Verify no existing records have fractional precision beyond 2 decimal places.
  -- Abort before altering column types to prevent silent mathematical rounding/corruption.
  SELECT COUNT(*) INTO v_invalid_gst_count
  FROM gst_invoice_items
  WHERE "quantity" <> TRUNC("quantity", 2) OR scale("quantity") > 2;

  IF v_invalid_gst_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply migration 014: gst_invoice_items contains % historical record(s) with > 2 decimal places. Manual reconciliation is required to prevent rounding discrepancies.', v_invalid_gst_count;
  END IF;

  SELECT COUNT(*) INTO v_invalid_normal_count
  FROM normal_bill_items
  WHERE "quantity" <> TRUNC("quantity", 2) OR scale("quantity") > 2;

  IF v_invalid_normal_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply migration 014: normal_bill_items contains % historical record(s) with > 2 decimal places. Manual reconciliation is required to prevent rounding discrepancies.', v_invalid_normal_count;
  END IF;

  -- 2. Synchronize GST Invoice Number Sequence atomically
  -- When table has existing records, setval(seq, max, true) -> next is max + 1.
  -- When table is empty, setval(seq, 1, false) -> next is 1 ('001').
  SELECT COALESCE(MAX(
    CASE
      WHEN invoice_number ~ '^[0-9]+$' THEN invoice_number::BIGINT
      WHEN regexp_replace(invoice_number, '[^0-9]', '', 'g') <> '' THEN regexp_replace(invoice_number, '[^0-9]', '', 'g')::BIGINT
      ELSE 0
    END
  ), 0) INTO v_max_gst FROM gst_invoices;

  IF v_max_gst > 0 THEN
    PERFORM setval('gst_invoice_number_seq', v_max_gst, true);
  ELSE
    PERFORM setval('gst_invoice_number_seq', 1, false);
  END IF;

  -- 3. Synchronize Normal Bill Number Sequence atomically
  -- When table has existing records, setval(seq, max, true) -> next is max + 1.
  -- When table is empty, setval(seq, 1, false) -> next is 1 ('001').
  SELECT COALESCE(MAX(
    CASE
      WHEN bill_number ~ '^[0-9]+$' THEN bill_number::BIGINT
      WHEN regexp_replace(bill_number, '[^0-9]', '', 'g') <> '' THEN regexp_replace(bill_number, '[^0-9]', '', 'g')::BIGINT
      ELSE 0
    END
  ), 0) INTO v_max_normal FROM normal_bills;

  IF v_max_normal > 0 THEN
    PERFORM setval('normal_bill_number_seq', v_max_normal, true);
  ELSE
    PERFORM setval('normal_bill_number_seq', 1, false);
  END IF;
END $$;

-- 4. Adjust GST Invoice Items quantity column to unconstrained NUMERIC with strict 2-decimal constraint
-- Using unconstrained NUMERIC prevents PostgreSQL from silently rounding inputs like 1.234 to 1.23
ALTER TABLE "gst_invoice_items"
  ALTER COLUMN "quantity" TYPE NUMERIC;

ALTER TABLE "gst_invoice_items"
  DROP CONSTRAINT IF EXISTS "chk_gst_invoice_items_quantity_scale";

ALTER TABLE "gst_invoice_items"
  ADD CONSTRAINT "chk_gst_invoice_items_quantity_scale"
  CHECK ("quantity" > 0 AND "quantity" <= 1000000 AND scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");

-- 5. Adjust Normal Bill Items quantity column to unconstrained NUMERIC with strict 2-decimal constraint
-- Using unconstrained NUMERIC prevents PostgreSQL from silently rounding inputs like 1.234 to 1.23
ALTER TABLE "normal_bill_items"
  ALTER COLUMN "quantity" TYPE NUMERIC;

ALTER TABLE "normal_bill_items"
  DROP CONSTRAINT IF EXISTS "chk_normal_bill_items_quantity_scale";

ALTER TABLE "normal_bill_items"
  ADD CONSTRAINT "chk_normal_bill_items_quantity_scale"
  CHECK ("quantity" > 0 AND "quantity" <= 1000000 AND scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");
