-- ==============================================================================
-- Khata Application Migration (021):
-- Supplier Financial Integrity, Payment & Allocation Reversals,
-- Duplicate Digital Reference Protection & Historical Bill Supplier Snapshots
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Supplier Payments Reversal Status & Metadata Constraints
-- ------------------------------------------------------------------------------
ALTER TABLE "supplier_payments"
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "reversed_at" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "reversal_reason" TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    INNER JOIN pg_class t ON t.oid = c.conrelid
    INNER JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'supplier_payments'
      AND c.conname = 'chk_supplier_payments_status'
  ) THEN
    ALTER TABLE "supplier_payments"
      ADD CONSTRAINT "chk_supplier_payments_status"
      CHECK ("status" IN ('active', 'reversed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    INNER JOIN pg_class t ON t.oid = c.conrelid
    INNER JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'supplier_payments'
      AND c.conname = 'chk_supplier_payments_reversal_metadata'
  ) THEN
    ALTER TABLE "supplier_payments"
      ADD CONSTRAINT "chk_supplier_payments_reversal_metadata"
      CHECK (
        ("status" = 'active' AND "reversed_at" IS NULL)
        OR (
          "status" = 'reversed'
          AND "reversed_at" IS NOT NULL
          AND "reversal_reason" IS NOT NULL
          AND LENGTH(TRIM("reversal_reason")) > 0
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_supplier_payments_supplier_status_date"
  ON "supplier_payments" ("supplier_id", "status", "payment_date" DESC, "id" DESC);

-- ------------------------------------------------------------------------------
-- 2. Immutable Supplier Payment Reversal Audit Table
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "supplier_payment_reversals" (
  "id" BIGSERIAL PRIMARY KEY,
  "reversal_number" VARCHAR(60) NOT NULL UNIQUE,
  "payment_id" BIGINT NOT NULL UNIQUE,
  "supplier_id" UUID NOT NULL REFERENCES "suppliers"("id") ON DELETE RESTRICT,
  "original_amount" NUMERIC(14, 2) NOT NULL CHECK ("original_amount" > 0),
  "reason" TEXT NOT NULL CHECK (LENGTH(TRIM("reason")) > 0),
  "payment_snapshot" JSONB NOT NULL,
  "reversed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_supplier_pay_rev_payment_supplier"
    FOREIGN KEY ("payment_id", "supplier_id")
    REFERENCES "supplier_payments"("id", "supplier_id")
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "idx_supplier_payment_reversals_supplier_date"
  ON "supplier_payment_reversals" ("supplier_id", "reversed_at" DESC, "id" DESC);

-- ------------------------------------------------------------------------------
-- 3. Immutable Supplier Payment Allocation Reversal Audit Table
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    INNER JOIN pg_class t ON t.oid = c.conrelid
    INNER JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'supplier_payment_allocations'
      AND c.conname = 'uq_supplier_payment_allocations_composite'
  ) THEN
    ALTER TABLE "supplier_payment_allocations"
      ADD CONSTRAINT "uq_supplier_payment_allocations_composite"
      UNIQUE ("id", "payment_id", "purchase_bill_id", "supplier_id");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "supplier_payment_allocation_reversals" (
  "id" BIGSERIAL PRIMARY KEY,
  "allocation_id" BIGINT NOT NULL,
  "payment_id" BIGINT NOT NULL,
  "purchase_bill_id" BIGINT NOT NULL,
  "supplier_id" UUID NOT NULL REFERENCES "suppliers"("id") ON DELETE RESTRICT,
  "reversed_amount" NUMERIC(14, 2) NOT NULL CHECK ("reversed_amount" > 0),
  "reason" TEXT NOT NULL CHECK (LENGTH(TRIM("reason")) > 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_supplier_alloc_rev_allocation"
    FOREIGN KEY ("allocation_id", "payment_id", "purchase_bill_id", "supplier_id")
    REFERENCES "supplier_payment_allocations"("id", "payment_id", "purchase_bill_id", "supplier_id")
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "idx_supplier_alloc_rev_allocation_id"
  ON "supplier_payment_allocation_reversals" ("allocation_id");

CREATE INDEX IF NOT EXISTS "idx_supplier_alloc_rev_payment_id"
  ON "supplier_payment_allocation_reversals" ("payment_id");

CREATE INDEX IF NOT EXISTS "idx_supplier_alloc_rev_bill_id"
  ON "supplier_payment_allocation_reversals" ("purchase_bill_id");

CREATE INDEX IF NOT EXISTS "idx_supplier_alloc_rev_supplier_id"
  ON "supplier_payment_allocation_reversals" ("supplier_id");

-- ------------------------------------------------------------------------------
-- 4. Historical Supplier Snapshot on Purchase Bills (Nullable for Legacy Rows)
-- ------------------------------------------------------------------------------
ALTER TABLE "supplier_purchase_bills"
  ADD COLUMN IF NOT EXISTS "supplier_snapshot" JSONB NULL;

-- ------------------------------------------------------------------------------
-- 5. Active Digital Payment Reference Uniqueness (With Safe Pre-Check Diagnostic)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  v_duplicates TEXT;
BEGIN
  SELECT string_agg(
    format(
      'supplier_id=%s, payment_method=%s, normalized_reference=%s, count=%s, payment_ids=[%s]',
      dup."supplier_id",
      dup."payment_method",
      dup."norm_ref",
      dup."cnt",
      dup."payment_ids"
    ),
    '; '
  )
  INTO v_duplicates
  FROM (
    SELECT
      "supplier_id",
      "payment_method",
      LOWER(BTRIM("transaction_reference")) AS "norm_ref",
      COUNT(*) AS "cnt",
      string_agg("id"::TEXT, ',' ORDER BY "id") AS "payment_ids"
    FROM "supplier_payments"
    WHERE "transaction_reference" IS NOT NULL
      AND BTRIM("transaction_reference") <> ''
      AND "payment_method" IN ('upi', 'bank_transfer', 'cheque')
      AND "status" = 'active'
    GROUP BY "supplier_id", "payment_method", LOWER(BTRIM("transaction_reference"))
    HAVING COUNT(*) > 1
  ) dup;

  IF v_duplicates IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create uq_supplier_payments_active_reference: conflicting active duplicate digital payment references found: %',
      v_duplicates;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_supplier_payments_active_reference"
  ON "supplier_payments" ("supplier_id", "payment_method", LOWER(BTRIM("transaction_reference")))
  WHERE "transaction_reference" IS NOT NULL
    AND BTRIM("transaction_reference") <> ''
    AND "payment_method" IN ('upi', 'bank_transfer', 'cheque')
    AND "status" = 'active';
