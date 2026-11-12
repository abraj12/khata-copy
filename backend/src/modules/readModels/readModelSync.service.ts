import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { appPool } from '../../config/database.js';
import { env } from '../../config/env.js';
import { isMongoReady } from '../../config/mongodb.js';
import { storageService } from '../../services/storage.service.js';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import {
  CustomerSummaryModel,
  DailyAnalyticsModel,
  DashboardSnapshotModel,
  ProductSearchModel,
  RecentActivityModel,
  type DailyAnalyticsDoc,
  type DashboardSnapshotGlobals,
  type RecentActivityDoc,
} from './models.js';
import type { DashboardOverviewData } from '../dashboard/dashboard.service.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

function toFixedMoney(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0.00';
  return new Decimal(String(value)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function toFixedQuantity(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0';
  const d = new Decimal(String(value)).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  return d.toFixed(d.decimalPlaces() === 0 ? 0 : Math.min(2, d.decimalPlaces()));
}

function toPaise(amountStr: string): number {
  const dec = new Decimal(amountStr || '0').times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return Math.trunc(dec.toNumber());
}

export function normalizeSearchText(value: string | null | undefined): string {
  if (!value) return '';
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildSearchTokens(parts: Array<string | null | undefined>): string[] {
  const tokens = new Set<string>();
  for (const part of parts) {
    const clean = normalizeSearchText(part);
    if (!clean) continue;
    tokens.add(clean);
    for (const word of clean.split(/[^a-z0-9]+/)) {
      if (!word) continue;
      tokens.add(word);
      // Bounded prefix tokens (min 2 chars, max 12 chars) for fast indexed autocomplete
      const maxLen = Math.min(word.length, 12);
      for (let len = 2; len <= maxLen; len++) {
        tokens.add(word.slice(0, len));
      }
    }
  }
  return Array.from(tokens).slice(0, 96);
}

export function buildCustomerSearchTokens(
  name: string | null | undefined,
  phone: string | null | undefined,
  normalizedPhone: string | null | undefined
): string[] {
  const tokens = new Set<string>();
  const digits = String(normalizedPhone || phone || '').replace(/\D/g, '');
  if (digits.length > 0) {
    tokens.add(digits);
    const maxPref = Math.min(digits.length, 15);
    for (let len = 2; len <= maxPref; len++) {
      tokens.add(digits.slice(0, len));
    }
    const maxSuf = Math.min(digits.length, 10);
    for (let len = 3; len <= maxSuf; len++) {
      tokens.add(digits.slice(-len));
    }
  }
  for (const tok of buildSearchTokens([name, phone, normalizedPhone])) {
    tokens.add(tok);
    if (tokens.size >= 96) break;
  }
  return Array.from(tokens);
}

/**
 * Atomic monotonic timestamp-guarded upsert preventing stale events from overwriting newer projections
 * and avoiding E11000 duplicate-key errors on conditional upserts.
 */
async function atomicTimestampGuardedUpdate<
  TDoc extends { sourceUpdatedAt: Date; projectionUpdatedAt: Date }
>(
  model: {
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>, opts?: any) => Promise<any>;
  },
  keyFilter: Record<string, unknown>,
  doc: TDoc
): Promise<'upserted' | 'skipped_stale'> {
  const res = await model.updateOne(
    {
      ...keyFilter,
      $or: [
        { sourceUpdatedAt: { $lte: doc.sourceUpdatedAt } },
        { sourceUpdatedAt: { $exists: false } },
      ],
    },
    { $set: doc },
    { upsert: false }
  );
  if (res && typeof res.matchedCount === 'number' && res.matchedCount === 0) {
    return 'skipped_stale';
  }
  return 'upserted';
}

export async function upsertProjectionWithTimestampGuard<
  TDoc extends { sourceUpdatedAt: Date; projectionUpdatedAt: Date }
>(
  model: {
    findOne: (filter: Record<string, unknown>) => any;
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>, opts?: any) => Promise<any>;
  },
  keyFilter: Record<string, unknown>,
  doc: TDoc
): Promise<'upserted' | 'skipped_stale'> {
  const existing = (await model
    .findOne(keyFilter)
    .select({ sourceUpdatedAt: 1 })
    .lean()) as { sourceUpdatedAt?: Date } | null;

  if (
    existing?.sourceUpdatedAt &&
    new Date(existing.sourceUpdatedAt).getTime() > doc.sourceUpdatedAt.getTime()
  ) {
    return 'skipped_stale';
  }

  try {
    if (existing) {
      return await atomicTimestampGuardedUpdate(model, keyFilter, doc);
    }

    await model.updateOne(keyFilter, { $setOnInsert: doc }, { upsert: true });
    return 'upserted';
  } catch (err: any) {
    // Handle concurrent first-insert race cleanly without overwriting newer sourceUpdatedAt
    if (err?.code === 11000) {
      return await atomicTimestampGuardedUpdate(model, keyFilter, doc);
    }
    throw err;
  }
}

export async function bulkUpsertByNumericKey(
  model: any,
  keyField: 'productId' | 'customerId',
  docs: Array<Record<string, unknown> & { sourceUpdatedAt: Date; projectionUpdatedAt: Date }>
): Promise<void> {
  if (docs.length === 0) return;

  const keys = docs.map((d) => Number(d[keyField]));
  const existingRows = (await model
    .find({ [keyField]: { $in: keys } })
    .select({ [keyField]: 1, sourceUpdatedAt: 1 })
    .lean()) as Array<Record<string, unknown>>;

  const existingTimestampByKey = new Map<number, number>();
  for (const row of existingRows) {
    const k = Number(row[keyField]);
    const ts = row.sourceUpdatedAt instanceof Date ? row.sourceUpdatedAt.getTime() : 0;
    existingTimestampByKey.set(k, ts);
  }

  const bulkOps: any[] = [];
  for (const doc of docs) {
    const k = Number(doc[keyField]);
    const existingTs = existingTimestampByKey.get(k);
    if (existingTs !== undefined) {
      if (existingTs > doc.sourceUpdatedAt.getTime()) {
        continue;
      }
      bulkOps.push({
        updateOne: {
          filter: {
            [keyField]: k,
            $or: [
              { sourceUpdatedAt: { $lte: doc.sourceUpdatedAt } },
              { sourceUpdatedAt: { $exists: false } },
            ],
          },
          update: { $set: doc },
          upsert: false,
        },
      });
    } else {
      bulkOps.push({
        updateOne: {
          filter: { [keyField]: k },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      });
    }
  }

  if (bulkOps.length === 0) return;
  try {
    await model.bulkWrite(bulkOps, { ordered: false });
  } catch (err: any) {
    if (err?.code === 11000 || Array.isArray(err?.writeErrors)) {
      for (const doc of docs) {
        const k = Number(doc[keyField]);
        await upsertProjectionWithTimestampGuard(model, { [keyField]: k }, doc);
      }
      return;
    }
    throw err;
  }
}

export interface OutboxBatchEventRow {
  id: number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  source_version: number;
  business_date: string | null;
}

export class ReadModelSyncService {
  private dashboardSnapshotQueue: Promise<void> = Promise.resolve();
  /**
   * Projects a single product from PostgreSQL into MongoDB product_search.
   * Deliberately excludes any stock/inventory/quantity fields.
   */
  public async syncProductById(client: PoolClient, productId: number): Promise<void> {
    await this.syncProductsByIds(client, [productId]);
  }

  /**
   * Batched projection of multiple products from PostgreSQL into MongoDB product_search.
   * Deliberately excludes any stock/inventory/quantity fields.
   */
  public async syncProductsByIds(client: PoolClient, productIds: number[]): Promise<void> {
    const uniqueIds = Array.from(
      new Set(productIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))
    );
    if (uniqueIds.length === 0) return;

    const res = await client.query(
      `SELECT id, name, buying_price, hsn_code, barcode, created_at, updated_at, archived_at,
              image_object_key, image_updated_at
       FROM products
       WHERE id = ANY($1::bigint[])`,
      [uniqueIds]
    );

    const foundIds = new Set<number>();
    const storageReady = storageService.isConfigured();
    const now = new Date();
    const docs: Array<Record<string, unknown> & { sourceUpdatedAt: Date; projectionUpdatedAt: Date }> = [];

    for (const row of res.rows) {
      const pid = Number(row.id);
      foundIds.add(pid);
      const hasImage = Boolean(row.image_object_key) && storageReady;
      const versionTag =
        Date.parse(String(row.image_updated_at || row.updated_at || '')) || 1;
      const imageUrl = hasImage ? `/api/v1/products/${row.id}/image?v=${versionTag}` : null;
      const sourceUpdatedAt = new Date(row.updated_at || Date.now());
      const createdAtPg = new Date(row.created_at || row.updated_at || sourceUpdatedAt);

      docs.push({
        productId: pid,
        name: String(row.name),
        normalizedName: normalizeSearchText(row.name),
        searchTokens: buildSearchTokens([row.hsn_code, row.barcode, row.name]),
        buyingPrice: toFixedMoney(row.buying_price),
        hsnCode: row.hsn_code ? String(row.hsn_code) : null,
        normalizedHsnCode: row.hsn_code ? normalizeSearchText(row.hsn_code) : null,
        barcode: row.barcode ? String(row.barcode) : null,
        imageObjectKey: row.image_object_key ? String(row.image_object_key) : null,
        imageUrl,
        isArchived: Boolean(row.archived_at),
        archivedAt: row.archived_at ? new Date(row.archived_at) : null,
        createdAtPg,
        sourceUpdatedAt,
        projectionUpdatedAt: now,
      });
    }

    const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      await ProductSearchModel.deleteMany({ productId: { $in: missingIds } });
    }

    await bulkUpsertByNumericKey(ProductSearchModel, 'productId', docs);
  }

  /**
   * Projects a single customer summary (lifetime udhar, received, outstanding, lastActivity)
   * from PostgreSQL into MongoDB customer_summaries.
   */
  public async syncCustomerById(client: PoolClient, customerId: number): Promise<void> {
    await this.syncCustomersByIds(client, [customerId]);
  }

  /**
   * Batched projection of customer summaries from PostgreSQL into MongoDB customer_summaries.
   */
  public async syncCustomersByIds(client: PoolClient, customerIds: number[]): Promise<void> {
    const uniqueIds = Array.from(
      new Set(customerIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))
    );
    if (uniqueIds.length === 0) return;

    const res = await client.query(
      `
      WITH tx_agg AS (
        SELECT
          customer_id,
          COUNT(*)::bigint AS tx_count,
          COALESCE(SUM(total_amount), 0)::numeric AS total_udhar,
          MAX(created_at) AS last_tx
        FROM udhar_transactions
        WHERE customer_id = ANY($1::bigint[])
        GROUP BY customer_id
      ),
      alloc_agg AS (
        SELECT
          t.customer_id,
          COALESCE(SUM(pa.amount), 0)::numeric AS total_allocated
        FROM payment_allocations pa
        INNER JOIN udhar_transactions t ON t.id = pa.transaction_id
        WHERE t.customer_id = ANY($1::bigint[])
        GROUP BY t.customer_id
      ),
      pay_agg AS (
        SELECT
          customer_id,
          COUNT(*)::bigint AS pay_count,
          COALESCE(SUM(amount), 0)::numeric AS total_received,
          MAX(received_at) AS last_pay
        FROM payments
        WHERE customer_id = ANY($1::bigint[])
        GROUP BY customer_id
      )
      SELECT
        c.id,
        c.name,
        c.normalized_name,
        c.phone,
        c.normalized_phone,
        c.address,
        c.state,
        c.state_code,
        c.archived_at,
        c.created_at,
        c.updated_at,
        COALESCE(tx.tx_count, 0)::bigint AS tx_count,
        COALESCE(pay.pay_count, 0)::bigint AS pay_count,
        COALESCE(tx.total_udhar, 0)::numeric AS total_udhar,
        COALESCE(pay.total_received, 0)::numeric AS total_received,
        GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0)::numeric AS outstanding,
        NULLIF(GREATEST(
          COALESCE(tx.last_tx, '-infinity'::timestamptz),
          COALESCE(pay.last_pay, '-infinity'::timestamptz)
        ), '-infinity'::timestamptz) AS last_activity,
        GREATEST(
          c.updated_at,
          COALESCE(tx.last_tx, c.updated_at),
          COALESCE(pay.last_pay, c.updated_at)
        ) AS source_updated_at
      FROM customers c
      LEFT JOIN tx_agg tx ON tx.customer_id = c.id
      LEFT JOIN alloc_agg alloc ON alloc.customer_id = c.id
      LEFT JOIN pay_agg pay ON pay.customer_id = c.id
      WHERE c.id = ANY($1::bigint[])
      `,
      [uniqueIds]
    );

    const foundIds = new Set<number>();
    const now = new Date();
    const docs: Array<Record<string, unknown> & { sourceUpdatedAt: Date; projectionUpdatedAt: Date }> = [];

    for (const r of res.rows) {
      const cid = Number(r.id);
      foundIds.add(cid);
      const outstandingStr = toFixedMoney(r.outstanding);
      const outstandingPaise = toPaise(outstandingStr);
      const sourceUpdatedAt = new Date(r.source_updated_at || r.updated_at || Date.now());

      docs.push({
        customerId: cid,
        name: String(r.name),
        normalizedName: normalizeSearchText(r.normalized_name || r.name),
        phone: r.phone ? String(r.phone) : null,
        normalizedPhone: r.normalized_phone ? String(r.normalized_phone) : null,
        address: r.address ? String(r.address) : null,
        state: r.state ? String(r.state) : null,
        stateCode: r.state_code ? String(r.state_code) : null,
        totalUdhar: toFixedMoney(r.total_udhar),
        totalReceived: toFixedMoney(r.total_received),
        outstanding: outstandingStr,
        outstandingPaise,
        hasOutstanding: outstandingPaise > 0,
        transactionCount: Number(r.tx_count || 0),
        paymentCount: Number(r.pay_count || 0),
        lastActivityAt: r.last_activity ? new Date(r.last_activity) : null,
        searchTokens: buildCustomerSearchTokens(
          r.name ? String(r.name) : null,
          r.phone ? String(r.phone) : null,
          r.normalized_phone ? String(r.normalized_phone) : null
        ),
        isArchived: Boolean(r.archived_at),
        createdAtPg: new Date(r.created_at),
        sourceUpdatedAt,
        projectionUpdatedAt: now,
      });
    }

    const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      await CustomerSummaryModel.deleteMany({ customerId: { $in: missingIds } });
    }

    await bulkUpsertByNumericKey(CustomerSummaryModel, 'customerId', docs);
  }

  /**
   * Computes and upserts precomputed DailyAnalytics for one business date (YYYY-MM-DD).
   */
  public async syncDailyAnalyticsForDate(client: PoolClient, businessDate: string): Promise<void> {
    const timeZone = env.BUSINESS_TIME_ZONE || 'Asia/Kolkata';

    const salesRes = await client.query(
        `
        WITH nb AS (
          SELECT COUNT(*)::bigint AS cnt, COALESCE(SUM(total_amount), 0)::numeric AS total
          FROM normal_bills
          WHERE bill_date = $1::date
        ),
        gi AS (
          SELECT
            COUNT(*)::bigint AS cnt,
            COALESCE(SUM(taxable_amount), 0)::numeric AS taxable_sales,
            COALESCE(SUM(tax_amount), 0)::numeric AS gst_collected,
            COALESCE(SUM(grand_total), 0)::numeric AS grand_total
          FROM gst_invoices
          WHERE invoice_date = $1::date
        )
        SELECT
          nb.cnt AS normal_bills_count,
          nb.total AS normal_bills_total,
          gi.cnt AS gst_invoices_count,
          gi.taxable_sales AS gst_taxable_sales,
          gi.gst_collected AS gst_collected,
          gi.grand_total AS gst_invoices_grand_total
        FROM nb CROSS JOIN gi
        `,
        [businessDate]
      );
    const profitRes = await client.query(
        `
        WITH nb_lines AS (
          SELECT
            bill_id,
            COALESCE(SUM(amount), 0)::numeric AS line_subtotal,
            COALESCE(SUM(amount) FILTER (WHERE cost_rate_snapshot IS NOT NULL), 0)::numeric AS costed_line_subtotal,
            COALESCE(SUM(quantity * cost_rate_snapshot) FILTER (WHERE cost_rate_snapshot IS NOT NULL), 0)::numeric AS cogs_total
          FROM normal_bill_items
          GROUP BY bill_id
        ),
        nb_agg AS (
          SELECT
            COALESCE(SUM(
              CASE
                WHEN COALESCE(nbl.line_subtotal, 0) > 0
                  THEN ROUND(nb.total_amount * (COALESCE(nbl.costed_line_subtotal, 0) / nbl.line_subtotal), 2)
                ELSE 0
              END
            ), 0)::numeric AS costed_revenue,
            COALESCE(SUM(COALESCE(nbl.cogs_total, 0)), 0)::numeric AS cogs_total
          FROM normal_bills nb
          LEFT JOIN nb_lines nbl ON nbl.bill_id = nb.id
          WHERE nb.bill_date = $1::date
        ),
        gi_lines AS (
          SELECT
            invoice_id,
            COALESCE(SUM(amount), 0)::numeric AS line_subtotal,
            COALESCE(SUM(amount) FILTER (WHERE cost_rate_snapshot IS NOT NULL), 0)::numeric AS costed_line_subtotal,
            COALESCE(SUM(quantity * cost_rate_snapshot) FILTER (WHERE cost_rate_snapshot IS NOT NULL), 0)::numeric AS cogs_total
          FROM gst_invoice_items
          GROUP BY invoice_id
        ),
        gi_agg AS (
          SELECT
            COALESCE(SUM(
              CASE
                WHEN COALESCE(gil.line_subtotal, 0) > 0
                  THEN ROUND(gi.taxable_amount * (COALESCE(gil.costed_line_subtotal, 0) / gil.line_subtotal), 2)
                ELSE 0
              END
            ), 0)::numeric AS costed_revenue,
            COALESCE(SUM(COALESCE(gil.cogs_total, 0)), 0)::numeric AS cogs_total
          FROM gst_invoices gi
          LEFT JOIN gi_lines gil ON gil.invoice_id = gi.id
          WHERE gi.invoice_date = $1::date
        )
        SELECT
          nb_agg.costed_revenue AS normal_costed_revenue,
          nb_agg.cogs_total AS normal_cogs_total,
          gi_agg.costed_revenue AS gst_costed_revenue,
          gi_agg.cogs_total AS gst_cogs_total
        FROM nb_agg CROSS JOIN gi_agg
        `,
        [businessDate]
      );
    const expSummaryRes = await client.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::bigint AS active_count,
          COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0)::numeric AS active_total,
          COUNT(*) FILTER (WHERE status = 'voided')::bigint AS voided_count
        FROM business_expenses
        WHERE expense_date = $1::date
        `,
        [businessDate]
      );
    const expCatRes = await client.query(
        `
        SELECT
          category,
          COUNT(*)::bigint AS count,
          COALESCE(SUM(amount), 0)::numeric AS total_amount
        FROM business_expenses
        WHERE status = 'active' AND expense_date = $1::date
        GROUP BY category
        ORDER BY total_amount DESC, category ASC
        `,
        [businessDate]
      );
    const custRes = await client.query(
        `
        SELECT COUNT(*)::bigint AS new_customers_count
        FROM customers
        WHERE created_at >= ($1::date::timestamp AT TIME ZONE $2)
          AND created_at < (($1::date + 1)::timestamp AT TIME ZONE $2)
        `,
        [businessDate, timeZone]
      );
    const udharRes = await client.query(
        `
        SELECT COALESCE(SUM(total_amount), 0)::numeric AS credit_given
        FROM udhar_transactions
        WHERE transaction_date = $1::date
        `,
        [businessDate]
      );
    const payRes = await client.query(
        `
        SELECT
          COUNT(*)::bigint AS payment_count,
          COALESCE(SUM(amount), 0)::numeric AS payments_received
        FROM payments
        WHERE received_at >= ($1::date::timestamp AT TIME ZONE $2)
          AND received_at < (($1::date + 1)::timestamp AT TIME ZONE $2)
        `,
        [businessDate, timeZone]
      );
    const quotesRes = await client.query(
        `
        SELECT
          status,
          TO_CHAR(valid_until, 'YYYY-MM-DD') AS valid_until,
          COALESCE(SUM(grand_total), 0)::numeric AS grand_total,
          COUNT(*)::bigint AS cnt
        FROM quotations
        WHERE quotation_date = $1::date
        GROUP BY status, valid_until
        `,
        [businessDate]
      );
    const supBillRes = await client.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'finalized')::bigint AS purchase_bills_count,
          COALESCE(SUM(grand_total) FILTER (WHERE status = 'finalized'), 0)::numeric AS total_purchases,
          COUNT(*) FILTER (WHERE status = 'cancelled')::bigint AS cancelled_bills_count
        FROM supplier_purchase_bills
        WHERE invoice_date = $1::date
        `,
        [businessDate]
      );
    const supPayRes = await client.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::bigint AS payments_count,
          COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0)::numeric AS total_payments_made
        FROM supplier_payments
        WHERE payment_date = $1::date
        `,
        [businessDate]
      );
    const supRevRes = await client.query(
        `
        SELECT COALESCE(SUM(original_amount), 0)::numeric AS total_payments_reversed
        FROM supplier_payment_reversals
        WHERE reversed_at >= ($1::date::timestamp AT TIME ZONE $2)
          AND reversed_at < (($1::date + 1)::timestamp AT TIME ZONE $2)
        `,
        [businessDate, timeZone]
      );
    const topProdRes = await client.query(
        `
        WITH nb_scored AS (
          SELECT
            nbi.id,
            nbi.product_id,
            nbi.quantity,
            nbi.amount,
            nb.id AS bill_id,
            nb.total_amount AS doc_net_total,
            SUM(nbi.amount) OVER (PARTITION BY nbi.bill_id) AS doc_subtotal,
            ROW_NUMBER() OVER (
              PARTITION BY nbi.bill_id
              ORDER BY CASE WHEN nbi.amount > 0 THEN 0 ELSE 1 END, nbi.item_index DESC, nbi.id DESC
            ) AS adj_rn
          FROM normal_bill_items nbi
          INNER JOIN normal_bills nb ON nb.id = nbi.bill_id
          WHERE nb.bill_date = $1::date
        ),
        nb_weighted AS (
          SELECT
            product_id,
            quantity,
            bill_id,
            doc_net_total,
            adj_rn,
            CASE
              WHEN doc_subtotal > 0 THEN ROUND((doc_net_total * amount) / doc_subtotal, 2)
              WHEN adj_rn = 1 THEN ROUND(doc_net_total, 2)
              ELSE 0::numeric(14, 2)
            END AS base_alloc
          FROM nb_scored
        ),
        nb_final AS (
          SELECT
            product_id,
            quantity,
            (
              base_alloc + CASE
                WHEN adj_rn = 1 THEN (doc_net_total - SUM(base_alloc) OVER (PARTITION BY bill_id))
                ELSE 0::numeric
              END
            ) AS allocated_net_amount,
            ('nb:' || bill_id::text) AS doc_key
          FROM nb_weighted
        ),
        gi_scored AS (
          SELECT
            gii.id,
            gii.product_id,
            gii.quantity,
            gii.amount,
            gi.id AS invoice_id,
            gi.taxable_amount AS doc_net_total,
            SUM(gii.amount) OVER (PARTITION BY gii.invoice_id) AS doc_subtotal,
            ROW_NUMBER() OVER (
              PARTITION BY gii.invoice_id
              ORDER BY CASE WHEN gii.amount > 0 THEN 0 ELSE 1 END, gii.item_index DESC, gii.id DESC
            ) AS adj_rn
          FROM gst_invoice_items gii
          INNER JOIN gst_invoices gi ON gi.id = gii.invoice_id
          WHERE gi.invoice_date = $1::date
        ),
        gi_weighted AS (
          SELECT
            product_id,
            quantity,
            invoice_id,
            doc_net_total,
            adj_rn,
            CASE
              WHEN doc_subtotal > 0 THEN ROUND((doc_net_total * amount) / doc_subtotal, 2)
              WHEN adj_rn = 1 THEN ROUND(doc_net_total, 2)
              ELSE 0::numeric(14, 2)
            END AS base_alloc
          FROM gi_scored
        ),
        gi_final AS (
          SELECT
            product_id,
            quantity,
            (
              base_alloc + CASE
                WHEN adj_rn = 1 THEN (doc_net_total - SUM(base_alloc) OVER (PARTITION BY invoice_id))
                ELSE 0::numeric
              END
            ) AS allocated_net_amount,
            ('gi:' || invoice_id::text) AS doc_key
          FROM gi_weighted
        ),
        combined_lines AS (
          SELECT product_id, quantity, allocated_net_amount, doc_key FROM nb_final WHERE product_id IS NOT NULL
          UNION ALL
          SELECT product_id, quantity, allocated_net_amount, doc_key FROM gi_final WHERE product_id IS NOT NULL
        ),
        aggregated AS (
          SELECT
            product_id,
            COALESCE(SUM(quantity), 0)::numeric AS total_quantity_sold,
            COALESCE(SUM(allocated_net_amount), 0)::numeric AS total_sales_amount,
            COUNT(DISTINCT doc_key)::bigint AS bill_count
          FROM combined_lines
          GROUP BY product_id
        )
        SELECT
          p.id AS product_id,
          p.name AS product_name,
          (p.archived_at IS NOT NULL) AS is_archived,
          a.total_quantity_sold,
          a.total_sales_amount,
          a.bill_count
        FROM aggregated a
        INNER JOIN products p ON p.id = a.product_id
        `,
        [businessDate]
      );

    const s = salesRes.rows[0] || {};
    const p = profitRes.rows[0] || {};
    const e = expSummaryRes.rows[0] || {};
    const c = custRes.rows[0] || {};
    const u = udharRes.rows[0] || {};
    const kPay = payRes.rows[0] || {};
    const sb = supBillRes.rows[0] || {};
    const sp = supPayRes.rows[0] || {};
    const sr = supRevRes.rows[0] || {};

    let quotationsTotal = 0;
    let quotationsConverted = 0;
    let quotationsRejected = 0;
    let quotationsConvertedValueDec = new Decimal(0);
    const quotationBuckets = quotesRes.rows.map((qr) => {
      const cnt = Number(qr.cnt || 0);
      quotationsTotal += cnt;
      if (qr.status === 'converted') {
        quotationsConverted += cnt;
        quotationsConvertedValueDec = quotationsConvertedValueDec.plus(toFixedMoney(qr.grand_total));
      } else if (qr.status === 'rejected') {
        quotationsRejected += cnt;
      }
      return {
        status: qr.status as any,
        validUntil: qr.valid_until ? String(qr.valid_until) : null,
        grandTotal: toFixedMoney(qr.grand_total),
        count: cnt,
      };
    });

    const dailyDoc: DailyAnalyticsDoc = {
      businessDate,
      yearMonth: businessDate.slice(0, 7),
      normalBillsCount: Number(s.normal_bills_count || 0),
      normalBillsTotal: toFixedMoney(s.normal_bills_total),
      normalCostedRevenue: toFixedMoney(p.normal_costed_revenue),
      normalCogsTotal: toFixedMoney(p.normal_cogs_total),
      gstInvoicesCount: Number(s.gst_invoices_count || 0),
      gstTaxableSales: toFixedMoney(s.gst_taxable_sales),
      gstCollected: toFixedMoney(s.gst_collected),
      gstInvoicesGrandTotal: toFixedMoney(s.gst_invoices_grand_total),
      gstCostedRevenue: toFixedMoney(p.gst_costed_revenue),
      gstCogsTotal: toFixedMoney(p.gst_cogs_total),
      expensesActiveCount: Number(e.active_count || 0),
      expensesActiveTotal: toFixedMoney(e.active_total),
      expensesVoidedCount: Number(e.voided_count || 0),
      expensesByCategory: expCatRes.rows.map((r) => ({
        category: String(r.category),
        count: Number(r.count || 0),
        totalAmount: toFixedMoney(r.total_amount),
      })),
      newCustomersCount: Number(c.new_customers_count || 0),
      khataCreditGiven: toFixedMoney(u.credit_given),
      khataPaymentsReceived: toFixedMoney(kPay.payments_received),
      khataPaymentCount: Number(kPay.payment_count || 0),
      quotationsTotal,
      quotationsConverted,
      quotationsRejected,
      quotationsConvertedValue: quotationsConvertedValueDec.toFixed(2),
      quotationBuckets,
      supplierBillsCount: Number(sb.purchase_bills_count || 0),
      supplierCancelledBillsCount: Number(sb.cancelled_bills_count || 0),
      supplierPurchases: toFixedMoney(sb.total_purchases),
      supplierPaymentsCount: Number(sp.payments_count || 0),
      supplierPaymentsMade: toFixedMoney(sp.total_payments_made),
      supplierPaymentsReversed: toFixedMoney(sr.total_payments_reversed),
      productSales: topProdRes.rows.map((r) => ({
        productId: Number(r.product_id),
        productName: String(r.product_name),
        isArchived: Boolean(r.is_archived),
        quantitySold: toFixedQuantity(r.total_quantity_sold),
        salesAmount: toFixedMoney(r.total_sales_amount),
        billCount: Number(r.bill_count || 0),
      })),
      projectionUpdatedAt: new Date(),
    };

    await DailyAnalyticsModel.updateOne(
      { businessDate },
      { $set: dailyDoc },
      { upsert: true }
    );
  }

  /**
   * Projects latest cross-module recent activities from PostgreSQL into MongoDB recent_activity.
   */
  public async syncRecentActivities(client: PoolClient, perModuleLimit = 30): Promise<void> {
    const timeZone = env.BUSINESS_TIME_ZONE || 'Asia/Kolkata';
    const businessDate = getBusinessDateISO();

    const res = await client.query(
      `
      SELECT
        activity_key,
        type,
        reference,
        party,
        amount,
        TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date,
        status,
        occurred_at,
        target_tab
      FROM (
        (
          SELECT
            ('normal_bill:' || nb.id::text) AS activity_key,
            'normal_bill'::text AS type,
            nb.bill_number AS reference,
            nb.customer_name AS party,
            nb.total_amount AS amount,
            nb.bill_date AS event_date,
            NULL::text AS status,
            nb.created_at AS occurred_at,
            'normal-bill'::text AS target_tab
          FROM normal_bills nb
          ORDER BY nb.created_at DESC, nb.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('gst_invoice:' || gi.id::text) AS activity_key,
            'gst_invoice'::text AS type,
            gi.invoice_number AS reference,
            gi.customer_name AS party,
            gi.grand_total AS amount,
            gi.invoice_date AS event_date,
            NULL::text AS status,
            gi.created_at AS occurred_at,
            'gst-bill'::text AS target_tab
          FROM gst_invoices gi
          ORDER BY gi.created_at DESC, gi.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('khata_credit:' || ut.id::text) AS activity_key,
            'khata_credit'::text AS type,
            ('Khata #' || ut.id::text) AS reference,
            c.name AS party,
            ut.total_amount AS amount,
            ut.transaction_date AS event_date,
            NULL::text AS status,
            ut.created_at AS occurred_at,
            'khata'::text AS target_tab
          FROM udhar_transactions ut
          INNER JOIN customers c ON c.id = ut.customer_id
          ORDER BY ut.created_at DESC, ut.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('khata_payment:' || p.id::text) AS activity_key,
            'khata_payment'::text AS type,
            ('Receipt #' || p.id::text) AS reference,
            c.name AS party,
            p.amount AS amount,
            (p.received_at AT TIME ZONE $1)::date AS event_date,
            NULL::text AS status,
            p.received_at AS occurred_at,
            'khata'::text AS target_tab
          FROM payments p
          INNER JOIN customers c ON c.id = p.customer_id
          ORDER BY p.received_at DESC, p.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('supplier_bill:' || spb.id::text) AS activity_key,
            'supplier_bill'::text AS type,
            spb.invoice_number AS reference,
            s.name AS party,
            spb.grand_total AS amount,
            spb.invoice_date AS event_date,
            spb.status AS status,
            spb.created_at AS occurred_at,
            'suppliers'::text AS target_tab
          FROM supplier_purchase_bills spb
          INNER JOIN suppliers s ON s.id = spb.supplier_id
          ORDER BY spb.created_at DESC, spb.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('supplier_payment:' || sp.id::text) AS activity_key,
            'supplier_payment'::text AS type,
            sp.receipt_number AS reference,
            s.name AS party,
            sp.amount AS amount,
            sp.payment_date AS event_date,
            sp.status AS status,
            sp.created_at AS occurred_at,
            'suppliers'::text AS target_tab
          FROM supplier_payments sp
          INNER JOIN suppliers s ON s.id = sp.supplier_id
          ORDER BY sp.created_at DESC, sp.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('supplier_payment_reversal:' || spr.id::text) AS activity_key,
            'supplier_payment_reversal'::text AS type,
            spr.reversal_number AS reference,
            s.name AS party,
            spr.original_amount AS amount,
            (spr.reversed_at AT TIME ZONE $1)::date AS event_date,
            'reversed'::text AS status,
            spr.reversed_at AS occurred_at,
            'suppliers'::text AS target_tab
          FROM supplier_payment_reversals spr
          INNER JOIN suppliers s ON s.id = spr.supplier_id
          ORDER BY spr.reversed_at DESC, spr.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('supplier_allocation_reversal:' || spar.id::text) AS activity_key,
            'supplier_allocation_reversal'::text AS type,
            (sp.receipt_number || ' -> ' || spb.invoice_number) AS reference,
            s.name AS party,
            spar.reversed_amount AS amount,
            (spar.created_at AT TIME ZONE $1)::date AS event_date,
            'reversed'::text AS status,
            spar.created_at AS occurred_at,
            'suppliers'::text AS target_tab
          FROM supplier_payment_allocation_reversals spar
          INNER JOIN supplier_payments sp ON sp.id = spar.payment_id
          INNER JOIN supplier_purchase_bills spb ON spb.id = spar.purchase_bill_id
          INNER JOIN suppliers s ON s.id = spar.supplier_id
          ORDER BY spar.created_at DESC, spar.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('supplier_bill_cancellation:' || spbc.id::text) AS activity_key,
            'supplier_bill_cancellation'::text AS type,
            spbc.invoice_number AS reference,
            s.name AS party,
            spbc.original_grand_total AS amount,
            (spbc.cancelled_at AT TIME ZONE $1)::date AS event_date,
            'cancelled'::text AS status,
            spbc.cancelled_at AS occurred_at,
            'suppliers'::text AS target_tab
          FROM supplier_purchase_bill_cancellations spbc
          INNER JOIN suppliers s ON s.id = spbc.supplier_id
          ORDER BY spbc.cancelled_at DESC, spbc.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('expense:' || be.id::text) AS activity_key,
            'expense'::text AS type,
            be.title AS reference,
            COALESCE(be.vendor_name, INITCAP(be.category)) AS party,
            be.amount AS amount,
            be.expense_date AS event_date,
            be.status AS status,
            be.created_at AS occurred_at,
            'home'::text AS target_tab
          FROM business_expenses be
          ORDER BY be.created_at DESC, be.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('expense_void:' || bee.id::text) AS activity_key,
            'expense_void'::text AS type,
            be.title AS reference,
            COALESCE(be.vendor_name, INITCAP(be.category)) AS party,
            be.amount AS amount,
            (bee.created_at AT TIME ZONE $1)::date AS event_date,
            'voided'::text AS status,
            bee.created_at AS occurred_at,
            'home'::text AS target_tab
          FROM business_expense_events bee
          INNER JOIN business_expenses be ON be.id = bee.expense_id
          WHERE bee.action = 'voided'
          ORDER BY bee.created_at DESC, bee.id DESC
          LIMIT $3
        )
        UNION ALL
        (
          SELECT
            ('quotation:' || q.id::text) AS activity_key,
            'quotation'::text AS type,
            q.quotation_number AS reference,
            q.customer_name AS party,
            q.grand_total AS amount,
            q.quotation_date AS event_date,
            CASE
              WHEN q.status IN ('draft', 'sent', 'accepted')
                AND q.valid_until IS NOT NULL
                AND q.valid_until < $2::date THEN 'expired'
              ELSE q.status
            END AS status,
            q.created_at AS occurred_at,
            'quotations'::text AS target_tab
          FROM quotations q
          ORDER BY q.created_at DESC, q.id DESC
          LIMIT $3
        )
      ) all_activities
      ORDER BY occurred_at DESC
      LIMIT 150
      `,
      [timeZone, businessDate, perModuleLimit]
    );

    if (res.rows.length === 0) return;

    const now = new Date();
    const ops = res.rows.map((r) => {
      const doc: RecentActivityDoc = {
        activityKey: String(r.activity_key),
        type: r.type,
        reference: String(r.reference),
        party: String(r.party),
        amount: toFixedMoney(r.amount),
        date: String(r.event_date),
        status: r.status ?? null,
        occurredAt: new Date(r.occurred_at),
        targetTab: r.target_tab,
        projectionUpdatedAt: now,
      };
      return {
        updateOne: {
          filter: { activityKey: doc.activityKey },
          update: { $set: doc },
          upsert: true,
        },
      };
    });

    await RecentActivityModel.bulkWrite(ops, { ordered: false });
  }

  /**
   * Computes current non-date-filtered globals and all-time overview snapshot into MongoDB dashboard_snapshots.
   * Serialized internally to prevent slower overlapping executions from overwriting newer aggregates.
   */
  public syncDashboardSnapshot(
    client: PoolClient,
    lastOutboxEventId: number | null = null
  ): Promise<void> {
    const run = this.dashboardSnapshotQueue
      .catch(() => {})
      .then(() => this.executeSyncDashboardSnapshot(client, lastOutboxEventId));
    this.dashboardSnapshotQueue = run;
    return run;
  }

  private async executeSyncDashboardSnapshot(
    client: PoolClient,
    lastOutboxEventId: number | null = null
  ): Promise<void> {
    const custPosRes = await client.query(`
        WITH customer_udhar AS (
          SELECT customer_id, COALESCE(SUM(total_amount), 0)::numeric AS total_udhar
          FROM udhar_transactions
          GROUP BY customer_id
        ),
        customer_alloc AS (
          SELECT ut.customer_id, COALESCE(SUM(pa.amount), 0)::numeric AS total_allocated
          FROM payment_allocations pa
          INNER JOIN udhar_transactions ut ON ut.id = pa.transaction_id
          GROUP BY ut.customer_id
        ),
        per_customer AS (
          SELECT
            c.id,
            c.archived_at,
            GREATEST(COALESCE(cu.total_udhar, 0) - COALESCE(ca.total_allocated, 0), 0) AS outstanding
          FROM customers c
          LEFT JOIN customer_udhar cu ON cu.customer_id = c.id
          LEFT JOIN customer_alloc ca ON ca.customer_id = c.id
        )
        SELECT
          COUNT(*)::bigint AS total_customers,
          COUNT(*) FILTER (WHERE archived_at IS NULL)::bigint AS active_customers,
          COUNT(*) FILTER (WHERE outstanding > 0)::bigint AS customers_with_outstanding,
          COALESCE(SUM(outstanding), 0)::numeric AS total_outstanding_receivable
        FROM per_customer
      `);
    const khataSummaryRes = await client.query(`
        WITH transaction_totals AS (
          SELECT
            COUNT(DISTINCT customer_id)::bigint AS total_customers,
            COALESCE(SUM(total_amount), 0)::numeric AS total_udhar
          FROM udhar_transactions
        ),
        allocation_totals AS (
          SELECT COALESCE(SUM(amount), 0)::numeric AS total_allocated
          FROM payment_allocations
        ),
        payment_totals AS (
          SELECT COALESCE(SUM(amount), 0)::numeric AS total_received
          FROM payments
        )
        SELECT
          transaction_totals.total_customers,
          GREATEST(transaction_totals.total_udhar - allocation_totals.total_allocated, 0) AS total_outstanding,
          payment_totals.total_received
        FROM transaction_totals
        CROSS JOIN allocation_totals
        CROSS JOIN payment_totals
      `);
    const prodCountRes = await client.query(`
        SELECT
          COUNT(*)::bigint AS total_products,
          COUNT(*) FILTER (WHERE archived_at IS NULL)::bigint AS active_products,
          COUNT(*) FILTER (WHERE archived_at IS NOT NULL)::bigint AS archived_products
        FROM products
      `);
    const supPosRes = await client.query(`
        WITH bill_totals AS (
          SELECT supplier_id, COALESCE(SUM(grand_total), 0)::numeric AS total_purchases
          FROM supplier_purchase_bills
          WHERE status = 'finalized'
          GROUP BY supplier_id
        ),
        pay_totals AS (
          SELECT supplier_id, COALESCE(SUM(amount), 0)::numeric AS total_payments
          FROM supplier_payments
          WHERE status = 'active'
          GROUP BY supplier_id
        ),
        alloc_rev AS (
          SELECT allocation_id, COALESCE(SUM(reversed_amount), 0)::numeric AS reversed_amount
          FROM supplier_payment_allocation_reversals
          GROUP BY allocation_id
        ),
        alloc_totals AS (
          SELECT
            spa.supplier_id,
            COALESCE(SUM(GREATEST(spa.amount - COALESCE(ar.reversed_amount, 0), 0)), 0)::numeric AS allocated_payments
          FROM supplier_payment_allocations spa
          INNER JOIN supplier_purchase_bills spb ON spb.id = spa.purchase_bill_id
          INNER JOIN supplier_payments sp ON sp.id = spa.payment_id
          LEFT JOIN alloc_rev ar ON ar.allocation_id = spa.id
          WHERE spb.status = 'finalized'
            AND sp.status = 'active'
          GROUP BY spa.supplier_id
        ),
        per_supplier AS (
          SELECT
            s.id,
            s.archived_at,
            COALESCE(bt.total_purchases, 0)::numeric AS purchases,
            COALESCE(pt.total_payments, 0)::numeric AS payments,
            COALESCE(at.allocated_payments, 0)::numeric AS allocated
          FROM suppliers s
          LEFT JOIN bill_totals bt ON bt.supplier_id = s.id
          LEFT JOIN pay_totals pt ON pt.supplier_id = s.id
          LEFT JOIN alloc_totals at ON at.supplier_id = s.id
        ),
        bill_agg AS (
          SELECT
            COUNT(*) FILTER (WHERE status = 'finalized')::bigint AS purchase_bills_count,
            COALESCE(SUM(grand_total) FILTER (WHERE status = 'finalized'), 0)::numeric AS total_purchases,
            COUNT(*) FILTER (WHERE status = 'cancelled')::bigint AS cancelled_bills_count
          FROM supplier_purchase_bills
        ),
        pay_agg AS (
          SELECT
            COUNT(*) FILTER (WHERE status = 'active')::bigint AS payments_count,
            COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0)::numeric AS total_payments_made
          FROM supplier_payments
        ),
        rev_agg AS (
          SELECT COALESCE(SUM(original_amount), 0)::numeric AS total_payments_reversed
          FROM supplier_payment_reversals
        )
        SELECT
          (SELECT COUNT(*)::bigint FROM per_supplier) AS total_suppliers,
          (SELECT COUNT(*)::bigint FROM per_supplier WHERE archived_at IS NULL) AS active_suppliers,
          (SELECT COALESCE(SUM(GREATEST(purchases - payments, 0)), 0)::numeric FROM per_supplier) AS total_outstanding_payable,
          (SELECT COALESCE(SUM(GREATEST(payments - purchases, 0)), 0)::numeric FROM per_supplier) AS total_advance_credit,
          (SELECT COALESCE(SUM(GREATEST(payments - allocated, 0)), 0)::numeric FROM per_supplier) AS total_unallocated_payments,
          ba.purchase_bills_count,
          ba.total_purchases,
          ba.cancelled_bills_count,
          pa.payments_count,
          pa.total_payments_made,
          ra.total_payments_reversed
        FROM bill_agg ba
        CROSS JOIN pay_agg pa
        CROSS JOIN rev_agg ra
      `);

    const cRow = custPosRes.rows[0] || {};
    const kRow = khataSummaryRes.rows[0] || {};
    const pRow = prodCountRes.rows[0] || {};
    const sRow = supPosRes.rows[0] || {};

    const globals: DashboardSnapshotGlobals = {
      totalCustomers: Number(cRow.total_customers || 0),
      activeCustomers: Number(cRow.active_customers || 0),
      customersWithOutstanding: Number(cRow.customers_with_outstanding || 0),
      totalOutstandingReceivable: toFixedMoney(cRow.total_outstanding_receivable),
      khataSummaryTotalCustomers: Number(kRow.total_customers || 0),
      khataSummaryTotalOutstanding: toFixedMoney(kRow.total_outstanding),
      khataSummaryTotalReceived: toFixedMoney(kRow.total_received),
      totalProducts: Number(pRow.total_products || 0),
      activeProducts: Number(pRow.active_products || 0),
      archivedProducts: Number(pRow.archived_products || 0),
      totalSuppliers: Number(sRow.total_suppliers || 0),
      activeSuppliers: Number(sRow.active_suppliers || 0),
      supplierTotalPurchases: toFixedMoney(sRow.total_purchases),
      supplierBillsCount: Number(sRow.purchase_bills_count || 0),
      supplierCancelledBillsCount: Number(sRow.cancelled_bills_count || 0),
      supplierTotalPaymentsMade: toFixedMoney(sRow.total_payments_made),
      supplierPaymentsCount: Number(sRow.payments_count || 0),
      supplierTotalPaymentsReversed: toFixedMoney(sRow.total_payments_reversed),
      supplierTotalOutstandingPayable: toFixedMoney(sRow.total_outstanding_payable),
      supplierTotalAdvanceCredit: toFixedMoney(sRow.total_advance_credit),
      supplierTotalUnallocatedPayments: toFixedMoney(sRow.total_unallocated_payments),
    };

    const existing = (await DashboardSnapshotModel.findOne({ snapshotKey: '__global__' })
      .select({ lastOutboxEventId: 1 })
      .lean()) as { lastOutboxEventId?: number | null } | null;

    const effectiveOutboxId =
      lastOutboxEventId !== null
        ? Math.max(lastOutboxEventId, existing?.lastOutboxEventId ?? 0)
        : existing?.lastOutboxEventId ?? null;

    const { readModelsQueryService } = await import('./readModelsQuery.service.js');
    const allTimeOverview = await readModelsQueryService.buildOverviewFromAnalytics(globals, {});
    const now = new Date();

    await DashboardSnapshotModel.updateOne(
      { snapshotKey: '__global__' },
      {
        $set: {
          snapshotKey: '__global__',
          globals,
          allTimeOverview: allTimeOverview as unknown as Record<string, unknown>,
          lastOutboxEventId: effectiveOutboxId,
          lastSyncedAt: now,
          lastDashboardRefreshAt: now,
          projectionUpdatedAt: now,
        },
        $max: {
          lastProjectionSyncAt: now,
        },
      },
      { upsert: true }
    );
  }

  /**
   * Refreshes only the global dashboard snapshot using a pooled PostgreSQL connection.
   * Invoked by the outbox worker's coalesced trailing refresh scheduler.
   */
  public async refreshGlobalDashboardSnapshotFromPool(): Promise<void> {
    if (!isMongoReady()) return;
    const client = await appPool.connect();
    try {
      await this.syncDashboardSnapshot(client, null);
    } finally {
      client.release();
    }
  }

  /**
   * Processes a claimed batch of outbox events cleanly by deduplicating impacted
   * aggregates and dates, then running minimal PostgreSQL projection queries and MongoDB upserts.
   */
  public async applyOutboxBatch(
    events: OutboxBatchEventRow[],
    options: { skipDashboardSnapshot?: boolean } = {}
  ): Promise<number[]> {
    if (events.length === 0 || !isMongoReady()) {
      return [];
    }

    const productIds = new Set<number>();
    const customerIds = new Set<number>();
    const impactedDates = new Set<string>();
    let needsRecentActivity = false;
    let maxOutboxId = 0;

    for (const ev of events) {
      maxOutboxId = Math.max(maxOutboxId, Number(ev.id));
      if (ev.business_date) {
        impactedDates.add(String(ev.business_date));
      }
      const prevDate = ev.payload?.previousBusinessDate;
      if (typeof prevDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(prevDate)) {
        impactedDates.add(prevDate);
      }

      if (ev.aggregate_type === 'product') {
        const pid = Number(ev.aggregate_id);
        if (Number.isFinite(pid) && pid > 0) productIds.add(pid);
      } else if (ev.aggregate_type === 'customer') {
        const cid = Number(ev.aggregate_id);
        if (Number.isFinite(cid) && cid > 0) customerIds.add(cid);
        if (ev.event_type.startsWith('khata.')) {
          needsRecentActivity = true;
        }
      } else {
        needsRecentActivity = true;
        const cid = ev.payload?.customerId;
        if (cid !== undefined && cid !== null && Number(cid) > 0) {
          customerIds.add(Number(cid));
        }
        const productList = ev.payload?.productIds;
        if (Array.isArray(productList)) {
          for (const id of productList) {
            if (Number(id) > 0) productIds.add(Number(id));
          }
        }
      }
    }

    const client = await appPool.connect();
    try {
      if (productIds.size > 0) {
        await this.syncProductsByIds(client, Array.from(productIds));
      }
      if (customerIds.size > 0) {
        await this.syncCustomersByIds(client, Array.from(customerIds));
      }
      for (const dateIso of impactedDates) {
        await this.syncDailyAnalyticsForDate(client, dateIso);
      }
      if (needsRecentActivity) {
        await this.syncRecentActivities(client, 30);
      }
      if (options.skipDashboardSnapshot) {
        const projectionNow = new Date();
        const maxFields: Record<string, unknown> = {
          lastProjectionSyncAt: projectionNow,
          projectionUpdatedAt: projectionNow,
        };
        if (maxOutboxId > 0) {
          maxFields.lastOutboxEventId = maxOutboxId;
        }
        await DashboardSnapshotModel.updateOne(
          { snapshotKey: '__global__' },
          { $max: maxFields },
          { upsert: false }
        );
      } else {
        await this.syncDashboardSnapshot(client, maxOutboxId > 0 ? maxOutboxId : null);
      }
    } finally {
      client.release();
    }

    return events.map((e) => Number(e.id));
  }

  /**
   * Explicitly rebuilds all MongoDB read-model collections from authoritative PostgreSQL state.
   * Requires { confirm: true } guard to avoid accidental full-DB scans in runtime traffic.
   */
  public async rebuildAllReadModels(options: {
    confirm: boolean;
    batchSize?: number;
  }): Promise<{
    productsSynced: number;
    customersSynced: number;
    daysSynced: number;
  }> {
    if (!options.confirm) {
      throw new Error('Explicit confirmation { confirm: true } is required to rebuild read models.');
    }
    if (!isMongoReady()) {
      throw new Error('MongoDB must be enabled and connected before rebuilding read models.');
    }

    const batchSize = Math.min(Math.max(10, options.batchSize ?? 250), 500);
    const timeZone = env.BUSINESS_TIME_ZONE || 'Asia/Kolkata';
    let productsSynced = 0;
    let customersSynced = 0;
    let daysSynced = 0;

    const client = await appPool.connect();
    try {
      // 1. Rebuild products in bounded batches
      let lastProductId = 0;
      while (true) {
        const res = await client.query(
          `SELECT id FROM products WHERE id > $1 ORDER BY id ASC LIMIT $2`,
          [lastProductId, batchSize]
        );
        if (res.rows.length === 0) break;
        const batchIds = res.rows.map((r) => Number(r.id));
        await this.syncProductsByIds(client, batchIds);
        lastProductId = batchIds[batchIds.length - 1];
        productsSynced += batchIds.length;
      }

      // 2. Rebuild customers in bounded batches
      let lastCustomerId = 0;
      while (true) {
        const res = await client.query(
          `SELECT id FROM customers WHERE id > $1 ORDER BY id ASC LIMIT $2`,
          [lastCustomerId, batchSize]
        );
        if (res.rows.length === 0) break;
        const batchIds = res.rows.map((r) => Number(r.id));
        await this.syncCustomersByIds(client, batchIds);
        lastCustomerId = batchIds[batchIds.length - 1];
        customersSynced += batchIds.length;
      }

      // 3. Discover all distinct business dates across financial/operational tables and recompute
      const datesRes = await client.query(
        `
        SELECT DISTINCT TO_CHAR(d, 'YYYY-MM-DD') AS business_date
        FROM (
          SELECT bill_date AS d FROM normal_bills
          UNION
          SELECT invoice_date AS d FROM gst_invoices
          UNION
          SELECT expense_date AS d FROM business_expenses
          UNION
          SELECT transaction_date AS d FROM udhar_transactions
          UNION
          SELECT (received_at AT TIME ZONE $1)::date AS d FROM payments
          UNION
          SELECT (created_at AT TIME ZONE $1)::date AS d FROM customers
          UNION
          SELECT quotation_date AS d FROM quotations
          UNION
          SELECT invoice_date AS d FROM supplier_purchase_bills
          UNION
          SELECT payment_date AS d FROM supplier_payments
          UNION
          SELECT (reversed_at AT TIME ZONE $1)::date AS d FROM supplier_payment_reversals
        ) dates
        WHERE d IS NOT NULL
        ORDER BY business_date ASC
        `,
        [timeZone]
      );

      for (const r of datesRes.rows) {
        await this.syncDailyAnalyticsForDate(client, String(r.business_date));
        daysSynced += 1;
      }

      // 4. Sync recent activity and global dashboard snapshot
      await this.syncRecentActivities(client, 40);
      await this.syncDashboardSnapshot(client, null);
    } finally {
      client.release();
    }

    return { productsSynced, customersSynced, daysSynced };
  }
}

export const readModelSyncService = new ReadModelSyncService();
