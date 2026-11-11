import { PoolClient } from 'pg';
import { Decimal } from 'decimal.js';
import { appPool } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import { resolveValidatedState, validateGstin, validateGstinForState } from '../../utils/indianTax.js';
import { escapeLike, validateMoneyInput } from '../../utils/validation.js';
import {
  allocateDocumentNumber,
  SUPPLIER_PAYMENT_RECEIPT_NUMBERING_CONFIG,
} from '../billing/numbering.js';
import { storageService } from '../../services/storage.service.js';
import {
  aggregateSupplierDashboardKPIs,
  buildSupplierStatementLedger,
  computePurchaseBillTotals,
  computeSupplierAccountSummary,
  ComputedStatementEntry,
  StatementEntryInput,
  SupplierBalanceSummary,
} from './suppliers.accounting.js';
import {
  normalizeOptionalEmail,
  normalizeSupplierInvoiceNumber,
  normalizeSupplierName,
  normalizeSupplierPhone,
} from './suppliers.validation.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface SupplierRecord extends SupplierBalanceSummary {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  stateCode: string | null;
  gstin: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivity: string | null;
  purchaseBillCount: number;
  paymentCount: number;
}

export interface PurchaseBillItemInput {
  productId?: number | null;
  description: string;
  quantity: number | string;
  purchaseRate: number | string;
  updateProductBuyingPrice?: boolean;
}

export interface CreatePurchaseBillInput {
  supplierId: string;
  invoiceNumber: string;
  invoiceDate?: string;
  dueDate?: string | null;
  items: PurchaseBillItemInput[];
  discountAmount?: number | string;
  gstRate?: number | string;
  notes?: string | null;
}

export interface UpdatePurchaseBillInput {
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string | null;
  items: PurchaseBillItemInput[];
  discountAmount?: number | string;
  gstRate?: number | string;
  notes?: string | null;
  reason?: string;
}

export interface PurchaseBillItemRecord {
  id: number;
  purchaseBillId: number;
  itemIndex: number;
  productId: number | null;
  productName: string | null;
  productBarcode: string | null;
  productCurrentBuyingPrice: string | null;
  description: string;
  quantity: string;
  purchaseRate: string;
  lineTotal: string;
  updatedProductBuyingPrice: boolean;
}

export interface PurchaseBillHistoryRecord {
  id: number;
  version: number;
  action: 'created' | 'edited' | 'cancelled';
  reason: string | null;
  previousData: Record<string, unknown> | null;
  newData: Record<string, unknown>;
  createdAt: string;
}

