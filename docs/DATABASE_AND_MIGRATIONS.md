# Khata — Database Schema & Migrations Guide

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Database Engine:** PostgreSQL 16 (Neon Serverless)  
**Schema Version:** 007  

---

## 1. Migration History

Migrations are executed sequentially via `backend/scripts/migrate.ts` using direct unpooled connections with PostgreSQL advisory locks (`pg_advisory_lock(987654321)`).

| Migration | File | Description |
|---|---|---|
| **001** | `001_auth_tables.sql` | `session`, `login_attempts`, `products`, `customers`, `ledger_entries`. |
| **002** | `002_khata_transactions.sql` | Normalized schema: `udhar_transactions`, `udhar_items`, `payments`, `payment_allocations`. |
| **003** | `003_idempotency_and_hardening.sql` | `idempotency_keys` table and performance indexes. |
| **004** | `004_integer_quantity_and_money_constraints.sql` | Initial integer quantity constraints and money scale checks. |
| **005** | `005_search_indexes_and_identity_constraints.sql` | Normalized phone & name indexes; `products.buying_price` widened to `NUMERIC(12,2)`. |
| **006** | `006_quantity_two_decimal_places.sql` | Quantity widened to allow fractional quantities up to 2 decimal places. |
| **007** | `007_quantity_strict_scale_and_allocation_integrity.sql` | **Unconstrained NUMERIC with TRUNC scale check** (rejects silent rounding on direct SQL inserts) and **composite foreign keys** ensuring payment allocations cannot cross customer ownership. |

---

## 2. Migration 007 Details

### 2.1 Quantity Precision Enforcement
PostgreSQL columns declared `NUMERIC(12,2)` automatically round values like `1.234` to `1.23` during type coercion before executing CHECK constraints.
Migration 007 converts `udhar_items.quantity` to unconstrained `NUMERIC` and adds:
```sql
ALTER TABLE "udhar_items"
  ADD CONSTRAINT "chk_udhar_items_quantity_scale"
  CHECK (TRUNC("quantity", 2) = "quantity");

ALTER TABLE "udhar_items"
  ADD CONSTRAINT "chk_udhar_items_quantity_positive"
  CHECK ("quantity" > 0 AND "quantity" <= 1000000);
```
Under this definition:
- `1.25`: `TRUNC(1.25, 2) = 1.25` (Accepted)
- `1.234`: `TRUNC(1.234, 2) = 1.23 != 1.234` (Rejected with constraint violation)

### 2.2 Payment Allocation Cross-Customer Integrity
To prevent any possibility of a payment belonging to Customer A being allocated to a transaction belonging to Customer B, composite unique constraints and foreign keys are enforced:
```sql
ALTER TABLE "payments" ADD CONSTRAINT "uq_payments_id_customer" UNIQUE ("id", "customer_id");
ALTER TABLE "udhar_transactions" ADD CONSTRAINT "uq_udhar_transactions_id_customer" UNIQUE ("id", "customer_id");

ALTER TABLE "payment_allocations" ADD COLUMN "customer_id" BIGINT NOT NULL;

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "fk_payment_allocations_payment_customer"
  FOREIGN KEY ("payment_id", "customer_id")
  REFERENCES "payments" ("id", "customer_id")
  ON DELETE CASCADE;

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "fk_payment_allocations_transaction_customer"
  FOREIGN KEY ("transaction_id", "customer_id")
  REFERENCES "udhar_transactions" ("id", "customer_id")
  ON DELETE RESTRICT;
```

---

## 3. Legacy Ledger Preflight Audit Script

Run the safe, read-only preflight inspection:
```bash
npm run preflight:legacy --workspace=backend
```
This script connects in `READ ONLY` transaction mode and reports:
- Number of legacy `ledger_entries`
- Total registered customers
- Customers with missing `normalized_phone`
- Phone normalization collision groups
- Total normalized `udhar_transactions` and `payments`
- Unrepresented legacy records count
- Never prints customer PII to logs.
