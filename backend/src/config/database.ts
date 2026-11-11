import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

// Parse PostgreSQL 64-bit integers (BIGINT / BIGSERIAL, OID 20) as JavaScript numbers
pg.types.setTypeParser(20, (val: string) => (val === null ? null : parseInt(val, 10)));

// Reusable single application connection pool (against Neon pooled endpoint)
export const appPool = new Pool({
  connectionString: env.DATABASE_URL_POOLED,
  ssl: env.NODE_ENV === 'test' ? false : true, // Enforce TLS verification without disabling certificate checks
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Admin / migration pool (direct endpoint)
export const directPool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.NODE_ENV === 'test' ? false : true,
  max: 2,
  connectionTimeoutMillis: 5000,
});

appPool.on('error', (err) => {
  console.error('[DB ERROR] Unexpected error on idle client in application pool:', err.message);
});

directPool.on('error', (err) => {
  console.error('[DB ERROR] Unexpected error on idle client in direct pool:', err.message);
});

export const EXPECTED_MIGRATIONS = [
  '001_auth_tables.sql',
  '002_khata_transactions.sql',
  '003_idempotency_and_hardening.sql',
  '004_integer_quantity_and_money_constraints.sql',
  '005_search_indexes_and_identity_constraints.sql',
  '006_quantity_two_decimal_places.sql',
  '007_quantity_strict_scale_and_allocation_integrity.sql',
  '008_strict_quantity_scale.sql',
  '009_product_images_and_offline_bills.sql',
  '010_product_hsn_code.sql',
  '011_gst_invoices.sql',
  '012_normal_bills.sql',
  '013_customer_address.sql',
  '014_billing_quantity_and_sequences.sql',
  '015_product_barcode.sql',
  '016_quotations.sql',
  '017_quotation_conversion_financial_fields.sql',
  '018_numbering_and_legacy_data_integrity.sql',
  '019_customer_tax_integrity_and_idempotency.sql',
  '020_supplier_management.sql',
  '021_supplier_financial_integrity.sql',
  '022_supplier_operational_hardening.sql',
  '023_supplier_audit_truncate_guard.sql',
];

export const EXPECTED_CORE_TABLES = [
  'session',
  'login_attempts',
  'products',
  'customers',
  'udhar_transactions',
  'udhar_items',
  'payments',
  'payment_allocations',
  'idempotency_keys',
  'offline_bill_records',
  'gst_invoices',
  'gst_invoice_items',
  'normal_bills',
  'normal_bill_items',
  'quotations',
  'quotation_items',
  'quotation_settings',
  'suppliers',
  'supplier_purchase_bills',
  'supplier_purchase_bill_items',
  'supplier_purchase_bill_history',
  'supplier_payments',
  'supplier_payment_allocations',
  'supplier_payment_reversals',
  'supplier_payment_allocation_reversals',
  'supplier_purchase_bill_cancellations',
];

export interface ReadinessReport {
  isReady: boolean;
  latencyMs: number;
  checks: {
    connection: boolean;
    schemaMigrationsTable: boolean;
    migrationsApplied: {
      expected: string[];
      found: string[];
      missing: string[];
    };
    coreTables: {
      expected: string[];
      found: string[];
      missing: string[];
    };
  };
  error?: string;
}

/**
 * Lightweight database liveness check
 */
export async function checkDatabaseLiveness(): Promise<boolean> {
  try {
    const res = await appPool.query('SELECT 1');
    return (res.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Comprehensive database readiness check:
 * 1. Connectivity via application pool
 * 2. Presence of schema_migrations table
 * 3. Applied migration versions check
 * 4. Verification of all core financial/auth tables
 */
export async function checkDatabaseReadiness(): Promise<ReadinessReport> {
  const start = Date.now();
  const checks: ReadinessReport['checks'] = {
    connection: false,
    schemaMigrationsTable: false,
    migrationsApplied: {
      expected: [...EXPECTED_MIGRATIONS],
      found: [],
      missing: [...EXPECTED_MIGRATIONS],
    },
    coreTables: {
      expected: [...EXPECTED_CORE_TABLES],
      found: [],
      missing: [...EXPECTED_CORE_TABLES],
    },
  };

  try {
    // 1. Connection check
    await appPool.query('SELECT 1');
    checks.connection = true;

    // 2. Check schema_migrations table
    const migTableRes = await appPool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'schema_migrations'
      ) AS has_table;
    `);

    const hasMigrationsTable = Boolean(migTableRes.rows[0]?.has_table);
    checks.schemaMigrationsTable = hasMigrationsTable;

    if (hasMigrationsTable) {
      const versionsRes = await appPool.query('SELECT version FROM schema_migrations');
      const foundVersions = versionsRes.rows.map((r: { version: string }) => r.version);
      checks.migrationsApplied.found = foundVersions;
      checks.migrationsApplied.missing = EXPECTED_MIGRATIONS.filter((m) => !foundVersions.includes(m));
    }

    // 3. Check core tables
    const tablesRes = await appPool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[]);
    `, [EXPECTED_CORE_TABLES]);

    const foundTables = tablesRes.rows.map((r: { table_name: string }) => r.table_name);
    checks.coreTables.found = foundTables;
    checks.coreTables.missing = EXPECTED_CORE_TABLES.filter((t) => !foundTables.includes(t));

    const isReady =
      checks.connection &&
      checks.schemaMigrationsTable &&
      checks.migrationsApplied.missing.length === 0 &&
      checks.coreTables.missing.length === 0;

    return {
      isReady,
      latencyMs: Date.now() - start,
      checks,
    };
  } catch (err) {
    console.error('[DATABASE READINESS ERROR]', (err as Error).message);
    return {
      isReady: false,
      latencyMs: Date.now() - start,
      checks,
      error: 'Database connection or query failed',
    };
  }
}
