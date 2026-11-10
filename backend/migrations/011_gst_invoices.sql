-- ==============================================================================
-- Khata Application Migration (011):
-- GST Billing Module (Algions AI Labs Private Limited Tax Invoices & Line Items)
-- ==============================================================================

-- 1. Sequence for collision-free sequential invoice numbers
CREATE SEQUENCE IF NOT EXISTS "gst_invoice_number_seq" START WITH 1;

-- 2. GST Invoices Table
CREATE TABLE IF NOT EXISTS "gst_invoices" (
  "id" BIGSERIAL PRIMARY KEY,
  "invoice_number" VARCHAR(50) NOT NULL,
  "invoice_date" DATE NOT NULL DEFAULT CURRENT_DATE,
  "state" VARCHAR(100) NOT NULL DEFAULT 'Bihar',
  "state_code" VARCHAR(10) NOT NULL DEFAULT '10',
  "transportation_mode" VARCHAR(100) NULL,
  "vehicle_number" VARCHAR(50) NULL,
  "date_of_supply" DATE NULL,
  "place_of_supply" VARCHAR(150) NULL,
  "customer_id" BIGINT NULL REFERENCES "customers"("id") ON DELETE SET NULL,
  "customer_name" VARCHAR(255) NOT NULL,
  "customer_address" TEXT NULL,
  "customer_gstin" VARCHAR(20) NULL,
  "customer_state" VARCHAR(100) NOT NULL DEFAULT 'Bihar',
  "customer_state_code" VARCHAR(10) NOT NULL DEFAULT '10',
  "taxable_amount" NUMERIC(12, 2) NOT NULL CHECK ("taxable_amount" >= 0),
  "cgst_rate" NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK ("cgst_rate" >= 0),
  "cgst_amount" NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK ("cgst_amount" >= 0),
  "sgst_rate" NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK ("sgst_rate" >= 0),
  "sgst_amount" NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK ("sgst_amount" >= 0),
  "igst_rate" NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK ("igst_rate" >= 0),
  "igst_amount" NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK ("igst_amount" >= 0),
  "tax_amount" NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK ("tax_amount" >= 0),
  "grand_total" NUMERIC(12, 2) NOT NULL CHECK ("grand_total" >= 0),
  "amount_in_words" TEXT NOT NULL,
  "r2_object_key" TEXT NULL,
  "pdf_status" VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK ("pdf_status" IN ('pending', 'uploaded', 'failed', 'local_only')),
  "notes" TEXT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_gst_invoices_number" UNIQUE ("invoice_number")
);

-- 3. GST Invoice Line Items Table (Snapshot of product and pricing at issuance)
CREATE TABLE IF NOT EXISTS "gst_invoice_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "invoice_id" BIGINT NOT NULL REFERENCES "gst_invoices"("id") ON DELETE CASCADE,
  "product_id" BIGINT NULL REFERENCES "products"("id") ON DELETE SET NULL,
  "item_index" INT NOT NULL,
  "description" VARCHAR(255) NOT NULL,
  "hsn_code" VARCHAR(20) NULL,
  "quantity" NUMERIC(12, 3) NOT NULL CHECK ("quantity" > 0),
  "unit" VARCHAR(20) NULL,
  "rate" NUMERIC(12, 2) NOT NULL CHECK ("rate" >= 0),
  "rate_unit" VARCHAR(20) NULL,
  "amount" NUMERIC(12, 2) NOT NULL CHECK ("amount" >= 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Search and lookup indexes
CREATE INDEX IF NOT EXISTS "idx_gst_invoices_date" ON "gst_invoices" ("invoice_date" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_gst_invoices_customer_name" ON "gst_invoices" (LOWER("customer_name"));
CREATE INDEX IF NOT EXISTS "idx_gst_invoices_number" ON "gst_invoices" ("invoice_number");
CREATE INDEX IF NOT EXISTS "idx_gst_invoices_created_at" ON "gst_invoices" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_gst_invoice_items_invoice_id" ON "gst_invoice_items" ("invoice_id");
