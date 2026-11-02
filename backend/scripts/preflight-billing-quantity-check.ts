import { directPool } from '../src/config/database.js';

/**
 * Preflight Safety Audit for Billing Item Quantities:
 * Verifies that no historical records in `gst_invoice_items` or `normal_bill_items`
 * contain quantities with precision exceeding 2 decimal places before running migration 014.
 */
export async function runBillingQuantityPreflightCheck(): Promise<{ isSafe: boolean; invalidRowsCount: number }> {
  console.log('[PREFLIGHT] Auditing billing tables for quantities with > 2 decimal places...');

  let totalInvalid = 0;

  // 1. Audit gst_invoice_items
  const gstTableCheck = await directPool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'gst_invoice_items'
    ) AS has_table;
  `);

  if (gstTableCheck.rows[0]?.has_table) {
    const gstRes = await directPool.query(`
      SELECT id, invoice_id, description, quantity
      FROM gst_invoice_items
      WHERE quantity <> TRUNC(quantity, 2) OR scale(quantity) > 2;
    `);

    if (gstRes.rows.length > 0) {
      console.error(`\x1b[31m[PREFLIGHT DANGER] Found ${gstRes.rows.length} row(s) in gst_invoice_items with > 2 decimal places!\x1b[0m`);
      console.error('GST items:', gstRes.rows);
      totalInvalid += gstRes.rows.length;
    }
  }

  // 2. Audit normal_bill_items
  const normalTableCheck = await directPool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'normal_bill_items'
    ) AS has_table;
  `);

  if (normalTableCheck.rows[0]?.has_table) {
    const normalRes = await directPool.query(`
      SELECT id, bill_id, description, quantity
      FROM normal_bill_items
      WHERE quantity <> TRUNC(quantity, 2) OR scale(quantity) > 2;
    `);

    if (normalRes.rows.length > 0) {
      console.error(`\x1b[31m[PREFLIGHT DANGER] Found ${normalRes.rows.length} row(s) in normal_bill_items with > 2 decimal places!\x1b[0m`);
      console.error('Normal bill items:', normalRes.rows);
      totalInvalid += normalRes.rows.length;
    }
  }

  if (totalInvalid > 0) {
    console.error(`[PREFLIGHT FAILED] Total invalid rows: ${totalInvalid}. Aborting migration to prevent silent rounding.`);
    return { isSafe: false, invalidRowsCount: totalInvalid };
  }

  console.log('\x1b[32m[PREFLIGHT PASSED] All historical billing quantities comply with 2-decimal scale standard.\x1b[0m');
  return { isSafe: true, invalidRowsCount: 0 };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runBillingQuantityPreflightCheck()
    .then((res) => {
      process.exit(res.isSafe ? 0 : 1);
    })
    .catch((err) => {
      console.error('[PREFLIGHT ERROR]', err);
      process.exit(1);
    });
}
