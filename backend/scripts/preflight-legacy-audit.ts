/**
 * Safe, Read-Only Preflight Audit Script for Legacy Ledger Data & Identity Preservation
 *
 * Checks:
 * - Number of legacy ledger_entries (migration 001)
 * - Number of customers
 * - Number of normalized udhar_transactions & payments
 * - Customers with missing normalized phone values
 * - Phone normalization collisions across distinct customer records
 * - Legacy ledger records not represented in the normalized model
 *
 * NEVER exposes customer PII (names, phone numbers) in console output.
 */

import pg from 'pg';
import { env } from '../src/config/env.js';

const { Pool } = pg;

async function runPreflightAudit() {
  const connectionString = process.env.AUDIT_DATABASE_URL || env.DATABASE_URL;
  console.log('[AUDIT] Connecting to database in read-only audit mode...');

  const pool = new Pool({
    connectionString,
    ssl: env.NODE_ENV === 'test' ? false : true,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();
  try {
    // Enforce read-only transaction for safety
    await client.query('BEGIN READ ONLY');

    console.log('===============================================================');
    console.log('   KHATA LEGACY DATA & IDENTITY PREFLIGHT AUDIT REPORT         ');
    console.log('===============================================================');

    // 1. Check legacy ledger_entries table
    const ledgerTableRes = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'ledger_entries'
      ) AS exists
    `);
    const hasLedgerTable = ledgerTableRes.rows[0]?.exists === true;

    let legacyCount = 0;
    if (hasLedgerTable) {
      const countRes = await client.query('SELECT COUNT(*)::bigint AS count FROM ledger_entries');
      legacyCount = parseInt(countRes.rows[0]?.count || '0', 10);
    }
    console.log(`[1] Legacy ledger_entries table exists: ${hasLedgerTable ? 'YES' : 'NO'}`);
    console.log(`    Total legacy records count:         ${legacyCount}`);

    // 2. Customers metrics
    const custRes = await client.query(`
      SELECT
        COUNT(*)::bigint AS total_customers,
        COUNT(*) FILTER (WHERE phone IS NOT NULL AND normalized_phone IS NULL)::bigint AS missing_norm_phone,
        COUNT(*) FILTER (WHERE phone IS NULL)::bigint AS customers_without_phone
      FROM customers
    `);
    const totalCustomers = parseInt(custRes.rows[0]?.total_customers || '0', 10);
    const missingNormPhone = parseInt(custRes.rows[0]?.missing_norm_phone || '0', 10);
    const customersWithoutPhone = parseInt(custRes.rows[0]?.customers_without_phone || '0', 10);

    console.log(`[2] Total registered customers:         ${totalCustomers}`);
    console.log(`    Customers without phone:            ${customersWithoutPhone}`);
    console.log(`    Customers with missing norm_phone:  ${missingNormPhone}`);

    // 3. Potential phone normalization collisions
    const collisionRes = await client.query(`
      SELECT normalized_phone, COUNT(*)::int AS count
      FROM customers
      WHERE normalized_phone IS NOT NULL
      GROUP BY normalized_phone
      HAVING COUNT(*) > 1
    `);
    const collisionCount = collisionRes.rows.length;
    console.log(`[3] Phone normalization collision groups: ${collisionCount}`);

    // 4. Normalized udhar_transactions and payments counts
    const txRes = await client.query('SELECT COUNT(*)::bigint AS count FROM udhar_transactions');
    const payRes = await client.query('SELECT COUNT(*)::bigint AS count FROM payments');
    const totalTx = parseInt(txRes.rows[0]?.count || '0', 10);
    const totalPay = parseInt(payRes.rows[0]?.count || '0', 10);

    console.log(`[4] Total normalized udhar_transactions: ${totalTx}`);
    console.log(`    Total normalized payments:          ${totalPay}`);

    // 5. Check if legacy records are unrepresented in normalized model
    if (hasLedgerTable && legacyCount > 0) {
      const unrepresentedRes = await client.query(`
        SELECT COUNT(*)::bigint AS count
        FROM ledger_entries le
        WHERE NOT EXISTS (
          SELECT 1 FROM udhar_transactions t WHERE t.customer_id = le.customer_id
        ) AND NOT EXISTS (
          SELECT 1 FROM payments p WHERE p.customer_id = le.customer_id
        )
      `);
      const unrepresentedCount = parseInt(unrepresentedRes.rows[0]?.count || '0', 10);
      console.log(`[5] Unrepresented legacy records:       ${unrepresentedCount}`);
    } else {
      console.log(`[5] Unrepresented legacy records:       0 (No legacy records present)`);
    }

    console.log('---------------------------------------------------------------');
    if (legacyCount === 0 && missingNormPhone === 0 && collisionCount === 0) {
      console.log('[STATUS] PASS: Schema and data integrity is clean. No backfill needed.');
    } else {
      console.log('[STATUS] ACTION REQUIRED: Inspect metrics above before running migrations.');
    }
    console.log('===============================================================');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[AUDIT ERROR] Audit execution failed:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void runPreflightAudit();
