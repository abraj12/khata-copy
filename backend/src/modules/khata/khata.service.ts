import { appPool } from '../../config/database.js';
import { authService } from '../auth/auth.service.js';

export interface CustomerSummaryItem {
  id: number;
  name: string;
  phone: string | null;
  totalUdhar: string;
  totalReceived: string;
  outstanding: string;
  lastActivity: string | null;
}

export interface KhataOverviewSummary {
  totalCustomers: number;
  totalOutstanding: string;
  totalReceived: string;
}

export interface UdharItemInput {
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
  items: UdharItemInput[];
  initialPayment?: number | string | null;
  note?: string | null;
}

export class KhataService {
  /**
   * Normalizes customer Indian phone number to canonical +91XXXXXXXXXX format
   */
  public normalizeCustomerPhone(rawPhone?: string | null): string | null {
    if (!rawPhone || !rawPhone.trim()) return null;
    const digits10 = authService.normalizePhone(rawPhone);
    if (!digits10) {
      throw new Error('Invalid Indian mobile number. Enter a valid 10-digit number or +91 format.');
    }
    return `+91${digits10}`;
  }

  /**
   * Dashboard Global Overview Summary
   */
  public async getSummary(): Promise<KhataOverviewSummary> {
    const query = `
      SELECT
        COUNT(DISTINCT c.id) FILTER (WHERE t.id IS NOT NULL) AS total_customers,
        COALESCE(SUM(t.total_amount), 0) - COALESCE(SUM(pa.amount), 0) AS total_outstanding,
        COALESCE((SELECT SUM(amount) FROM payments), 0) AS total_received
      FROM customers c
      INNER JOIN udhar_transactions t ON t.customer_id = c.id
      LEFT JOIN payment_allocations pa ON pa.transaction_id = t.id
    `;

    const result = await appPool.query(query);
    const row = result.rows[0];

    const outstanding = Math.max(0, parseFloat(row?.total_outstanding || '0')).toFixed(2);
    const received = parseFloat(row?.total_received || '0').toFixed(2);
    const totalCustomers = parseInt(row?.total_customers || '0', 10);

    return {
      totalCustomers,
      totalOutstanding: outstanding,
      totalReceived: received,
    };
  }

  /**
   * List of customers with lifetime Udhar, received payments, and current balance
   */
  public async listCustomers(search?: string): Promise<CustomerSummaryItem[]> {
    let sql = `
      SELECT
        c.id,
        c.name,
        c.phone,
        COALESCE(SUM(t.total_amount), 0) AS total_udhar,
        COALESCE((
          SELECT SUM(p.amount)
          FROM payments p
          WHERE p.customer_id = c.id
        ), 0) AS total_received,
        MAX(t.created_at) AS last_activity
      FROM customers c
      INNER JOIN udhar_transactions t ON t.customer_id = c.id
    `;

    const params: unknown[] = [];
    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      sql += ` WHERE (c.normalized_name ILIKE $1 OR c.phone ILIKE $1) `;
    }

    sql += `
      GROUP BY c.id, c.name, c.phone
      ORDER BY last_activity DESC NULLS LAST, c.name ASC
    `;

    const result = await appPool.query(sql, params);

