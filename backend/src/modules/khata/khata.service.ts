import { AppError } from '../../utils/errors.js';
import crypto from 'crypto';
import { Decimal } from 'decimal.js';
import { appPool } from '../../config/database.js';
import { validateMoneyInput, validateDecimalQuantityInput, escapeLike } from '../../utils/validation.js';

// Configure Decimal globally for money arithmetic
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface CustomerSummaryItem {
  id: number;
  name: string;
  phone: string | null;
  address?: string | null;
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
  };
  items: CreateTransactionItemInput[];
  initialPayment?: number | string | null;
  note?: string | null;
  idempotencyKey?: string | null;
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

    throw new AppError('Invalid phone number format. Must be a valid 10-digit Indian mobile number.', 400, 'INVALID_PHONE_FORMAT');
  }

  /**
   * Computes SHA-256 hash for idempotency payload comparison
   */
  private hashPayload(payload: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
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
   * Searchable Customer List with independent pre-aggregated totals and bounded pagination
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
        COALESCE(tx.total_udhar, 0)::numeric AS total_udhar,
        COALESCE(pay.total_received, 0)::numeric AS total_received,
        GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0)::numeric AS outstanding,
        GREATEST(tx.last_activity, pay.last_payment) AS last_activity
      FROM customers c
      INNER JOIN customer_tx tx ON tx.customer_id = c.id
      LEFT JOIN customer_alloc alloc ON alloc.customer_id = c.id
      LEFT JOIN customer_pay pay ON pay.customer_id = c.id
    `;

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
        sql += ` WHERE (c.normalized_name ILIKE $1 OR c.phone ILIKE $1 OR c.normalized_phone ILIKE $2) `;
      } else {
        sql += ` WHERE (c.normalized_name ILIKE $1 OR c.phone ILIKE $1) `;
      }
    }

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
   * Customer Profile & Balance Summary
   */
  public async getCustomerDetail(customerId: number): Promise<CustomerSummaryItem | null> {
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
        COALESCE(tx.total_udhar, 0)::numeric AS total_udhar,
        COALESCE(pay.total_received, 0)::numeric AS total_received,
        GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0)::numeric AS outstanding,
        GREATEST(tx.last_activity, pay.last_payment) AS last_activity
      FROM customers c
      LEFT JOIN customer_tx tx ON tx.customer_id = c.id
      LEFT JOIN customer_alloc alloc ON alloc.customer_id = c.id
      LEFT JOIN customer_pay pay ON pay.customer_id = c.id
      WHERE c.id = $1
    `;

    const result = await appPool.query(query, [customerId]);
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
      totalUdhar: udhar,
      totalReceived: received,
      outstanding,
      lastActivity: row.last_activity,
    };
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
   * Creates a new Udhar Transaction with line items and optional initial payment atomically
   * Supports Idempotency-Key and safe customer resolution
   */
  public async createTransaction(input: CreateTransactionInput) {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one item is required for an Udhar transaction.', 400, 'VALIDATION_ERROR');
    }

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // Idempotency check
      if (input.idempotencyKey) {
        const idempRes = await client.query(
          'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1',
          [input.idempotencyKey]
        );
        if (idempRes.rows.length > 0) {
          const row = idempRes.rows[0];
          const currentHash = this.hashPayload({
            customer: input.customer,
            items: input.items,
            initialPayment: input.initialPayment,
            note: input.note,
          });
          if (row.request_hash === currentHash) {
            await client.query('COMMIT');
            return row.response_body;
          } else {
            throw new AppError('Idempotency key reused with different request payload.', 409, 'IDEMPOTENCY_CONFLICT');
          }
        }
      }

      // 1. Resolve Customer safely
      let customerId: number;
      const rawName = input.customer.name.trim();
      if (!rawName) throw new AppError('Customer name is required.', 400, 'VALIDATION_ERROR');

      const normName = this.normalizeName(rawName);
      const normPhone = this.normalizeCustomerPhone(input.customer.phone);
      const custAddr = input.customer.address ? input.customer.address.trim() : null;

      if (input.customer.id) {
        // Explicitly selected customer
        const custRes = await client.query(
          'SELECT id, name, phone, normalized_phone FROM customers WHERE id = $1 FOR UPDATE',
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
            'UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2 AND (address IS NULL OR address = \'\')',
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
          // Phone provided, but no customer found with this phone yet.
          // Check if exactly one customer with matching normalized name exists and currently has NO phone
          const nameMatches = await client.query(
            'SELECT id, name, phone, normalized_phone FROM customers WHERE normalized_name = $1 FOR UPDATE',
            [normName]
          );

          if (nameMatches.rows.length === 1 && !nameMatches.rows[0].phone) {
            // Exactly one existing customer with no phone: safely attach phone under row lock!
            const existingCust = nameMatches.rows[0];
            await client.query(
              'UPDATE customers SET phone = $1, normalized_phone = $2, updated_at = NOW() WHERE id = $3',
              [input.customer.phone ? input.customer.phone.trim() : normPhone, normPhone, existingCust.id]
            );
            customerId = parseInt(existingCust.id, 10);
          } else if (nameMatches.rows.length > 0 && nameMatches.rows.some((c) => c.phone !== null)) {
            // Name matches someone with a different phone -> reject to prevent accidental merge
            throw new AppError(
              `A customer named "${rawName}" already exists with a different phone number. Please select the customer explicitly or verify identity.`,
              409,
              'CUSTOMER_NAME_CONFLICT'
            );
          } else if (nameMatches.rows.length > 1) {
            // Multiple customers with the same name -> ambiguous
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
            // 0 matches: safe to insert new customer with the phone
            const newCust = await client.query(
              `INSERT INTO customers (name, normalized_name, phone, normalized_phone, address, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
               RETURNING id`,
              [rawName, normName, input.customer.phone ? input.customer.phone.trim() : null, normPhone, custAddr]
            );
            customerId = parseInt(newCust.rows[0].id, 10);
          }
        } else {
          // No phone provided. Search by exact normalized name
          const nameMatches = await client.query(
            'SELECT id, name, phone, address FROM customers WHERE normalized_name = $1 FOR UPDATE',
            [normName]
          );
          if (nameMatches.rows.length === 1) {
            // Exactly one match: safely reuse
            customerId = parseInt(nameMatches.rows[0].id, 10);
            if (custAddr && !nameMatches.rows[0].address) {
              await client.query(
                'UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2',
                [custAddr, customerId]
              );
            }
          } else if (nameMatches.rows.length > 1) {
            // Ambiguous matches: reject with 409 AMBIGUOUS_CUSTOMER_MATCH
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
            // 0 matches: create new customer without phone
            const newCust = await client.query(
              `INSERT INTO customers (name, normalized_name, phone, normalized_phone, address, created_at, updated_at)
               VALUES ($1, $2, NULL, NULL, $3, NOW(), NOW())
               RETURNING id`,
              [rawName, normName, custAddr]
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

      for (const item of input.items) {
        const prodId = Number(item.productId);
        const qtyDec = validateDecimalQuantityInput(item.quantity, `Item for product ID ${prodId} quantity`);
        const sellPriceDec = validateMoneyInput(item.sellingPrice, `Selling price for product ID ${prodId}`);

        const prodRes = await client.query(
          'SELECT id, name, buying_price, archived_at FROM products WHERE id = $1',
          [prodId]
        );

        if (prodRes.rows.length === 0) {
          throw new AppError(`Product with ID ${prodId} does not exist.`, 404, 'PRODUCT_NOT_FOUND');
        }

        const product = prodRes.rows[0];
        if (product.archived_at) {
          throw new AppError(`Product "${product.name}" is archived and cannot be selected for new Udhar.`, 400, 'PRODUCT_ARCHIVED');
        }

        const lineTotalDec = qtyDec.times(sellPriceDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        serverComputedTotal = serverComputedTotal.plus(lineTotalDec);

        verifiedItems.push({
          productId: prodId,
          nameSnapshot: product.name,
          buyingPriceSnapshot: new Decimal(product.buying_price).toFixed(2),
          quantity: qtyDec.toFixed(2),
          sellingPrice: sellPriceDec.toFixed(2),
          lineTotal: lineTotalDec.toFixed(2),
        });
      }

      if (serverComputedTotal.lessThanOrEqualTo(0)) {
        throw new AppError('Transaction total must be greater than zero.', 400, 'VALIDATION_ERROR');
      }

      // 3. Insert udhar_transactions
      const txRes = await client.query(
        `INSERT INTO udhar_transactions (customer_id, transaction_date, total_amount, note, created_at)
         VALUES ($1, CURRENT_DATE, $2, $3, NOW())
         RETURNING id, transaction_date, total_amount, note, created_at`,
        [customerId, serverComputedTotal.toFixed(2), input.note || null]
      );
      const transactionId = parseInt(txRes.rows[0].id, 10);

      // 4. Insert udhar_items snapshots
      for (const item of verifiedItems) {
        await client.query(
          `INSERT INTO udhar_items
            (transaction_id, product_id, product_name_snapshot, buying_price_snapshot, quantity, selling_price, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            transactionId,
            item.productId,
            item.nameSnapshot,
            item.buyingPriceSnapshot,
            item.quantity,
            item.sellingPrice,
            item.lineTotal,
          ]
        );
      }

      // 5. Initial Payment Handling (if provided)
      let initialPaymentRecorded = '0.00';
      if (input.initialPayment !== undefined && input.initialPayment !== null && input.initialPayment !== '') {
        const initPayDec = validateMoneyInput(input.initialPayment, 'Initial payment');

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

      // Save idempotency key if provided
      if (input.idempotencyKey) {
        const currentHash = this.hashPayload({
          customer: input.customer,
          items: input.items,
          initialPayment: input.initialPayment,
          note: input.note,
        });
        await client.query(
          `INSERT INTO idempotency_keys (key, action, request_hash, response_status, response_body, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [input.idempotencyKey, 'CREATE_TRANSACTION', currentHash, 201, JSON.stringify(responsePayload)]
        );
      }

      await client.query('COMMIT');
      return responsePayload;
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const pgErr = err as { code?: string; constraint?: string };
      if (input.idempotencyKey && pgErr?.code === '23505' && pgErr?.constraint?.includes('idempotency')) {
        const existingKeyRes = await appPool.query(
          'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1',
          [input.idempotencyKey]
        );
        if (existingKeyRes.rows.length > 0) {
          const row = existingKeyRes.rows[0];
          const currentHash = this.hashPayload({
            customer: input.customer,
            items: input.items,
            initialPayment: input.initialPayment,
            note: input.note,
          });
          if (row.request_hash === currentHash) {
            return row.response_body;
          } else {
            throw new AppError('Idempotency key reused with different request payload.', 409, 'IDEMPOTENCY_CONFLICT');
          }
        }
        throw new AppError('A request with this idempotency key is currently processing. Please retry in a moment.', 409, 'IDEMPOTENCY_IN_FLIGHT');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Records a Customer Payment and allocates it using strict FIFO order to oldest outstanding transactions
   * Uses exact Decimal arithmetic and idempotency protection
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

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // Idempotency check
      if (idempotencyKey) {
        const idempRes = await client.query(
          'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1',
          [idempotencyKey]
        );
        if (idempRes.rows.length > 0) {
          const row = idempRes.rows[0];
          const currentHash = this.hashPayload({ customerId, amount: payDec.toFixed(2), note: note || null });
          if (row.request_hash === currentHash) {
            await client.query('COMMIT');
            return row.response_body;
          } else {
            throw new AppError('Idempotency key reused with different request payload.', 409, 'IDEMPOTENCY_CONFLICT');
          }
        }
      }

      // 1. Lock customer row FOR UPDATE
      const custRes = await client.query(
        'SELECT id, name FROM customers WHERE id = $1 FOR UPDATE',
        [customerId]
      );
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

      // Save idempotency key if provided
      if (idempotencyKey) {
        const currentHash = this.hashPayload({ customerId, amount: payDec.toFixed(2), note: note || null });
        await client.query(
          `INSERT INTO idempotency_keys (key, action, request_hash, response_status, response_body, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [idempotencyKey, 'RECORD_PAYMENT', currentHash, 201, JSON.stringify(responsePayload)]
        );
      }

      await client.query('COMMIT');
      return responsePayload;
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const pgErr = err as { code?: string; constraint?: string };
      if (idempotencyKey && pgErr?.code === '23505' && pgErr?.constraint?.includes('idempotency')) {
        const existingKeyRes = await appPool.query(
          'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1',
          [idempotencyKey]
        );
        if (existingKeyRes.rows.length > 0) {
          const row = existingKeyRes.rows[0];
          const currentHash = this.hashPayload({ customerId, amount: payDec.toFixed(2), note: note || null });
          if (row.request_hash === currentHash) {
            return row.response_body;
          } else {
            throw new AppError('Idempotency key reused with different request payload.', 409, 'IDEMPOTENCY_CONFLICT');
          }
        }
        throw new AppError('A request with this idempotency key is currently processing. Please retry in a moment.', 409, 'IDEMPOTENCY_IN_FLIGHT');
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export const khataService = new KhataService();
