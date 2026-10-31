import crypto from 'crypto';
import { Decimal } from 'decimal.js';
import { appPool } from '../../config/database.js';

// Configure Decimal globally for money arithmetic
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface CustomerSummaryItem {
  id: number;
  name: string;
  phone: string | null;
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
   */
  public normalizeCustomerPhone(phone?: string | null): string | null {
    if (!phone || typeof phone !== 'string') return null;
    let cleaned = phone.replace(/[\s\-()]/g, '');
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
    return null;
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
   * Searchable Customer List with independent pre-aggregated totals
   */
  public async listCustomers(search?: string): Promise<CustomerSummaryItem[]> {
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
          COALESCE(SUM(amount), 0)::numeric AS total_received
        FROM payments
        GROUP BY customer_id
      )
      SELECT
        c.id,
        c.name,
        c.phone,
        COALESCE(tx.total_udhar, 0)::numeric AS total_udhar,
        COALESCE(pay.total_received, 0)::numeric AS total_received,
        GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0)::numeric AS outstanding,
        tx.last_activity
      FROM customers c
      INNER JOIN customer_tx tx ON tx.customer_id = c.id
      LEFT JOIN customer_alloc alloc ON alloc.customer_id = c.id
      LEFT JOIN customer_pay pay ON pay.customer_id = c.id
    `;

    const params: unknown[] = [];
    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      sql += ` WHERE (c.normalized_name ILIKE $1 OR c.phone ILIKE $1) `;
    }

    sql += ` ORDER BY tx.last_activity DESC NULLS LAST, c.name ASC `;

    const result = await appPool.query(sql, params);

    return result.rows.map((row) => {
      const udhar = new Decimal(row.total_udhar || '0').toFixed(2);
      const received = new Decimal(row.total_received || '0').toFixed(2);
      const outstanding = new Decimal(row.outstanding || '0').toFixed(2);

      return {
        id: parseInt(row.id, 10),
        name: row.name,
        phone: row.phone,
        totalUdhar: udhar,
        totalReceived: received,
        outstanding,
        lastActivity: row.last_activity,
      };
    });
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
          COALESCE(SUM(amount), 0)::numeric AS total_received
        FROM payments
        WHERE customer_id = $1
        GROUP BY customer_id
      )
      SELECT
        c.id,
        c.name,
        c.phone,
        COALESCE(tx.total_udhar, 0)::numeric AS total_udhar,
        COALESCE(pay.total_received, 0)::numeric AS total_received,
        GREATEST(COALESCE(tx.total_udhar, 0) - COALESCE(alloc.total_allocated, 0), 0)::numeric AS outstanding,
        tx.last_activity
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
      throw new Error('At least one item is required for an Udhar transaction.');
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
            const conflictErr = new Error('Idempotency key reused with different request payload.');
            (conflictErr as unknown as { status: number }).status = 409;
            throw conflictErr;
          }
        }
      }

      // 1. Resolve Customer safely
      let customerId: number;
      const rawName = input.customer.name.trim();
      if (!rawName) throw new Error('Customer name is required.');

      const normName = this.normalizeName(rawName);
      const normPhone = this.normalizeCustomerPhone(input.customer.phone);

      if (input.customer.id) {
        // Explicitly selected customer
        const custRes = await client.query(
          'SELECT id, name, phone, normalized_phone FROM customers WHERE id = $1 FOR UPDATE',
          [input.customer.id]
        );
        if (custRes.rows.length === 0) {
          throw new Error('Selected customer not found.');
        }
        const existing = custRes.rows[0];
        if (normPhone && existing.normalized_phone && existing.normalized_phone !== normPhone) {
          const conflictErr = new Error(
            `Customer #${existing.id} already has phone ${existing.phone}. Cannot overwrite with ${input.customer.phone}.`
          );
          (conflictErr as unknown as { status: number }).status = 409;
          throw conflictErr;
        }
        customerId = parseInt(existing.id, 10);
      } else {
        // Customer resolution by phone or exact normalized name
        let matchedCustomer = null;
        if (normPhone) {
          const phoneRes = await client.query(
            'SELECT id, name, phone, normalized_name FROM customers WHERE normalized_phone = $1 FOR UPDATE',
            [normPhone]
          );
          if (phoneRes.rows.length > 0) {
            matchedCustomer = phoneRes.rows[0];
          }
        }

        if (matchedCustomer) {
          customerId = parseInt(matchedCustomer.id, 10);
        } else if (normPhone) {
          // Phone provided but no phone match. Check if name matches someone with another phone
          const nameMatches = await client.query(
            'SELECT id, name, phone FROM customers WHERE normalized_name = $1 FOR UPDATE',
            [normName]
          );
          if (nameMatches.rows.length > 0 && nameMatches.rows.some((c) => c.phone !== null)) {
            const conflictErr = new Error(
              `A customer named "${rawName}" already exists with a different phone number. Please select the customer explicitly or verify identity.`
            );
            (conflictErr as unknown as { status: number }).status = 409;
            throw conflictErr;
          }

          const newCust = await client.query(
            `INSERT INTO customers (name, normalized_name, phone, normalized_phone, created_at, updated_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW())
             RETURNING id`,
            [rawName, normName, input.customer.phone ? input.customer.phone.trim() : null, normPhone]
          );
          customerId = parseInt(newCust.rows[0].id, 10);
        } else {
          // No phone provided. Search by exact normalized name
          const nameMatches = await client.query(
            'SELECT id, name, phone FROM customers WHERE normalized_name = $1 FOR UPDATE',
            [normName]
          );
          if (nameMatches.rows.length === 1) {
            // Exactly one match: safely reuse
            customerId = parseInt(nameMatches.rows[0].id, 10);
          } else if (nameMatches.rows.length > 1) {
            // Ambiguous matches: reject with 409 AMBIGUOUS_CUSTOMER_MATCH
            const conflictErr = new Error(
              `Multiple customers found matching "${rawName}". Please specify customer ID or phone.`
            );
            (conflictErr as unknown as { status: number; code: string; candidates: unknown[] }).status = 409;
            (conflictErr as unknown as { status: number; code: string; candidates: unknown[] }).code = 'AMBIGUOUS_CUSTOMER_MATCH';
            (conflictErr as unknown as { status: number; code: string; candidates: unknown[] }).candidates = nameMatches.rows;
            throw conflictErr;
          } else {
            // 0 matches: create new customer
            const newCust = await client.query(
              `INSERT INTO customers (name, normalized_name, phone, normalized_phone, created_at, updated_at)
               VALUES ($1, $2, NULL, NULL, NOW(), NOW())
               RETURNING id`,
              [rawName, normName]
            );
            customerId = parseInt(newCust.rows[0].id, 10);
          }
        }
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
        const qtyDec = new Decimal(item.quantity);
        const sellPriceDec = new Decimal(item.sellingPrice);

        if (qtyDec.isNaN() || qtyDec.lessThanOrEqualTo(0)) {
          throw new Error(`Quantity for product ID ${prodId} must be greater than zero.`);
        }
        if (sellPriceDec.isNaN() || sellPriceDec.lessThan(0)) {
          throw new Error(`Selling price for product ID ${prodId} must be non-negative.`);
        }

        const prodRes = await client.query(
          'SELECT id, name, buying_price, archived_at FROM products WHERE id = $1',
          [prodId]
        );

        if (prodRes.rows.length === 0) {
          throw new Error(`Product with ID ${prodId} does not exist.`);
        }

        const product = prodRes.rows[0];
        if (product.archived_at) {
          throw new Error(`Product "${product.name}" is archived and cannot be selected for new Udhar.`);
        }

        const lineTotalDec = qtyDec.times(sellPriceDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        serverComputedTotal = serverComputedTotal.plus(lineTotalDec);

        verifiedItems.push({
          productId: prodId,
          nameSnapshot: product.name,
          buyingPriceSnapshot: new Decimal(product.buying_price).toFixed(2),
          quantity: qtyDec.toFixed(3),
          sellingPrice: sellPriceDec.toFixed(2),
          lineTotal: lineTotalDec.toFixed(2),
        });
      }

      if (serverComputedTotal.lessThanOrEqualTo(0)) {
        throw new Error('Transaction total must be greater than zero.');
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
        const initPayDec = new Decimal(input.initialPayment).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        if (initPayDec.isNaN() || initPayDec.lessThan(0)) {
          throw new Error('Initial payment must be a valid non-negative number.');
        }

        if (initPayDec.greaterThan(serverComputedTotal)) {
          throw new Error(
            `Initial payment (₹${initPayDec.toFixed(2)}) cannot exceed transaction total (₹${serverComputedTotal.toFixed(2)}).`
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
            `INSERT INTO payment_allocations (payment_id, transaction_id, amount, created_at)
             VALUES ($1, $2, $3, NOW())`,
            [paymentId, transactionId, initPayDec.toFixed(2)]
          );

          initialPaymentRecorded = initPayDec.toFixed(2);
        }
      }

      const remainingDue = serverComputedTotal.minus(new Decimal(initialPaymentRecorded)).toFixed(2);

      const responsePayload = {
        success: true,
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
    } catch (err) {
      await client.query('ROLLBACK');
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
    const payDec = new Decimal(rawAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (payDec.isNaN() || payDec.lessThanOrEqualTo(0)) {
      throw new Error('Payment amount must be greater than zero.');
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
            const conflictErr = new Error('Idempotency key reused with different request payload.');
            (conflictErr as unknown as { status: number }).status = 409;
            throw conflictErr;
          }
        }
      }

      // 1. Lock customer row FOR UPDATE
      const custRes = await client.query(
        'SELECT id, name FROM customers WHERE id = $1 FOR UPDATE',
        [customerId]
      );
      if (custRes.rows.length === 0) {
        throw new Error('Customer not found.');
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
        throw new Error(
          `Payment amount (₹${payDec.toFixed(2)}) cannot exceed customer total outstanding due (₹${currentOutstandingDec.toFixed(2)}).`
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

      // 4. Fetch outstanding transactions in FIFO order (oldest transaction_date, created_at, id)
      const outstandingTxRes = await client.query(
        `SELECT
          t.id,
          t.total_amount,
          COALESCE(SUM(pa.amount), 0) AS allocated_amount
         FROM udhar_transactions t
         LEFT JOIN payment_allocations pa ON pa.transaction_id = t.id
         WHERE t.customer_id = $1
         GROUP BY t.id, t.transaction_date, t.created_at
         HAVING t.total_amount > COALESCE(SUM(pa.amount), 0)
         ORDER BY t.transaction_date ASC, t.created_at ASC, t.id ASC FOR UPDATE OF t`,
        [customerId]
      );

      let remainingToAllocate = new Decimal(payDec);
      const allocationDetails = [];

      for (const tx of outstandingTxRes.rows) {
        if (remainingToAllocate.lessThanOrEqualTo(0)) break;

        const txTotal = new Decimal(tx.total_amount);
        const txAllocated = new Decimal(tx.allocated_amount);
        const txDue = txTotal.minus(txAllocated);

        if (txDue.lessThanOrEqualTo(0)) continue;

        const allocationAmount = Decimal.min(remainingToAllocate, txDue);

        await client.query(
          `INSERT INTO payment_allocations (payment_id, transaction_id, amount, created_at)
           VALUES ($1, $2, $3, NOW())`,
          [paymentId, tx.id, allocationAmount.toFixed(2)]
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
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const khataService = new KhataService();
