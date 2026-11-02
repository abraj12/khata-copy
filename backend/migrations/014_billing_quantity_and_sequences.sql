-- ==============================================================================
-- Khata Application Migration (014):
-- Enforce 2-decimal scale standard on billing item quantities and synchronize sequences
-- ==============================================================================

-- 1. Synchronize GST Invoice Number Sequence with existing max numerical invoice number
SELECT setval(
  'gst_invoice_number_seq',
  GREATEST(
    COALESCE((
      SELECT MAX(
        CASE
          WHEN invoice_number ~ '^\d+$' THEN invoice_number::BIGINT
          WHEN regexp_replace(invoice_number, '\D', '', 'g') <> '' THEN regexp_replace(invoice_number, '\\D', '', 'g')::BIGINT
          ELSE 0
        END
      ) FROM gst_invoices
    ), 0),
    1
  )
);

-- 2. Synchronize Normal Bill Number Sequence with existing max numerical bill number
SELECT setval(
  'normal_bill_number_seq',
  GREATEST(
    COALESCE((
      SELECT MAX(
        CASE
          WHEN bill_number ~ '^\d+$' THEN bill_number::BIGINT
          WHEN regexp_replace(bill_number, '\D', '', 'g') <> '' THEN regexp_replace(bill_number, '\\D', '', 'g')::BIGINT
          ELSE 0
        END
      ) FROM normal_bills
    ), 0),
    1
  )
);

-- 3. Adjust GST Invoice Items quantity column to NUMERIC(12, 2) with strict 2-decimal constraint
ALTER TABLE "gst_invoice_items"
  ALTER COLUMN "quantity" TYPE NUMERIC(12, 2);

ALTER TABLE "gst_invoice_items"
  DROP CONSTRAINT IF EXISTS "chk_gst_invoice_items_quantity_scale";

ALTER TABLE "gst_invoice_items"
  ADD CONSTRAINT "chk_gst_invoice_items_quantity_scale"
  CHECK ("quantity" > 0 AND scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");

-- 4. Adjust Normal Bill Items quantity column to NUMERIC(12, 2) with strict 2-decimal constraint
ALTER TABLE "normal_bill_items"
  ALTER COLUMN "quantity" TYPE NUMERIC(12, 2);

ALTER TABLE "normal_bill_items"
  DROP CONSTRAINT IF EXISTS "chk_normal_bill_items_quantity_scale";

ALTER TABLE "normal_bill_items"
  ADD CONSTRAINT "chk_normal_bill_items_quantity_scale"
  CHECK ("quantity" > 0 AND scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");
