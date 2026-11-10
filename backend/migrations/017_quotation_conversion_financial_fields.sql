-- ==============================================================================
-- Khata Application Migration (017):
-- Quotation Conversion Financial Integrity, Subtotals, Discounts & Customer State
-- ==============================================================================

-- 1. Add Subtotal and Discount fields to Normal Bills table
ALTER TABLE "normal_bills"
  ADD COLUMN IF NOT EXISTS "subtotal_amount" NUMERIC(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS "discount_type" VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS "discount_value" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "discount_amount" NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- Ensure check constraints on normal_bills discount fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_normal_bill_discount_type'
  ) THEN
    ALTER TABLE "normal_bills"
      ADD CONSTRAINT "check_normal_bill_discount_type"
      CHECK ("discount_type" IS NULL OR "discount_type" IN ('percentage', 'fixed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_normal_bill_discount_amount'
  ) THEN
    ALTER TABLE "normal_bills"
      ADD CONSTRAINT "check_normal_bill_discount_amount"
      CHECK ("discount_amount" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_normal_bill_discount_value'
  ) THEN
    ALTER TABLE "normal_bills"
      ADD CONSTRAINT "check_normal_bill_discount_value"
      CHECK ("discount_value" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_normal_bill_subtotal_amount'
  ) THEN
    ALTER TABLE "normal_bills"
      ADD CONSTRAINT "check_normal_bill_subtotal_amount"
      CHECK ("subtotal_amount" IS NULL OR "subtotal_amount" >= 0);
  END IF;
END $$;

-- Backfill subtotal_amount for existing normal bills where missing
UPDATE "normal_bills"
SET "subtotal_amount" = "total_amount"
WHERE "subtotal_amount" IS NULL;

-- 2. Add Subtotal and Discount fields to GST Invoices table
ALTER TABLE "gst_invoices"
  ADD COLUMN IF NOT EXISTS "subtotal_amount" NUMERIC(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS "discount_type" VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS "discount_value" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "discount_amount" NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- Ensure check constraints on gst_invoices discount fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_gst_invoice_discount_type'
  ) THEN
    ALTER TABLE "gst_invoices"
      ADD CONSTRAINT "check_gst_invoice_discount_type"
      CHECK ("discount_type" IS NULL OR "discount_type" IN ('percentage', 'fixed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_gst_invoice_discount_amount'
  ) THEN
    ALTER TABLE "gst_invoices"
      ADD CONSTRAINT "check_gst_invoice_discount_amount"
      CHECK ("discount_amount" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_gst_invoice_discount_value'
  ) THEN
    ALTER TABLE "gst_invoices"
      ADD CONSTRAINT "check_gst_invoice_discount_value"
      CHECK ("discount_value" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_gst_invoice_subtotal_amount'
  ) THEN
    ALTER TABLE "gst_invoices"
      ADD CONSTRAINT "check_gst_invoice_subtotal_amount"
      CHECK ("subtotal_amount" IS NULL OR "subtotal_amount" >= 0);
  END IF;
END $$;

-- Backfill subtotal_amount for existing GST invoices where missing
UPDATE "gst_invoices"
SET "subtotal_amount" = "taxable_amount"
WHERE "subtotal_amount" IS NULL;

-- 3. Add Customer State and State Code to Quotations table
ALTER TABLE "quotations"
  ADD COLUMN IF NOT EXISTS "customer_state" VARCHAR(100) NOT NULL DEFAULT 'Bihar',
  ADD COLUMN IF NOT EXISTS "customer_state_code" VARCHAR(10) NOT NULL DEFAULT '10';

-- 4. Update quotation_settings default phone if placeholder is present
UPDATE "quotation_settings"
SET "phone" = '94938 40000'
WHERE "id" = 1 AND ("phone" IS NULL OR "phone" = '+91 9999999999');
