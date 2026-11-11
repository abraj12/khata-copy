import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';

/**
 * Fetches current buying_price values for product-linked line items within the active
 * transaction client so bill/invoice line items store immutable historical cost snapshots.
 * Unlinked/manual rows remain omitted from the returned map (stored as NULL).
 */
export async function resolveProductCostSnapshots(
  client: PoolClient,
  items: Array<{ productId?: number | null }>
): Promise<Map<number, string>> {
  const productIds = Array.from(
    new Set(
      items
        .map((item) => item.productId)
        .filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0)
    )
  );

  const costMap = new Map<number, string>();
  if (productIds.length === 0) {
    return costMap;
  }

  const res = await client.query(
    `SELECT id, buying_price FROM products WHERE id = ANY($1::bigint[])`,
    [productIds]
  );

  for (const row of res.rows) {
    if (
      row &&
      row.id !== undefined &&
      row.id !== null &&
      row.buying_price !== null &&
      row.buying_price !== undefined
    ) {
      try {
        const dec = new Decimal(String(row.buying_price));
        if (dec.isFinite() && !dec.isNegative()) {
          costMap.set(Number(row.id), dec.toFixed(2));
        }
      } catch {
        // Ignore unexpected non-numeric fallback rows (e.g., partial unit-test mocks)
      }
    }
  }

  return costMap;
}
