import { Decimal } from 'decimal.js';
import { appPool } from '../../config/database.js';
import { enqueueOutboxEvent, notifyOutboxCommitted } from '../readModels/outbox.service.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import { resolveValidatedState } from '../../utils/indianTax.js';
import { validateMoneyInput, validateDecimalQuantityInput, escapeLike } from '../../utils/validation.js';
import {
  acquireIdempotencyLock,
  checkIdempotencyRecord,
  cleanupExpiredIdempotencyKeys,
  hashIdempotencyPayload,
  IdempotencyDbClient,
  storeIdempotencyRecord,
} from '../../services/idempotency.service.js';

// Configure Decimal globally for money arithmetic
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface CustomerSummaryItem {
  id: number;
  name: string;
  phone: string | null;
  address?: string | null;
  state: string | null;
  state_code: string | null;
  totalUdhar: string;
  totalReceived: string;
  outstanding: string;
  lastActivity?: string;
}

export interface KhataOverviewSummary {
  totalCustomers: number;
  totalOutstanding: string;
  totalReceived: string;
}

export interface ListCustomersOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PaginatedCustomersResult {
  customers: CustomerSummaryItem[];
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

export interface CreateTransactionItemInput {
  productId: number;
  quantity: number | string;
  sellingPrice: number | string;
}

export interface CreateTransactionInput {
  customer: {
    id?: number | null;
    name: string;
    phone?: string | null;
    address?: string | null;
    state?: string | null;
    stateCode?: string | null;
  };
  items: CreateTransactionItemInput[];
  initialPayment?: number | string | null;
  note?: string | null;
  idempotencyKey?: string | null;
}

export interface CreateCustomerInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  state?: string | null;
  stateCode?: string | null;
}

export interface UpdateCustomerInput {
  name?: string;
  phone?: string | null;
  address?: string | null;
  state?: string | null;
  stateCode?: string | null;
}

