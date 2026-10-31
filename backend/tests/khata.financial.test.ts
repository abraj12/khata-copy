import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appPool } from '../src/config/database.js';
import { productsService } from '../src/modules/products/products.service.js';
import { khataService } from '../src/modules/khata/khata.service.js';

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

// In-Memory PostgreSQL State Simulator for Unit/Integration Verification
class MockDatabaseState {
  public products: ProductRow[] = [];
  public customers: CustomerRow[] = [];
  public udharTransactions: UdharTxRow[] = [];
  public udharItems: UdharItemRow[] = [];
  public payments: PaymentRow[] = [];
  public paymentAllocations: PaymentAllocRow[] = [];

  private nextId = 1;

  public reset() {
    this.products = [];
    this.customers = [];
    this.udharTransactions = [];
    this.udharItems = [];
    this.payments = [];
    this.paymentAllocations = [];
    this.nextId = 1;
  }

  public async query(sql: string, params: unknown[] = []) {
    const s = sql.trim().toUpperCase();

    // 1. Transaction controls
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    // 2. Products Queries
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

    if (s.startsWith('SELECT ID, NAME, BUYING_PRICE') && s.includes('FROM PRODUCTS') && s.includes('WHERE ID = $1')) {
      const prod = this.products.find((p) => p.id === params[0]?.toString());
      return { rows: prod ? [prod] : [], rowCount: prod ? 1 : 0 };
    }

    if (s.startsWith('SELECT ID, NAME, BUYING_PRICE') && s.includes('FROM PRODUCTS')) {
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

    // 3. Customers Queries
    if (s.startsWith('SELECT ID, NAME, PHONE FROM CUSTOMERS WHERE ID = $1')) {
      const cust = this.customers.find((c) => c.id === params[0]?.toString());
      return { rows: cust ? [cust] : [], rowCount: cust ? 1 : 0 };
    }

    if (s.startsWith('SELECT ID, NAME, PHONE FROM CUSTOMERS WHERE NORMALIZED_PHONE = $1')) {
      const cust = this.customers.find((c) => c.normalized_phone === params[0]?.toString());
      return { rows: cust ? [cust] : [], rowCount: cust ? 1 : 0 };
    }

    if (s.startsWith('SELECT ID, NAME FROM CUSTOMERS WHERE ID = $1')) {
      const cust = this.customers.find((c) => c.id === params[0]?.toString());
      return { rows: cust ? [cust] : [], rowCount: cust ? 1 : 0 };
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

    // 4. Udhar Transactions Queries
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

    // 5. Payments Queries
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

    // 6. Balance & Allocation lookups for payment
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

    if (s.includes('SELECT') && s.includes('OUTSTANDING') && s.includes('FROM UDHAR_TRANSACTIONS T')) {
      const custId = params[0]?.toString();
      const customerTxs = this.udharTransactions.filter((t) => t.customer_id === custId);
      const customerPayments = this.payments.filter((p) => p.customer_id === custId);

      const totalUdhar = customerTxs.reduce((sum, t) => sum + parseFloat(t.total_amount), 0);
      const totalPaid = customerPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
      const outstanding = Math.max(0, totalUdhar - totalPaid);

      return {
        rows: [{ outstanding: outstanding.toFixed(2) }],
        rowCount: 1,
      };
    }

    // 7. Global Summary Query
    if (s.includes('FROM CUSTOMERS C') && s.includes('INNER JOIN UDHAR_TRANSACTIONS T') && s.includes('TOTAL_OUTSTANDING')) {
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

    // 8. List Customers Query
    if (s.includes('FROM CUSTOMERS C') && s.includes('INNER JOIN UDHAR_TRANSACTIONS T')) {
      const distinctCustomerIds = Array.from(new Set(this.udharTransactions.map((t) => t.customer_id)));
      const rows = [];

      for (const cId of distinctCustomerIds) {
        const cust = this.customers.find((c) => c.id === cId);
        if (!cust) continue;

        const custTxs = this.udharTransactions.filter((t) => t.customer_id === cId);
        const custPays = this.payments.filter((p) => p.customer_id === cId);

        const totalUdhar = custTxs.reduce((acc, t) => acc + parseFloat(t.total_amount), 0);
        const totalReceived = custPays.reduce((acc, p) => acc + parseFloat(p.amount), 0);

        rows.push({
          id: cust.id,
          name: cust.name,
          phone: cust.phone,
          total_udhar: totalUdhar.toFixed(2),
          total_received: totalReceived.toFixed(2),
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
        { productId: parseInt(fevicol.id, 10), quantity: 3, sellingPrice: 550.0 }, // 3 * 550 = 1650
        { productId: parseInt(pvcPipe.id, 10), quantity: 5, sellingPrice: 350.0 }, // 5 * 350 = 1750
      ],
      initialPayment: 1000.0,
      note: 'Hardware supply credit',
    });

    expect(tx.success).toBe(true);
    expect(tx.totalAmount).toBe('3400.00');
    expect(tx.initialPayment).toBe('1000.00');
    expect(tx.remainingDue).toBe('2400.00');

    // Verify snapshot was captured in DB
    expect(dbMock.udharItems.length).toBe(2);
    expect(dbMock.udharItems[0].product_name_snapshot).toBe('Fevicol 1kg');
    expect(dbMock.udharItems[0].line_total).toBe('1650.00');
    expect(dbMock.udharItems[1].product_name_snapshot).toBe('PVC Pipe 10ft');
    expect(dbMock.udharItems[1].line_total).toBe('1750.00');

    // Verify global summary
    const summary = await khataService.getSummary();
    expect(summary.totalCustomers).toBe(1);
    expect(summary.totalOutstanding).toBe('2400.00');
    expect(summary.totalReceived).toBe('1000.00');
  });

  // TEST CASE 2: Subsequent Partial Payment
  it('2. Subsequent Partial Payment: Ramesh pays ₹500, reducing due from ₹2,400 to ₹1,900', async () => {
    const prod = await productsService.createProduct('Cement Bag', '340.00');
    const tx = await khataService.createTransaction({
      customer: { name: 'Ramesh Kumar', phone: '9876543210' },
      items: [{ productId: parseInt(prod.id, 10), quantity: 10, sellingPrice: 340.0 }], // Total = 3400
      initialPayment: 1000.0, // Remaining = 2400
    });

    // Pay ₹500
    const payResult = await khataService.recordPayment(tx.customerId, 500.0, 'Partial cash deposit');

    expect(payResult.success).toBe(true);
    expect(payResult.amount).toBe('500.00');
    expect(payResult.newOutstanding).toBe('1900.00');

    // Verify global summary after payment
    const summary = await khataService.getSummary();
    expect(summary.totalOutstanding).toBe('1900.00');
    expect(summary.totalReceived).toBe('1500.00');
  });

  // TEST CASE 3: Full Settlement
  it('3. Full Settlement: Settle remaining ₹1,900; customer balance reaches ₹0 and customer remains in count', async () => {
    const prod = await productsService.createProduct('Cement Bag', '340.00');
    const tx = await khataService.createTransaction({
      customer: { name: 'Ramesh Kumar', phone: '9876543210' },
      items: [{ productId: parseInt(prod.id, 10), quantity: 10, sellingPrice: 340.0 }],
      initialPayment: 1500.0,
    });

    // Settle remaining 1900.00
    const payResult = await khataService.recordPayment(tx.customerId, 1900.0, 'Full settlement');
    expect(payResult.newOutstanding).toBe('0.00');

    // Settled customer remains in customer list and total customer count
    const summary = await khataService.getSummary();
    expect(summary.totalCustomers).toBe(1);
    expect(summary.totalOutstanding).toBe('0.00');
    expect(summary.totalReceived).toBe('3400.00');

    const customerList = await khataService.listCustomers();
    expect(customerList.length).toBe(1);
    expect(customerList[0].outstanding).toBe('0.00');
    expect(customerList[0].totalReceived).toBe('3400.00');
  });

  // TEST CASE 4: FIFO Allocation across Multiple Transactions
  it('4. FIFO Allocation: Payment of ₹150 settles oldest transaction (₹100) first, then partially allocates to next (₹50)', async () => {
    const prod = await productsService.createProduct('Item A', '50.00');

    // Customer takes Tx1 for ₹100
    const tx1 = await khataService.createTransaction({
      customer: { name: 'Suresh Sharma', phone: '9822334455' },
      items: [{ productId: parseInt(prod.id, 10), quantity: 2, sellingPrice: 50.0 }], // ₹100
      initialPayment: null,
    });

    // Customer takes Tx2 for ₹200
    const tx2 = await khataService.createTransaction({
      customer: { id: tx1.customerId, name: 'Suresh Sharma' },
      items: [{ productId: parseInt(prod.id, 10), quantity: 4, sellingPrice: 50.0 }], // ₹200
      initialPayment: null,
    });

    expect(tx1.totalAmount).toBe('100.00');
    expect(tx2.totalAmount).toBe('200.00');

    // Record payment of ₹150
    const payResult = await khataService.recordPayment(tx1.customerId, 150.0, 'Split FIFO payment');

    expect(payResult.success).toBe(true);
    expect(payResult.newOutstanding).toBe('150.00'); // 300 - 150 = 150

    // Verify FIFO allocation details
    expect(payResult.allocations.length).toBe(2);
    expect(payResult.allocations[0].transactionId).toBe(tx1.transactionId);
    expect(payResult.allocations[0].allocated).toBe('100.00'); // Older Tx1 fully settled
    expect(payResult.allocations[1].transactionId).toBe(tx2.transactionId);
    expect(payResult.allocations[1].allocated).toBe('50.00'); // Newer Tx2 partially settled
  });

  // TEST CASE 5: Overpayment Rejection
  it('5. Overpayment Rejection: Reject payment greater than total outstanding to prevent negative due', async () => {
    const prod = await productsService.createProduct('Item A', '50.00');
    const tx = await khataService.createTransaction({
      customer: { name: 'Anil Verma', phone: '9833445566' },
      items: [{ productId: parseInt(prod.id, 10), quantity: 2, sellingPrice: 50.0 }], // ₹100
      initialPayment: null,
    });

    // Attempt to pay ₹150 when only ₹100 is owed
    await expect(khataService.recordPayment(tx.customerId, 150.0)).rejects.toThrow(
      /cannot exceed customer total outstanding due/
    );
  });

  // TEST CASE 6: Product Archive Snapshot Safety
  it('6. Product Archive: Archiving product prevents new selections, but preserves historical line snapshots', async () => {
    const prod = await productsService.createProduct('Classic Paint', '800.00');
    const tx = await khataService.createTransaction({
      customer: { name: 'Vikram Singh' },
      items: [{ productId: parseInt(prod.id, 10), quantity: 1, sellingPrice: 1200.0 }],
    });

    // Archive product
    const archived = await productsService.archiveProduct(parseInt(prod.id, 10));
    expect(archived).toBe(true);

    // Attempting to create new transaction with archived product is rejected
    await expect(
      khataService.createTransaction({
        customer: { id: tx.customerId, name: 'Vikram Singh' },
        items: [{ productId: parseInt(prod.id, 10), quantity: 1, sellingPrice: 1200.0 }],
      })
    ).rejects.toThrow(/is archived and cannot be selected/);

    // Existing historical item snapshot remains intact
    const historicalItem = dbMock.udharItems.find((i) => i.transaction_id === tx.transactionId.toString());
    expect(historicalItem).toBeDefined();
    expect(historicalItem?.product_name_snapshot).toBe('Classic Paint');
    expect(historicalItem?.buying_price_snapshot).toBe('800.00');
  });

  // TEST CASE 7: Server Authority Over Calculations
  it('7. Server Authority: Rejects transaction with invalid/negative quantities or empty items', async () => {
    const prod = await productsService.createProduct('Hammer', '150.00');

    await expect(
      khataService.createTransaction({
        customer: { name: 'Test' },
        items: [],
      })
    ).rejects.toThrow(/At least one item is required/);

    await expect(
      khataService.createTransaction({
        customer: { name: 'Test' },
        items: [{ productId: parseInt(prod.id, 10), quantity: -2, sellingPrice: 200.0 }],
      })
    ).rejects.toThrow(/must be greater than zero/);
  });
});
