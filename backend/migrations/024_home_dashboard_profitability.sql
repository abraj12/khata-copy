-- ==============================================================================
-- Khata Application Migration (024):
-- Release #024: Home Dashboard Profitability Snapshots & Business Expense Ledger
--   1. Nullable historical buying-price snapshots on normal_bill_items & gst_invoice_items
--   2. Operating expenses ledger (business_expenses) with soft-void metadata constraints
--   3. Append-only expense audit ledger (business_expense_events) with UPDATE/DELETE/TRUNCATE guards
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Cost Snapshot Columns on Billing Line Items (Never backfills historical rows)
-- ------------------------------------------------------------------------------
ALTER TABLE "normal_bill_items"
  ADD COLUMN IF NOT EXISTS "cost_rate_snapshot" NUMERIC(12, 2) NULL;

ALTER TABLE "gst_invoice_items"
  ADD COLUMN IF NOT EXISTS "cost_rate_snapshot" NUMERIC(12, 2) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    INNER JOIN pg_class t ON t.oid = c.conrelid
    INNER JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'normal_bill_items'
      AND c.conname = 'chk_normal_bill_items_cost_rate_snapshot'
  ) THEN
    ALTER TABLE "normal_bill_items"
      ADD CONSTRAINT "chk_normal_bill_items_cost_rate_snapshot"
      CHECK ("cost_rate_snapshot" IS NULL OR "cost_rate_snapshot" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    INNER JOIN pg_class t ON t.oid = c.conrelid
    INNER JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'gst_invoice_items'
      AND c.conname = 'chk_gst_invoice_items_cost_rate_snapshot'
  ) THEN
    ALTER TABLE "gst_invoice_items"
      ADD CONSTRAINT "chk_gst_invoice_items_cost_rate_snapshot"
      CHECK ("cost_rate_snapshot" IS NULL OR "cost_rate_snapshot" >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_normal_bill_items_product_id"
  ON "normal_bill_items" ("product_id")
  WHERE "product_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_gst_invoice_items_product_id"
  ON "gst_invoice_items" ("product_id")
  WHERE "product_id" IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 2. Business Operating Expenses Ledger (Separate from Supplier Purchase Payments)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "business_expenses" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "expense_date" DATE NOT NULL,
  "category" VARCHAR(60) NOT NULL CHECK (
    "category" IN ('rent', 'electricity', 'salaries', 'transport', 'packaging', 'maintenance', 'marketing', 'misc')
  ),
  "title" VARCHAR(200) NOT NULL CHECK (LENGTH(TRIM("title")) > 0),
  "vendor_name" VARCHAR(160) NULL,
  "amount" NUMERIC(14, 2) NOT NULL CHECK ("amount" > 0),
  "payment_method" VARCHAR(30) NOT NULL CHECK (
    "payment_method" IN ('cash', 'upi', 'bank_transfer', 'cheque', 'other')
  ),
  "reference_number" VARCHAR(120) NULL,
  "notes" TEXT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'voided')),
  "voided_at" TIMESTAMPTZ NULL,
  "void_reason" TEXT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "chk_business_expenses_void_metadata" CHECK (
    (
      "status" = 'active'
      AND "voided_at" IS NULL
      AND ("void_reason" IS NULL OR LENGTH(TRIM("void_reason")) = 0)
    )
    OR (
      "status" = 'voided'
      AND "voided_at" IS NOT NULL
      AND "void_reason" IS NOT NULL
      AND LENGTH(TRIM("void_reason")) > 0
    )
  )
);

CREATE INDEX IF NOT EXISTS "idx_business_expenses_status_date"
  ON "business_expenses" ("status", "expense_date" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_business_expenses_category_date"
  ON "business_expenses" ("category", "expense_date" DESC);

-- ------------------------------------------------------------------------------
-- 3. Immutable Append-Only Expense Audit Ledger
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "business_expense_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "expense_id" UUID NOT NULL REFERENCES "business_expenses"("id") ON DELETE RESTRICT,
  "action" VARCHAR(30) NOT NULL CHECK ("action" IN ('created', 'updated', 'voided')),
  "reason" TEXT NULL,
  "previous_data" JSONB NULL,
  "new_data" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_business_expense_events_expense"
  ON "business_expense_events" ("expense_id", "id" DESC);

-- Ensure prevent_financial_audit_mutation() exists even if inspected standalone, preserving SQLSTATE 55000 semantics
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_prevent_business_expense_events_mutation'
      AND tgrelid = 'business_expense_events'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "trg_prevent_business_expense_events_mutation"
      BEFORE UPDATE OR DELETE ON "business_expense_events"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_financial_audit_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_prevent_business_expense_events_truncate'
      AND tgrelid = 'business_expense_events'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "trg_prevent_business_expense_events_truncate"
      BEFORE TRUNCATE ON "business_expense_events"
      FOR EACH STATEMENT
      EXECUTE FUNCTION prevent_financial_audit_mutation();
  END IF;
END $$;