export interface PurchaseBillSummary {
  id: number;
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  supplierGstin: string | null;
  supplierArchivedAt: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  subtotalAmount: string;
  discountAmount: string;
  taxableAmount: string;
  gstRate: string;
  gstAmount: string;
  grandTotal: string;
  allocatedAmount: string;
  remainingAmount: string;
  paymentStatus: 'paid' | 'partial' | 'unpaid' | 'cancelled';
  status: 'finalized' | 'cancelled';
  notes: string | null;
  hasAttachment: boolean;
  attachmentFilename: string | null;
  attachmentContentType: string | null;
  attachmentSizeBytes: number | null;
  version: number;
  cancelledAt: string | null;
  cancellationReason: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseBillDetail extends PurchaseBillSummary {
  supplierAddress: string | null;
  supplierState: string | null;
  supplierStateCode: string | null;
  items: PurchaseBillItemRecord[];
  allocations: Array<{
    allocationId: number;
    paymentId: number;
    receiptNumber: string;
    paymentDate: string;
    paymentMethod: string;
    transactionReference: string | null;
    allocatedAmount: string;
  }>;
  history: PurchaseBillHistoryRecord[];
}

export interface PaymentAllocationInput {
  purchaseBillId: number;
  amount: number | string;
}

export interface CreateSupplierPaymentInput {
  supplierId: string;
  paymentDate?: string;
  amount: number | string;
  paymentMethod: 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'other';
  transactionReference?: string | null;
  notes?: string | null;
  allocations?: PaymentAllocationInput[];
}

export interface SupplierPaymentAllocationRecord {
  allocationId: number;
  purchaseBillId: number;
  invoiceNumber: string;
  invoiceDate: string;
  billGrandTotal: string;
  amount: string;
}

export interface SupplierPaymentRecord {
  id: number;
  receiptNumber: string;
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  supplierGstin: string | null;
  supplierAddress: string | null;
  supplierArchivedAt: string | null;
  paymentDate: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  paymentMethod: 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'other';
  transactionReference: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  allocations: SupplierPaymentAllocationRecord[];
  supplierSummary?: SupplierBalanceSummary;
}

export interface SupplierStatementResponse {
  supplier: SupplierRecord;
  filters: {
    fromDate: string | null;
    toDate: string | null;
  };
  openingBalance: string;
  periodPurchases: string;
  periodPayments: string;
  closingBalance: string;
  entries: ComputedStatementEntry[];
}

function toFixedMoney(val: unknown): string {
  return new Decimal((val as string | number) || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function csvSafeCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const needsFormulaNeutralization =
    raw.length > 0 && /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(?:\.\d+)?$/.test(raw);
  const safe = needsFormulaNeutralization ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function rethrowConstraintError(err: unknown): never {
  const pgErr = err as { code?: string; constraint?: string };
  if (pgErr?.code === '23505') {
    const constraint = pgErr.constraint || '';
    if (constraint === 'uq_suppliers_active_normalized_name') {
      throw new AppError('An active supplier with this name already exists.', 409, 'DUPLICATE_SUPPLIER');
    }
    if (constraint === 'uq_suppliers_active_phone') {
      throw new AppError('An active supplier with this mobile number already exists.', 409, 'DUPLICATE_SUPPLIER');
    }
    if (constraint === 'uq_suppliers_active_gstin') {
      throw new AppError('An active supplier with this GSTIN already exists.', 409, 'DUPLICATE_SUPPLIER');
    }
    if (constraint === 'uq_supplier_purchase_bills_invoice') {
      throw new AppError(
        'A finalized purchase bill with this invoice number already exists for this supplier.',
        409,
        'DUPLICATE_INVOICE_NUMBER'
      );
    }
    throw new AppError('Duplicate supplier or invoice record detected.', 409, 'CONFLICT');
  }
  throw err;
}

export class SuppliersService {
  private mapSupplierRow(row: Record<string, any>): SupplierRecord {
    const summary = computeSupplierAccountSummary({
      totalPurchases: row.total_purchases || '0',
      totalPayments: row.total_payments || '0',
      allocatedPayments: row.allocated_payments || '0',
    });

    return {
      id: row.id,
      name: row.name,
      contactPerson: row.contact_person ?? null,
      phone: row.phone ?? null,
      email: row.email ?? null,
      address: row.address ?? null,
      state: row.state ?? null,
      stateCode: row.state_code ?? null,
      gstin: row.gstin ?? null,
      notes: row.notes ?? null,
      archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      lastActivity: row.last_activity ?? null,
      purchaseBillCount: parseInt(row.purchase_bill_count || '0', 10),
      paymentCount: parseInt(row.payment_count || '0', 10),
      ...summary,
    };
  }

  private async fetchSuppliersWithMetrics(
    clientOrPool: PoolClient | typeof appPool,
    whereClause = 'TRUE',
    params: unknown[] = []
  ): Promise<SupplierRecord[]> {
    const query = `
      WITH purchase_totals AS (
        SELECT
          supplier_id,
          COALESCE(SUM(grand_total), 0)::numeric AS total_purchases,
          COUNT(*)::bigint AS purchase_bill_count,
          MAX(invoice_date) AS last_purchase_date
        FROM supplier_purchase_bills
        WHERE status = 'finalized'
        GROUP BY supplier_id
      ),
      payment_totals AS (
        SELECT
          supplier_id,
          COALESCE(SUM(amount), 0)::numeric AS total_payments,
          COUNT(*)::bigint AS payment_count,
          MAX(payment_date) AS last_payment_date
        FROM supplier_payments
        GROUP BY supplier_id
      ),
      allocation_totals AS (
        SELECT
          spa.supplier_id,
          COALESCE(SUM(spa.amount), 0)::numeric AS allocated_payments
        FROM supplier_payment_allocations spa
        INNER JOIN supplier_purchase_bills spb ON spb.id = spa.purchase_bill_id
        WHERE spb.status = 'finalized'
        GROUP BY spa.supplier_id
      )
      SELECT
        s.id,
        s.name,
        s.contact_person,
        s.phone,
        s.email,
        s.address,
        s.state,
        s.state_code,
        s.gstin,
        s.notes,
        s.archived_at,
        s.created_at,
        s.updated_at,
        COALESCE(pt.total_purchases, 0) AS total_purchases,
        COALESCE(pmt.total_payments, 0) AS total_payments,
        COALESCE(alt.allocated_payments, 0) AS allocated_payments,
        COALESCE(pt.purchase_bill_count, 0) AS purchase_bill_count,
        COALESCE(pmt.payment_count, 0) AS payment_count,
        TO_CHAR(
          NULLIF(GREATEST(
            COALESCE(pt.last_purchase_date, DATE '1900-01-01'),
            COALESCE(pmt.last_payment_date, DATE '1900-01-01')
          ), DATE '1900-01-01'),
          'YYYY-MM-DD'
        ) AS last_activity
      FROM suppliers s
      LEFT JOIN purchase_totals pt ON pt.supplier_id = s.id
      LEFT JOIN payment_totals pmt ON pmt.supplier_id = s.id
      LEFT JOIN allocation_totals alt ON alt.supplier_id = s.id
      WHERE ${whereClause}
    `;

    const result = await clientOrPool.query(query, params);
    return result.rows.map((row) => this.mapSupplierRow(row));
  }

  public async getDashboard(): Promise<{
    kpis: ReturnType<typeof aggregateSupplierDashboardKPIs>;
    suppliers: SupplierRecord[];
  }> {
    const suppliers = await this.fetchSuppliersWithMetrics(appPool);

    suppliers.sort((a, b) => {
      const diff = new Decimal(b.outstandingPayable).comparedTo(new Decimal(a.outstandingPayable));
      if (diff !== 0) return diff;
      if (a.archivedAt !== b.archivedAt) return a.archivedAt ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    const kpis = aggregateSupplierDashboardKPIs(suppliers);
    return { kpis, suppliers };
  }

  public async listSuppliers(options?: {
    search?: string;
    status?: 'active' | 'archived' | 'all';
    limit?: number;
    offset?: number;
  }): Promise<{
    suppliers: SupplierRecord[];
    total: number;
    pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
  }> {
    const status = options?.status || 'active';
    const limit = Math.min(Math.max(1, options?.limit || 100), 200);
    const offset = Math.max(0, options?.offset || 0);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status === 'active') {
      conditions.push('s.archived_at IS NULL');
    } else if (status === 'archived') {
      conditions.push('s.archived_at IS NOT NULL');
    }

    if (options?.search && options.search.trim()) {
      params.push(`%${escapeLike(options.search.trim())}%`);
      const idx = params.length;
      conditions.push(
        `(s.name ILIKE $${idx} ESCAPE '\\' OR s.contact_person ILIKE $${idx} ESCAPE '\\' OR COALESCE(s.phone, '') ILIKE $${idx} ESCAPE '\\' OR COALESCE(s.gstin, '') ILIKE $${idx} ESCAPE '\\')`
      );
    }

    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';
    const allMatching = await this.fetchSuppliersWithMetrics(appPool, whereClause, params);

    allMatching.sort((a, b) => {
      if (a.archivedAt !== b.archivedAt) return a.archivedAt ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    const sliced = allMatching.slice(offset, offset + limit);
    const hasMore = offset + sliced.length < allMatching.length;

    return {
      suppliers: sliced,
      total: allMatching.length,
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + sliced.length : null,
      },
    };
  }

  public async getSupplierById(id: string): Promise<SupplierRecord> {
    const rows = await this.fetchSuppliersWithMetrics(appPool, 's.id = $1', [id]);
    if (rows.length === 0) {
      throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
    }
    return rows[0];
  }

  private async assertNoActiveDuplicateSupplier(
    client: PoolClient,
    params: {
      normalizedName: string;
      normalizedPhone: string | null;
      normalizedGstin: string | null;
      excludeId?: string;
    }
  ): Promise<void> {
    const excludeClause = params.excludeId ? 'AND id <> $4' : '';
    const queryParams: unknown[] = [
      params.normalizedName,
      params.normalizedPhone,
      params.normalizedGstin,
    ];
    if (params.excludeId) queryParams.push(params.excludeId);

    const dupCheck = await client.query(
      `SELECT id, name, phone, gstin, normalized_name, normalized_phone
       FROM suppliers
       WHERE archived_at IS NULL
         ${excludeClause}
         AND (
           normalized_name = $1
           OR ($2::text IS NOT NULL AND normalized_phone = $2)
           OR ($3::text IS NOT NULL AND UPPER(gstin) = UPPER($3))
         )`,
      queryParams
    );

    if (dupCheck.rows.length > 0) {
      const candidates = dupCheck.rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        gstin: r.gstin,
      }));
      const first = dupCheck.rows[0];
      if (first.normalized_name === params.normalizedName) {
        throw new AppError(
          `An active supplier named "${first.name}" already exists.`,
          409,
          'DUPLICATE_SUPPLIER',
          candidates
        );
      }
      if (params.normalizedPhone && first.normalized_phone === params.normalizedPhone) {
        throw new AppError(
          `Active supplier "${first.name}" already uses mobile number ${first.phone}.`,
          409,
          'DUPLICATE_SUPPLIER',
          candidates
        );
      }
      throw new AppError(
        `Active supplier "${first.name}" already uses GSTIN ${first.gstin}.`,
        409,
        'DUPLICATE_SUPPLIER',
        candidates
      );
    }
  }

  public async createSupplier(input: {
    name: string;
    contactPerson?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    state?: string | null;
    stateCode?: string | null;
    gstin?: string | null;
    notes?: string | null;
  }): Promise<SupplierRecord> {
    const cleanName = input.name.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const normalizedName = normalizeSupplierName(cleanName);
    const normalizedPhone = normalizeSupplierPhone(input.phone);
    const email = normalizeOptionalEmail(input.email);
    const resolvedState = resolveValidatedState({
      state: input.state,
      stateCode: input.stateCode,
      required: false,
      fieldLabel: 'Supplier',
    });
    const validatedGstin = resolvedState.stateCode
      ? validateGstinForState(input.gstin, resolvedState.stateCode)
      : validateGstin(input.gstin);

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      await this.assertNoActiveDuplicateSupplier(client, {
        normalizedName,
        normalizedPhone,
        normalizedGstin: validatedGstin,
      });

      const insertRes = await client.query(
        `INSERT INTO suppliers (
          name, normalized_name, contact_person, phone, normalized_phone,
          email, address, state, state_code, gstin, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id`,
        [
          cleanName,
          normalizedName,
          input.contactPerson?.trim() || null,
          normalizedPhone,
          normalizedPhone,
          email,
          input.address?.trim() || null,
          resolvedState.state,
          resolvedState.stateCode,
          validatedGstin,
          input.notes?.trim() || null,
        ]
      );

      await client.query('COMMIT');
      return this.getSupplierById(insertRes.rows[0].id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      rethrowConstraintError(err);
    } finally {
      client.release();
    }
  }

  public async updateSupplier(
    id: string,
    input: Partial<{
      name: string;
      contactPerson: string | null;
      phone: string | null;
      email: string | null;
      address: string | null;
      state: string | null;
      stateCode: string | null;
      gstin: string | null;
      notes: string | null;
    }>
  ): Promise<SupplierRecord> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        `SELECT * FROM suppliers WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (existingRes.rows.length === 0) {
        throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
      }
      const existing = existingRes.rows[0];

      const nextName =
        input.name !== undefined
          ? input.name.normalize('NFKC').trim().replace(/\s+/g, ' ')
          : existing.name;
      const normalizedName = normalizeSupplierName(nextName);

      const nextPhone =
        input.phone !== undefined ? normalizeSupplierPhone(input.phone) : existing.phone;

      const nextEmail =
        input.email !== undefined ? normalizeOptionalEmail(input.email) : existing.email;

      const stateProvided = input.state !== undefined || input.stateCode !== undefined;
      const resolvedState = stateProvided
        ? resolveValidatedState({
            state: input.state !== undefined ? input.state : existing.state,
            stateCode: input.stateCode !== undefined ? input.stateCode : existing.state_code,
            required: false,
            fieldLabel: 'Supplier',
          })
        : { state: existing.state, stateCode: existing.state_code };

      const rawGstin = input.gstin !== undefined ? input.gstin : existing.gstin;
      const nextGstin = resolvedState.stateCode
        ? validateGstinForState(rawGstin, resolvedState.stateCode)
        : validateGstin(rawGstin);

      if (!existing.archived_at) {
        await this.assertNoActiveDuplicateSupplier(client, {
          normalizedName,
          normalizedPhone: nextPhone,
          normalizedGstin: nextGstin,
          excludeId: id,
        });
      }

      await client.query(
        `UPDATE suppliers
         SET
           name = $1,
           normalized_name = $2,
           contact_person = $3,
           phone = $4,
           normalized_phone = $5,
           email = $6,
           address = $7,
           state = $8,
           state_code = $9,
           gstin = $10,
           notes = $11,
           updated_at = NOW()
         WHERE id = $12`,
        [
          nextName,
          normalizedName,
          input.contactPerson !== undefined ? input.contactPerson?.trim() || null : existing.contact_person,
          nextPhone,
          nextPhone,
          nextEmail,
          input.address !== undefined ? input.address?.trim() || null : existing.address,
          resolvedState.state,
          resolvedState.stateCode,
          nextGstin,
          input.notes !== undefined ? input.notes?.trim() || null : existing.notes,
          id,
        ]
      );

      await client.query('COMMIT');
      return this.getSupplierById(id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      rethrowConstraintError(err);
    } finally {
      client.release();
    }
  }

  public async archiveSupplier(id: string): Promise<SupplierRecord> {
    const res = await appPool.query(
      `UPDATE suppliers
       SET archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND archived_at IS NULL
       RETURNING id`,
      [id]
    );
    if (res.rowCount === 0) {
      const exists = await appPool.query('SELECT archived_at FROM suppliers WHERE id = $1', [id]);
      if (exists.rows.length === 0) {
        throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
      }
      throw new AppError('Supplier is already archived.', 409, 'ALREADY_ARCHIVED');
    }
    return this.getSupplierById(id);
  }

  public async restoreSupplier(id: string): Promise<SupplierRecord> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      const existingRes = await client.query(
        'SELECT id, name, normalized_name, normalized_phone, gstin, archived_at FROM suppliers WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (existingRes.rows.length === 0) {
        throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
      }
      const existing = existingRes.rows[0];
      if (!existing.archived_at) {
        throw new AppError('Supplier is already active.', 409, 'ALREADY_ACTIVE');
      }

      await this.assertNoActiveDuplicateSupplier(client, {
        normalizedName: existing.normalized_name,
        normalizedPhone: existing.normalized_phone,
        normalizedGstin: existing.gstin,
        excludeId: id,
      });

      await client.query(
        `UPDATE suppliers SET archived_at = NULL, updated_at = NOW() WHERE id = $1`,
        [id]
      );

      await client.query('COMMIT');
      return this.getSupplierById(id);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      rethrowConstraintError(err);
    } finally {
      client.release();
    }
  }

  public async deleteSupplier(id: string): Promise<void> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [id]);
      if (exists.rows.length === 0) {
        throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
      }

      const historyRes = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM supplier_purchase_bills WHERE supplier_id = $1)::bigint AS bills,
           (SELECT COUNT(*) FROM supplier_payments WHERE supplier_id = $1)::bigint AS payments`,
        [id]
      );
      const bills = parseInt(historyRes.rows[0].bills || '0', 10);
      const payments = parseInt(historyRes.rows[0].payments || '0', 10);

      if (bills > 0 || payments > 0) {
        throw new AppError(
          'Suppliers with purchase bills or payment records cannot be permanently deleted. Archive the supplier instead.',
          409,
          'SUPPLIER_HAS_FINANCIAL_HISTORY'
        );
      }

      await client.query('DELETE FROM suppliers WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async validatePurchaseBillProducts(
    client: PoolClient,
    items: PurchaseBillItemInput[],
    previouslyLinkedIds: Set<number> = new Set()
  ): Promise<Map<number, { id: number; name: string; buyingPrice: string }>> {
    const productIds = Array.from(
      new Set(items.map((item) => item.productId).filter((id): id is number => Boolean(id)))
    );
    const map = new Map<number, { id: number; name: string; buyingPrice: string }>();

    if (productIds.length === 0) return map;

    const prodRes = await client.query(
      `SELECT id, name, buying_price, archived_at FROM products WHERE id = ANY($1::bigint[])`,
      [productIds]
    );
    for (const row of prodRes.rows) {
      if (row.archived_at && !previouslyLinkedIds.has(Number(row.id))) {
        throw new AppError(
          `Product "${row.name}" is archived and cannot be added to a new purchase bill.`,
          400,
          'ARCHIVED_PRODUCT'
        );
      }
      map.set(Number(row.id), {
        id: Number(row.id),
        name: row.name,
        buyingPrice: toFixedMoney(row.buying_price),
      });
    }

    for (const pid of productIds) {
      if (!map.has(pid)) {
        throw new AppError(`Linked product ID ${pid} was not found.`, 404, 'PRODUCT_NOT_FOUND');
      }
    }

    return map;
  }

  private mapPurchaseBillSummary(row: Record<string, any>): PurchaseBillSummary {
    const grandTotal = new Decimal(row.grand_total || 0);
    const allocatedAmount = new Decimal(row.allocated_amount || 0);
    const remainingAmount = Decimal.max(grandTotal.minus(allocatedAmount), new Decimal(0));
    const status = row.status as 'finalized' | 'cancelled';

    let paymentStatus: 'paid' | 'partial' | 'unpaid' | 'cancelled' = 'unpaid';
    if (status === 'cancelled') {
      paymentStatus = 'cancelled';
    } else if (remainingAmount.isZero() && grandTotal.greaterThanOrEqualTo(0)) {
      paymentStatus = grandTotal.isZero() ? 'paid' : allocatedAmount.greaterThanOrEqualTo(grandTotal) ? 'paid' : 'unpaid';
    } else if (allocatedAmount.greaterThan(0)) {
      paymentStatus = 'partial';
    }

    return {
      id: Number(row.id),
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      supplierPhone: row.supplier_phone ?? null,
      supplierGstin: row.supplier_gstin ?? null,
      supplierArchivedAt: row.supplier_archived_at ? new Date(row.supplier_archived_at).toISOString() : null,
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      dueDate: row.due_date ?? null,
      subtotalAmount: toFixedMoney(row.subtotal_amount),
      discountAmount: toFixedMoney(row.discount_amount),
      taxableAmount: toFixedMoney(row.taxable_amount),
      gstRate: toFixedMoney(row.gst_rate),
      gstAmount: toFixedMoney(row.gst_amount),
      grandTotal: toFixedMoney(grandTotal),
      allocatedAmount: toFixedMoney(allocatedAmount),
      remainingAmount: status === 'cancelled' ? '0.00' : toFixedMoney(remainingAmount),
      paymentStatus,
      status,
      notes: row.notes ?? null,
      hasAttachment: Boolean(row.attachment_object_key),
      attachmentFilename: row.attachment_filename ?? null,
      attachmentContentType: row.attachment_content_type ?? null,
      attachmentSizeBytes: row.attachment_size_bytes !== null && row.attachment_size_bytes !== undefined
        ? Number(row.attachment_size_bytes)
        : null,
      version: Number(row.version),
      cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
      cancellationReason: row.cancellation_reason ?? null,
      itemCount: parseInt(row.item_count || '0', 10),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  public async listPurchaseBills(options?: {
    supplierId?: string;
    status?: 'finalized' | 'cancelled' | 'all';
    search?: string;
    fromDate?: string;
    toDate?: string;
    openOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{
    purchaseBills: PurchaseBillSummary[];
    total: number;
    pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
  }> {
    const limit = Math.min(Math.max(1, options?.limit || 100), 200);
    const offset = Math.max(0, options?.offset || 0);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.supplierId) {
      params.push(options.supplierId);
      conditions.push(`spb.supplier_id = $${params.length}`);
    }
    if (options?.status && options.status !== 'all') {
      params.push(options.status);
      conditions.push(`spb.status = $${params.length}`);
    }
    if (options?.fromDate) {
      params.push(options.fromDate);
      conditions.push(`spb.invoice_date >= $${params.length}::date`);
    }
    if (options?.toDate) {
      params.push(options.toDate);
      conditions.push(`spb.invoice_date <= $${params.length}::date`);
    }
    if (options?.search && options.search.trim()) {
      params.push(`%${escapeLike(options.search.trim())}%`);
      const idx = params.length;
      conditions.push(
        `(spb.invoice_number ILIKE $${idx} ESCAPE '\\' OR s.name ILIKE $${idx} ESCAPE '\\')`
      );
    }
    if (options?.openOnly) {
      conditions.push(`spb.status = 'finalized'`);
      conditions.push(`(spb.grand_total - COALESCE(alloc.allocated_amount, 0)) > 0`);
    }

    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';

    const query = `
      WITH alloc AS (
        SELECT purchase_bill_id, COALESCE(SUM(amount), 0)::numeric AS allocated_amount
        FROM supplier_payment_allocations
        GROUP BY purchase_bill_id
      ),
      item_counts AS (
        SELECT purchase_bill_id, COUNT(*)::bigint AS item_count
        FROM supplier_purchase_bill_items
        GROUP BY purchase_bill_id
      )
      SELECT
        spb.id,
        spb.supplier_id,
        s.name AS supplier_name,
        s.phone AS supplier_phone,
        s.gstin AS supplier_gstin,
        s.archived_at AS supplier_archived_at,
        spb.invoice_number,
        TO_CHAR(spb.invoice_date, 'YYYY-MM-DD') AS invoice_date,
        TO_CHAR(spb.due_date, 'YYYY-MM-DD') AS due_date,
        spb.subtotal_amount,
        spb.discount_amount,
        spb.taxable_amount,
        spb.gst_rate,
        spb.gst_amount,
        spb.grand_total,
        COALESCE(alloc.allocated_amount, 0) AS allocated_amount,
        spb.status,
        spb.notes,
        spb.attachment_object_key,
        spb.attachment_filename,
        spb.attachment_content_type,
        spb.attachment_size_bytes,
        spb.version,
        spb.cancelled_at,
        spb.cancellation_reason,
        COALESCE(ic.item_count, 0) AS item_count,
        spb.created_at,
        spb.updated_at,
        COUNT(*) OVER()::bigint AS full_count
      FROM supplier_purchase_bills spb
      INNER JOIN suppliers s ON s.id = spb.supplier_id
      LEFT JOIN alloc ON alloc.purchase_bill_id = spb.id
      LEFT JOIN item_counts ic ON ic.purchase_bill_id = spb.id
      WHERE ${whereClause}
      ORDER BY spb.invoice_date DESC, spb.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const res = await appPool.query(query, [...params, limit, offset]);
    const total = res.rows.length > 0 ? parseInt(res.rows[0].full_count, 10) : 0;
    const purchaseBills = res.rows.map((r) => this.mapPurchaseBillSummary(r));
    const hasMore = offset + purchaseBills.length < total;

    return {
      purchaseBills,
      total,
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + purchaseBills.length : null,
      },
    };
  }

  public async getPurchaseBillById(billId: number): Promise<PurchaseBillDetail> {
    const billRes = await appPool.query(
      `WITH alloc AS (
        SELECT purchase_bill_id, COALESCE(SUM(amount), 0)::numeric AS allocated_amount
        FROM supplier_payment_allocations
        WHERE purchase_bill_id = $1
        GROUP BY purchase_bill_id
      ),
      item_counts AS (
        SELECT purchase_bill_id, COUNT(*)::bigint AS item_count
        FROM supplier_purchase_bill_items
        WHERE purchase_bill_id = $1
        GROUP BY purchase_bill_id
      )
      SELECT
        spb.*,
        TO_CHAR(spb.invoice_date, 'YYYY-MM-DD') AS invoice_date_iso,
        TO_CHAR(spb.due_date, 'YYYY-MM-DD') AS due_date_iso,
        s.name AS supplier_name,
        s.phone AS supplier_phone,
        s.gstin AS supplier_gstin,
        s.address AS supplier_address,
        s.state AS supplier_state,
        s.state_code AS supplier_state_code,
        s.archived_at AS supplier_archived_at,
        COALESCE(alloc.allocated_amount, 0) AS allocated_amount,
        COALESCE(ic.item_count, 0) AS item_count
      FROM supplier_purchase_bills spb
      INNER JOIN suppliers s ON s.id = spb.supplier_id
      LEFT JOIN alloc ON alloc.purchase_bill_id = spb.id
      LEFT JOIN item_counts ic ON ic.purchase_bill_id = spb.id
      WHERE spb.id = $1`,
      [billId]
    );

    if (billRes.rows.length === 0) {
      throw new AppError('Purchase bill not found.', 404, 'PURCHASE_BILL_NOT_FOUND');
    }

    const billRow = billRes.rows[0];
    const summary = this.mapPurchaseBillSummary({
      ...billRow,
      invoice_date: billRow.invoice_date_iso,
      due_date: billRow.due_date_iso,
    });

    const [itemsRes, allocRes, historyRes] = await Promise.all([
      appPool.query(
        `SELECT
          i.*,
          p.name AS product_name,
          p.barcode AS product_barcode,
          p.buying_price AS product_current_buying_price
        FROM supplier_purchase_bill_items i
        LEFT JOIN products p ON p.id = i.product_id
        WHERE i.purchase_bill_id = $1
        ORDER BY i.item_index ASC, i.id ASC`,
        [billId]
      ),
      appPool.query(
        `SELECT
          spa.id AS allocation_id,
          spa.payment_id,
          spa.amount AS allocated_amount,
          sp.receipt_number,
          TO_CHAR(sp.payment_date, 'YYYY-MM-DD') AS payment_date,
          sp.payment_method,
          sp.transaction_reference
        FROM supplier_payment_allocations spa
        INNER JOIN supplier_payments sp ON sp.id = spa.payment_id
        WHERE spa.purchase_bill_id = $1
        ORDER BY sp.payment_date DESC, spa.id DESC`,
        [billId]
      ),
      appPool.query(
        `SELECT id, version, action, reason, previous_data, new_data, created_at
         FROM supplier_purchase_bill_history
         WHERE purchase_bill_id = $1
         ORDER BY version DESC, id DESC`,
        [billId]
      ),
    ]);

    return {
      ...summary,
      supplierAddress: billRow.supplier_address ?? null,
      supplierState: billRow.supplier_state ?? null,
      supplierStateCode: billRow.supplier_state_code ?? null,
      items: itemsRes.rows.map((r) => ({
        id: Number(r.id),
        purchaseBillId: Number(r.purchase_bill_id),
        itemIndex: Number(r.item_index),
        productId: r.product_id !== null ? Number(r.product_id) : null,
        productName: r.product_name ?? null,
        productBarcode: r.product_barcode ?? null,
        productCurrentBuyingPrice:
          r.product_current_buying_price !== null ? toFixedMoney(r.product_current_buying_price) : null,
        description: r.description,
        quantity: new Decimal(r.quantity).toFixed(2),
        purchaseRate: toFixedMoney(r.purchase_rate),
        lineTotal: toFixedMoney(r.line_total),
        updatedProductBuyingPrice: Boolean(r.updated_product_buying_price),
      })),
      allocations: allocRes.rows.map((a) => ({
        allocationId: Number(a.allocation_id),
        paymentId: Number(a.payment_id),
        receiptNumber: a.receipt_number,
        paymentDate: a.payment_date,
        paymentMethod: a.payment_method,
        transactionReference: a.transaction_reference ?? null,
        allocatedAmount: toFixedMoney(a.allocated_amount),
      })),
      history: historyRes.rows.map((h) => ({
        id: Number(h.id),
        version: Number(h.version),
        action: h.action,
        reason: h.reason ?? null,
        previousData: h.previous_data ?? null,
        newData: h.new_data,
        createdAt: new Date(h.created_at).toISOString(),
      })),
    };
  }

  public async getPurchaseBillAttachmentMeta(billId: number): Promise<{
    id: number;
    invoiceNumber: string;
    attachmentObjectKey: string | null;
    attachmentFilename: string | null;
    attachmentContentType: string | null;
  }> {
    const res = await appPool.query(
      `SELECT id, invoice_number, attachment_object_key, attachment_filename, attachment_content_type
       FROM supplier_purchase_bills WHERE id = $1`,
      [billId]
    );
    if (res.rows.length === 0) {
      throw new AppError('Purchase bill not found.', 404, 'PURCHASE_BILL_NOT_FOUND');
    }
    const r = res.rows[0];
    return {
      id: Number(r.id),
      invoiceNumber: r.invoice_number,
      attachmentObjectKey: r.attachment_object_key ?? null,
      attachmentFilename: r.attachment_filename ?? null,
      attachmentContentType: r.attachment_content_type ?? null,
    };
  }

  public async createPurchaseBill(input: CreatePurchaseBillInput): Promise<PurchaseBillDetail> {
    const invoiceDate = input.invoiceDate || getBusinessDateISO();
    const dueDate = input.dueDate || null;
    if (dueDate && dueDate < invoiceDate) {
      throw new AppError('Due date cannot be earlier than invoice date.', 400, 'INVALID_DATE_RANGE');
    }

    const cleanInvoiceNo = input.invoiceNumber.trim();
    const normalizedInvoiceNo = normalizeSupplierInvoiceNumber(cleanInvoiceNo);
    const totals = computePurchaseBillTotals(input.items, input.discountAmount || 0, input.gstRate || 0);

    if (new Decimal(totals.discountAmount).greaterThan(new Decimal(totals.subtotalAmount))) {
      throw new AppError('Discount amount cannot exceed subtotal amount.', 400, 'INVALID_DISCOUNT');
    }

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      const supplierRes = await client.query(
        'SELECT id, name, archived_at FROM suppliers WHERE id = $1 FOR UPDATE',
        [input.supplierId]
      );
      if (supplierRes.rows.length === 0) {
        throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
      }
      if (supplierRes.rows[0].archived_at) {
        throw new AppError(
          'Cannot create a purchase bill for an archived supplier. Restore the supplier first.',
          409,
          'SUPPLIER_ARCHIVED'
        );
      }

      const dupInvoiceRes = await client.query(
        `SELECT id FROM supplier_purchase_bills
         WHERE supplier_id = $1 AND normalized_invoice_number = $2 AND status <> 'cancelled'`,
        [input.supplierId, normalizedInvoiceNo]
      );
      if (dupInvoiceRes.rows.length > 0) {
        throw new AppError(
          `Invoice number "${cleanInvoiceNo}" already exists for this supplier.`,
          409,
          'DUPLICATE_INVOICE_NUMBER'
        );
      }

      await this.validatePurchaseBillProducts(client, input.items);

      const billInsertRes = await client.query(
        `INSERT INTO supplier_purchase_bills (
          supplier_id, invoice_number, normalized_invoice_number, invoice_date, due_date,
          subtotal_amount, discount_amount, taxable_amount, gst_rate, gst_amount, grand_total,
          status, notes, version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'finalized', $12, 1)
        RETURNING id`,
        [
          input.supplierId,
          cleanInvoiceNo,
          normalizedInvoiceNo,
          invoiceDate,
          dueDate,
          totals.subtotalAmount,
          totals.discountAmount,
          totals.taxableAmount,
          totals.gstRate,
          totals.gstAmount,
          totals.grandTotal,
          input.notes?.trim() || null,
        ]
      );

      const billId = Number(billInsertRes.rows[0].id);

      const snapshotItems: Array<Record<string, unknown>> = [];
      for (let i = 0; i < input.items.length; i += 1) {
        const rawItem = input.items[i];
        const calcItem = totals.items[i];
        const productId = rawItem.productId ?? null;
        const optInUpdateBuyingPrice = Boolean(productId && rawItem.updateProductBuyingPrice === true);

        await client.query(
          `INSERT INTO supplier_purchase_bill_items (
            purchase_bill_id, item_index, product_id, description,
            quantity, purchase_rate, line_total, updated_product_buying_price
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            billId,
            i,
            productId,
            rawItem.description.trim(),
            calcItem.quantity,
            calcItem.purchaseRate,
            calcItem.lineTotal,
            optInUpdateBuyingPrice,
          ]
        );

        if (optInUpdateBuyingPrice && productId) {
          await client.query(
            `UPDATE products SET buying_price = $1, updated_at = NOW() WHERE id = $2`,
            [calcItem.purchaseRate, productId]
          );
        }

        snapshotItems.push({
          itemIndex: i,
          productId,
          description: rawItem.description.trim(),
          quantity: calcItem.quantity,
          purchaseRate: calcItem.purchaseRate,
          lineTotal: calcItem.lineTotal,
          updatedProductBuyingPrice: optInUpdateBuyingPrice,
        });
      }

      await client.query(
        `INSERT INTO supplier_purchase_bill_history (
          purchase_bill_id, version, action, reason, previous_data, new_data
        ) VALUES ($1, 1, 'created', $2, NULL, $3::jsonb)`,
        [
          billId,
          'Initial purchase bill recorded',
          JSON.stringify({
            invoiceNumber: cleanInvoiceNo,
            invoiceDate,
            dueDate,
            subtotalAmount: totals.subtotalAmount,
            discountAmount: totals.discountAmount,
            taxableAmount: totals.taxableAmount,
            gstRate: totals.gstRate,
            gstAmount: totals.gstAmount,
            grandTotal: totals.grandTotal,
            notes: input.notes?.trim() || null,
            items: snapshotItems,
          }),
        ]
      );

      await client.query('COMMIT');
      return this.getPurchaseBillById(billId);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      rethrowConstraintError(err);
    } finally {
      client.release();
    }
  }

  public async updatePurchaseBill(
    billId: number,
    input: UpdatePurchaseBillInput
  ): Promise<PurchaseBillDetail> {
    if (input.dueDate && input.dueDate < input.invoiceDate) {
      throw new AppError('Due date cannot be earlier than invoice date.', 400, 'INVALID_DATE_RANGE');
    }

    const cleanInvoiceNo = input.invoiceNumber.trim();
    const normalizedInvoiceNo = normalizeSupplierInvoiceNumber(cleanInvoiceNo);
    const totals = computePurchaseBillTotals(input.items, input.discountAmount || 0, input.gstRate || 0);

    if (new Decimal(totals.discountAmount).greaterThan(new Decimal(totals.subtotalAmount))) {
      throw new AppError('Discount amount cannot exceed subtotal amount.', 400, 'INVALID_DISCOUNT');
    }

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        `SELECT *, TO_CHAR(invoice_date, 'YYYY-MM-DD') AS invoice_date_iso, TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date_iso
         FROM supplier_purchase_bills WHERE id = $1 FOR UPDATE`,
        [billId]
      );
      if (existingRes.rows.length === 0) {
        throw new AppError('Purchase bill not found.', 404, 'PURCHASE_BILL_NOT_FOUND');
      }
      const existing = existingRes.rows[0];
      if (existing.status === 'cancelled') {
        throw new AppError('Cancelled purchase bills cannot be edited.', 409, 'BILL_CANCELLED');
      }

      const prevItemsRes = await client.query(
        `SELECT * FROM supplier_purchase_bill_items WHERE purchase_bill_id = $1 ORDER BY item_index ASC`,
        [billId]
      );
      const previouslyLinkedIds = new Set<number>(
        prevItemsRes.rows.map((r) => Number(r.product_id)).filter((n) => !Number.isNaN(n) && n > 0)
      );

      const dupInvoiceRes = await client.query(
        `SELECT id FROM supplier_purchase_bills
         WHERE supplier_id = $1 AND normalized_invoice_number = $2 AND status <> 'cancelled' AND id <> $3`,
        [existing.supplier_id, normalizedInvoiceNo, billId]
      );
      if (dupInvoiceRes.rows.length > 0) {
        throw new AppError(
          `Invoice number "${cleanInvoiceNo}" already exists for this supplier.`,
          409,
          'DUPLICATE_INVOICE_NUMBER'
        );
      }

      const allocRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS allocated_amount
         FROM supplier_payment_allocations WHERE purchase_bill_id = $1`,
        [billId]
      );
      const alreadyAllocated = new Decimal(allocRes.rows[0].allocated_amount || 0);
      if (new Decimal(totals.grandTotal).lessThan(alreadyAllocated)) {
        throw new AppError(
          `Updated grand total (${totals.grandTotal}) cannot be less than payments already allocated to this bill (${alreadyAllocated.toFixed(2)}).`,
          409,
          'ALLOCATION_CONFLICT'
        );
      }

      await this.validatePurchaseBillProducts(client, input.items, previouslyLinkedIds);

      const previousSnapshot = {
        invoiceNumber: existing.invoice_number,
        invoiceDate: existing.invoice_date_iso,
        dueDate: existing.due_date_iso ?? null,
        subtotalAmount: toFixedMoney(existing.subtotal_amount),
        discountAmount: toFixedMoney(existing.discount_amount),
        taxableAmount: toFixedMoney(existing.taxable_amount),
        gstRate: toFixedMoney(existing.gst_rate),
        gstAmount: toFixedMoney(existing.gst_amount),
        grandTotal: toFixedMoney(existing.grand_total),
        notes: existing.notes ?? null,
        items: prevItemsRes.rows.map((r) => ({
          itemIndex: Number(r.item_index),
          productId: r.product_id !== null ? Number(r.product_id) : null,
          description: r.description,
          quantity: new Decimal(r.quantity).toFixed(2),
          purchaseRate: toFixedMoney(r.purchase_rate),
          lineTotal: toFixedMoney(r.line_total),
          updatedProductBuyingPrice: Boolean(r.updated_product_buying_price),
        })),
      };

      const nextVersion = Number(existing.version) + 1;

      await client.query(
        `UPDATE supplier_purchase_bills
         SET
           invoice_number = $1,
           normalized_invoice_number = $2,
           invoice_date = $3,
           due_date = $4,
           subtotal_amount = $5,
           discount_amount = $6,
           taxable_amount = $7,
           gst_rate = $8,
           gst_amount = $9,
           grand_total = $10,
           notes = $11,
           version = $12,
           updated_at = NOW()
         WHERE id = $13`,
        [
          cleanInvoiceNo,
          normalizedInvoiceNo,
          input.invoiceDate,
          input.dueDate ?? null,
          totals.subtotalAmount,
          totals.discountAmount,
          totals.taxableAmount,
          totals.gstRate,
          totals.gstAmount,
          totals.grandTotal,
          input.notes?.trim() || null,
          nextVersion,
          billId,
        ]
      );

      await client.query('DELETE FROM supplier_purchase_bill_items WHERE purchase_bill_id = $1', [billId]);

      const nextSnapshotItems: Array<Record<string, unknown>> = [];
      for (let i = 0; i < input.items.length; i += 1) {
        const rawItem = input.items[i];
        const calcItem = totals.items[i];
        const productId = rawItem.productId ?? null;
        const optInUpdateBuyingPrice = Boolean(productId && rawItem.updateProductBuyingPrice === true);

        await client.query(
          `INSERT INTO supplier_purchase_bill_items (
            purchase_bill_id, item_index, product_id, description,
            quantity, purchase_rate, line_total, updated_product_buying_price
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            billId,
            i,
            productId,
            rawItem.description.trim(),
            calcItem.quantity,
            calcItem.purchaseRate,
            calcItem.lineTotal,
            optInUpdateBuyingPrice,
          ]
        );

