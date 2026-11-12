import pg from 'pg';
import { env } from './env.js';
import { resolveValidatedTestPoolUrls } from './testDbGuard.js';

const { Pool } = pg;

// Parse PostgreSQL 64-bit integers (BIGINT / BIGSERIAL, OID 20) as JavaScript numbers
pg.types.setTypeParser(20, (val: string) => (val === null ? null : parseInt(val, 10)));

export class TestDatabaseUnavailableError extends Error {
  public readonly code = 'TEST_DB_UNAVAILABLE';

  constructor(
    message = 'Unit test attempted real PostgreSQL access without TEST_DATABASE_URL or query/connect spy mock.'
  ) {
    super(message);
    this.name = 'TestDatabaseUnavailableError';
  }
}

class UnavailableTestPool {
  public totalCount = 0;
  public idleCount = 0;
  public waitingCount = 0;

  public async query(): Promise<never> {
    throw new TestDatabaseUnavailableError();
  }

  public async connect(): Promise<never> {
    throw new TestDatabaseUnavailableError();
  }

  public async end(): Promise<void> {
    return;
  }

  public on(): this {
    return this;
  }
}

export function resolveDatabasePoolTargets(
  rawEnv: Record<string, string | undefined> = process.env,
  runtimeEnv: {
    NODE_ENV: string;
    DATABASE_URL_POOLED: string;
    DATABASE_URL: string;
  } = env
): {
  pooledConnectionString: string;
  directConnectionString: string;
  isTestDbActive: boolean;
  isUnitTestUnavailable: boolean;
  ssl: boolean;
} {
  const { isTestDbActive, testDbUrl } = resolveValidatedTestPoolUrls(rawEnv);
  if (isTestDbActive && testDbUrl) {
    return {
      pooledConnectionString: testDbUrl,
      directConnectionString: testDbUrl,
      isTestDbActive: true,
      isUnitTestUnavailable: false,
      ssl: false,
    };
  }

  if ((rawEnv.NODE_ENV ?? runtimeEnv.NODE_ENV) === 'test') {
    return {
      pooledConnectionString: '',
      directConnectionString: '',
      isTestDbActive: false,
      isUnitTestUnavailable: true,
      ssl: false,
    };
  }

  return {
    pooledConnectionString: runtimeEnv.DATABASE_URL_POOLED,
    directConnectionString: runtimeEnv.DATABASE_URL,
    isTestDbActive: false,
    isUnitTestUnavailable: false,
    ssl: true,
  };
}

const resolvedPoolTargets = resolveDatabasePoolTargets();

// Reusable single application connection pool (against Neon pooled endpoint, validated TEST_DATABASE_URL, or safe test adapter)
export const appPool: pg.Pool = resolvedPoolTargets.isUnitTestUnavailable
  ? (new UnavailableTestPool() as unknown as pg.Pool)
  : new Pool({
      connectionString: resolvedPoolTargets.pooledConnectionString,
      ssl: resolvedPoolTargets.ssl, // Enforce TLS verification without disabling certificate checks
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
      query_timeout: env.DB_QUERY_TIMEOUT_MS,
      keepAlive: true,
    });

// Admin / migration pool (direct endpoint, validated TEST_DATABASE_URL, or safe test adapter)
export const directPool: pg.Pool = resolvedPoolTargets.isUnitTestUnavailable
  ? (new UnavailableTestPool() as unknown as pg.Pool)
  : new Pool({
      connectionString: resolvedPoolTargets.directConnectionString,
      ssl: resolvedPoolTargets.ssl,
      max: env.DB_DIRECT_POOL_MAX,
      connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
      keepAlive: true,
    });

export interface DatabasePoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  max: number;
}

/**
 * Returns numeric-only pool utilization metrics without exposing connection URIs or credentials.
 */
export function getDatabasePoolStats(): DatabasePoolStats {
  return {
    totalCount: appPool.totalCount,
    idleCount: appPool.idleCount,
    waitingCount: appPool.waitingCount,
    max: env.DB_POOL_MAX,
  };
}

/**
 * Times an operation and logs safe latency/pool diagnostics when slow, without SQL params or PII.
 */
export async function measureDbOperation<T>(operationName: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const durationMs = Math.round(performance.now() - start);
    if (durationMs >= env.DB_SLOW_QUERY_MS) {
      const stats = getDatabasePoolStats();
      console.warn(
        `[DB SLOW OPERATION] op=${operationName} durationMs=${durationMs} totalPool=${stats.totalCount} idlePool=${stats.idleCount} waiting=${stats.waitingCount}`
      );
    }
  }
}

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
  '024_home_dashboard_profitability.sql',
  '025_performance_reporting_hardening.sql',
  '026_company_jurisdiction.sql',
  '027_outbox_events.sql',
  '028_outbox_dead_letter.sql',
  '029_outbox_legacy_dead_letter_and_perf_indexes.sql',
  '030_storage_cleanup_jobs.sql',
  '031_outbox_worker_search_indexes.sql',
  '032_storage_lifecycle_and_worker_fencing.sql',
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
  'business_expenses',
  'business_expense_events',
  'app_outbox_events',
  'storage_cleanup_jobs',
  'storage_upload_intents',
];

export const OPTIONAL_SEARCH_TRGM_INDEXES = [
  'idx_products_active_name_trgm',
  'idx_products_active_hsn_trgm',
  'idx_products_active_barcode_trgm',
  'idx_customers_active_name_trgm',
  'idx_customers_active_phone_trgm',
  'idx_customers_active_normalized_phone_trgm',
] as const;

export interface SearchIndexCapabilitiesReport {
  pgTrgmInstalled: boolean;
  expectedOptionalIndexes: string[];
  presentOptionalIndexes: string[];
  missingOptionalIndexes: string[];
  fallbackSearchMode: 'pg_trgm_gin' | 'sequential_fallback' | 'unknown';
}

/**
 * Inspects live PostgreSQL extension and index metadata to determine whether
 * optional trigram fallback search indexes are actually installed.
 */
export async function inspectSearchIndexCapabilities(options?: {
  warnOnMissing?: boolean;
}): Promise<SearchIndexCapabilitiesReport> {
  const expectedOptionalIndexes = [...OPTIONAL_SEARCH_TRGM_INDEXES];
  const [extRes, idxRes] = await Promise.all([
    appPool.query(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS pg_trgm_installed`
    ),
    appPool.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = ANY($1::text[])`,
      [expectedOptionalIndexes]
    ),
  ]);

  const pgTrgmInstalled = Boolean(extRes.rows[0]?.pg_trgm_installed);
  const presentSet = new Set(
    idxRes.rows.map((r: { indexname?: string }) => String(r.indexname || ''))
  );
  const presentOptionalIndexes = expectedOptionalIndexes.filter((name) => presentSet.has(name));
  const missingOptionalIndexes = expectedOptionalIndexes.filter((name) => !presentSet.has(name));

  if (options?.warnOnMissing && missingOptionalIndexes.length > 0) {
    console.warn('[PG SEARCH CAPABILITIES] Optional trigram search indexes missing; fallback ILIKE may use sequential scans.', {
      pgTrgmInstalled,
      missingOptionalIndexes,
    });
  }

  return {
    pgTrgmInstalled,
    expectedOptionalIndexes,
    presentOptionalIndexes,
    missingOptionalIndexes,
    fallbackSearchMode:
      pgTrgmInstalled && missingOptionalIndexes.length === 0
        ? 'pg_trgm_gin'
        : 'sequential_fallback',
  };
}

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

export async function closeDatabasePools(): Promise<void> {
  await Promise.allSettled([appPool.end(), directPool.end()]);
}
