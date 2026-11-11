-- Migration 022: Supplier Operational Hardening, Cancellation Ledger & Append-Only Audit Triggers
-- Release #022:
--   1. Dedicated append-only supplier_purchase_bill_cancellations event ledger
--   2. Safe idempotent backfill of legacy cancelled purchase bills
--   3. Database-level append-only mutation protection (SQLSTATE 55000) across reversal and cancellation tables

-- 1. Purchase Bill Cancellations Event Ledger
CREATE TABLE IF NOT EXISTS "supplier_purchase_bill_cancellations" (
  "id" BIGSERIAL PRIMARY KEY,
  "purchase_bill_id" BIGINT NOT NULL UNIQUE,
  "supplier_id" UUID NOT NULL,
  "invoice_number" VARCHAR(100) NOT NULL,
  "invoice_date" DATE NOT NULL,
  "original_grand_total" NUMERIC(14, 2) NOT NULL CHECK ("original_grand_total" >= 0),
  "reason" TEXT NOT NULL CHECK (LENGTH(TRIM("reason")) > 0),
  "cancelled_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_supplier_bill_cancel_bill"
    FOREIGN KEY ("purchase_bill_id", "supplier_id")
    REFERENCES "supplier_purchase_bills"("id", "supplier_id")
    ON DELETE RESTRICT,
  CONSTRAINT "fk_supplier_bill_cancel_supplier"
    FOREIGN KEY ("supplier_id")
    REFERENCES "suppliers"("id")
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "idx_supplier_bill_cancellations_supplier_date"
  ON "supplier_purchase_bill_cancellations" ("supplier_id", "cancelled_at" DESC, "id" DESC);

-- 2. Idempotent historical backfill of already-cancelled purchase bills
INSERT INTO "supplier_purchase_bill_cancellations" (
  "purchase_bill_id",
  "supplier_id",
  "invoice_number",
  "invoice_date",
  "original_grand_total",
  "reason",
  "cancelled_at"
)
SELECT
  "id",
  "supplier_id",
  "invoice_number",
  "invoice_date",
  "grand_total",
  COALESCE(
    NULLIF(TRIM("cancellation_reason"), ''),
    'Legacy cancellation — reason not recorded'
  ),
  COALESCE("cancelled_at", "updated_at", "created_at")
FROM "supplier_purchase_bills"
WHERE "status" = 'cancelled'
ON CONFLICT ("purchase_bill_id") DO NOTHING;

-- 3. Reusable append-only trigger function (SQLSTATE 55000 = object_not_in_prerequisite_state)
CREATE OR REPLACE FUNCTION prevent_financial_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Financial audit records are append-only: % cannot be modified or deleted.',
    TG_TABLE_NAME
    USING ERRCODE = '55000';

  RETURN NULL;
END;
$$;

-- 4. Conditional trigger binding for repeatability on upgrades and clean installs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_prevent_supplier_payment_reversals_mutation'
      AND tgrelid = 'supplier_payment_reversals'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "trg_prevent_supplier_payment_reversals_mutation"
      BEFORE UPDATE OR DELETE ON "supplier_payment_reversals"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_financial_audit_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_prevent_supplier_allocation_reversals_mutation'
      AND tgrelid = 'supplier_payment_allocation_reversals'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "trg_prevent_supplier_allocation_reversals_mutation"
      BEFORE UPDATE OR DELETE ON "supplier_payment_allocation_reversals"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_financial_audit_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_prevent_supplier_bill_cancellations_mutation'
      AND tgrelid = 'supplier_purchase_bill_cancellations'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "trg_prevent_supplier_bill_cancellations_mutation"
      BEFORE UPDATE OR DELETE ON "supplier_purchase_bill_cancellations"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_financial_audit_mutation();
  END IF;
END $$;
