import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appPool } from '../src/config/database.js';
import { khataService } from '../src/modules/khata/khata.service.js';
import { productsService } from '../src/modules/products/products.service.js';
import { Decimal } from 'decimal.js';

interface ProductRow {
  id: string;
  name: string;
  buying_price: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface CustomerRow {
  id: string;
  name: string;
  normalized_name: string;
  phone: string | null;
  normalized_phone: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface UdharTxRow {
  id: string;
  customer_id: string;
  transaction_date: string;
  total_amount: string;
  note: string | null;
  created_at: string;
}

interface UdharItemRow {
  id: string;
  transaction_id: string;
  product_id: string | null;
  product_name_snapshot: string;
  buying_price_snapshot: string;
  quantity: string;
  selling_price: string;
  line_total: string;
}

interface PaymentRow {
  id: string;
  customer_id: string;
  amount: string;
  received_at: string;
  note: string | null;
}

interface PaymentAllocRow {
  id: string;
  payment_id: string;
  transaction_id: string;
  amount: string;
  created_at: string;
}

interface IdempotencyRow {
  key: string;
  action: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
  created_at: string;
}

// In-Memory PostgreSQL State Simulator for Unit/Integration Verification
class MockDatabaseState {
  public products: ProductRow[] = [];
  public customers: CustomerRow[] = [];
  public udharTransactions: UdharTxRow[] = [];
  public udharItems: UdharItemRow[] = [];
  public payments: PaymentRow[] = [];
  public paymentAllocations: PaymentAllocRow[] = [];
  public idempotencyKeys: IdempotencyRow[] = [];

  private nextId = 1;

  public reset() {
    this.products = [];
    this.customers = [];
    this.udharTransactions = [];
    this.udharItems = [];
    this.payments = [];
    this.paymentAllocations = [];
    this.idempotencyKeys = [];
    this.nextId = 1;
  }

  public async query(sql: string, params: unknown[] = []) {
    const s = sql.trim().toUpperCase();

    // 1. Transaction controls
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    // 2. Idempotency Keys Queries
    if (s.startsWith('SELECT REQUEST_HASH, RESPONSE_STATUS, RESPONSE_BODY FROM IDEMPOTENCY_KEYS')) {
      const key = params[0] as string;
      const found = this.idempotencyKeys.find((k) => k.key === key);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (s.startsWith('INSERT INTO IDEMPOTENCY_KEYS')) {
      const row: IdempotencyRow = {
        key: params[0] as string,
        action: params[1] as string,
        request_hash: params[2] as string,
        response_status: params[3] as number,
        response_body: JSON.parse(params[4] as string),
        created_at: new Date().toISOString(),
      };
      this.idempotencyKeys.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // 3. Products Queries
    if (s.startsWith('INSERT INTO PRODUCTS')) {
      const id = (this.nextId++).toString();
      const row: ProductRow = {
        id,
        name: params[0] as string,
        buying_price: params[1] as string,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        archived_at: null,
      };
      this.products.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (s.includes('FROM PRODUCTS') && s.includes('WHERE ID = $1')) {
      const prod = this.products.find((p) => p.id === params[0]?.toString());
      return { rows: prod ? [prod] : [], rowCount: prod ? 1 : 0 };
    }

    if (s.startsWith('SELECT') && s.includes('FROM PRODUCTS') && !s.includes('WHERE ID =')) {
      const active = this.products.filter((p) => !p.archived_at);
      return { rows: active, rowCount: active.length };
    }

    if (s.startsWith('UPDATE PRODUCTS') && s.includes('SET ARCHIVED_AT = NOW()')) {
      const prod = this.products.find((p) => p.id === params[0]?.toString() && !p.archived_at);
      if (prod) {
        prod.archived_at = new Date().toISOString();
        return { rows: [prod], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 4. Customers Queries
    if (s.includes('FROM CUSTOMERS') && s.includes('WHERE NORMALIZED_PHONE = $1 AND ID !=')) {
      const cust = this.customers.find(
        (c) => c.normalized_phone === params[0]?.toString() && c.id !== params[1]?.toString()
      );
      return { rows: cust ? [cust] : [], rowCount: cust ? 1 : 0 };
    }

    if (s.includes('FROM CUSTOMERS') && s.includes('WHERE ID = $1')) {
      const cust = this.customers.find((c) => c.id === params[0]?.toString());
      return { rows: cust ? [cust] : [], rowCount: cust ? 1 : 0 };
    }

    if (s.includes('FROM CUSTOMERS') && s.includes('WHERE NORMALIZED_PHONE = $1')) {
      const matches = this.customers.filter((c) => c.normalized_phone === params[0]?.toString());
      return { rows: matches, rowCount: matches.length };
    }

    if (s.includes('FROM CUSTOMERS') && s.includes('WHERE NORMALIZED_NAME = $1')) {
      const matches = this.customers.filter((c) => c.normalized_name === params[0]?.toString());
      return { rows: matches, rowCount: matches.length };
    }

    if (s.startsWith('UPDATE CUSTOMERS') && s.includes('SET PHONE = $1')) {
      const cust = this.customers.find((c) => c.id === params[2]?.toString());
      if (cust) {
        cust.phone = params[0] as string;
        cust.normalized_phone = params[1] as string;
        cust.updated_at = new Date().toISOString();
        return { rows: [cust], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (s.startsWith('INSERT INTO CUSTOMERS')) {
      const id = (this.nextId++).toString();
      const row: CustomerRow = {
        id,
        name: params[0] as string,
        normalized_name: params[1] as string,
        phone: (params[2] as string) || null,
        normalized_phone: (params[3] as string) || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        archived_at: null,
      };
      this.customers.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // 5. Udhar Transactions Queries
    if (s.startsWith('INSERT INTO UDHAR_TRANSACTIONS')) {
      const id = (this.nextId++).toString();
      const row: UdharTxRow = {
        id,
        customer_id: params[0]?.toString() as string,
        transaction_date: new Date().toISOString().split('T')[0],
        total_amount: params[1] as string,
        note: (params[2] as string) || null,
        created_at: new Date().toISOString(),
      };
      this.udharTransactions.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (s.startsWith('INSERT INTO UDHAR_ITEMS')) {
      const id = (this.nextId++).toString();
      const row: UdharItemRow = {
        id,
        transaction_id: params[0]?.toString() as string,
        product_id: params[1]?.toString() as string,
        product_name_snapshot: params[2] as string,
        buying_price_snapshot: params[3] as string,
        quantity: params[4]?.toString() as string,
        selling_price: params[5]?.toString() as string,
        line_total: params[6]?.toString() as string,
      };
      this.udharItems.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // 6. Payments Queries
    if (s.startsWith('INSERT INTO PAYMENTS')) {
      const id = (this.nextId++).toString();
      const row: PaymentRow = {
        id,
        customer_id: params[0]?.toString() as string,
        amount: params[1] as string,
        received_at: new Date().toISOString(),
        note: (params[2] as string) || null,
      };
      this.payments.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (s.startsWith('INSERT INTO PAYMENT_ALLOCATIONS')) {
      const id = (this.nextId++).toString();
      const row: PaymentAllocRow = {
        id,
        payment_id: params[0]?.toString() as string,
        transaction_id: params[1]?.toString() as string,
        amount: params[2] as string,
        created_at: new Date().toISOString(),
      };
      this.paymentAllocations.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // 7. Balance Calculation Lookups for Customer Payments
    if (s.includes('TOTAL_UDHAR') && s.includes('TOTAL_ALLOCATED') && s.includes('WHERE CUSTOMER_ID = $1')) {
      const custId = params[0]?.toString();
      const customerTxs = this.udharTransactions.filter((t) => t.customer_id === custId);
      const totalUdhar = customerTxs.reduce((sum, t) => sum + parseFloat(t.total_amount), 0);

      const customerTxIds = new Set(customerTxs.map((t) => t.id));
      const totalAllocated = this.paymentAllocations
        .filter((a) => customerTxIds.has(a.transaction_id))
        .reduce((sum, a) => sum + parseFloat(a.amount), 0);

      return {
        rows: [{ total_udhar: totalUdhar.toFixed(2), total_allocated: totalAllocated.toFixed(2) }],
        rowCount: 1,
      };
    }

    // Outstanding Transactions in FIFO order (Clean non-aggregated FOR UPDATE query)
    if (s.includes('FROM UDHAR_TRANSACTIONS') && s.includes('FOR UPDATE') && s.includes('WHERE CUSTOMER_ID = $1')) {
      const custId = params[0]?.toString();
      const customerTxs = this.udharTransactions
        .filter((t) => t.customer_id === custId)
        .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || a.created_at.localeCompare(b.created_at) || parseInt(a.id, 10) - parseInt(b.id, 10));

      return {
        rows: customerTxs.map((t) => ({
          id: t.id,
          total_amount: t.total_amount,
          transaction_date: t.transaction_date,
          created_at: t.created_at,
        })),
        rowCount: customerTxs.length,
      };
    }

    // Separate transaction allocations query without FOR UPDATE
    if (s.includes('FROM PAYMENT_ALLOCATIONS PA') && s.includes('GROUP BY PA.TRANSACTION_ID')) {
      const custId = params[0]?.toString();
      const customerTxIds = new Set(this.udharTransactions.filter((t) => t.customer_id === custId).map((t) => t.id));

      const allocationSums = {};
      for (const a of this.paymentAllocations) {
        if (customerTxIds.has(a.transaction_id)) {
          allocationSums[a.transaction_id] = (allocationSums[a.transaction_id] || 0) + parseFloat(a.amount);
        }
      }

      const rows = Object.entries(allocationSums).map(([txId, sum]) => ({
        transaction_id: txId,
        allocated_amount: sum.toFixed(2),
      }));

      return { rows, rowCount: rows.length };
    }

    if (s.includes('FROM UDHAR_TRANSACTIONS T') && s.includes('COALESCE(SUM(PA.AMOUNT), 0) AS ALLOCATED_AMOUNT')) {
      const custId = params[0]?.toString();
      const customerTxs = this.udharTransactions.filter((t) => t.customer_id === custId);

      const rows = [];
      for (const t of customerTxs) {
        const allocs = this.paymentAllocations.filter((a) => a.transaction_id === t.id);
        const allocSum = allocs.reduce((acc, curr) => acc + parseFloat(curr.amount), 0);
        const total = parseFloat(t.total_amount);

        if (total > allocSum) {
          rows.push({
            id: t.id,
            total_amount: t.total_amount,
            allocated_amount: allocSum.toFixed(2),
            transaction_date: t.transaction_date,
            created_at: t.created_at,
          });
        }
      }
      return { rows, rowCount: rows.length };
    }

    // 8. Global Summary Query (WITH transaction_totals AS ...)
    if (s.includes('TOTAL_OUTSTANDING') && (s.includes('TRANSACTION_TOTALS') || s.includes('CROSS JOIN'))) {
      const distinctCustomerIds = new Set(this.udharTransactions.map((t) => t.customer_id));
      const totalUdhar = this.udharTransactions.reduce((acc, t) => acc + parseFloat(t.total_amount), 0);
      const totalAllocated = this.paymentAllocations.reduce((acc, a) => acc + parseFloat(a.amount), 0);
      const totalPaid = this.payments.reduce((acc, p) => acc + parseFloat(p.amount), 0);
      const outstanding = Math.max(0, totalUdhar - totalAllocated);

      return {
        rows: [
          {
            total_customers: distinctCustomerIds.size.toString(),
            total_outstanding: outstanding.toFixed(2),
            total_received: totalPaid.toFixed(2),
          },
        ],
        rowCount: 1,
      };
    }

    // 9. List Customers Query (WITH customer_tx AS ...)
    if (s.includes('CUSTOMER_TX') && s.includes('FROM CUSTOMERS C')) {
      const distinctCustomerIds = Array.from(new Set(this.udharTransactions.map((t) => t.customer_id)));
      const rows = [];

      for (const cId of distinctCustomerIds) {
        const cust = this.customers.find((c) => c.id === cId);
        if (!cust) continue;

        const custTxs = this.udharTransactions.filter((t) => t.customer_id === cId);
        const custPays = this.payments.filter((p) => p.customer_id === cId);
        const custTxIds = new Set(custTxs.map((t) => t.id));
        const custAllocs = this.paymentAllocations.filter((a) => custTxIds.has(a.transaction_id));

        const totalUdhar = custTxs.reduce((acc, t) => acc + parseFloat(t.total_amount), 0);
        const totalReceived = custPays.reduce((acc, p) => acc + parseFloat(p.amount), 0);
        const totalAllocated = custAllocs.reduce((acc, a) => acc + parseFloat(a.amount), 0);
        const outstanding = Math.max(0, totalUdhar - totalAllocated);

        rows.push({
          id: cust.id,
          name: cust.name,
          phone: cust.phone,
          total_udhar: totalUdhar.toFixed(2),
          total_received: totalReceived.toFixed(2),
          outstanding: outstanding.toFixed(2),
          last_activity: custTxs[custTxs.length - 1]?.created_at || null,
        });
      }

      return { rows, rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  }
}

const dbMock = new MockDatabaseState();

describe('Khata Application Financial Correctness & FIFO Allocation Test Suite', () => {
  beforeEach(() => {
    dbMock.reset();

    // Mock appPool.query
    vi.spyOn(appPool, 'query').mockImplementation((sql: unknown, params?: unknown) => {
      return dbMock.query(sql as string, params as unknown[]) as unknown as Promise<{
        rows: unknown[];
        rowCount: number;
      }>;
    });

    // Mock appPool.connect
    vi.spyOn(appPool, 'connect').mockImplementation(async () => {
      return {
        query: (sql: string, params?: unknown[]) => dbMock.query(sql, params),
        release: () => {},
      } as unknown as Awaited<ReturnType<typeof appPool.connect>>;
    });
  });

  // TEST CASE 1: Specification Example (Fevicol & PVC Pipe)
  it('1. Specification Example: Fevicol (3 x ₹550) + PVC Pipe (5 x ₹350) = ₹3,400 with ₹1,000 initial payment', async () => {
    // 1. Add Reference Products
    const fevicol = await productsService.createProduct('Fevicol 1kg', '400.00');
    const pvcPipe = await productsService.createProduct('PVC Pipe 10ft', '250.00');

    expect(fevicol.name).toBe('Fevicol 1kg');
    expect(pvcPipe.name).toBe('PVC Pipe 10ft');

    // 2. Create Udhar Transaction
    const tx = await khataService.createTransaction({
      customer: {
        name: 'Ramesh Kumar',
        phone: '9876543210',
      },
      items: [
        { productId: parseInt(fevicol.id.toString(), 10), quantity: '3', sellingPrice: '550.00' },
        { productId: parseInt(pvcPipe.id.toString(), 10), quantity: '5', sellingPrice: '350.00' },
      ],
      initialPayment: '1000.00',
      note: 'Bathroom pipes and glue',
    });

    expect(tx.success).toBe(true);
    expect(tx.totalAmount).toBe('3400.00');
    expect(tx.initialPayment).toBe('1000.00');
    expect(tx.remainingDue).toBe('2400.00');

    // Verify global summary
    const summary = await khataService.getSummary();
    expect(summary.totalCustomers).toBe(1);
    expect(summary.totalOutstanding).toBe('2400.00');
    expect(summary.totalReceived).toBe('1000.00');
  });

  // TEST CASE 2: Subsequent Partial Payment
  it('2. Subsequent Partial Payment: Ramesh pays ₹500, reducing due from ₹2,400 to ₹1,900', async () => {
    const prod = await productsService.createProduct('Sample Item', '50.00');
    const tx = await khataService.createTransaction({
      customer: { name: 'Ramesh Kumar', phone: '9876543210' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '3400.00' }],
      initialPayment: '1000.00',
    });

    const paymentRes = await khataService.recordPayment(tx.customerId, '500.00', 'Cash installment');
    expect(paymentRes.success).toBe(true);
    expect(paymentRes.amount).toBe('500.00');
    expect(paymentRes.newOutstanding).toBe('1900.00');

    // Verify global summary reflects payment
    const summary = await khataService.getSummary();
    expect(summary.totalOutstanding).toBe('1900.00');
    expect(summary.totalReceived).toBe('1500.00');
  });

  // TEST CASE 3: Full Settlement
  it('3. Full Settlement: Settle remaining ₹1,900; customer balance reaches ₹0 and customer remains in count', async () => {
    const prod = await productsService.createProduct('Item A', '10.00');
    const tx = await khataService.createTransaction({
      customer: { name: 'Ramesh Kumar', phone: '9876543210' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '1900.00' }],
    });

    const settlement = await khataService.recordPayment(tx.customerId, '1900.00', 'Final settlement in full');
    expect(settlement.success).toBe(true);
    expect(settlement.newOutstanding).toBe('0.00');

    // Customer remains in ledger count, outstanding is 0, received is 1900
    const summary = await khataService.getSummary();
    expect(summary.totalCustomers).toBe(1);
    expect(summary.totalOutstanding).toBe('0.00');
    expect(summary.totalReceived).toBe('1900.00');
  });

  // TEST CASE 4: Multi-Transaction FIFO Allocation
  it('4. FIFO Allocation: Payment of ₹150 settles oldest transaction (₹100) first, then partially allocates to next (₹50)', async () => {
    const prod = await productsService.createProduct('Hardware Item', '20.00');

    const tx1 = await khataService.createTransaction({
      customer: { name: 'Suresh Sharma', phone: '9811223344' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '100.00' }],
    });

    const tx2 = await khataService.createTransaction({
      customer: { id: tx1.customerId, name: 'Suresh Sharma' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '100.00' }],
    });

    // Make payment of 150
    const payRes = await khataService.recordPayment(tx1.customerId, '150.00', 'Partial settlement');
    expect(payRes.allocations).toHaveLength(2);
    expect(payRes.allocations[0]).toEqual({ transactionId: tx1.transactionId, allocated: '100.00' });
    expect(payRes.allocations[1]).toEqual({ transactionId: tx2.transactionId, allocated: '50.00' });
    expect(payRes.newOutstanding).toBe('50.00');
  });

  // TEST CASE 5: Overpayment Rejection
  it('5. Overpayment Rejection: Payment greater than customer outstanding is rejected with 400', async () => {
    const prod = await productsService.createProduct('Cement Bag', '380.00');
    const tx = await khataService.createTransaction({
      customer: { name: 'Anil Gupta', phone: '9822334455' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '450.00' }],
    });

    await expect(khataService.recordPayment(tx.customerId, '500.00')).rejects.toThrow(
      /cannot exceed customer total outstanding due/
    );

    // Assert no payment record was saved
    expect(dbMock.payments).toHaveLength(0);
  });

  // TEST CASE 6: Product Archive Snapshot Preservation
  it('6. Product Archive: Archiving product prevents new selections, but preserves historical line snapshots', async () => {
    const prod = await productsService.createProduct('Asian Paints 1L', '320.00');
    const tx = await khataService.createTransaction({
      customer: { name: 'Vikram Singh', phone: '9833445566' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '2', sellingPrice: '420.00' }],
    });

    // Archive product
    const archived = await productsService.archiveProduct(parseInt(prod.id.toString(), 10));
    expect(archived).toBe(true);

    // Historical item snapshot preserves name and price
    const snapshotItem = dbMock.udharItems.find((i) => i.transaction_id === tx.transactionId.toString());
    expect(snapshotItem?.product_name_snapshot).toBe('Asian Paints 1L');
    expect(snapshotItem?.buying_price_snapshot).toBe('320.00');
    expect(snapshotItem?.selling_price).toBe('420.00');

    // Attempting to create new transaction with archived product is rejected
    await expect(
      khataService.createTransaction({
        customer: { id: tx.customerId, name: 'Vikram Singh' },
        items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '420.00' }],
      })
    ).rejects.toThrow(/is archived and cannot be selected/);
  });

  // TEST CASE 7: Multi-Allocation Dashboard Aggregate Fan-Out Prevention (Regression Test for Section 1)
  it('7. Multi-Allocation Dashboard Regression: Single transaction with 2 separate payments does not inflate total outstanding', async () => {
    const prod = await productsService.createProduct('Bulk Steel Bar', '800.00');

    // 1 transaction of ₹1,000
    const tx = await khataService.createTransaction({
      customer: { name: 'Manoj Tiwari', phone: '9844556677' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '1000.00' }],
    });

    // Payment 1: ₹100
    await khataService.recordPayment(tx.customerId, '100.00', 'Installment 1');

    // Payment 2: ₹100
    await khataService.recordPayment(tx.customerId, '100.00', 'Installment 2');

    // In old flawed query with one-to-many join fan-out, total_amount was summed twice (2,000 - 200 = 1,800).
    // In our corrected independent CTE query, total_amount is 1,000, allocated is 200, outstanding MUST BE exactly 800.00!
    const summary = await khataService.getSummary();
    expect(summary.totalCustomers).toBe(1);
    expect(summary.totalOutstanding).toBe('800.00');
    expect(summary.totalReceived).toBe('200.00');
  });

  // TEST CASE 8: Idempotency Key Duplicate Request Protection
  it('8. Idempotency: Retrying create-transaction with same idempotency key returns cached result; differing payload returns 409', async () => {
    const prod = await productsService.createProduct('Electric Wire Coil', '950.00');
    const idempKey = 'tx_idemp_key_12345';

    const txInput = {
      customer: { name: 'Deepak Verma', phone: '9855667788' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '1200.00' }],
      idempotencyKey: idempKey,
    };

    // First request
    const firstRes = await khataService.createTransaction(txInput);
    expect(firstRes.success).toBe(true);
    expect(dbMock.udharTransactions).toHaveLength(1);

    // Duplicate retry with exact same payload returns identical cached result without inserting a second row
    const retryRes = await khataService.createTransaction(txInput);
    expect(retryRes.transactionId).toBe(firstRes.transactionId);
    expect(dbMock.udharTransactions).toHaveLength(1);

    // Reusing key with a different payload throws 409 Conflict
    const conflictingInput = {
      ...txInput,
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '2', sellingPrice: '2400.00' }],
    };
    await expect(khataService.createTransaction(conflictingInput)).rejects.toThrow(
      /Idempotency key reused with different request payload/
    );
  });

  // TEST CASE 9: Customer Phone Normalization & Canonical Resolution
  it('9. Customer Phone Normalization: Phone formats with "+91", spaces, and dashes resolve to the exact same customer', async () => {
    const prod = await productsService.createProduct('Switch Board', '120.00');

    // First transaction with "+91 9876543210"
    const tx1 = await khataService.createTransaction({
      customer: { name: 'Rajesh Sharma', phone: '+91 9876543210' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '150.00' }],
    });

    // Second transaction with "9876543210" (no country code)
    const tx2 = await khataService.createTransaction({
      customer: { name: 'Rajesh Sharma', phone: '9876543210' },
      items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '200.00' }],
    });

    // Both must resolve to the exact same customer ID
    expect(tx2.customerId).toBe(tx1.customerId);
    expect(dbMock.customers).toHaveLength(1);
    expect(dbMock.customers[0].normalized_phone).toBe('+919876543210');
  });

  // TEST CASE 10: Ambiguous Customer Detection
  it('10. Ambiguous Customer Resolution: If multiple customers share the same name without phone, throws 409 AMBIGUOUS_CUSTOMER_MATCH', async () => {
    // Insert two distinct customers with the name "Amit Kumar" (e.g. created previously)
    dbMock.customers.push({
      id: '101',
      name: 'Amit Kumar',
      normalized_name: 'amit kumar',
      phone: null,
      normalized_phone: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    });
    dbMock.customers.push({
      id: '102',
      name: 'Amit Kumar',
      normalized_name: 'amit kumar',
      phone: null,
      normalized_phone: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    });

    const prod = await productsService.createProduct('LED Bulb 9W', '80.00');

    // Attempting to create transaction for "Amit Kumar" without ID or phone must fail with AMBIGUOUS_CUSTOMER_MATCH
    await expect(
      khataService.createTransaction({
        customer: { name: 'Amit Kumar' },
        items: [{ productId: parseInt(prod.id.toString(), 10), quantity: '1', sellingPrice: '100.00' }],
      })
    ).rejects.toThrow(/Multiple customers found matching "Amit Kumar"/);
  });

  // TEST CASE 11: Exact Decimal Arithmetic Validation
  it('11. Decimal Precision: Floating-point edge cases (e.g. 0.333 x ₹0.10) round half-up to deterministic 2-decimal money', () => {
    const qty = new Decimal('0.333');
    const price = new Decimal('0.10');
    const lineTotal = qty.times(price).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

    // 0.333 * 0.10 = 0.0333 -> rounds to 0.03
    expect(lineTotal).toBe('0.03');

    // 0.335 * 0.10 = 0.0335 -> rounds half-up to 0.03
    const lineTotal2 = new Decimal('0.35').times(new Decimal('0.10')).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    expect(lineTotal2).toBe('0.04');
  });
  // TEST CASE 12: Hardware Item Integer Quantity Enforcement
  it('12. Integer Quantity Enforcement: Rejects fractional decimals with "Quantity must be a whole number."', async () => {
    const prod = await productsService.createProduct('Hammer 500g', '250.00');
    const prodId = parseInt(prod.id.toString(), 10);

    // Rejection of fractional strings
    await expect(
      khataService.createTransaction({
        customer: { name: 'Ramesh Patel' },
        items: [{ productId: prodId, quantity: '1.5', sellingPrice: '300.00' }],
      })
    ).rejects.toThrow('Quantity must be a whole number.');

    await expect(
      khataService.createTransaction({
        customer: { name: 'Ramesh Patel' },
        items: [{ productId: prodId, quantity: '0.5', sellingPrice: '300.00' }],
      })
    ).rejects.toThrow('Quantity must be a whole number.');

    await expect(
      khataService.createTransaction({
        customer: { name: 'Ramesh Patel' },
        items: [{ productId: prodId, quantity: '2.00', sellingPrice: '300.00' }],
      })
    ).rejects.toThrow('Quantity must be a whole number.');

    // Acceptance of valid whole integer quantity
    const tx = await khataService.createTransaction({
      customer: { name: 'Ramesh Patel' },
      items: [{ productId: prodId, quantity: '3', sellingPrice: '300.00' }],
    });
    expect(tx.success).toBe(true);
    expect(tx.totalAmount).toBe('900.00');
    expect(tx.remainingDue).toBe('900.00');
  });

  // TEST CASE 13: Strict Money Precision (Max 2 Decimal Places)
  it('13. Strict Money Precision: Rejects prices/payments with >2 decimal places', async () => {
    // Products buying price >2 decimal places rejected
    await expect(
      productsService.createProduct('Drill Bit 6mm', '45.555')
    ).rejects.toThrow(/at most 2 decimal places/);

    const prod = await productsService.createProduct('Drill Bit 6mm', '45.50');
    const prodId = parseInt(prod.id.toString(), 10);

    // Selling price >2 decimal places rejected
    await expect(
      khataService.createTransaction({
        customer: { name: 'Suresh Raina' },
        items: [{ productId: prodId, quantity: '2', sellingPrice: '60.123' }],
      })
    ).rejects.toThrow(/at most 2 decimal places/);

    // Valid transaction
    const tx = await khataService.createTransaction({
      customer: { name: 'Suresh Raina' },
      items: [{ productId: prodId, quantity: '2', sellingPrice: '60.50' }],
    });
    expect(tx.success).toBe(true);
    expect(tx.totalAmount).toBe('121.00');

    // Payment amount >2 decimal places rejected
    await expect(
      khataService.recordPayment(tx.customerId, '50.123')
    ).rejects.toThrow(/at most 2 decimal places/);

    // Valid payment accepted
    const payRes = await khataService.recordPayment(tx.customerId, '50.50');
    expect(payRes.success).toBe(true);
    expect(payRes.amount).toBe('50.50');
  });

  // TEST CASE 14: Customer Identity: Phone normalization and strict rejection of invalid phone
  it('14. Customer Identity: Phone normalization rejects invalid non-empty phone with HTTP 400', async () => {
    // Null, undefined, empty, or whitespace-only return null (valid optional phone)
    expect(khataService.normalizeCustomerPhone(null)).toBe(null);
    expect(khataService.normalizeCustomerPhone(undefined)).toBe(null);
    expect(khataService.normalizeCustomerPhone('')).toBe(null);
    expect(khataService.normalizeCustomerPhone('   ')).toBe(null);

    // Malformed non-empty strings throw 400 INVALID_PHONE_FORMAT
    expect(() => khataService.normalizeCustomerPhone('12345')).toThrow(
      'Invalid phone number format. Must be a valid 10-digit Indian mobile number.'
    );
    expect(() => khataService.normalizeCustomerPhone('abcdefghij')).toThrow(
      'Invalid phone number format. Must be a valid 10-digit Indian mobile number.'
    );
    expect(() => khataService.normalizeCustomerPhone('1234567890')).toThrow(
      'Invalid phone number format. Must be a valid 10-digit Indian mobile number.'
    ); // Starts with 1, not 6-9
  });

  // TEST CASE 15: Customer Identity: Phone formats resolve to identical +91 format and same customer
  it('15. Customer Identity: Varied phone formats resolve to identical +91 format and same customer', async () => {
    const p1 = khataService.normalizeCustomerPhone('9876543210');
    const p2 = khataService.normalizeCustomerPhone('+91 98765 43210');
    const p3 = khataService.normalizeCustomerPhone('+91-98765-43210');
    const p4 = khataService.normalizeCustomerPhone('09876543210');

    expect(p1).toBe('+919876543210');
    expect(p2).toBe('+919876543210');
    expect(p3).toBe('+919876543210');
    expect(p4).toBe('+919876543210');

    const prod = await productsService.createProduct('Hammer 500g', '250.00');
    const prodId = parseInt(prod.id.toString(), 10);

    // Create customer with 10-digit format
    const tx1 = await khataService.createTransaction({
      customer: { name: 'Aakash Verma', phone: '9876543210' },
      items: [{ productId: prodId, quantity: 1, sellingPrice: '300.00' }],
    });

    // Reuse customer with +91 separated format
    const tx2 = await khataService.createTransaction({
      customer: { name: 'Aakash Verma', phone: '+91 98765 43210' },
      items: [{ productId: prodId, quantity: 1, sellingPrice: '300.00' }],
    });

    expect(tx1.customerId).toBe(tx2.customerId);
  });

  // TEST CASE 16: Customer Identity: Existing no-phone customer receives phone safely without duplicate
  it('16. Customer Identity: Safe phone attachment to existing no-phone customer without creating duplicate', async () => {
    const prod = await productsService.createProduct('Wrench 10in', '150.00');
    const prodId = parseInt(prod.id.toString(), 10);

    // 1. Create customer without phone
    const tx1 = await khataService.createTransaction({
      customer: { name: 'Vijay Kumar' },
      items: [{ productId: prodId, quantity: 1, sellingPrice: '200.00' }],
    });
    const origCustId = tx1.customerId;

    // Verify customer has no phone initially
    const cust1 = dbMock.customers.find((c) => c.id === origCustId.toString());
    expect(cust1?.phone).toBe(null);

    // 2. Later transaction supplies a valid phone for the same name
    const tx2 = await khataService.createTransaction({
      customer: { name: 'Vijay Kumar', phone: '9811223344' },
      items: [{ productId: prodId, quantity: 2, sellingPrice: '200.00' }],
    });

    // Must safely attach phone to existing customer instead of creating a duplicate row!
    expect(tx2.customerId).toBe(origCustId);
    const updatedCust = dbMock.customers.find((c) => c.id === origCustId.toString());
    expect(updatedCust?.phone).toBe('9811223344');
    expect(updatedCust?.normalized_phone).toBe('+919811223344');
    expect(dbMock.customers.filter((c) => c.normalized_name === 'vijay kumar').length).toBe(1);
  });

  // TEST CASE 17: Customer Identity: Rejects merge when same customer name exists with different phone
  it('17. Customer Identity: Rejects merge with HTTP 409 when same name exists with different phone', async () => {
    const prod = await productsService.createProduct('Pliers 8in', '120.00');
    const prodId = parseInt(prod.id.toString(), 10);

    // Customer 1 with phone A
    await khataService.createTransaction({
      customer: { name: 'Rajesh Sharma', phone: '9876500001' },
      items: [{ productId: prodId, quantity: 1, sellingPrice: '150.00' }],
    });

    // Transaction with same name but phone B must throw 409 to prevent silent data corruption
    await expect(
      khataService.createTransaction({
        customer: { name: 'Rajesh Sharma', phone: '9876500002' },
        items: [{ productId: prodId, quantity: 1, sellingPrice: '150.00' }],
      })
    ).rejects.toThrow(/already exists with a different phone number/);
  });

  // TEST CASE 18: Customer Identity: Rejects ambiguity when multiple customers match same name
  it('18. Customer Identity: Rejects ambiguity with HTTP 409 when multiple customers share same name', async () => {
    const prod = await productsService.createProduct('Tape 5m', '50.00');
    const prodId = parseInt(prod.id.toString(), 10);

    // Seed two customers with same name manually (legacy data)
    dbMock.customers.push({
      id: '901',
      name: 'Mohan Lal',
      normalized_name: 'mohan lal',
      phone: null,
      normalized_phone: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    });
    dbMock.customers.push({
      id: '902',
      name: 'Mohan Lal',
      normalized_name: 'mohan lal',
      phone: null,
      normalized_phone: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived_at: null,
    });

    // Creating transaction without explicit ID or phone must fail with AMBIGUOUS_CUSTOMER_MATCH (409)
    await expect(
      khataService.createTransaction({
        customer: { name: 'Mohan Lal' },
        items: [{ productId: prodId, quantity: 1, sellingPrice: '60.00' }],
      })
    ).rejects.toThrow(/Multiple customers found matching "Mohan Lal"/);
  });
});