export class KhataService {
  /**
   * Canonical Unicode and whitespace normalization for customer names
   */
  public normalizeName(name: string): string {
    return name
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  /**
   * Normalizes an Indian customer phone number to canonical +91XXXXXXXXXX
   * Rejects malformed non-empty phone input with HTTP 400 (INVALID_PHONE_FORMAT).
   * Missing/empty/whitespace-only input safely returns null (optional phone).
   */
  public normalizeCustomerPhone(phone?: string | null): string | null {
    if (phone === null || phone === undefined) return null;
    if (typeof phone !== 'string') {
      throw new AppError('Customer phone must be a string.', 400, 'INVALID_PHONE_FORMAT');
    }
    const trimmed = phone.trim();
    if (trimmed === '') return null;

    let cleaned = trimmed.replace(/[\s\-()]/g, '');
    if (cleaned.startsWith('+91')) {
      cleaned = cleaned.slice(3);
    } else if (cleaned.startsWith('91') && cleaned.length === 12) {
      cleaned = cleaned.slice(2);
    } else if (cleaned.startsWith('0') && cleaned.length === 11) {
      cleaned = cleaned.slice(1);
    }

    if (/^[6-9]\d{9}$/.test(cleaned)) {
      return `+91${cleaned}`;
    }

    throw new AppError(
      'Invalid phone number format. Must be a valid 10-digit Indian mobile number.',
      400,
      'INVALID_PHONE_FORMAT'
    );
  }

  /**
   * Dashboard Global Overview Summary
   * Uses separate aggregate CTEs to prevent fan-out / inflated totals
   */
  public async getSummary(): Promise<KhataOverviewSummary> {
    const query = `
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
        GREATEST(
          transaction_totals.total_udhar - allocation_totals.total_allocated,
          0
        ) AS total_outstanding,
        payment_totals.total_received
      FROM transaction_totals
      CROSS JOIN allocation_totals
      CROSS JOIN payment_totals;
    `;

    const result = await appPool.query(query);
    const row = result.rows[0];

    const outstanding = new Decimal(row?.total_outstanding || '0').toFixed(2);
    const received = new Decimal(row?.total_received || '0').toFixed(2);
    const totalCustomers = parseInt(row?.total_customers || '0', 10);

    return {
      totalCustomers,
      totalOutstanding: outstanding,
      totalReceived: received,
    };
  }

  /**
   * Searchable Customer List with independent pre-aggregated totals and bounded pagination.
   * Uses LEFT JOIN so customers without prior transactions are also discoverable.
   */
  public async listCustomers(optionsOrSearch?: string | ListCustomersOptions): Promise<PaginatedCustomersResult> {
    const opts = typeof optionsOrSearch === 'string' ? { search: optionsOrSearch } : optionsOrSearch || {};
    const limit = Math.min(Math.max(1, opts.limit || 25), 200);
    const offset = Math.max(0, opts.offset || 0);

    let sql = `
      WITH customer_tx AS (
        SELECT
          customer_id,
          COALESCE(SUM(total_amount), 0)::numeric AS total_udhar,
          MAX(created_at) AS last_activity
        FROM udhar_transactions
        GROUP BY customer_id
      ),
      customer_alloc AS (
        SELECT
          t.customer_id,
          COALESCE(SUM(pa.amount), 0)::numeric AS total_allocated
        FROM payment_allocations pa
        JOIN udhar_transactions t ON t.id = pa.transaction_id
        GROUP BY t.customer_id
      ),
      customer_pay AS (
        SELECT
          customer_id,
          COALESCE(SUM(amount), 0)::numeric AS total_received,
          MAX(received_at) AS last_payment
        FROM payments
        GROUP BY customer_id
      )
      SELECT
        c.id,
        c.name,
        c.phone,
        c.address,
        c.state,
        c.state_code,
        COALESCE(tx.total_udhar, 0)::numeric AS total_udhar,
        COALESCE(pay.total_received, 0)::numeric AS total_received,
        GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0)::numeric AS outstanding,
        GREATEST(tx.last_activity, pay.last_payment) AS last_activity
      FROM customers c
      LEFT JOIN customer_tx tx ON tx.customer_id = c.id
      LEFT JOIN customer_alloc alloc ON alloc.customer_id = c.id
      LEFT JOIN customer_pay pay ON pay.customer_id = c.id
    `;

    const conditions: string[] = ['c.archived_at IS NULL'];
    const params: unknown[] = [];

    if (opts.search && opts.search.trim()) {
      const raw = opts.search.trim();
      const escaped = escapeLike(raw.toLowerCase());
      params.push(`%${escaped}%`);

      const digits = raw.replace(/\D/g, '');
      let cleanPhoneDigits = digits;
      if (cleanPhoneDigits.startsWith('91') && cleanPhoneDigits.length === 12) {
        cleanPhoneDigits = cleanPhoneDigits.slice(2);
      } else if (cleanPhoneDigits.startsWith('0') && cleanPhoneDigits.length === 11) {
        cleanPhoneDigits = cleanPhoneDigits.slice(1);
      }

      if (cleanPhoneDigits.length >= 3) {
        params.push(`%${escapeLike(cleanPhoneDigits)}%`);
        conditions.push(`(c.normalized_name ILIKE $1 OR c.phone ILIKE $1 OR c.normalized_phone ILIKE $2)`);
      } else {
        conditions.push(`(c.normalized_name ILIKE $1 OR c.phone ILIKE $1)`);
      }
    }

    sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY GREATEST(tx.last_activity, pay.last_payment) DESC NULLS LAST, c.name ASC, c.id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit + 1, offset);

    const result = await appPool.query(sql, params);
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

    const customers = rows.map((row) => {
      const udhar = new Decimal(row.total_udhar || '0').toFixed(2);
      const received = new Decimal(row.total_received || '0').toFixed(2);
      const outstanding = new Decimal(row.outstanding || '0').toFixed(2);

      return {
        id: parseInt(row.id, 10),
        name: row.name,
        phone: row.phone,
        address: row.address || null,
        state: row.state || null,
        state_code: row.state_code || null,
        totalUdhar: udhar,
        totalReceived: received,
        outstanding,
        lastActivity: row.last_activity,
      };
    });

    return {
      customers,
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
    };
  }

