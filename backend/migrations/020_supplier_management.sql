-- ==============================================================================
-- Khata Application Migration (020):
-- Module 1: Normalized Supplier Management, Purchase Bills, Payments, Allocations & Audit History
-- Module 2: Product Barcode Non-Empty Integrity Constraint
-- ==============================================================================

-- 1. Ensure product barcodes never store blank/whitespace strings
UPDATE "products"
SET "barcode" = NULL
WHERE "barcode" IS NOT NULL AND LENGTH(TRIM("barcode")) = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    INNER JOIN pg_class t ON t.oid = c.conrelid
    INNER JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'products'
      AND c.conname = 'chk_products_barcode_non_empty'
  ) THEN
    ALTER TABLE "products"
      ADD CONSTRAINT "chk_products_barcode_non_empty"
      CHECK ("barcode" IS NULL OR LENGTH(TRIM("barcode")) > 0);
  END IF;
END $$;

-- 2. Suppliers Master Table (UUID PK, single-vendor supplier accounting)
CREATE TABLE IF NOT EXISTS "suppliers" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" VARCHAR(255) NOT NULL,
  "normalized_name" VARCHAR(255) NOT NULL,
  "contact_person" VARCHAR(255) NULL,
  "phone" VARCHAR(20) NULL,
  "normalized_phone" VARCHAR(20) NULL,
  "email" VARCHAR(255) NULL,
  "address" TEXT NULL,
  "state" VARCHAR(100) NULL,
  "state_code" VARCHAR(10) NULL,
  "gstin" VARCHAR(20) NULL,
  "notes" TEXT NULL,
  "archived_at" TIMESTAMPTZ NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "chk_suppliers_name_non_empty" CHECK (LENGTH(TRIM("name")) > 0),
  CONSTRAINT "chk_suppliers_state_code_format" CHECK (
    "state_code" IS NULL OR ("state_code" ~ '^[0-9]{2}$' AND "state" IS NOT NULL)
  ),
  CONSTRAINT "chk_suppliers_gstin_format" CHECK (
    "gstin" IS NULL OR LENGTH(TRIM("gstin")) = 15
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_suppliers_active_normalized_name"
  ON "suppliers" ("normalized_name")
  WHERE "archived_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_suppliers_active_phone"
  ON "suppliers" ("normalized_phone")
  WHERE "normalized_phone" IS NOT NULL AND "archived_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_suppliers_active_gstin"
  ON "suppliers" (UPPER("gstin"))
  WHERE "gstin" IS NOT NULL AND "archived_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_suppliers_archived_name"
  ON "suppliers" ("archived_at", "normalized_name");

-- 3. Supplier Purchase Bills (Purchase Invoices Received)
CREATE TABLE IF NOT EXISTS "supplier_purchase_bills" (
  "id" BIGSERIAL PRIMARY KEY,
  "supplier_id" UUID NOT NULL REFERENCES "suppliers"("id") ON DELETE RESTRICT,
  "invoice_number" VARCHAR(100) NOT NULL,
  "normalized_invoice_number" VARCHAR(100) NOT NULL,
  "invoice_date" DATE NOT NULL,
  "due_date" DATE NULL,
  "subtotal_amount" NUMERIC(14, 2) NOT NULL CHECK ("subtotal_amount" >= 0),
  "discount_amount" NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK ("discount_amount" >= 0),
  "taxable_amount" NUMERIC(14, 2) NOT NULL CHECK ("taxable_amount" >= 0),
  "gst_rate" NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK ("gst_rate" >= 0 AND "gst_rate" <= 100),
  "gst_amount" NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK ("gst_amount" >= 0),
  "grand_total" NUMERIC(14, 2) NOT NULL CHECK ("grand_total" >= 0),
  "status" VARCHAR(20) NOT NULL DEFAULT 'finalized' CHECK ("status" IN ('finalized', 'cancelled')),
  "notes" TEXT NULL,
  "attachment_object_key" TEXT NULL,
  "attachment_content_type" VARCHAR(100) NULL,
  "attachment_size_bytes" BIGINT NULL,
  "attachment_filename" VARCHAR(255) NULL,
  "version" INT NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "cancelled_at" TIMESTAMPTZ NULL,
  "cancellation_reason" TEXT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "chk_supplier_purchase_bill_invoice_non_empty" CHECK (LENGTH(TRIM("invoice_number")) > 0),
  CONSTRAINT "uq_supplier_purchase_bills_id_supplier" UNIQUE ("id", "supplier_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_supplier_purchase_bills_invoice"
  ON "supplier_purchase_bills" ("supplier_id", "normalized_invoice_number")
  WHERE "status" <> 'cancelled';

CREATE INDEX IF NOT EXISTS "idx_supplier_purchase_bills_supplier_date"
  ON "supplier_purchase_bills" ("supplier_id", "invoice_date" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_supplier_purchase_bills_status"
  ON "supplier_purchase_bills" ("status", "invoice_date" DESC);

-- 4. Supplier Purchase Bill Line Items (No stock/inventory tracking)
CREATE TABLE IF NOT EXISTS "supplier_purchase_bill_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "purchase_bill_id" BIGINT NOT NULL REFERENCES "supplier_purchase_bills"("id") ON DELETE CASCADE,
  "item_index" INT NOT NULL CHECK ("item_index" >= 0),
  "product_id" BIGINT NULL REFERENCES "products"("id") ON DELETE SET NULL,
  "description" VARCHAR(255) NOT NULL CHECK (LENGTH(TRIM("description")) > 0),
  "quantity" NUMERIC NOT NULL CHECK (
    "quantity" > 0 AND "quantity" <= 1000000 AND scale("quantity") <= 2 AND TRUNC("quantity", 2) = "quantity"
  ),
  "purchase_rate" NUMERIC(12, 2) NOT NULL CHECK ("purchase_rate" >= 0),
  "line_total" NUMERIC(14, 2) NOT NULL CHECK ("line_total" >= 0),
  "updated_product_buying_price" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_supplier_purchase_bill_items_bill_id"
  ON "supplier_purchase_bill_items" ("purchase_bill_id");

CREATE INDEX IF NOT EXISTS "idx_supplier_purchase_bill_items_product_id"
  ON "supplier_purchase_bill_items" ("product_id")
  WHERE "product_id" IS NOT NULL;

-- 5. Purchase Bill Audit History (Immutable audit trail for edits & cancellations)
CREATE TABLE IF NOT EXISTS "supplier_purchase_bill_history" (
  "id" BIGSERIAL PRIMARY KEY,
  "purchase_bill_id" BIGINT NOT NULL REFERENCES "supplier_purchase_bills"("id") ON DELETE CASCADE,
  "version" INT NOT NULL CHECK ("version" >= 1),
  "action" VARCHAR(30) NOT NULL CHECK ("action" IN ('created', 'edited', 'cancelled')),
  "reason" TEXT NULL,
  "previous_data" JSONB NULL,
  "new_data" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_supplier_purchase_bill_history_bill_id"
  ON "supplier_purchase_bill_history" ("purchase_bill_id", "version" DESC);

-- 6. Supplier Payments & Concurrency-Safe Receipt Numbering Sequence
CREATE SEQUENCE IF NOT EXISTS "supplier_payment_receipt_seq" START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE IF NOT EXISTS "supplier_payments" (
  "id" BIGSERIAL PRIMARY KEY,
  "receipt_number" VARCHAR(50) NOT NULL UNIQUE,
  "supplier_id" UUID NOT NULL REFERENCES "suppliers"("id") ON DELETE RESTRICT,
  "payment_date" DATE NOT NULL,
  "amount" NUMERIC(14, 2) NOT NULL CHECK ("amount" > 0),
  "payment_method" VARCHAR(30) NOT NULL CHECK ("payment_method" IN ('cash', 'upi', 'bank_transfer', 'cheque', 'other')),
  "transaction_reference" VARCHAR(120) NULL,
  "notes" TEXT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_supplier_payments_id_supplier" UNIQUE ("id", "supplier_id")
);

CREATE INDEX IF NOT EXISTS "idx_supplier_payments_supplier_date"
  ON "supplier_payments" ("supplier_id", "payment_date" DESC, "id" DESC);

-- 7. Supplier Payment Allocations (Enforcing same-supplier ownership in DB FK constraints)
CREATE TABLE IF NOT EXISTS "supplier_payment_allocations" (
  "id" BIGSERIAL PRIMARY KEY,
  "payment_id" BIGINT NOT NULL,
  "purchase_bill_id" BIGINT NOT NULL,
  "supplier_id" UUID NOT NULL,
  "amount" NUMERIC(14, 2) NOT NULL CHECK ("amount" > 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_supplier_alloc_payment_supplier"
    FOREIGN KEY ("payment_id", "supplier_id") REFERENCES "supplier_payments"("id", "supplier_id") ON DELETE RESTRICT,
  CONSTRAINT "fk_supplier_alloc_bill_supplier"
    FOREIGN KEY ("purchase_bill_id", "supplier_id") REFERENCES "supplier_purchase_bills"("id", "supplier_id") ON DELETE RESTRICT,
  CONSTRAINT "uq_supplier_payment_bill_allocation" UNIQUE ("payment_id", "purchase_bill_id")
);

CREATE INDEX IF NOT EXISTS "idx_supplier_alloc_payment_id"
  ON "supplier_payment_allocations" ("payment_id");

CREATE INDEX IF NOT EXISTS "idx_supplier_alloc_bill_id"
  ON "supplier_payment_allocations" ("purchase_bill_id");

CREATE INDEX IF NOT EXISTS "idx_supplier_alloc_supplier_id"
  ON "supplier_payment_allocations" ("supplier_id");
