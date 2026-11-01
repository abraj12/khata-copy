-- ==============================================================================
-- Khata Application Migration (012):
-- Normal Billing Module (Mannat Hardware Store Standard / Non-GST Bills)
-- ==============================================================================

-- 1. Sequence for collision-free sequential normal bill numbers
CREATE SEQUENCE IF NOT EXISTS "normal_bill_number_seq" START WITH 1;

-- 2. Normal Bills Table (Non-GST / Standard Retail Bills & Estimates)
CREATE TABLE IF NOT EXISTS "normal_bills" (
  "id" BIGSERIAL PRIMARY KEY,
  "bill_number" VARCHAR(50) NOT NULL,
  "bill_date" DATE NOT NULL DEFAULT CURRENT_DATE,
  "state" VARCHAR(100) NOT NULL DEFAULT 'Uttar Pradesh',
  "state_code" VARCHAR(10) NOT NULL DEFAULT '09',
  "transportation_mode" VARCHAR(100) NULL,
  "vehicle_number" VARCHAR(50) NULL,
  "date_of_supply" DATE NULL,
  "place_of_supply" VARCHAR(150) NULL,
  "customer_id" BIGINT NULL REFERENCES "customers"("id") ON DELETE SET NULL,
  "customer_name" VARCHAR(255) NOT NULL,
  "customer_address" TEXT NULL,
  "customer_phone" VARCHAR(20) NULL,
  "customer_state" VARCHAR(100) NOT NULL DEFAULT 'Uttar Pradesh',
  "customer_state_code" VARCHAR(10) NOT NULL DEFAULT '09',
  "total_amount" NUMERIC(12, 2) NOT NULL CHECK ("total_amount" >= 0),
  "amount_in_words" TEXT NOT NULL,
  "r2_object_key" TEXT NULL,
  "pdf_status" VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK ("pdf_status" IN ('pending', 'uploaded', 'failed', 'local_only')),
  "notes" TEXT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_normal_bills_number" UNIQUE ("bill_number")
);

-- 3. Normal Bill Line Items Table (Snapshot of product and pricing at issuance)
CREATE TABLE IF NOT EXISTS "normal_bill_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "bill_id" BIGINT NOT NULL REFERENCES "normal_bills"("id") ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS "idx_normal_bills_date" ON "normal_bills" ("bill_date" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_normal_bills_customer_name" ON "normal_bills" (LOWER("customer_name"));
CREATE INDEX IF NOT EXISTS "idx_normal_bills_number" ON "normal_bills" ("bill_number");
CREATE INDEX IF NOT EXISTS "idx_normal_bills_created_at" ON "normal_bills" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_normal_bill_items_bill_id" ON "normal_bill_items" ("bill_id");
