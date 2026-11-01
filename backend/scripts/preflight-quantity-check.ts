import { directPool } from '../src/config/database.js';

/**
 * Preflight Safety Audit for Udhar Item Quantities:
 * Verifies that no historical records in `udhar_items` contain non-integer/fractional quantities
 * before altering the column type from NUMERIC(12, 3) to INTEGER.
 */
export async function runQuantityPreflightCheck(): Promise<{ isSafe: boolean; fractionalRowsCount: number }> {
  console.log('[PREFLIGHT] Auditing udhar_items table for fractional quantities...');

  // Check if udhar_items table exists
  const tableCheck = await directPool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'udhar_items'
    ) AS has_table;
  `);

  if (!tableCheck.rows[0]?.has_table) {
    console.log('[PREFLIGHT] udhar_items table does not exist yet. Safe to proceed.');
    return { isSafe: true, fractionalRowsCount: 0 };
  }

  const result = await directPool.query(`
    SELECT id, transaction_id, product_name_snapshot, quantity
    FROM udhar_items
    WHERE quantity <> TRUNC(quantity);
  `);

  const count = result.rows.length;
  if (count > 0) {
    console.error(`\x1b[31m[PREFLIGHT DANGER] Found ${count} historical row(s) with fractional quantities!\x1b[0m`);
    console.error('Fractional rows details:', result.rows);
    console.error('Destructive type conversion to INTEGER aborted to prevent silent financial truncation.');
    return { isSafe: false, fractionalRowsCount: count };
  }

  console.log('\x1b[32m[PREFLIGHT PASSED] 0 fractional rows detected in udhar_items. Safe to convert quantity to INTEGER.\x1b[0m');
  return { isSafe: true, fractionalRowsCount: 0 };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runQuantityPreflightCheck()
    .then((res) => {
      process.exit(res.isSafe ? 0 : 1);
    })
    .catch((err) => {
      console.error('[PREFLIGHT ERROR]', err);
      process.exit(1);
    });
}
