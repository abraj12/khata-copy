-- ==============================================================================
-- Khata Application Migration (025):
-- Release #025: Performance Indexes & Query/Reporting Hardening
-- All indexes are idempotent (IF NOT EXISTS) and executed inside migrator TX
-- (no CONCURRENTLY, matching backend/src/config/migrator.ts).
-- Compatible with PostgreSQL 16+ (Neon Serverless production) and PostgreSQL 18.
-- ==============================================================================

-- 1. Customers & Khata timestamp range lookups (supports sargable AT TIME ZONE bounds)
CREATE INDEX IF NOT EXISTS "idx_customers_created_at"
  ON "customers" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_payments_received_at"
  ON "payments" ("received_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_udhar_transactions_created_at"
  ON "udhar_transactions" ("created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_udhar_transactions_date"
  ON "udhar_transactions" ("transaction_date" DESC, "id" DESC);

-- 2. Supplier reversals, cancellations, allocation reversals & recent activity ordering
CREATE INDEX IF NOT EXISTS "idx_supplier_payment_reversals_reversed_at"
  ON "supplier_payment_reversals" ("reversed_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_supplier_bill_cancellations_cancelled_at"
  ON "supplier_purchase_bill_cancellations" ("cancelled_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_supplier_alloc_rev_created_at"
  ON "supplier_payment_allocation_reversals" ("created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_supplier_purchase_bills_created_at"
  ON "supplier_purchase_bills" ("created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_supplier_payments_created_at"
  ON "supplier_payments" ("created_at" DESC, "id" DESC);

-- 3. Operating expenses pagination/sort coverage & recent void activity partial index
CREATE INDEX IF NOT EXISTS "idx_business_expenses_status_date_created"
  ON "business_expenses" ("status", "expense_date" DESC, "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_business_expenses_created_at"
  ON "business_expenses" ("created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_business_expense_events_voided_created"
  ON "business_expense_events" ("created_at" DESC, "id" DESC)
  WHERE "action" = 'voided';

-- 4. Active product listing deterministic case-insensitive sort index
CREATE INDEX IF NOT EXISTS "idx_products_active_lower_name"
  ON "products" (LOWER("name") ASC, "name" ASC, "id" ASC)
  WHERE "archived_at" IS NULL;
