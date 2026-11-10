-- ==============================================================================
-- Khata Application Migration (016):
-- Professional Quotations Module (Quotations, Items, Settings & Numbering Sequence)
-- ==============================================================================

-- 1. Quotation Number Sequence for concurrency-safe, collision-resistant sequential numbers
CREATE SEQUENCE IF NOT EXISTS "quotation_number_seq"
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

-- 2. Quotation Settings Table (Configurable company profile, terms, defaults)
CREATE TABLE IF NOT EXISTS "quotation_settings" (
  "id" INT PRIMARY KEY DEFAULT 1,
  "company_name" VARCHAR(255) NOT NULL DEFAULT 'ALGIONS AI LABS PRIVATE LIMITED',
  "logo_url" TEXT NULL,
  "cin" VARCHAR(50) NULL DEFAULT 'U62011BR2026PTC088473',
  "gstin" VARCHAR(20) NULL DEFAULT '10ABGCA8624E1Z3',
  "address" TEXT NOT NULL DEFAULT 'House No. 145A, Haziyapur, Ward 26, Gopalganj, Bihar – 841428',
  "email" VARCHAR(255) NULL DEFAULT 'contact@algions.in',
  "phone" VARCHAR(20) NULL DEFAULT '+91 9999999999',
  "website" VARCHAR(255) NULL DEFAULT 'algions.in',
  "state" VARCHAR(100) NOT NULL DEFAULT 'Bihar',
  "state_code" VARCHAR(10) NOT NULL DEFAULT '10',
  "bank_name" VARCHAR(255) NULL,
  "bank_account_number" VARCHAR(100) NULL,
  "bank_ifsc" VARCHAR(50) NULL,
  "bank_branch" VARCHAR(255) NULL,
  "standard_validity_days" INT NOT NULL DEFAULT 30,
  "standard_payment_terms" TEXT NULL DEFAULT '100% advance or as agreed in commercial contract.',
  "standard_delivery_terms" TEXT NULL DEFAULT 'Delivery within agreed milestone schedule upon confirmation.',
  "standard_warranty_terms" TEXT NULL DEFAULT 'Standard support and warranty as per service agreement.',
  "standard_declaration" TEXT NULL DEFAULT 'This is a computer-generated commercial quotation issued by Algions AI Labs Private Limited.',
  "signatory_title" VARCHAR(100) NOT NULL DEFAULT 'Authorized Signatory',
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "check_quotation_settings_single_row" CHECK ("id" = 1)
);

-- Seed initial settings row if not present
INSERT INTO "quotation_settings" ("id")
VALUES (1)
ON CONFLICT ("id") DO NOTHING;

-- 3. Quotations Table
CREATE TABLE IF NOT EXISTS "quotations" (
  "id" BIGSERIAL PRIMARY KEY,
  "quotation_number" VARCHAR(50) NOT NULL UNIQUE,
  "quotation_date" DATE NOT NULL,
  "valid_until" DATE NULL,
  "customer_id" BIGINT NULL REFERENCES "customers"("id") ON DELETE SET NULL,
  "customer_name" VARCHAR(255) NOT NULL,
  "customer_address" TEXT NULL,
  "customer_phone" VARCHAR(20) NULL,
  "customer_gstin" VARCHAR(20) NULL,
  "project_title" VARCHAR(255) NULL,
  "subject" TEXT NULL,
  "company_snapshot" JSONB NOT NULL,
  "subtotal" NUMERIC(14,2) NOT NULL,
  "discount_type" VARCHAR(20) NULL,
  "discount_value" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "discount_amount" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "taxable_amount" NUMERIC(14,2) NOT NULL,
  "gst_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "gst_rate" NUMERIC(5,2) NOT NULL DEFAULT 0,
  "cgst_amount" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "sgst_amount" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "igst_amount" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "tax_amount" NUMERIC(14,2) NOT NULL DEFAULT 0,
  "grand_total" NUMERIC(14,2) NOT NULL,
  "amount_in_words" TEXT NOT NULL,
  "terms_and_conditions" TEXT NULL,
  "notes" TEXT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  "converted_normal_bill_id" BIGINT NULL REFERENCES "normal_bills"("id") ON DELETE SET NULL,
  "converted_gst_invoice_id" BIGINT NULL REFERENCES "gst_invoices"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "check_quotations_status" CHECK ("status" IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted')),
  CONSTRAINT "check_quotations_discount_type" CHECK ("discount_type" IS NULL OR "discount_type" IN ('percentage', 'fixed')),
  CONSTRAINT "check_quotations_subtotal_non_negative" CHECK ("subtotal" >= 0),
  CONSTRAINT "check_quotations_taxable_amount_non_negative" CHECK ("taxable_amount" >= 0),
  CONSTRAINT "check_quotations_grand_total_non_negative" CHECK ("grand_total" >= 0),
  CONSTRAINT "check_quotations_discount_amount_non_negative" CHECK ("discount_amount" >= 0)
);

-- Indexes for quotation queries
CREATE INDEX IF NOT EXISTS "idx_quotations_customer_id" ON "quotations" ("customer_id");
CREATE INDEX IF NOT EXISTS "idx_quotations_status" ON "quotations" ("status");
CREATE INDEX IF NOT EXISTS "idx_quotations_quotation_date" ON "quotations" ("quotation_date");
CREATE INDEX IF NOT EXISTS "idx_quotations_created_at" ON "quotations" ("created_at" DESC);

-- 4. Quotation Items Table
CREATE TABLE IF NOT EXISTS "quotation_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "quotation_id" BIGINT NOT NULL REFERENCES "quotations"("id") ON DELETE CASCADE,
  "product_id" BIGINT NULL REFERENCES "products"("id") ON DELETE SET NULL,
  "item_index" INT NOT NULL,
  "description" VARCHAR(255) NOT NULL,
  "hsn_code" VARCHAR(20) NULL,
  "barcode" VARCHAR(64) NULL,
  "quantity" NUMERIC(14,2) NOT NULL,
  "unit" VARCHAR(20) NULL,
  "rate" NUMERIC(14,2) NOT NULL,
  "rate_unit" VARCHAR(20) NULL,
  "amount" NUMERIC(14,2) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "check_quotation_items_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "check_quotation_items_quantity_scale" CHECK ("quantity" = ROUND("quantity", 2)),
  CONSTRAINT "check_quotation_items_rate_non_negative" CHECK ("rate" >= 0),
  CONSTRAINT "check_quotation_items_amount_non_negative" CHECK ("amount" >= 0),
  CONSTRAINT "check_quotation_items_index_non_negative" CHECK ("item_index" >= 0)
);

CREATE INDEX IF NOT EXISTS "idx_quotation_items_quotation_id" ON "quotation_items" ("quotation_id");
CREATE INDEX IF NOT EXISTS "idx_quotation_items_product_id" ON "quotation_items" ("product_id");
