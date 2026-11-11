import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { EXPECTED_MIGRATIONS, appPool, getDatabasePoolStats } from '../src/config/database.js';
import { dashboardService } from '../src/modules/dashboard/dashboard.service.js';
import { resolveProductCostSnapshots } from '../src/modules/billing/costSnapshot.js';
import {
  createExpenseSchema,
  dashboardOverviewQuerySchema,
  listExpensesQuerySchema,
  voidExpenseSchema,
} from '../src/modules/dashboard/dashboard.validation.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const app = createApp({ useMemoryStoreInTest: true });
const SAMPLE_UUID = '11111111-1111-4111-8111-111111111111';

function buildOverviewMockClient(overrides: Partial<{
  sales: Record<string, unknown>;
  profit: Record<string, unknown>;
  expenseSummary: Record<string, unknown>;
  expenseCats: Array<Record<string, unknown>>;
  custPos: Record<string, unknown>;
  khataUdhar: Record<string, unknown>;
  khataPay: Record<string, unknown>;
  prodCounts: Record<string, unknown>;
  topProducts: Array<Record<string, unknown>>;
  supPos: Record<string, unknown>;
  supBill: Record<string, unknown>;
  supPay: Record<string, unknown>;
  supRev: Record<string, unknown>;
  quotes: Record<string, unknown>;
  trend: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
}> = {}) {
  const executedSql: Array<{ text: string; params: unknown[] | undefined }> = [];
  const client = {
    query: vi.fn(async (sql: any, params?: unknown[]) => {
      const text = typeof sql === 'string' ? sql : sql?.text || '';
      executedSql.push({ text, params });

      if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      if (text.includes('AS gst_invoices_grand_total')) {
        return {
          rows: [
            overrides.sales ?? {
              normal_bills_count: '2',
              normal_bills_total: '1500.00',
              gst_invoices_count: '1',
              gst_taxable_sales: '2000.00',
              gst_collected: '360.00',
              gst_invoices_grand_total: '2360.00',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('AS estimated_cogs')) {
        return {
          rows: [
            overrides.profit ?? {
              costed_sales_revenue: '2500.00',
              estimated_cogs: '1750.00',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('AS voided_count')) {
        return {
          rows: [
            overrides.expenseSummary ?? {
              active_count: '2',
              active_total: '450.00',
              voided_count: '1',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('GROUP BY category')) {
        return {
          rows: overrides.expenseCats ?? [
            { category: 'rent', count: '1', total_amount: '300.00' },
            { category: 'electricity', count: '1', total_amount: '150.00' },
          ],
          rowCount: 2,
        };
      }
      if (text.includes('AS total_outstanding_receivable')) {
        return {
          rows: [
            overrides.custPos ?? {
              total_customers: '12',
              active_customers: '10',
              customers_with_outstanding: '4',
              total_outstanding_receivable: '3200.00',
              new_customers_count: '2',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('AS credit_given')) {
        return { rows: [overrides.khataUdhar ?? { credit_given: '900.00' }], rowCount: 1 };
      }
      if (text.includes('AS payments_received')) {
        return {
          rows: [overrides.khataPay ?? { payment_count: '2', payments_received: '400.00' }],
          rowCount: 1,
        };
      }
      if (text.includes('AS active_products')) {
        return {
          rows: [
            overrides.prodCounts ?? {
              total_products: '25',
              active_products: '22',
              archived_products: '3',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM aggregated a')) {
        return {
          rows: overrides.topProducts ?? [
            {
              product_id: 1,
              product_name: 'Cement Bag 50kg',
              is_archived: false,
              total_quantity_sold: '10.00',
              total_sales_amount: '3500.00',
              bill_count: '3',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('AS total_outstanding_payable')) {
        return {
          rows: [
            overrides.supPos ?? {
              total_suppliers: '5',
              active_suppliers: '4',
              total_outstanding_payable: '5400.00',
              total_advance_credit: '200.00',
              total_unallocated_payments: '100.00',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('AS cancelled_bills_count')) {
        return {
          rows: [
            overrides.supBill ?? {
              purchase_bills_count: '3',
              total_purchases: '6000.00',
              cancelled_bills_count: '1',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('AS total_payments_made')) {
        return {
          rows: [overrides.supPay ?? { payments_count: '2', total_payments_made: '2400.00' }],
          rowCount: 1,
        };
      }
      if (text.includes('AS total_payments_reversed')) {
        return {
          rows: [overrides.supRev ?? { total_payments_reversed: '300.00' }],
          rowCount: 1,
        };
      }
      if (text.includes('AS pending_pipeline_value')) {
        return {
          rows: [
            overrides.quotes ?? {
              total_count: '5',
              draft_count: '1',
              sent_count: '1',
              accepted_count: '1',
              converted_count: '1',
              rejected_count: '0',
              expired_count: '1',
              pending_pipeline_value: '4500.00',
              converted_value: '2000.00',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM series s')) {
        return {
          rows: overrides.trend ?? [
            {
              bucket: '2026-11-10',
              normal_sales: '500.00',
              gst_taxable_sales: '1000.00',
              gst_collected: '180.00',
              expenses: '150.00',
              bills_count: '2',
            },
            {
              bucket: '2026-11-11',
              normal_sales: '1000.00',
              gst_taxable_sales: '1000.00',
              gst_collected: '180.00',
              expenses: '300.00',
              bills_count: '1',
            },
          ],
          rowCount: 2,
        };
      }
      if (text.includes('FROM combined_activity') || text.includes(') combined_activity')) {
        return {
          rows: overrides.activity ?? [
            {
              type: 'gst_invoice',
              reference: 'INV-001',
              party: 'Bharat Traders',
              amount: '2360.00',
              event_date: '2026-11-11',
              status: null,
              occurred_at: '2026-11-11T10:00:00.000Z',
              target_tab: 'gst-bill',
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  return { client, executedSql };
}

describe('Release #024: Home Dashboard, Profitability Analytics & Operating Expenses Test Suite', () => {
  let authCookie = '';
  let csrfToken = '';

  beforeEach(async () => {
    vi.restoreAllMocks();
    const loginRes = await request(app).post('/api/v1/auth/login').send({
      phone: TEST_PHONE,
      password: TEST_PASSWORD,
    });
    authCookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
    const csrfRes = await request(app).get('/api/v1/auth/csrf-token').set('Cookie', authCookie);
    csrfToken = csrfRes.body.csrfToken;
  });

  it('1. Rejects unauthenticated access (HTTP 401) across all dashboard & expense endpoints', async () => {
    const r1 = await request(app).get('/api/v1/dashboard/overview');
    const r2 = await request(app).get('/api/v1/dashboard/expenses');
    const r3 = await request(app).post('/api/v1/dashboard/expenses').send({});
    const r4 = await request(app).put(`/api/v1/dashboard/expenses/${SAMPLE_UUID}`).send({});
    const r5 = await request(app).post(`/api/v1/dashboard/expenses/${SAMPLE_UUID}/void`).send({ reason: 'test' });

    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(401);
    expect(r4.status).toBe(401);
    expect(r5.status).toBe(401);
  });

  it('2. Enforces CSRF protection on state-changing expense endpoints', async () => {
    const res = await request(app)
      .post('/api/v1/dashboard/expenses')
      .set('Cookie', authCookie)
      .send({
        expenseDate: '2026-11-11',
        category: 'rent',
        title: 'Shop Rent',
        amount: '5000.00',
        paymentMethod: 'upi',
      });
    expect(res.status).toBe(403);
  });

  it('3. Validates overview query dates (rejects impossible dates and inverted range)', async () => {
    const badCalendar = await request(app)
      .get('/api/v1/dashboard/overview?fromDate=2026-02-30')
      .set('Cookie', authCookie);
    expect(badCalendar.status).toBe(400);

    const inverted = await request(app)
      .get('/api/v1/dashboard/overview?fromDate=2026-11-15&toDate=2026-11-10')
      .set('Cookie', authCookie);
    expect(inverted.status).toBe(400);

    expect(dashboardOverviewQuerySchema.safeParse({ fromDate: '2026-11-01', toDate: '2026-11-11' }).success).toBe(true);
  });

  it('4. Rejects invalid expense payloads, invalid UUIDs, negative/zero/3dp amounts, and missing void reasons', async () => {
    const badId = await request(app)
      .put('/api/v1/dashboard/expenses/not-a-uuid')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({});
    expect(badId.status).toBe(400);

    for (const amount of ['0', '-50', '10.123', '1e4', 'abc']) {
      expect(
        createExpenseSchema.safeParse({
          expenseDate: '2026-11-11',
          category: 'rent',
          title: 'Test',
          amount,
          paymentMethod: 'cash',
        }).success
      ).toBe(false);
    }

    expect(voidExpenseSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(
      listExpensesQuerySchema.safeParse({ fromDate: '2026-11-20', toDate: '2026-11-01' }).success
    ).toBe(false);
  });

  it('5. Computes exact revenue excluding GST, partial cost coverage, gross profit, and net operating result inside one REPEATABLE READ READ ONLY snapshot', async () => {
    const { client, executedSql } = buildOverviewMockClient();
    vi.spyOn(appPool, 'connect').mockResolvedValue(client as any);

    const res = await request(app)
      .get('/api/v1/dashboard/overview?fromDate=2026-11-10&toDate=2026-11-11')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(executedSql[0].text).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(executedSql[executedSql.length - 1].text).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);

    const data = res.body.data;
    // Normal 1500 + GST taxable 2000 = 3500 revenue (GST 360 excluded from revenue/profit!)
    expect(data.sales.totalSalesRevenue).toBe('3500.00');
    expect(data.sales.gstCollected).toBe('360.00');
    expect(data.sales.totalBilledAmountIncludingGst).toBe('3860.00');
    expect(data.sales.averageBillValue).toBe('1166.67');

    // Partial cost coverage: 2500/3500 = 71.43%, gross = 2500 - 1750 = 750.00, net = 750 - 450 = 300.00
    expect(data.profitability.costedSalesRevenue).toBe('2500.00');
    expect(data.profitability.uncostedSalesRevenue).toBe('1000.00');
    expect(data.profitability.estimatedGrossProfit).toBe('750.00');
    expect(data.profitability.estimatedGrossMarginPercent).toBe('30.00');
    expect(data.profitability.costCoveragePercent).toBe('71.43');
    expect(data.profitability.operatingExpenses).toBe('450.00');
    expect(data.profitability.estimatedNetOperatingResult).toBe('300.00');
    expect(data.profitability.hasIncompleteCostData).toBe(true);

    // Ensure no stock/inventory keys appear anywhere in response payload
    const serialized = JSON.stringify(data).toLowerCase();
    expect(serialized).not.toContain('stock');
    expect(serialized).not.toContain('inventory');

    // Daily trend granularity when span <= 45 days
    expect(data.salesTrend.granularity).toBe('day');
    expect(data.salesTrend.points).toHaveLength(2);
    expect(data.quotations.conversionRatePercent).toBe('20.00');
  });

  it('6. Reports net operating loss accurately and handles 0% uncosted empty/historical periods honestly', async () => {
    const { client } = buildOverviewMockClient({
      sales: {
        normal_bills_count: '1',
        normal_bills_total: '500.00',
        gst_invoices_count: '0',
        gst_taxable_sales: '0.00',
        gst_collected: '0.00',
        gst_invoices_grand_total: '0.00',
      },
      profit: {
        costed_sales_revenue: '0.00',
        estimated_cogs: '0.00',
      },
      expenseSummary: {
        active_count: '1',
        active_total: '1200.00',
        voided_count: '0',
      },
      trend: [
        {
          bucket: '2026-11',
          normal_sales: '500.00',
          gst_taxable_sales: '0.00',
          gst_collected: '0.00',
          expenses: '1200.00',
          bills_count: '1',
        },
      ],
    });
    vi.spyOn(appPool, 'connect').mockResolvedValue(client as any);

    const overview = await dashboardService.getOverview();
    expect(overview.profitability.costCoveragePercent).toBe('0.00');
    expect(overview.profitability.hasIncompleteCostData).toBe(true);
    expect(overview.profitability.estimatedGrossProfit).toBe('0.00');
    expect(overview.profitability.estimatedNetOperatingResult).toBe('-1200.00');
    expect(overview.salesTrend.granularity).toBe('month');
  });

  it('7. Lists expenses cleanly with escaped search wildcards and bounded pagination', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any, params?: any[]) => {
      const text = typeof sql === 'string' ? sql : sql?.text || '';
      executed.push({ sql: text, params: params || [] });
      if (text.includes('WITH summary AS')) {
        return {
          rows: [
            {
              total: '1',
              total_active_amount: '850.00',
              id: SAMPLE_UUID,
              expense_date: '2026-11-11',
              category: 'electricity',
              title: '100%_Power',
              vendor_name: 'NBPDCL',
              amount: '850.00',
              payment_method: 'upi',
              reference_number: 'UPI-123',
              notes: null,
              status: 'active',
              voided_at: null,
              void_reason: null,
              created_at: '2026-11-11T09:00:00.000Z',
              updated_at: '2026-11-11T09:00:00.000Z',
            },
          ],
          rowCount: 1,
        } as any;
      }
      return {
        rows: [
          {
            id: SAMPLE_UUID,
            expense_date: '2026-11-11',
            category: 'electricity',
            title: '100%_Power',
            vendor_name: 'NBPDCL',
            amount: '850.00',
            payment_method: 'upi',
            reference_number: 'UPI-123',
            notes: null,
            status: 'active',
            voided_at: null,
            void_reason: null,
            created_at: '2026-11-11T09:00:00.000Z',
            updated_at: '2026-11-11T09:00:00.000Z',
          },
        ],
        rowCount: 1,
      } as any;
    });

    const res = await request(app)
      .get('/api/v1/dashboard/expenses?search=100%25_&category=electricity&status=active&limit=10&offset=0')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.totalActiveAmount).toBe('850.00');
    expect(res.body.data.items).toHaveLength(1);
    expect(executed[0].params).toContain('%100\\%\\_%');
  });

  it('8. Creates, updates, voids, and blocks invalid mutations on voided/missing expenses with audit events', async () => {
    const baseRow = {
      id: SAMPLE_UUID,
      expense_date: '2026-11-11',
      category: 'rent',
      title: 'Shop Rent',
      vendor_name: 'Owner Landlord',
      amount: '15000.00',
      payment_method: 'bank_transfer',
      reference_number: 'NEFT-99',
      notes: 'Nov rent',
      status: 'active',
      voided_at: null,
      void_reason: null,
      created_at: '2026-11-11T09:00:00.000Z',
      updated_at: '2026-11-11T09:00:00.000Z',
    };

    const queries: string[] = [];
    let currentRow: any = baseRow;
    const mockClient = {
      query: vi.fn(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        queries.push(text);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('INSERT INTO business_expenses')) {
          return { rows: [baseRow], rowCount: 1 };
        }
        if (text.includes('FOR UPDATE')) {
          return currentRow ? { rows: [currentRow], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (text.includes('UPDATE business_expenses') && text.includes("status = 'voided'")) {
          currentRow = {
            ...baseRow,
            status: 'voided',
            voided_at: '2026-11-11T10:00:00.000Z',
            void_reason: 'Duplicate',
          };
          return { rows: [currentRow], rowCount: 1 };
        }
        if (text.includes('UPDATE business_expenses')) {
          currentRow = { ...baseRow, amount: '16000.00' };
          return { rows: [currentRow], rowCount: 1 };
        }
        if (text.includes('INSERT INTO business_expense_events')) {
          return { rows: [{ id: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const createRes = await request(app)
      .post('/api/v1/dashboard/expenses')
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        expenseDate: '2026-11-11',
        category: 'rent',
        title: 'Shop Rent',
        vendorName: 'Owner Landlord',
        amount: '15000.00',
        paymentMethod: 'bank_transfer',
        referenceNumber: 'NEFT-99',
        notes: 'Nov rent',
      });
    expect(createRes.status).toBe(201);
    expect(queries.some((q) => q.includes('INSERT INTO business_expense_events'))).toBe(true);

    const updateRes = await request(app)
      .put(`/api/v1/dashboard/expenses/${SAMPLE_UUID}`)
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        expenseDate: '2026-11-11',
        category: 'rent',
        title: 'Shop Rent',
        amount: '16000.00',
        paymentMethod: 'bank_transfer',
        reason: 'Adjusted',
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.amount).toBe('16000.00');

    const voidRes = await request(app)
      .post(`/api/v1/dashboard/expenses/${SAMPLE_UUID}/void`)
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ reason: 'Duplicate' });
    expect(voidRes.status).toBe(200);
    expect(voidRes.body.data.status).toBe('voided');

    // Editing or double-voiding a voided expense must return 409 Conflict
    const editVoided = await request(app)
      .put(`/api/v1/dashboard/expenses/${SAMPLE_UUID}`)
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({
        expenseDate: '2026-11-11',
        category: 'rent',
        title: 'Shop Rent',
        amount: '100.00',
        paymentMethod: 'cash',
      });
    expect(editVoided.status).toBe(409);

    const doubleVoid = await request(app)
      .post(`/api/v1/dashboard/expenses/${SAMPLE_UUID}/void`)
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ reason: 'Again' });
    expect(doubleVoid.status).toBe(409);

    // Missing ID -> 404
    currentRow = null;
    const notFound = await request(app)
      .post(`/api/v1/dashboard/expenses/${SAMPLE_UUID}/void`)
      .set('Cookie', authCookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ reason: 'Missing' });
    expect(notFound.status).toBe(404);
  });

  it('9. Resolves product buying_price snapshots for linked lines and leaves manual lines null', async () => {
    const client = {
      query: vi.fn(async () => ({
        rows: [
          { id: 10, buying_price: '245.50' },
          { id: 11, buying_price: '0.00' },
        ],
      })),
    } as any;

    const map = await resolveProductCostSnapshots(client, [
      { productId: 10 },
      { productId: 11 },
      { productId: null },
      {},
    ]);
    expect(map.get(10)).toBe('245.50');
    expect(map.get(11)).toBe('0.00');
    expect(map.size).toBe(2);

    const manualOnly = await resolveProductCostSnapshots(client, [{ productId: null }]);
    expect(manualOnly.size).toBe(0);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('10. Expense history endpoint validates params, enforces auth/404, and returns read-only snapshot audit events', async () => {
    const unauth = await request(app).get(`/api/v1/dashboard/expenses/${SAMPLE_UUID}/history`);
    expect(unauth.status).toBe(401);

    const badId = await request(app)
      .get('/api/v1/dashboard/expenses/not-a-uuid/history')
      .set('Cookie', authCookie);
    expect(badId.status).toBe(400);

    const badLimit = await request(app)
      .get(`/api/v1/dashboard/expenses/${SAMPLE_UUID}/history?limit=101`)
      .set('Cookie', authCookie);
    expect(badLimit.status).toBe(400);

    const executedSql: string[] = [];
    let expenseFound = false;
    const mockClient = {
      query: vi.fn(async (sql: any) => {
        const text = typeof sql === 'string' ? sql : sql?.text || '';
        executedSql.push(text);
        if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('FROM business_expenses')) {
          if (!expenseFound) return { rows: [], rowCount: 0 };
          return {
            rows: [
              {
                id: SAMPLE_UUID,
                expense_date: '2026-11-11',
                category: 'rent',
                title: 'Shop Rent',
                vendor_name: 'Owner Landlord',
                amount: '16000.00',
                payment_method: 'bank_transfer',
                reference_number: 'NEFT-99',
                notes: 'Updated rent',
                status: 'voided',
                voided_at: '2026-11-11T10:30:00.000Z',
                void_reason: 'Duplicate entry',
                created_at: '2026-11-11T08:00:00.000Z',
                updated_at: '2026-11-11T10:30:00.000Z',
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes('FROM business_expense_events')) {
          return {
            rows: [
              {
                id: 2,
                expense_id: SAMPLE_UUID,
                action: 'voided',
                reason: 'Duplicate entry',
                previous_data: { amount: '16000.00', status: 'active' },
                new_data: { amount: '16000.00', status: 'voided' },
                created_at: '2026-11-11T10:30:00.000Z',
              },
              {
                id: 1,
                expense_id: SAMPLE_UUID,
                action: 'created',
                reason: null,
                previous_data: null,
                new_data: { amount: '15000.00', status: 'active' },
                created_at: '2026-11-11T08:00:00.000Z',
              },
            ],
            rowCount: 2,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

    const notFoundRes = await request(app)
      .get(`/api/v1/dashboard/expenses/${SAMPLE_UUID}/history`)
      .set('Cookie', authCookie);
    expect(notFoundRes.status).toBe(404);

    expenseFound = true;
    const okRes = await request(app)
      .get(`/api/v1/dashboard/expenses/${SAMPLE_UUID}/history?limit=25`)
      .set('Cookie', authCookie);

    expect(okRes.status).toBe(200);
    expect(okRes.headers['cache-control']).toContain('no-store');
    expect(executedSql).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(executedSql).toContain('COMMIT');
    expect(okRes.body.data.expense.status).toBe('voided');
    expect(okRes.body.data.events).toHaveLength(2);
    expect(okRes.body.data.events.map((e: any) => e.action)).toEqual(['voided', 'created']);
  });

  it('11. Executes parameter-clean SQL on All Time overview (08P01 guard) and sets 6-month trend metadata', async () => {
    const { client, executedSql } = buildOverviewMockClient();
    vi.spyOn(appPool, 'connect').mockResolvedValue(client as any);

    const res = await request(app)
      .get('/api/v1/dashboard/overview')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.dateRange).toEqual({ fromDate: null, toDate: null });
    expect(res.body.data.salesTrend.granularity).toBe('month');
    expect(res.body.data.salesTrend.isSixMonthWindow).toBe(true);
    expect(res.body.data.salesTrend.effectiveFromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.data.salesTrend.effectiveToDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Ensure every parameterized query passes exact parameter count matching $N placeholders (prevents PG 08P01)
    for (const stmt of executedSql) {
      const matches = [...stmt.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      const highestPlaceholder = matches.length > 0 ? Math.max(...matches) : 0;
      const paramCount = stmt.params?.length ?? 0;
      expect(paramCount).toBe(highestPlaceholder);
    }
  });

  it('12. Clips monthly trend query strictly to mid-month custom endpoints when span > 45 days', async () => {
    const { client, executedSql } = buildOverviewMockClient();
    vi.spyOn(appPool, 'connect').mockResolvedValue(client as any);

    const res = await request(app)
      .get('/api/v1/dashboard/overview?fromDate=2026-09-15&toDate=2026-11-10')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.salesTrend.granularity).toBe('month');
    expect(res.body.data.salesTrend.isSixMonthWindow).toBe(false);
    expect(res.body.data.salesTrend.effectiveFromDate).toBe('2026-09-15');
    expect(res.body.data.salesTrend.effectiveToDate).toBe('2026-11-10');

    const trendQuery = executedSql.find((q) => q.text.includes('FROM series s'));
    expect(trendQuery).toBeDefined();
    expect(trendQuery!.text).toContain('bill_date >= $3::date AND bill_date <= $4::date');
    expect(trendQuery!.params?.slice(0, 4)).toEqual([
      '2026-09-01',
      '2026-11-01',
      '2026-09-15',
      '2026-11-10',
    ]);
  });

  it('13. Top-products SQL allocates bill discounts proportionally across all lines including manual items and excludes GST', async () => {
    const { client, executedSql } = buildOverviewMockClient();
    vi.spyOn(appPool, 'connect').mockResolvedValue(client as any);

    const res = await request(app)
      .get('/api/v1/dashboard/overview?fromDate=2026-11-01&toDate=2026-11-11')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const topSql = executedSql.find((q) => q.text.includes('nb_scored') && q.text.includes('gi_scored'));
    expect(topSql).toBeDefined();
    expect(topSql!.text).toContain('doc_subtotal');
    expect(topSql!.text).toContain('adj_rn');
    expect(topSql!.text).toContain('nbi.amount');
    expect(topSql!.text).toContain('gi.taxable_amount');
    expect(topSql!.text).not.toContain('gi.line_total');
    expect(topSql!.text).not.toContain('gi.total_amount');
  });

  it('14. Maps supplier reversal, bill cancellation, expense void activity types and uses sargable timestamp bounds', async () => {
    const { client, executedSql } = buildOverviewMockClient({
      activity: [
        {
          type: 'supplier_payment_reversal',
          reference: 'REV-PAY-001',
          party: 'Apex Timber',
          amount: '500.00',
          event_date: '2026-11-11',
          status: 'reversed',
          occurred_at: '2026-11-11T12:00:00.000Z',
          target_tab: 'suppliers',
        },
        {
          type: 'supplier_allocation_reversal',
          reference: 'REV-ALLOC-002',
          party: 'Apex Timber',
          amount: '250.00',
          event_date: '2026-11-11',
          status: 'reversed',
          occurred_at: '2026-11-11T11:30:00.000Z',
          target_tab: 'suppliers',
        },
        {
          type: 'supplier_bill_cancellation',
          reference: 'CANCEL-BILL-003',
          party: 'Apex Timber',
          amount: '1200.00',
          event_date: '2026-11-11',
          status: 'cancelled',
          occurred_at: '2026-11-11T11:00:00.000Z',
          target_tab: 'suppliers',
        },
        {
          type: 'expense_void',
          reference: 'Electricity Bill',
          party: 'Shop Operating Expense',
          amount: '900.00',
          event_date: '2026-11-11',
          status: 'voided',
          occurred_at: '2026-11-11T10:00:00.000Z',
          target_tab: 'home',
        },
      ],
    });
    vi.spyOn(appPool, 'connect').mockResolvedValue(client as any);

    const res = await request(app)
      .get('/api/v1/dashboard/overview?fromDate=2026-11-01&toDate=2026-11-11')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.recentActivity.map((a: any) => a.type)).toEqual([
      'supplier_payment_reversal',
      'supplier_allocation_reversal',
      'supplier_bill_cancellation',
      'expense_void',
    ]);

    const activitySql = executedSql.find((q) => q.text.includes('combined_activity'));
    expect(activitySql).toBeDefined();
    expect(activitySql!.text).toContain('AT TIME ZONE');
    expect(activitySql!.text).toContain("'supplier_payment_reversal'");
    expect(activitySql!.text).toContain("'supplier_allocation_reversal'");
    expect(activitySql!.text).toContain("'supplier_bill_cancellation'");
    expect(activitySql!.text).toContain("'expense_void'");

    const khataPaySql = executedSql.find((q) => q.text.includes('AS payments_received'));
    expect(khataPaySql!.text).toContain('received_at >=');
    expect(khataPaySql!.text).not.toContain('(received_at AT TIME ZONE');
  });

  it('15. Tracks migration 025 in EXPECTED_MIGRATIONS and exposes bounded numeric-only DB pool stats', () => {
    expect(EXPECTED_MIGRATIONS).toContain('025_performance_reporting_hardening.sql');
    expect(env.DB_POOL_MAX).toBeGreaterThanOrEqual(2);
    expect(env.DB_DIRECT_POOL_MAX).toBeGreaterThanOrEqual(1);
    expect(env.DB_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(env.DB_SLOW_QUERY_MS).toBeGreaterThanOrEqual(25);

    const stats = getDatabasePoolStats();
    expect(typeof stats.totalCount).toBe('number');
    expect(typeof stats.idleCount).toBe('number');
    expect(typeof stats.waitingCount).toBe('number');
    expect(stats.max).toBe(env.DB_POOL_MAX);
  });
});
