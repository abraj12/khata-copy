-- ==============================================================================
-- Khata Owner Authentication & Core Ledger Tables Migration
-- ==============================================================================

-- 1. PostgreSQL Session Table (connect-pg-simple standard schema)
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- 2. Persistent Login Abuse / Lockout Tracking
CREATE TABLE IF NOT EXISTS "login_attempts" (
  "id" BIGSERIAL PRIMARY KEY,
  "ip_hash" VARCHAR(64) NOT NULL,
  "phone_hash" VARCHAR(64) NOT NULL,
  "combined_hash" VARCHAR(64) NOT NULL,
  "success" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_login_attempts_ip_hash_created" ON "login_attempts" ("ip_hash", "created_at");
CREATE INDEX IF NOT EXISTS "idx_login_attempts_phone_hash_created" ON "login_attempts" ("phone_hash", "created_at");
CREATE INDEX IF NOT EXISTS "idx_login_attempts_combined_hash_created" ON "login_attempts" ("combined_hash", "created_at");

-- 3. Owner Reference Products (Product name & buying price for reference only)
CREATE TABLE IF NOT EXISTS "products" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "buying_price" NUMERIC(10, 2) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Khata Ledger: Customers
CREATE TABLE IF NOT EXISTS "customers" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "phone" VARCHAR(20),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Khata Ledger: Entries (Credit/Udhar & Payments)
CREATE TABLE IF NOT EXISTS "ledger_entries" (
  "id" BIGSERIAL PRIMARY KEY,
  "customer_id" BIGINT NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "type" VARCHAR(20) NOT NULL CHECK ("type" IN ('UDHAR_GIVEN', 'PAYMENT_RECEIVED')),
  "amount" NUMERIC(10, 2) NOT NULL,
  "description" TEXT,
  "entry_date" DATE NOT NULL DEFAULT CURRENT_DATE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_ledger_entries_customer_id" ON "ledger_entries" ("customer_id");
