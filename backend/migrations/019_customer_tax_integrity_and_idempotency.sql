-- ==============================================================================
-- Khata Database Schema Migration (019):
-- Customer Tax State Storage, Document Default Removal, Idempotency Expiry,
-- Quotation Sequence Sync, and 2-Decimal Quantity Integrity Enforcement
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. R019-01: Customer State & State Code Storage (Preserve NULL for legacy rows)
-- ------------------------------------------------------------------------------
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "state" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "state_code" VARCHAR(2);

ALTER TABLE "customers"
  DROP CONSTRAINT IF EXISTS "chk_customers_state_code_format";

ALTER TABLE "customers"
  ADD CONSTRAINT "chk_customers_state_code_format"
  CHECK (
    "state_code" IS NULL
    OR "state_code" ~ '^[0-9]{2}$'
  );

-- ------------------------------------------------------------------------------
-- 2. R019-01: Remove Artificial Buyer/Supplier State Defaults on Document Tables
-- ------------------------------------------------------------------------------
-- Normal bills: allow NULL buyer state when unknown; remove artificial defaults
ALTER TABLE "normal_bills"
  ALTER COLUMN "state" DROP DEFAULT,
  ALTER COLUMN "state_code" DROP DEFAULT,
  ALTER COLUMN "customer_state" DROP DEFAULT,
  ALTER COLUMN "customer_state_code" DROP DEFAULT,
  ALTER COLUMN "customer_state" DROP NOT NULL,
  ALTER COLUMN "customer_state_code" DROP NOT NULL;

-- GST invoices: remove defaults so new rows require explicit validated states
ALTER TABLE "gst_invoices"
  ALTER COLUMN "state" DROP DEFAULT,
  ALTER COLUMN "state_code" DROP DEFAULT,
  ALTER COLUMN "customer_state" DROP DEFAULT,
  ALTER COLUMN "customer_state_code" DROP DEFAULT;

-- Quotations: ensure buyer state remains nullable with no default
ALTER TABLE "quotations"
  ALTER COLUMN "customer_state" DROP DEFAULT,
  ALTER COLUMN "customer_state_code" DROP DEFAULT,
  ALTER COLUMN "customer_state" DROP NOT NULL,
  ALTER COLUMN "customer_state_code" DROP NOT NULL;

-- ------------------------------------------------------------------------------
-- 3. R019-05: Real Idempotency Key 24-Hour Expiration Support
-- ------------------------------------------------------------------------------
ALTER TABLE "idempotency_keys"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ;

UPDATE "idempotency_keys"
SET "expires_at" = "created_at" + INTERVAL '24 hours'
WHERE "expires_at" IS NULL;

ALTER TABLE "idempotency_keys"
  ALTER COLUMN "expires_at"
  SET DEFAULT (NOW() + INTERVAL '24 hours');

ALTER TABLE "idempotency_keys"
  ALTER COLUMN "expires_at" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_idempotency_keys_expires_at"
  ON "idempotency_keys" ("expires_at");

-- ------------------------------------------------------------------------------
-- 4. R019-06: Synchronize Quotation Number Sequence Safely (Strict QT-<N> Format)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  v_max_qt BIGINT;
  v_last BIGINT;
  v_called BOOLEAN;
  v_high_water BIGINT;
BEGIN
  SELECT COALESCE(
    MAX(
      CASE
        WHEN "quotation_number" ~ '^QT-([0-9]+)$'
          THEN substring("quotation_number" FROM '^QT-([0-9]+)$')::BIGINT
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_qt
  FROM "quotations";

  SELECT "last_value", "is_called"
  INTO v_last, v_called
  FROM "quotation_number_seq";

  v_high_water := GREATEST(
    v_max_qt,
    CASE
      WHEN v_called THEN v_last
      ELSE v_last - 1
    END
  );

  IF v_high_water <= 0 THEN
    PERFORM setval('quotation_number_seq', 1, false);
  ELSE
    PERFORM setval('quotation_number_seq', v_high_water, true);
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 5. R019-09: Enforce Maximum 2 Decimal Places for Quantity Across All Line Items
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  v_invalid_qt INT;
  v_invalid_gst INT;
  v_invalid_normal INT;
  v_invalid_udhar INT;
BEGIN
  -- Abort loudly if any historical item has >2 decimal places (never silently round)
  SELECT COUNT(*) INTO v_invalid_qt
  FROM "quotation_items"
  WHERE "quantity" <> TRUNC("quantity", 2);

  IF v_invalid_qt > 0 THEN
    RAISE EXCEPTION 'Cannot apply migration 019: quotation_items contains % record(s) with > 2 decimal places.', v_invalid_qt;
  END IF;

  SELECT COUNT(*) INTO v_invalid_gst
  FROM "gst_invoice_items"
  WHERE "quantity" <> TRUNC("quantity", 2);

  IF v_invalid_gst > 0 THEN
    RAISE EXCEPTION 'Cannot apply migration 019: gst_invoice_items contains % record(s) with > 2 decimal places.', v_invalid_gst;
  END IF;

  SELECT COUNT(*) INTO v_invalid_normal
  FROM "normal_bill_items"
  WHERE "quantity" <> TRUNC("quantity", 2);

  IF v_invalid_normal > 0 THEN
    RAISE EXCEPTION 'Cannot apply migration 019: normal_bill_items contains % record(s) with > 2 decimal places.', v_invalid_normal;
  END IF;

  SELECT COUNT(*) INTO v_invalid_udhar
  FROM "udhar_items"
  WHERE "quantity" <> TRUNC("quantity", 2);

  IF v_invalid_udhar > 0 THEN
    RAISE EXCEPTION 'Cannot apply migration 019: udhar_items contains % record(s) with > 2 decimal places.', v_invalid_udhar;
  END IF;
END $$;

-- Convert quotation_items.quantity from NUMERIC(14,2) to unconstrained NUMERIC so Postgres never silently rounds 1.234
ALTER TABLE "quotation_items"
  DROP CONSTRAINT IF EXISTS "check_quotation_items_quantity_positive",
  DROP CONSTRAINT IF EXISTS "check_quotation_items_quantity_scale",
  DROP CONSTRAINT IF EXISTS "chk_quotation_items_quantity_scale";

ALTER TABLE "quotation_items"
  ALTER COLUMN "quantity" TYPE NUMERIC;

ALTER TABLE "quotation_items"
  ADD CONSTRAINT "chk_quotation_items_quantity_scale"
  CHECK ("quantity" > 0 AND "quantity" <= 1000000 AND scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");

-- Ensure gst_invoice_items and normal_bill_items retain unconstrained NUMERIC and identical strict constraints
ALTER TABLE "gst_invoice_items"
  ALTER COLUMN "quantity" TYPE NUMERIC;

ALTER TABLE "gst_invoice_items"
  DROP CONSTRAINT IF EXISTS "chk_gst_invoice_items_quantity_scale";

ALTER TABLE "gst_invoice_items"
  ADD CONSTRAINT "chk_gst_invoice_items_quantity_scale"
  CHECK ("quantity" > 0 AND "quantity" <= 1000000 AND scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");

ALTER TABLE "normal_bill_items"
  ALTER COLUMN "quantity" TYPE NUMERIC;

ALTER TABLE "normal_bill_items"
  DROP CONSTRAINT IF EXISTS "chk_normal_bill_items_quantity_scale";

ALTER TABLE "normal_bill_items"
  ADD CONSTRAINT "chk_normal_bill_items_quantity_scale"
  CHECK ("quantity" > 0 AND "quantity" <= 1000000 AND scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity");