    return result.rows.map((row) => {
      const udhar = parseFloat(row.total_udhar || '0');
      const received = parseFloat(row.total_received || '0');
      const outstanding = Math.max(0, udhar - received).toFixed(2);

      return {
        id: parseInt(row.id, 10),
        name: row.name,
        phone: row.phone,
        totalUdhar: udhar.toFixed(2),
        totalReceived: received.toFixed(2),
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
      SELECT
        c.id,
        c.name,
        c.phone,
        COALESCE(SUM(t.total_amount), 0) AS total_udhar,
        COALESCE((
          SELECT SUM(p.amount)
          FROM payments p
          WHERE p.customer_id = c.id
        ), 0) AS total_received,
        MAX(t.created_at) AS last_activity
      FROM customers c
      LEFT JOIN udhar_transactions t ON t.customer_id = c.id
      WHERE c.id = $1
      GROUP BY c.id, c.name, c.phone
    `;

    const result = await appPool.query(query, [customerId]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const udhar = parseFloat(row.total_udhar || '0');
    const received = parseFloat(row.total_received || '0');
    const outstanding = Math.max(0, udhar - received).toFixed(2);

    return {
      id: parseInt(row.id, 10),
      name: row.name,
      phone: row.phone,
      totalUdhar: udhar.toFixed(2),
      totalReceived: received.toFixed(2),
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

    // Fetch transactions with line items
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
      ORDER BY t.transaction_date DESC, t.created_at DESC
    `;
    const txRes = await appPool.query(txQuery, [customerId]);

    const txIds = txRes.rows.map((r) => r.id);
    let itemsByTxId: Record<string, unknown[]> = {};

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
      const total = parseFloat(t.total_amount);
      const paid = parseFloat(t.allocated_payment);
      return {
        id: parseInt(t.id, 10),
        transactionDate: t.transaction_date,
        totalAmount: total.toFixed(2),
        allocatedPayment: paid.toFixed(2),
        outstanding: Math.max(0, total - paid).toFixed(2),
        isSettled: total - paid <= 0.001,
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
       ORDER BY p.received_at DESC`,
      [customerId]
    );

    const payments = paymentsRes.rows.map((p) => ({
      id: parseInt(p.id, 10),
      amount: parseFloat(p.amount).toFixed(2),
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
   */
  public async createTransaction(input: CreateTransactionInput) {
    if (!input.items || input.items.length === 0) {
      throw new Error('At least one item is required for an Udhar transaction.');
    }

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // 1. Resolve Customer
      let customerId: number;
      const rawName = input.customer.name.trim();
      if (!rawName) throw new Error('Customer name is required.');

      const normName = rawName.toLowerCase();
      const normPhone = this.normalizeCustomerPhone(input.customer.phone);

      if (input.customer.id) {
        // Explicitly selected customer
        const custRes = await client.query(
          'SELECT id, name, phone FROM customers WHERE id = $1 FOR UPDATE',
          [input.customer.id]
        );
        if (custRes.rows.length === 0) {
          throw new Error('Selected customer not found.');
        }
        customerId = parseInt(custRes.rows[0].id, 10);
      } else {
        // Customer resolution by phone or exact name
        let matchedCustomer = null;
        if (normPhone) {
          const phoneRes = await client.query(
            'SELECT id, name, phone FROM customers WHERE normalized_phone = $1 FOR UPDATE',
            [normPhone]
          );
          if (phoneRes.rows.length > 0) {
            matchedCustomer = phoneRes.rows[0];
          }
        }

        if (matchedCustomer) {
          customerId = parseInt(matchedCustomer.id, 10);
        } else {
          // Create new customer
          const newCust = await client.query(
            `INSERT INTO customers (name, normalized_name, phone, normalized_phone, created_at, updated_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW())
             RETURNING id`,
            [rawName, normName, input.customer.phone ? input.customer.phone.trim() : null, normPhone]
          );
          customerId = parseInt(newCust.rows[0].id, 10);
        }
      }

      // 2. Validate Items & Snapshot Products from DB
      const verifiedItems: Array<{
        productId: number;
        nameSnapshot: string;
        buyingPriceSnapshot: string;
        quantity: number;
        sellingPrice: number;
        lineTotal: number;
      }> = [];

      let serverComputedTotal = 0;

      for (const item of input.items) {
        const prodId = Number(item.productId);
        const qty = Number(item.quantity);
        const sellPrice = Number(item.sellingPrice);

        if (isNaN(qty) || qty <= 0) {
          throw new Error(`Quantity for product ID ${prodId} must be greater than zero.`);
        }
        if (isNaN(sellPrice) || sellPrice < 0) {
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

        const lineTotal = Math.round(qty * sellPrice * 100) / 100;
        serverComputedTotal = Math.round((serverComputedTotal + lineTotal) * 100) / 100;

        verifiedItems.push({
          productId: prodId,
          nameSnapshot: product.name,
          buyingPriceSnapshot: product.buying_price,
          quantity: qty,
          sellingPrice: sellPrice,
          lineTotal,
        });
      }

      if (serverComputedTotal <= 0) {
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
            item.sellingPrice.toFixed(2),
            item.lineTotal.toFixed(2),
          ]
        );
      }

      // 5. Initial Payment Handling (if provided)
      let initialPaymentRecorded = '0.00';
      if (input.initialPayment !== undefined && input.initialPayment !== null && input.initialPayment !== '') {
        const initPay = Number(input.initialPayment);
        if (isNaN(initPay) || initPay < 0) {
          throw new Error('Initial payment must be a valid non-negative number.');
        }

        if (initPay > serverComputedTotal) {
          throw new Error(`Initial payment (₹${initPay.toFixed(2)}) cannot exceed transaction total (₹${serverComputedTotal.toFixed(2)}).`);
        }

        if (initPay > 0) {
          const payRes = await client.query(
            `INSERT INTO payments (customer_id, amount, received_at, note)
             VALUES ($1, $2, NOW(), $3)
             RETURNING id, amount`,
            [customerId, initPay.toFixed(2), 'Initial payment at Udhar creation']
          );
          const paymentId = parseInt(payRes.rows[0].id, 10);

          await client.query(
            `INSERT INTO payment_allocations (payment_id, transaction_id, amount, created_at)
             VALUES ($1, $2, $3, NOW())`,
            [paymentId, transactionId, initPay.toFixed(2)]
          );

          initialPaymentRecorded = initPay.toFixed(2);
        }
      }

      await client.query('COMMIT');

      const remainingDue = (serverComputedTotal - parseFloat(initialPaymentRecorded)).toFixed(2);

      return {
        success: true,
        transactionId,
        customerId,
        totalAmount: serverComputedTotal.toFixed(2),
        initialPayment: initialPaymentRecorded,
        remainingDue,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Records a Customer Payment and allocates it using strict FIFO order to oldest outstanding transactions
   */
  public async recordPayment(customerId: number, rawAmount: number | string, note?: string | null) {
    const payAmount = Number(rawAmount);
    if (isNaN(payAmount) || payAmount <= 0) {
      throw new Error('Payment amount must be greater than zero.');
    }

    const roundedPayment = Math.round(payAmount * 100) / 100;

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // 1. Lock customer row FOR UPDATE to prevent concurrent payment races
      const custRes = await client.query(
        'SELECT id, name FROM customers WHERE id = $1 FOR UPDATE',
        [customerId]
      );
      if (custRes.rows.length === 0) {
        throw new Error('Customer not found.');
      }

      // 2. Compute current total outstanding for customer
      const balanceRes = await client.query(
        `SELECT
          COALESCE(SUM(t.total_amount), 0) - COALESCE(
            (SELECT SUM(amount) FROM payments WHERE customer_id = $1), 0
          ) AS outstanding
         FROM udhar_transactions t
         WHERE t.customer_id = $1`,
        [customerId]
      );

      const currentOutstanding = Math.max(0, parseFloat(balanceRes.rows[0]?.outstanding || '0'));

      if (roundedPayment > currentOutstanding) {
        throw new Error(
          `Payment amount (₹${roundedPayment.toFixed(2)}) cannot exceed customer total outstanding due (₹${currentOutstanding.toFixed(2)}).`
        );
      }

      // 3. Insert Payment record
      const payRes = await client.query(
        `INSERT INTO payments (customer_id, amount, received_at, note)
         VALUES ($1, $2, NOW(), $3)
         RETURNING id, amount, received_at`,
        [customerId, roundedPayment.toFixed(2), note || null]
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
         ORDER BY t.transaction_date ASC, t.created_at ASC, t.id ASC`,
        [customerId]
      );

      let remainingToAllocate = roundedPayment;
      const allocationDetails = [];

      for (const tx of outstandingTxRes.rows) {
        if (remainingToAllocate <= 0) break;

        const txTotal = parseFloat(tx.total_amount);
        const txAllocated = parseFloat(tx.allocated_amount);
        const txDue = Math.round((txTotal - txAllocated) * 100) / 100;

        if (txDue <= 0) continue;

        const allocationAmount = Math.min(remainingToAllocate, txDue);

        await client.query(
          `INSERT INTO payment_allocations (payment_id, transaction_id, amount, created_at)
           VALUES ($1, $2, $3, NOW())`,
          [paymentId, tx.id, allocationAmount.toFixed(2)]
        );

        allocationDetails.push({
          transactionId: parseInt(tx.id, 10),
          allocated: allocationAmount.toFixed(2),
        });

        remainingToAllocate = Math.round((remainingToAllocate - allocationAmount) * 100) / 100;
      }

      await client.query('COMMIT');

      const newOutstanding = Math.max(0, currentOutstanding - roundedPayment).toFixed(2);

      return {
        success: true,
        paymentId,
        customerId,
        amount: roundedPayment.toFixed(2),
        newOutstanding,
        allocations: allocationDetails,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const khataService = new KhataService();