        if (optInUpdateBuyingPrice && productId) {
          await client.query(
            `UPDATE products SET buying_price = $1, updated_at = NOW() WHERE id = $2`,
            [calcItem.purchaseRate, productId]
          );
        }

        nextSnapshotItems.push({
          itemIndex: i,
          productId,
          description: rawItem.description.trim(),
          quantity: calcItem.quantity,
          purchaseRate: calcItem.purchaseRate,
          lineTotal: calcItem.lineTotal,
          updatedProductBuyingPrice: optInUpdateBuyingPrice,
        });
      }

      await client.query(
        `INSERT INTO supplier_purchase_bill_history (
          purchase_bill_id, version, action, reason, previous_data, new_data
        ) VALUES ($1, $2, 'edited', $3, $4::jsonb, $5::jsonb)`,
        [
          billId,
          nextVersion,
          input.reason?.trim() || 'Purchase bill updated',
          JSON.stringify(previousSnapshot),
          JSON.stringify({
            invoiceNumber: cleanInvoiceNo,
            invoiceDate: input.invoiceDate,
            dueDate: input.dueDate ?? null,
            subtotalAmount: totals.subtotalAmount,
            discountAmount: totals.discountAmount,
            taxableAmount: totals.taxableAmount,
            gstRate: totals.gstRate,
            gstAmount: totals.gstAmount,
            grandTotal: totals.grandTotal,
            notes: input.notes?.trim() || null,
            items: nextSnapshotItems,
          }),
        ]
      );

      await client.query('COMMIT');
      return this.getPurchaseBillById(billId);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      rethrowConstraintError(err);
    } finally {
      client.release();
    }
  }

  public async cancelPurchaseBill(billId: number, reason: string): Promise<PurchaseBillDetail> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      const existingRes = await client.query(
        'SELECT * FROM supplier_purchase_bills WHERE id = $1 FOR UPDATE',
        [billId]
      );
      if (existingRes.rows.length === 0) {
        throw new AppError('Purchase bill not found.', 404, 'PURCHASE_BILL_NOT_FOUND');
      }
      const existing = existingRes.rows[0];
      if (existing.status === 'cancelled') {
        throw new AppError('Purchase bill is already cancelled.', 409, 'BILL_ALREADY_CANCELLED');
      }

      const allocRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS allocated_amount
         FROM supplier_payment_allocations WHERE purchase_bill_id = $1`,
        [billId]
      );
      if (new Decimal(allocRes.rows[0].allocated_amount || 0).greaterThan(0)) {
        throw new AppError(
          'Cannot cancel a purchase bill that already has payments allocated against it.',
          409,
          'BILL_HAS_ALLOCATIONS'
        );
      }

      const nextVersion = Number(existing.version) + 1;
      const trimmedReason = reason.trim();

      await client.query(
        `UPDATE supplier_purchase_bills
         SET
           status = 'cancelled',
           cancelled_at = NOW(),
           cancellation_reason = $1,
           version = $2,
           updated_at = NOW()
         WHERE id = $3`,
        [trimmedReason, nextVersion, billId]
      );

      await client.query(
        `INSERT INTO supplier_purchase_bill_history (
          purchase_bill_id, version, action, reason, previous_data, new_data
        ) VALUES ($1, $2, 'cancelled', $3, $4::jsonb, $5::jsonb)`,
        [
          billId,
          nextVersion,
          trimmedReason,
          JSON.stringify({ status: 'finalized', version: Number(existing.version) }),
          JSON.stringify({ status: 'cancelled', cancellationReason: trimmedReason }),
        ]
      );

      await client.query('COMMIT');
      return this.getPurchaseBillById(billId);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  public async setPurchaseBillAttachment(
    billId: number,
    attachment: {
      objectKey: string;
      contentType: string;
      sizeBytes: number;
      filename: string;
    }
  ): Promise<PurchaseBillDetail> {
    const client = await appPool.connect();
    let previousKey: string | null = null;
    try {
      await client.query('BEGIN');
      const res = await client.query(
        'SELECT attachment_object_key FROM supplier_purchase_bills WHERE id = $1 FOR UPDATE',
        [billId]
      );
      if (res.rows.length === 0) {
        throw new AppError('Purchase bill not found.', 404, 'PURCHASE_BILL_NOT_FOUND');
      }
      previousKey = res.rows[0].attachment_object_key ?? null;

      await client.query(
        `UPDATE supplier_purchase_bills
         SET
           attachment_object_key = $1,
           attachment_content_type = $2,
           attachment_size_bytes = $3,
           attachment_filename = $4,
           updated_at = NOW()
         WHERE id = $5`,
        [
          attachment.objectKey,
          attachment.contentType,
          attachment.sizeBytes,
          attachment.filename.slice(0, 255),
          billId,
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (previousKey && previousKey !== attachment.objectKey) {
      await storageService.deleteObject(previousKey);
    }

    return this.getPurchaseBillById(billId);
  }

  public async removePurchaseBillAttachment(billId: number): Promise<PurchaseBillDetail> {
    const existingRes = await appPool.query(
      `SELECT attachment_object_key FROM supplier_purchase_bills WHERE id = $1`,
      [billId]
    );
    if (existingRes.rows.length === 0) {
      throw new AppError('Purchase bill not found.', 404, 'PURCHASE_BILL_NOT_FOUND');
    }
    const previousKey: string | null = existingRes.rows[0].attachment_object_key ?? null;

    await appPool.query(
      `UPDATE supplier_purchase_bills
       SET
         attachment_object_key = NULL,
         attachment_content_type = NULL,
         attachment_size_bytes = NULL,
         attachment_filename = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [billId]
    );

    if (previousKey) {
      await storageService.deleteObject(previousKey);
    }
    return this.getPurchaseBillById(billId);
  }

  private async applyBillAllocationsInTx(
    client: PoolClient,
    options: {
      paymentId: number;
      supplierId: string;
      availableAmount: Decimal;
      allocations: PaymentAllocationInput[];
      allowTopUp?: boolean;
    }
  ): Promise<void> {
    const { paymentId, supplierId, availableAmount, allocations, allowTopUp = false } = options;
    if (!allocations || allocations.length === 0) return;

    const seenBillIds = new Set<number>();
    const normalizedAllocs = allocations.map((a) => {
      const billId = Number(a.purchaseBillId);
      if (seenBillIds.has(billId)) {
        throw new AppError(
          `Duplicate allocation for purchase bill ID ${billId}. Combine amounts onto a single line.`,
          400,
          'DUPLICATE_BILL_ALLOCATION'
        );
      }
      seenBillIds.add(billId);
      const amount = validateMoneyInput(a.amount, 'Allocation amount', { allowZero: false });
      return { purchaseBillId: billId, amount };
    });

    const totalRequested = normalizedAllocs.reduce(
      (sum, item) => sum.plus(item.amount),
      new Decimal(0)
    );
    if (totalRequested.greaterThan(availableAmount)) {
      throw new AppError(
        `Total allocated amount (${totalRequested.toFixed(2)}) exceeds available payment balance (${availableAmount.toFixed(2)}).`,
        400,
        'OVER_ALLOCATION'
      );
    }

    // Lock bills in deterministic ascending order to eliminate deadlocks
    normalizedAllocs.sort((a, b) => a.purchaseBillId - b.purchaseBillId);

    for (const alloc of normalizedAllocs) {
      const billRes = await client.query(
        `SELECT id, supplier_id, invoice_number, grand_total, status
         FROM supplier_purchase_bills
         WHERE id = $1
         FOR UPDATE`,
        [alloc.purchaseBillId]
      );
      if (billRes.rows.length === 0) {
        throw new AppError(
          `Purchase bill ID ${alloc.purchaseBillId} not found.`,
          404,
          'PURCHASE_BILL_NOT_FOUND'
        );
      }
      const bill = billRes.rows[0];
      if (bill.supplier_id !== supplierId) {
        throw new AppError(
          `Purchase bill "${bill.invoice_number}" belongs to a different supplier and cannot be allocated from this payment.`,
          409,
          'CROSS_SUPPLIER_ALLOCATION'
        );
      }
      if (bill.status !== 'finalized') {
        throw new AppError(
          `Purchase bill "${bill.invoice_number}" is cancelled and cannot receive payment allocations.`,
          409,
          'BILL_CANCELLED'
        );
      }

      const existingAllocRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS allocated_amount
         FROM supplier_payment_allocations
         WHERE purchase_bill_id = $1`,
        [alloc.purchaseBillId]
      );
      const billAllocated = new Decimal(existingAllocRes.rows[0].allocated_amount || 0);
      const billTotal = new Decimal(bill.grand_total || 0);
      const billRemaining = Decimal.max(billTotal.minus(billAllocated), new Decimal(0));

      if (alloc.amount.greaterThan(billRemaining)) {
        throw new AppError(
          `Allocation (${alloc.amount.toFixed(2)}) for bill "${bill.invoice_number}" exceeds remaining due (${billRemaining.toFixed(2)}).`,
          409,
          'BILL_OVER_ALLOCATION'
        );
      }

      if (allowTopUp) {
        await client.query(
          `INSERT INTO supplier_payment_allocations (payment_id, purchase_bill_id, supplier_id, amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (payment_id, purchase_bill_id)
           DO UPDATE SET amount = supplier_payment_allocations.amount + EXCLUDED.amount`,
          [paymentId, alloc.purchaseBillId, supplierId, alloc.amount.toFixed(2)]
        );
      } else {
        await client.query(
          `INSERT INTO supplier_payment_allocations (payment_id, purchase_bill_id, supplier_id, amount)
           VALUES ($1, $2, $3, $4)`,
          [paymentId, alloc.purchaseBillId, supplierId, alloc.amount.toFixed(2)]
        );
      }
    }
  }

  public async createSupplierPayment(input: CreateSupplierPaymentInput): Promise<SupplierPaymentRecord> {
    const paymentDate = input.paymentDate || getBusinessDateISO();
    const amount = validateMoneyInput(input.amount, 'Payment amount', { allowZero: false });

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      const supplierRes = await client.query(
        'SELECT id, archived_at FROM suppliers WHERE id = $1 FOR UPDATE',
        [input.supplierId]
      );
      if (supplierRes.rows.length === 0) {
        throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
      }
      if (supplierRes.rows[0].archived_at) {
        throw new AppError(
          'Cannot record a payment for an archived supplier. Restore the supplier first.',
          409,
          'SUPPLIER_ARCHIVED'
        );
      }

      const receiptNumber = await allocateDocumentNumber(
        client,
        SUPPLIER_PAYMENT_RECEIPT_NUMBERING_CONFIG
      );

      const payInsertRes = await client.query(
        `INSERT INTO supplier_payments (
          receipt_number, supplier_id, payment_date, amount,
          payment_method, transaction_reference, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
        [
          receiptNumber,
          input.supplierId,
          paymentDate,
          amount.toFixed(2),
          input.paymentMethod,
          input.transactionReference?.trim() || null,
          input.notes?.trim() || null,
        ]
      );

      const paymentId = Number(payInsertRes.rows[0].id);

      await this.applyBillAllocationsInTx(client, {
        paymentId,
        supplierId: input.supplierId,
        availableAmount: amount,
        allocations: input.allocations || [],
        allowTopUp: false,
      });

      await client.query('COMMIT');
      return this.getSupplierPaymentById(paymentId);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  public async allocateAdvancePayment(
    paymentId: number,
    allocations: PaymentAllocationInput[]
  ): Promise<SupplierPaymentRecord> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      const payRes = await client.query(
        `SELECT sp.*, s.archived_at AS supplier_archived_at
         FROM supplier_payments sp
         INNER JOIN suppliers s ON s.id = sp.supplier_id
         WHERE sp.id = $1
         FOR UPDATE OF sp`,
        [paymentId]
      );
      if (payRes.rows.length === 0) {
        throw new AppError('Supplier payment not found.', 404, 'PAYMENT_NOT_FOUND');
      }
      const payment = payRes.rows[0];
      if (payment.supplier_archived_at) {
        throw new AppError(
          'Cannot allocate payments for an archived supplier. Restore the supplier first.',
          409,
          'SUPPLIER_ARCHIVED'
        );
      }

      const existingAllocRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS allocated_amount
         FROM supplier_payment_allocations
         WHERE payment_id = $1`,
        [paymentId]
      );
      const allocated = new Decimal(existingAllocRes.rows[0].allocated_amount || 0);
      const totalAmount = new Decimal(payment.amount || 0);
      const availableUnallocated = Decimal.max(totalAmount.minus(allocated), new Decimal(0));

      if (availableUnallocated.lessThanOrEqualTo(0)) {
        throw new AppError(
          'This payment is already fully allocated.',
          409,
          'PAYMENT_FULLY_ALLOCATED'
        );
      }

      await this.applyBillAllocationsInTx(client, {
        paymentId,
        supplierId: payment.supplier_id,
        availableAmount: availableUnallocated,
        allocations,
        allowTopUp: true,
      });

      await client.query('COMMIT');
      return this.getSupplierPaymentById(paymentId);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  public async listSupplierPayments(options?: {
    supplierId?: string;
    paymentMethod?: 'cash' | 'upi' | 'bank_transfer' | 'cheque' | 'other';
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    payments: SupplierPaymentRecord[];
    total: number;
    pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
  }> {
    const limit = Math.min(Math.max(1, options?.limit || 100), 200);
    const offset = Math.max(0, options?.offset || 0);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.supplierId) {
      params.push(options.supplierId);
      conditions.push(`sp.supplier_id = $${params.length}`);
    }
    if (options?.paymentMethod) {
      params.push(options.paymentMethod);
      conditions.push(`sp.payment_method = $${params.length}`);
    }
    if (options?.fromDate) {
      params.push(options.fromDate);
      conditions.push(`sp.payment_date >= $${params.length}::date`);
    }
    if (options?.toDate) {
      params.push(options.toDate);
      conditions.push(`sp.payment_date <= $${params.length}::date`);
    }

    const whereClause = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';

    const query = `
      WITH alloc AS (
        SELECT payment_id, COALESCE(SUM(amount), 0)::numeric AS allocated_amount
        FROM supplier_payment_allocations
        GROUP BY payment_id
      )
      SELECT
        sp.id,
        sp.receipt_number,
        sp.supplier_id,
        s.name AS supplier_name,
        s.phone AS supplier_phone,
        s.gstin AS supplier_gstin,
        s.address AS supplier_address,
        s.archived_at AS supplier_archived_at,
        TO_CHAR(sp.payment_date, 'YYYY-MM-DD') AS payment_date,
        sp.amount,
        COALESCE(alloc.allocated_amount, 0) AS allocated_amount,
        sp.payment_method,
        sp.transaction_reference,
        sp.notes,
        sp.created_at,
        sp.updated_at,
        COUNT(*) OVER()::bigint AS full_count
      FROM supplier_payments sp
      INNER JOIN suppliers s ON s.id = sp.supplier_id
      LEFT JOIN alloc ON alloc.payment_id = sp.id
      WHERE ${whereClause}
      ORDER BY sp.payment_date DESC, sp.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const res = await appPool.query(query, [...params, limit, offset]);
    const total = res.rows.length > 0 ? parseInt(res.rows[0].full_count, 10) : 0;

    const paymentIds = res.rows.map((r) => Number(r.id));
    const allocationsByPayment = new Map<number, SupplierPaymentAllocationRecord[]>();

    if (paymentIds.length > 0) {
      const allocRes = await appPool.query(
        `SELECT
          spa.id AS allocation_id,
          spa.payment_id,
          spa.purchase_bill_id,
          spa.amount,
          spb.invoice_number,
          TO_CHAR(spb.invoice_date, 'YYYY-MM-DD') AS invoice_date,
          spb.grand_total
        FROM supplier_payment_allocations spa
        INNER JOIN supplier_purchase_bills spb ON spb.id = spa.purchase_bill_id
        WHERE spa.payment_id = ANY($1::bigint[])
        ORDER BY spb.invoice_date ASC, spa.id ASC`,
        [paymentIds]
      );

      for (const r of allocRes.rows) {
        const pid = Number(r.payment_id);
        const list = allocationsByPayment.get(pid) || [];
        list.push({
          allocationId: Number(r.allocation_id),
          purchaseBillId: Number(r.purchase_bill_id),
          invoiceNumber: r.invoice_number,
          invoiceDate: r.invoice_date,
          billGrandTotal: toFixedMoney(r.grand_total),
          amount: toFixedMoney(r.amount),
        });
        allocationsByPayment.set(pid, list);
      }
    }

    const payments: SupplierPaymentRecord[] = res.rows.map((r) => {
      const totalAmt = new Decimal(r.amount || 0);
      const allocatedAmt = new Decimal(r.allocated_amount || 0);
      const unallocatedAmt = Decimal.max(totalAmt.minus(allocatedAmt), new Decimal(0));
      const pid = Number(r.id);

      return {
        id: pid,
        receiptNumber: r.receipt_number,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        supplierPhone: r.supplier_phone ?? null,
        supplierGstin: r.supplier_gstin ?? null,
        supplierAddress: r.supplier_address ?? null,
        supplierArchivedAt: r.supplier_archived_at ? new Date(r.supplier_archived_at).toISOString() : null,
        paymentDate: r.payment_date,
        amount: toFixedMoney(totalAmt),
        allocatedAmount: toFixedMoney(allocatedAmt),
        unallocatedAmount: toFixedMoney(unallocatedAmt),
        paymentMethod: r.payment_method,
        transactionReference: r.transaction_reference ?? null,
        notes: r.notes ?? null,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
        allocations: allocationsByPayment.get(pid) || [],
      };
    });

    const hasMore = offset + payments.length < total;
    return {
      payments,
      total,
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + payments.length : null,
      },
    };
  }

  public async getSupplierPaymentById(paymentId: number): Promise<SupplierPaymentRecord> {
    const payRes = await appPool.query(
      `WITH alloc AS (
        SELECT payment_id, COALESCE(SUM(amount), 0)::numeric AS allocated_amount
        FROM supplier_payment_allocations
        WHERE payment_id = $1
        GROUP BY payment_id
      )
      SELECT
        sp.id,
        sp.receipt_number,
        sp.supplier_id,
        s.name AS supplier_name,
        s.phone AS supplier_phone,
        s.gstin AS supplier_gstin,
        s.address AS supplier_address,
        s.archived_at AS supplier_archived_at,
        TO_CHAR(sp.payment_date, 'YYYY-MM-DD') AS payment_date,
        sp.amount,
        COALESCE(alloc.allocated_amount, 0) AS allocated_amount,
        sp.payment_method,
        sp.transaction_reference,
        sp.notes,
        sp.created_at,
        sp.updated_at
      FROM supplier_payments sp
      INNER JOIN suppliers s ON s.id = sp.supplier_id
      LEFT JOIN alloc ON alloc.payment_id = sp.id
      WHERE sp.id = $1`,
      [paymentId]
    );

    if (payRes.rows.length === 0) {
      throw new AppError('Supplier payment not found.', 404, 'PAYMENT_NOT_FOUND');
    }

    const r = payRes.rows[0];
    const [allocRes, supplier] = await Promise.all([
      appPool.query(
        `SELECT
          spa.id AS allocation_id,
          spa.purchase_bill_id,
          spa.amount,
          spb.invoice_number,
          TO_CHAR(spb.invoice_date, 'YYYY-MM-DD') AS invoice_date,
          spb.grand_total
        FROM supplier_payment_allocations spa
        INNER JOIN supplier_purchase_bills spb ON spb.id = spa.purchase_bill_id
        WHERE spa.payment_id = $1
        ORDER BY spb.invoice_date ASC, spa.id ASC`,
        [paymentId]
      ),
      this.getSupplierById(r.supplier_id),
    ]);

    const totalAmt = new Decimal(r.amount || 0);
    const allocatedAmt = new Decimal(r.allocated_amount || 0);
    const unallocatedAmt = Decimal.max(totalAmt.minus(allocatedAmt), new Decimal(0));

    return {
      id: Number(r.id),
      receiptNumber: r.receipt_number,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      supplierPhone: r.supplier_phone ?? null,
      supplierGstin: r.supplier_gstin ?? null,
      supplierAddress: r.supplier_address ?? null,
      supplierArchivedAt: r.supplier_archived_at ? new Date(r.supplier_archived_at).toISOString() : null,
      paymentDate: r.payment_date,
      amount: toFixedMoney(totalAmt),
      allocatedAmount: toFixedMoney(allocatedAmt),
      unallocatedAmount: toFixedMoney(unallocatedAmt),
      paymentMethod: r.payment_method,
      transactionReference: r.transaction_reference ?? null,
      notes: r.notes ?? null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      allocations: allocRes.rows.map((a) => ({
        allocationId: Number(a.allocation_id),
        purchaseBillId: Number(a.purchase_bill_id),
        invoiceNumber: a.invoice_number,
        invoiceDate: a.invoice_date,
        billGrandTotal: toFixedMoney(a.grand_total),
        amount: toFixedMoney(a.amount),
      })),
      supplierSummary: {
        totalPurchases: supplier.totalPurchases,
        totalPayments: supplier.totalPayments,
        allocatedPayments: supplier.allocatedPayments,
        unallocatedPayments: supplier.unallocatedPayments,
        outstandingPayable: supplier.outstandingPayable,
        advanceBalance: supplier.advanceBalance,
        netBalance: supplier.netBalance,
      },
    };
  }

  public async getSupplierStatement(
    supplierId: string,
    options?: {
      fromDate?: string;
      toDate?: string;
    }
  ): Promise<SupplierStatementResponse> {
    const fromDate = options?.fromDate || null;
    const toDate = options?.toDate || null;
    if (fromDate && toDate && toDate < fromDate) {
      throw new AppError('End date cannot be earlier than start date.', 400, 'INVALID_DATE_RANGE');
    }

    // Archived suppliers remain available for historical statements
    const supplier = await this.getSupplierById(supplierId);

    let priorPurchases = '0.00';
    let priorPayments = '0.00';

    if (fromDate) {
      const priorRes = await appPool.query(
        `SELECT
          (SELECT COALESCE(SUM(grand_total), 0)::numeric FROM supplier_purchase_bills WHERE supplier_id = $1 AND status = 'finalized' AND invoice_date < $2::date) AS prior_purchases,
          (SELECT COALESCE(SUM(amount), 0)::numeric FROM supplier_payments WHERE supplier_id = $1 AND payment_date < $2::date) AS prior_payments`,
        [supplierId, fromDate]
      );
      priorPurchases = toFixedMoney(priorRes.rows[0]?.prior_purchases || 0);
      priorPayments = toFixedMoney(priorRes.rows[0]?.prior_payments || 0);
    }

    const billConditions = [`spb.supplier_id = $1`, `spb.status = 'finalized'`];
    const billParams: unknown[] = [supplierId];
    if (fromDate) {
      billParams.push(fromDate);
      billConditions.push(`spb.invoice_date >= $${billParams.length}::date`);
    }
    if (toDate) {
      billParams.push(toDate);
      billConditions.push(`spb.invoice_date <= $${billParams.length}::date`);
    }

    const payConditions = [`sp.supplier_id = $1`];
    const payParams: unknown[] = [supplierId];
    if (fromDate) {
      payParams.push(fromDate);
      payConditions.push(`sp.payment_date >= $${payParams.length}::date`);
    }
    if (toDate) {
      payParams.push(toDate);
      payConditions.push(`sp.payment_date <= $${payParams.length}::date`);
    }

    const [billsRes, paymentsRes] = await Promise.all([
      appPool.query(
        `SELECT
          spb.id,
          spb.invoice_number,
          TO_CHAR(spb.invoice_date, 'YYYY-MM-DD') AS invoice_date,
          spb.grand_total,
          spb.status,
          COALESCE(SUM(spa.amount), 0)::numeric AS paid_amount
        FROM supplier_purchase_bills spb
        LEFT JOIN supplier_payment_allocations spa ON spa.purchase_bill_id = spb.id
        WHERE ${billConditions.join(' AND ')}
        GROUP BY spb.id`,
        billParams
      ),
      appPool.query(
        `SELECT
          sp.id,
          sp.receipt_number,
          TO_CHAR(sp.payment_date, 'YYYY-MM-DD') AS payment_date,
          sp.amount,
          sp.payment_method,
          sp.transaction_reference,
          COALESCE(SUM(spa.amount), 0)::numeric AS allocated_amount
        FROM supplier_payments sp
        LEFT JOIN supplier_payment_allocations spa ON spa.payment_id = sp.id
        WHERE ${payConditions.join(' AND ')}
        GROUP BY sp.id`,
        payParams
      ),
    ]);

    const rawEntries: StatementEntryInput[] = [];

    for (const b of billsRes.rows) {
      const grandTotal = new Decimal(b.grand_total || 0);
      const paidAmount = new Decimal(b.paid_amount || 0);
      const remaining = Decimal.max(grandTotal.minus(paidAmount), new Decimal(0));
      rawEntries.push({
        entryType: 'purchase_bill',
        entryDate: b.invoice_date,
        sortOrder: 0,
        id: Number(b.id),
        referenceNumber: b.invoice_number,
        description: `Purchase Bill ${b.invoice_number}`,
        amount: toFixedMoney(grandTotal),
        billStatus: remaining.isZero()
          ? 'paid'
          : paidAmount.greaterThan(0)
            ? 'partial'
            : 'unpaid',
        billPaidAmount: toFixedMoney(paidAmount),
        billRemainingAmount: toFixedMoney(remaining),
      });
    }

    for (const p of paymentsRes.rows) {
      const amt = new Decimal(p.amount || 0);
      const allocated = new Decimal(p.allocated_amount || 0);
      const unallocated = Decimal.max(amt.minus(allocated), new Decimal(0));
      rawEntries.push({
        entryType: 'payment',
        entryDate: p.payment_date,
        sortOrder: 1,
        id: Number(p.id),
        referenceNumber: p.receipt_number,
        description: `Payment ${p.receipt_number} (${p.payment_method.replace('_', ' ').toUpperCase()})`,
        amount: toFixedMoney(amt),
        paymentMethod: p.payment_method,
        transactionReference: p.transaction_reference ?? null,
        paymentAllocatedAmount: toFixedMoney(allocated),
        paymentUnallocatedAmount: toFixedMoney(unallocated),
      });
    }

    const statement = buildSupplierStatementLedger(priorPurchases, priorPayments, rawEntries);

    return {
      supplier,
      filters: { fromDate, toDate },
      ...statement,
    };
  }

  public formatStatementCsv(statement: SupplierStatementResponse): string {
    const lines: string[] = [];
    lines.push(
      [
        csvSafeCell('Supplier Statement'),
        csvSafeCell(statement.supplier.name),
        csvSafeCell(statement.supplier.gstin ? `GSTIN: ${statement.supplier.gstin}` : ''),
        csvSafeCell(
          statement.filters.fromDate || statement.filters.toDate
            ? `Period: ${statement.filters.fromDate || 'Beginning'} to ${statement.filters.toDate || 'Today'}`
            : 'Period: All Dates'
        ),
      ].join(',')
    );
    lines.push('');
    lines.push(
      [
        'Date',
        'Type',
        'Reference',
        'Details',
        'Method / Payment Status',
        'Purchases (Debit)',
        'Payments (Credit)',
        'Running Balance',
      ]
        .map((h) => csvSafeCell(h))
        .join(',')
    );

    if (statement.filters.fromDate) {
      lines.push(
        [
          csvSafeCell(statement.filters.fromDate),
          csvSafeCell('Opening Balance'),
          csvSafeCell('-'),
          csvSafeCell('Carried forward prior transactions'),
          csvSafeCell('-'),
          csvSafeCell('0.00'),
          csvSafeCell('0.00'),
          csvSafeCell(statement.openingBalance),
        ].join(',')
      );
    }

    for (const entry of statement.entries) {
      const statusOrMethod =
        entry.entryType === 'purchase_bill'
          ? `Bill: ${(entry.billStatus || 'unpaid').toUpperCase()}`
          : `${(entry.paymentMethod || '').toUpperCase()}${entry.transactionReference ? ` (${entry.transactionReference})` : ''}`;

      lines.push(
        [
          csvSafeCell(entry.entryDate),
          csvSafeCell(entry.entryType === 'purchase_bill' ? 'Purchase Bill' : 'Payment'),
          csvSafeCell(entry.referenceNumber),
          csvSafeCell(entry.description),
          csvSafeCell(statusOrMethod),
          csvSafeCell(entry.debitAmount),
          csvSafeCell(entry.creditAmount),
          csvSafeCell(entry.runningBalance),
        ].join(',')
      );
    }

    lines.push('');
    lines.push(
      [
        csvSafeCell('Totals'),
        csvSafeCell(''),
        csvSafeCell(''),
        csvSafeCell('Closing Balance'),
        csvSafeCell(
          new Decimal(statement.closingBalance).greaterThanOrEqualTo(0) ? 'Payable' : 'Advance Credit'
        ),
        csvSafeCell(statement.periodPurchases),
        csvSafeCell(statement.periodPayments),
        csvSafeCell(statement.closingBalance),
      ].join(',')
    );

    return `${lines.join('\r\n')}\r\n`;
  }
}

export const suppliersService = new SuppliersService();
