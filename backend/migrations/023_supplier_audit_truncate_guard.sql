-- Migration 023: Statement-level TRUNCATE protection on append-only supplier financial audit tables
-- Release #023 — prevents accidental or application-level TRUNCATE erasure on immutable audit trails.
-- Note: Reuses prevent_financial_audit_mutation() introduced by migration 022_supplier_operational_hardening.sql.

DROP TRIGGER IF EXISTS trg_block_supplier_payment_reversals_truncate
ON public.supplier_payment_reversals;

CREATE TRIGGER trg_block_supplier_payment_reversals_truncate
BEFORE TRUNCATE ON public.supplier_payment_reversals
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_financial_audit_mutation();


DROP TRIGGER IF EXISTS trg_block_supplier_allocation_reversals_truncate
ON public.supplier_payment_allocation_reversals;

CREATE TRIGGER trg_block_supplier_allocation_reversals_truncate
BEFORE TRUNCATE ON public.supplier_payment_allocation_reversals
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_financial_audit_mutation();


DROP TRIGGER IF EXISTS trg_block_supplier_bill_cancellations_truncate
ON public.supplier_purchase_bill_cancellations;

CREATE TRIGGER trg_block_supplier_bill_cancellations_truncate
BEFORE TRUNCATE ON public.supplier_purchase_bill_cancellations
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_financial_audit_mutation();