  /**
   * Creates a standalone customer profile (supports NULL state when not supplied)
   */
  public async createCustomer(input: CreateCustomerInput): Promise<CustomerSummaryItem> {
    const rawName = input.name.trim();
    if (!rawName) {
      throw new AppError('Customer name is required.', 400, 'VALIDATION_ERROR');
    }

    const normName = this.normalizeName(rawName);
    const normPhone = this.normalizeCustomerPhone(input.phone);
    const rawPhone = input.phone?.trim() || null;
    const custAddr = input.address?.trim() || null;

    const resolvedState = resolveValidatedState({
      state: input.state,
      stateCode: input.stateCode,
      required: false,
      fieldLabel: 'Customer',
    });

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      if (normPhone) {
        const phoneConflict = await client.query(
          'SELECT id, name FROM customers WHERE normalized_phone = $1 FOR UPDATE',
          [normPhone]
        );
        if (phoneConflict.rows.length > 0) {
          throw new AppError(
            `Phone number ${rawPhone || normPhone} is already attached to customer #${phoneConflict.rows[0].id} (${phoneConflict.rows[0].name}).`,
            409,
            'PHONE_ALREADY_ATTACHED'
          );
        }
      }

      const insertRes = await client.query(
        `INSERT INTO customers (
          name, normalized_name, phone, normalized_phone, address, state, state_code, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING id`,
        [
          rawName,
          normName,
          rawPhone,
          normPhone,
          custAddr,
          resolvedState.state,
          resolvedState.stateCode,
        ]
      );

      const newId = parseInt(insertRes.rows[0].id, 10);
      await enqueueOutboxEvent(client, {
        aggregateType: 'customer',
        aggregateId: newId,
        eventType: 'customer.created',
        businessDate: getBusinessDateISO(env.BUSINESS_TIME_ZONE),
      });
      const detail = await this.getCustomerDetailWithDb(client, newId);
      await client.query('COMMIT');
      notifyOutboxCommitted();
      return detail!;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Updates an existing customer's profile.
   * Explicit `{ state: null, stateCode: null }` (or `{ state: null }`) clears both state columns cleanly.
   */
  public async updateCustomer(customerId: number, input: UpdateCustomerInput): Promise<CustomerSummaryItem> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      const existingRes = await client.query(
        'SELECT id, name, phone, normalized_phone, address, state, state_code FROM customers WHERE id = $1 AND archived_at IS NULL FOR UPDATE',
        [customerId]
      );
      if (existingRes.rows.length === 0) {
        throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      const pushUpdate = (col: string, val: unknown) => {
        params.push(val);
        updates.push(`${col} = $${params.length}`);
      };

      if (input.name !== undefined) {
        const rawName = input.name.trim();
        if (!rawName) {
          throw new AppError('Customer name is required.', 400, 'VALIDATION_ERROR');
        }
        pushUpdate('name', rawName);
        pushUpdate('normalized_name', this.normalizeName(rawName));
      }

      if (input.phone !== undefined) {
        const normPhone = this.normalizeCustomerPhone(input.phone);
        const rawPhone = input.phone ? input.phone.trim() || null : null;

        if (normPhone) {
          const phoneConflict = await client.query(
            'SELECT id, name FROM customers WHERE normalized_phone = $1 AND id != $2 FOR UPDATE',
            [normPhone, customerId]
          );
          if (phoneConflict.rows.length > 0) {
            throw new AppError(
              `Phone number ${rawPhone || normPhone} is already attached to customer #${phoneConflict.rows[0].id} (${phoneConflict.rows[0].name}).`,
              409,
              'PHONE_ALREADY_ATTACHED'
            );
          }
        }
        pushUpdate('phone', rawPhone);
        pushUpdate('normalized_phone', normPhone);
      }

      if (input.address !== undefined) {
        pushUpdate('address', input.address ? input.address.trim() || null : null);
      }

      if (input.state !== undefined || input.stateCode !== undefined) {
        const clearingOnlyState =
          (input.state === null || (typeof input.state === 'string' && input.state.trim() === '')) &&
          (input.stateCode === undefined ||
            input.stateCode === null ||
            (typeof input.stateCode === 'string' && input.stateCode.trim() === ''));

        if (clearingOnlyState) {
          pushUpdate('state', null);
          pushUpdate('state_code', null);
        } else {
          const resolved = resolveValidatedState({
            state: input.state,
            stateCode: input.stateCode,
            required: false,
            fieldLabel: 'Customer',
          });
          pushUpdate('state', resolved.state);
          pushUpdate('state_code', resolved.stateCode);
        }
      }

      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        params.push(customerId);
        await client.query(
          `UPDATE customers SET ${updates.join(', ')} WHERE id = $${params.length}`,
          params
        );
      }

      if (updates.length > 0) {
        await enqueueOutboxEvent(client, {
          aggregateType: 'customer',
          aggregateId: customerId,
          eventType: 'customer.updated',
        });
      }
      const detail = await this.getCustomerDetailWithDb(client, customerId);
      await client.query('COMMIT');
      if (updates.length > 0) {
        notifyOutboxCommitted();
      }
      return detail!;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async getCustomerDetailWithDb(
    db: IdempotencyDbClient,
    customerId: number
  ): Promise<CustomerSummaryItem | null> {
    const query = `
      WITH customer_tx AS (
        SELECT
          customer_id,
          COALESCE(SUM(total_amount), 0)::numeric AS total_udhar,
          MAX(created_at) AS last_activity
        FROM udhar_transactions
        WHERE customer_id = $1
        GROUP BY customer_id
      ),
      customer_alloc AS (
        SELECT
          t.customer_id,
          COALESCE(SUM(pa.amount), 0)::numeric AS total_allocated
        FROM payment_allocations pa
        JOIN udhar_transactions t ON t.id = pa.transaction_id
        WHERE t.customer_id = $1
        GROUP BY t.customer_id
      ),
      customer_pay AS (
        SELECT
          customer_id,
          COALESCE(SUM(amount), 0)::numeric AS total_received,
          MAX(received_at) AS last_payment
        FROM payments
        WHERE customer_id = $1
        GROUP BY customer_id
      )
      SELECT
        c.id,
        c.name,
        c.phone,
        c.address,
        c.state,
        c.state_code,
        COALESCE(tx.total_udhar, 0)::numeric AS total_udhar,
        COALESCE(pay.total_received, 0)::numeric AS total_received,
        GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0)::numeric AS outstanding,
        GREATEST(tx.last_activity, pay.last_payment) AS last_activity
      FROM customers c
      LEFT JOIN customer_tx tx ON tx.customer_id = c.id
      LEFT JOIN customer_alloc alloc ON alloc.customer_id = c.id
      LEFT JOIN customer_pay pay ON pay.customer_id = c.id
      WHERE c.id = $1 AND c.archived_at IS NULL
    `;

    const result = await db.query(query, [customerId]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const udhar = new Decimal(row.total_udhar || '0').toFixed(2);
    const received = new Decimal(row.total_received || '0').toFixed(2);
    const outstanding = new Decimal(row.outstanding || '0').toFixed(2);

    return {
      id: parseInt(row.id, 10),
      name: row.name,
      phone: row.phone,
      address: row.address || null,
      state: row.state || null,
      state_code: row.state_code || null,
      totalUdhar: udhar,
      totalReceived: received,
      outstanding,
      lastActivity: row.last_activity,
    };
  }

  /**
   * Customer Profile & Balance Summary
   */
  public async getCustomerDetail(customerId: number): Promise<CustomerSummaryItem | null> {
    return this.getCustomerDetailWithDb(appPool, customerId);
  }

  /**
   * Customer Chronological History (Transactions with line items & Payments with allocations)
   */
  public async getCustomerHistory(customerId: number) {
    const customer = await this.getCustomerDetail(customerId);
    if (!customer) return null;

    // Fetch transactions with allocated payments
    const txQuery = `
      SELECT
        t.id,
        t.transaction_date,
        t.total_amount,
        t.note,
        t.created_at,
        COALESCE(SUM(pa.amount), 0) AS allocated_payment
      FROM udhar_transactions t
      LEFT JOIN payment_allocations pa ON pa.transaction_id = t.id
      WHERE t.customer_id = $1
      GROUP BY t.id, t.transaction_date, t.total_amount, t.note, t.created_at
      ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC
    `;
    const txRes = await appPool.query(txQuery, [customerId]);

    const txIds = txRes.rows.map((r) => r.id);
    const itemsByTxId: Record<string, unknown[]> = {};

    if (txIds.length > 0) {
      const itemsRes = await appPool.query(
        `SELECT
          id, transaction_id, product_id, product_name_snapshot,
          buying_price_snapshot, quantity, selling_price, line_total
         FROM udhar_items
         WHERE transaction_id = ANY($1::bigint[])
         ORDER BY id ASC`,
        [txIds]
      );

      for (const item of itemsRes.rows) {
        const txId = item.transaction_id.toString();
        if (!itemsByTxId[txId]) itemsByTxId[txId] = [];
        itemsByTxId[txId].push(item);
      }
    }

    const transactions = txRes.rows.map((t) => {
      const total = new Decimal(t.total_amount);
      const paid = new Decimal(t.allocated_payment);
      const remaining = Decimal.max(0, total.minus(paid));
      return {
        id: parseInt(t.id, 10),
        transactionDate: t.transaction_date,
        totalAmount: total.toFixed(2),
        allocatedPayment: paid.toFixed(2),
        outstanding: remaining.toFixed(2),
        isSettled: remaining.isZero(),
        note: t.note,
        createdAt: t.created_at,
        items: itemsByTxId[t.id.toString()] || [],
      };
    });

    // Fetch payments with their FIFO allocations
    const paymentsRes = await appPool.query(
      `SELECT
        p.id, p.amount, p.received_at, p.note,
        COALESCE(
          json_agg(
            json_build_object(
              'transactionId', pa.transaction_id,
              'amount', pa.amount
            )
          ) FILTER (WHERE pa.id IS NOT NULL), '[]'
        ) as allocations
       FROM payments p
       LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
       WHERE p.customer_id = $1
       GROUP BY p.id, p.amount, p.received_at, p.note
       ORDER BY p.received_at DESC, p.id DESC`,
      [customerId]
    );

    const payments = paymentsRes.rows.map((p) => ({
      id: parseInt(p.id, 10),
      amount: new Decimal(p.amount).toFixed(2),
      receivedAt: p.received_at,
      note: p.note,
      allocations: p.allocations || [],
    }));

    return {
      customer,
      transactions,
      payments,
    };
  }

  /**
   * Creates a new Udhar Transaction with line items and optional initial payment atomically.
   * Supports 24-hour TTL Idempotency-Key and safe customer resolution.
   */
  public async createTransaction(input: CreateTransactionInput) {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one item is required for an Udhar transaction.', 400, 'VALIDATION_ERROR');
    }

    const rawName = input.customer.name.trim();
    if (!rawName) {
      throw new AppError('Customer name is required.', 400, 'VALIDATION_ERROR');
    }

    const normName = this.normalizeName(rawName);
    const normPhone = this.normalizeCustomerPhone(input.customer.phone);
    const custAddr = input.customer.address ? input.customer.address.trim() || null : null;
    const resolvedCustomerState = resolveValidatedState({
      state: input.customer.state,
      stateCode: input.customer.stateCode,
      required: false,
      fieldLabel: 'Customer',
    });

    const parsedItems = input.items.map((item) => {
      const prodId = Number(item.productId);
      const qtyDec = validateDecimalQuantityInput(item.quantity, `Item for product ID ${prodId} quantity`);
      const sellPriceDec = validateMoneyInput(item.sellingPrice, `Selling price for product ID ${prodId}`);
      return {
        prodId,
        qtyDec,
        sellPriceDec,
      };
    });

    const initPayDec =
      input.initialPayment !== undefined && input.initialPayment !== null && input.initialPayment !== ''
        ? validateMoneyInput(input.initialPayment, 'Initial payment')
        : null;

    const idempotencyKey = input.idempotencyKey?.trim() || null;
    const requestHash = idempotencyKey
      ? hashIdempotencyPayload({
          customer: {
            id: input.customer.id ?? null,
            name: normName,
            phone: normPhone,
            address: custAddr,
            state: resolvedCustomerState.state,
            stateCode: resolvedCustomerState.stateCode,
          },
          items: parsedItems.map((it) => ({
            productId: it.prodId,
            quantity: it.qtyDec.toFixed(2),
            sellingPrice: it.sellPriceDec.toFixed(2),
          })),
          initialPayment: initPayDec ? initPayDec.toFixed(2) : null,
          note: input.note?.trim() || null,
        })
      : null;

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      if (idempotencyKey && requestHash) {
        await acquireIdempotencyLock(client, idempotencyKey);
        const existingIdemp = await checkIdempotencyRecord(
          client,
          idempotencyKey,
          'CREATE_TRANSACTION',
          requestHash
        );
        if (existingIdemp.found && !existingIdemp.expired) {
          await client.query('COMMIT');
          return existingIdemp.responseBody;
        }
        await cleanupExpiredIdempotencyKeys(client, 100);
      }

      // 1. Resolve Customer safely
      let customerId: number;

      if (input.customer.id) {
        // Explicitly selected customer
        const custRes = await client.query(
          'SELECT id, name, phone, normalized_phone, state, state_code FROM customers WHERE id = $1 FOR UPDATE',
          [input.customer.id]
        );
        if (custRes.rows.length === 0) {
          throw new AppError('Selected customer not found.', 404, 'CUSTOMER_NOT_FOUND');
        }
        const existing = custRes.rows[0];
        if (normPhone && existing.normalized_phone && existing.normalized_phone !== normPhone) {
          throw new AppError(
            `Customer #${existing.id} already has phone ${existing.phone}. Cannot overwrite with ${input.customer.phone}.`,
            409,
            'PHONE_CONFLICT'
          );
        }

        // If existing customer had no phone and new valid phone is supplied, attach it safely under row lock
        if (normPhone && !existing.normalized_phone) {
          const phoneConflict = await client.query(
            'SELECT id, name FROM customers WHERE normalized_phone = $1 AND id != $2 FOR UPDATE',
            [normPhone, existing.id]
          );
          if (phoneConflict.rows.length > 0) {
            throw new AppError(
              `Phone number ${input.customer.phone} is already attached to customer #${phoneConflict.rows[0].id} (${phoneConflict.rows[0].name}).`,
              409,
              'PHONE_ALREADY_ATTACHED'
            );
          }
          await client.query(
            'UPDATE customers SET phone = $1, normalized_phone = $2, updated_at = NOW() WHERE id = $3',
            [input.customer.phone ? input.customer.phone.trim() : normPhone, normPhone, existing.id]
          );
        }
        if (custAddr) {
          await client.query(
            "UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2 AND (address IS NULL OR address = '')",
            [custAddr, existing.id]
          );
        }
        customerId = parseInt(existing.id, 10);
      } else {
        // Customer resolution without explicit ID: match by phone or exact normalized name
        let matchedCustomer = null;
        if (normPhone) {
          const phoneRes = await client.query(
            'SELECT id, name, phone, normalized_name FROM customers WHERE normalized_phone = $1 FOR UPDATE',
            [normPhone]
          );
          if (phoneRes.rows.length === 1) {
            matchedCustomer = phoneRes.rows[0];
          } else if (phoneRes.rows.length > 1) {
            throw new AppError(
              `Multiple customer records found with phone ${input.customer.phone}. Please resolve duplicate customer records.`,
              409,
              'AMBIGUOUS_CUSTOMER_MATCH'
            );
          }
        }

        if (matchedCustomer) {
          customerId = parseInt(matchedCustomer.id, 10);
        } else if (normPhone) {
          const nameMatches = await client.query(
            'SELECT id, name, phone, normalized_phone FROM customers WHERE normalized_name = $1 FOR UPDATE',
            [normName]
          );

          if (nameMatches.rows.length === 1 && !nameMatches.rows[0].phone) {
            const existingCust = nameMatches.rows[0];
            await client.query(
              'UPDATE customers SET phone = $1, normalized_phone = $2, updated_at = NOW() WHERE id = $3',
              [input.customer.phone ? input.customer.phone.trim() : normPhone, normPhone, existingCust.id]
            );
            customerId = parseInt(existingCust.id, 10);
          } else if (nameMatches.rows.length > 0 && nameMatches.rows.some((c) => c.phone !== null)) {
            throw new AppError(
              `A customer named "${rawName}" already exists with a different phone number. Please select the customer explicitly or verify identity.`,
              409,
              'CUSTOMER_NAME_CONFLICT'
            );
          } else if (nameMatches.rows.length > 1) {
            throw new AppError(
              `Multiple customers found matching "${rawName}". Please specify customer ID or phone to disambiguate.`,
              409,
              'AMBIGUOUS_CUSTOMER_MATCH',
              nameMatches.rows.map((r) => ({
                id: parseInt(r.id, 10),
                name: r.name,
                phone: r.phone,
              }))
            );
          } else {
            const newCust = await client.query(
              `INSERT INTO customers (name, normalized_name, phone, normalized_phone, address, state, state_code, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
               RETURNING id`,
              [
                rawName,
                normName,
                input.customer.phone ? input.customer.phone.trim() : null,
                normPhone,
                custAddr,
                resolvedCustomerState.state,
                resolvedCustomerState.stateCode,
              ]
            );
            customerId = parseInt(newCust.rows[0].id, 10);
          }
        } else {
          const nameMatches = await client.query(
            'SELECT id, name, phone, address FROM customers WHERE normalized_name = $1 FOR UPDATE',
            [normName]
          );
          if (nameMatches.rows.length === 1) {
            customerId = parseInt(nameMatches.rows[0].id, 10);
            if (custAddr && !nameMatches.rows[0].address) {
              await client.query('UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2', [
                custAddr,
                customerId,
              ]);
            }
          } else if (nameMatches.rows.length > 1) {
            throw new AppError(
              `Multiple customers found matching "${rawName}". Please specify customer ID or phone.`,
              409,
              'AMBIGUOUS_CUSTOMER_MATCH',
              nameMatches.rows.map((r) => ({
                id: parseInt(r.id, 10),
                name: r.name,
                phone: r.phone,
              }))
            );
          } else {
            const newCust = await client.query(
              `INSERT INTO customers (name, normalized_name, phone, normalized_phone, address, state, state_code, created_at, updated_at)
               VALUES ($1, $2, NULL, NULL, $3, $4, $5, NOW(), NOW())
               RETURNING id`,
              [rawName, normName, custAddr, resolvedCustomerState.state, resolvedCustomerState.stateCode]
            );
            customerId = parseInt(newCust.rows[0].id, 10);
          }
        }
      }

      if (custAddr) {
        await client.query(
          `UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2 AND (address IS NULL OR address = '')`,
          [custAddr, customerId]
        );
      }

      if (resolvedCustomerState.stateCode) {
        await client.query(
          `UPDATE customers
           SET state = $1, state_code = $2, updated_at = NOW()
           WHERE id = $3 AND (state_code IS NULL OR state_code = '')`,
          [resolvedCustomerState.state, resolvedCustomerState.stateCode, customerId]
        );
      }

      // 2. Validate Items & Snapshot Products from DB using Decimal Arithmetic
      const verifiedItems: Array<{
        productId: number;
        nameSnapshot: string;
        buyingPriceSnapshot: string;
        quantity: string;
        sellingPrice: string;
        lineTotal: string;
      }> = [];

      let serverComputedTotal = new Decimal(0);

      const uniqueProductIds = Array.from(new Set(parsedItems.map((item) => item.prodId)));
      const prodRes = await client.query(
        'SELECT id, name, buying_price, archived_at FROM products WHERE id = ANY($1::bigint[])',
        [uniqueProductIds]
      );
      const productMap = new Map<number, { id: number; name: string; buying_price: string; archived_at: unknown }>();
      for (const row of prodRes.rows) {
        productMap.set(Number(row.id), row);
      }

      for (const parsedItem of parsedItems) {
        const product = productMap.get(parsedItem.prodId);
        if (!product) {
          throw new AppError(`Product with ID ${parsedItem.prodId} does not exist.`, 404, 'PRODUCT_NOT_FOUND');
        }
        if (product.archived_at) {
          throw new AppError(
            `Product "${product.name}" is archived and cannot be selected for new Udhar.`,
            400,
            'PRODUCT_ARCHIVED'
          );
        }

        const lineTotalDec = parsedItem.qtyDec
          .times(parsedItem.sellPriceDec)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        serverComputedTotal = serverComputedTotal.plus(lineTotalDec);

        verifiedItems.push({
          productId: parsedItem.prodId,
          nameSnapshot: product.name,
          buyingPriceSnapshot: new Decimal(product.buying_price).toFixed(2),
          quantity: parsedItem.qtyDec.toFixed(2),
          sellingPrice: parsedItem.sellPriceDec.toFixed(2),
          lineTotal: lineTotalDec.toFixed(2),
        });
      }

      if (serverComputedTotal.lessThanOrEqualTo(0)) {
        throw new AppError('Transaction total must be greater than zero.', 400, 'VALIDATION_ERROR');
      }

      // 3. Insert udhar_transactions using configured business date (IST)
      const businessDate = getBusinessDateISO(env.BUSINESS_TIME_ZONE);
      const txRes = await client.query(
        `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, note, created_at)
         VALUES ($1, $2::DATE, $3, $4, NOW())
         RETURNING id, transaction_date, total_amount, note, created_at`,
        [customerId, businessDate, serverComputedTotal.toFixed(2), input.note || null]
      );
      const transactionId = parseInt(txRes.rows[0].id, 10);

      // 4. Batch insert udhar_items snapshots
      if (verifiedItems.length > 0) {
        await client.query(
          `INSERT INTO udhar_items
            (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
           SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])`,
          [
            verifiedItems.map(() => transactionId),
            verifiedItems.map((item) => item.productId),
            verifiedItems.map((item) => item.nameSnapshot),
            verifiedItems.map((item) => item.buyingPriceSnapshot),
            verifiedItems.map((item) => item.quantity),
            verifiedItems.map((item) => item.sellingPrice),
            verifiedItems.map((item) => item.lineTotal),
          ]
        );
      }

      // 5. Initial Payment Handling (if provided)
      let initialPaymentRecorded = '0.00';
      if (initPayDec !== null) {
        if (initPayDec.greaterThan(serverComputedTotal)) {
          throw new AppError(
            `Initial payment (₹${initPayDec.toFixed(2)}) cannot exceed transaction total (₹${serverComputedTotal.toFixed(2)}).`,
            400,
            'PAYMENT_EXCEEDS_TOTAL'
          );
        }

        if (initPayDec.greaterThan(0)) {
          const payRes = await client.query(
            `INSERT INTO payments (customer_id, amount, received_at, note)
             VALUES ($1, $2, NOW(), $3)
             RETURNING id, amount`,
            [customerId, initPayDec.toFixed(2), 'Initial payment at Udhar creation']
          );
          const paymentId = parseInt(payRes.rows[0].id, 10);

          await client.query(
            `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [paymentId, transactionId, customerId, initPayDec.toFixed(2)]
          );

          initialPaymentRecorded = initPayDec.toFixed(2);
        }
      }

      const remainingDue = serverComputedTotal.minus(new Decimal(initialPaymentRecorded)).toFixed(2);

      const responsePayload = {
        success: true,
        data: {
          transactionId,
          customerId,
          totalAmount: serverComputedTotal.toFixed(2),
          initialPayment: initialPaymentRecorded,
          remainingDue,
        },
        transactionId,
        customerId,
        totalAmount: serverComputedTotal.toFixed(2),
        initialPayment: initialPaymentRecorded,
        remainingDue,
      };

      if (idempotencyKey && requestHash) {
        await storeIdempotencyRecord(client, {
          key: idempotencyKey,
          action: 'CREATE_TRANSACTION',
          requestHash,
          responseStatus: 201,
          responseBody: responsePayload,
        });
      }

      await enqueueOutboxEvent(client, {
        aggregateType: 'customer',
        aggregateId: customerId,
        eventType: 'khata.udhar_created',
        businessDate,
        payload: {
          transactionId,
          productIds: verifiedItems.map((item) => item.productId),
        },
      });

      await client.query('COMMIT');
      notifyOutboxCommitted();
      return responsePayload;
    } catch (err: unknown) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Records a Customer Payment and allocates it using strict FIFO order to oldest outstanding transactions.
   * Uses exact Decimal arithmetic and shared 24-hour TTL idempotency protection.
   */
  public async recordPayment(
    customerId: number,
    rawAmount: number | string,
    note?: string | null,
    idempotencyKey?: string | null
  ) {
    const payDec = validateMoneyInput(rawAmount, 'Payment amount');
    if (payDec.isZero()) {
      throw new AppError('Payment amount must be greater than zero.', 400, 'VALIDATION_ERROR');
    }

    const cleanKey = idempotencyKey?.trim() || null;
    const requestHash = cleanKey
      ? hashIdempotencyPayload({
          customerId,
          amount: payDec.toFixed(2),
          note: note?.trim() || null,
        })
      : null;

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      if (cleanKey && requestHash) {
        await acquireIdempotencyLock(client, cleanKey);
        const existingIdemp = await checkIdempotencyRecord(
          client,
          cleanKey,
          'RECORD_PAYMENT',
          requestHash
        );
        if (existingIdemp.found && !existingIdemp.expired) {
          await client.query('COMMIT');
          return existingIdemp.responseBody;
        }
        await cleanupExpiredIdempotencyKeys(client, 100);
      }

      // 1. Lock customer row FOR UPDATE
      const custRes = await client.query('SELECT id, name FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
      if (custRes.rows.length === 0) {
        throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
      }

      // 2. Compute current total outstanding for customer using independent aggregates
      const balanceRes = await client.query(
        `SELECT
          COALESCE(
            (SELECT SUM(total_amount) FROM udhar_transactions WHERE customer_id = $1), 0
          )::numeric AS total_udhar,
          COALESCE(
            (SELECT SUM(pa.amount) FROM payment_allocations pa JOIN udhar_transactions t ON t.id = pa.transaction_id WHERE t.customer_id = $1), 0
          )::numeric AS total_allocated`,
        [customerId]
      );

      const totalUdharDec = new Decimal(balanceRes.rows[0]?.total_udhar || '0');
      const totalAllocatedDec = new Decimal(balanceRes.rows[0]?.total_allocated || '0');
      const currentOutstandingDec = Decimal.max(0, totalUdharDec.minus(totalAllocatedDec));

      if (payDec.greaterThan(currentOutstandingDec)) {
        throw new AppError(
          `Payment amount (₹${payDec.toFixed(2)}) cannot exceed customer total outstanding due (₹${currentOutstandingDec.toFixed(2)}).`,
          400,
          'PAYMENT_EXCEEDS_BALANCE'
        );
      }

      // 3. Insert Payment record
      const payRes = await client.query(
        `INSERT INTO payments (customer_id, amount, received_at, note)
         VALUES ($1, $2, NOW(), $3)
         RETURNING id, amount, received_at`,
        [customerId, payDec.toFixed(2), note || null]
      );
      const paymentId = parseInt(payRes.rows[0].id, 10);

      // 4. Lock customer transaction rows with clean non-aggregated FOR UPDATE (PostgreSQL syntax compliant)
      const lockedTxRes = await client.query(
        `SELECT
          id,
          total_amount,
          transaction_date,
          created_at
         FROM udhar_transactions
         WHERE customer_id = $1
         ORDER BY transaction_date ASC, created_at ASC, id ASC
         FOR UPDATE`,
        [customerId]
      );

      // 5. Query allocations for this customer's transactions without FOR UPDATE
      const allocsRes = await client.query(
        `SELECT
          pa.transaction_id,
          COALESCE(SUM(pa.amount), 0)::numeric AS allocated_amount
         FROM payment_allocations pa
         JOIN udhar_transactions t ON t.id = pa.transaction_id
         WHERE t.customer_id = $1
         GROUP BY pa.transaction_id`,
        [customerId]
      );
      const allocMap = new Map<string, Decimal>();
      for (const row of allocsRes.rows) {
        allocMap.set(row.transaction_id.toString(), new Decimal(row.allocated_amount));
      }

      let remainingToAllocate = new Decimal(payDec);
      const allocationDetails: Array<{ transactionId: number; allocated: string }> = [];

      for (const tx of lockedTxRes.rows) {
        if (remainingToAllocate.lessThanOrEqualTo(0)) break;

        const txTotal = new Decimal(tx.total_amount);
        const txAllocated = allocMap.get(tx.id.toString()) || new Decimal(0);
        const txDue = txTotal.minus(txAllocated);

        if (txDue.lessThanOrEqualTo(0)) continue;

        const allocationAmount = Decimal.min(remainingToAllocate, txDue);

        await client.query(
          `INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [paymentId, tx.id, customerId, allocationAmount.toFixed(2)]
        );

        allocationDetails.push({
          transactionId: parseInt(tx.id, 10),
          allocated: allocationAmount.toFixed(2),
        });

        remainingToAllocate = remainingToAllocate.minus(allocationAmount);
      }

      const newOutstanding = Decimal.max(0, currentOutstandingDec.minus(payDec)).toFixed(2);

      const responsePayload = {
        success: true,
        data: {
          paymentId,
          customerId,
          amountPaid: payDec.toFixed(2),
          newOutstanding,
          allocations: allocationDetails,
        },
        paymentId,
        customerId,
        amount: payDec.toFixed(2),
        newOutstanding,
        allocations: allocationDetails,
      };

      if (cleanKey && requestHash) {
        await storeIdempotencyRecord(client, {
          key: cleanKey,
          action: 'RECORD_PAYMENT',
          requestHash,
          responseStatus: 201,
          responseBody: responsePayload,
        });
      }

      await enqueueOutboxEvent(client, {
        aggregateType: 'customer',
        aggregateId: customerId,
        eventType: 'khata.payment_recorded',
        businessDate: getBusinessDateISO(env.BUSINESS_TIME_ZONE),
        payload: { paymentId },
      });

      await client.query('COMMIT');
      notifyOutboxCommitted();
      return responsePayload;
    } catch (err: unknown) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export const khataService = new KhataService();
