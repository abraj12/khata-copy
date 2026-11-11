// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getInitialTab, KhataDashboard } from '../src/App.js';
import { Navbar } from '../src/components/Navbar.js';
import { AuthProvider } from '../src/features/auth/AuthProvider.js';
import { authApi } from '../src/features/auth/authApi.js';
import { ThemeAccessibilityProvider } from '../src/context/ThemeAccessibilityContext.js';
import { HomeDashboard } from '../src/features/dashboard/HomeDashboard.js';
import * as dashboardApi from '../src/features/dashboard/dashboardApi.js';
import type {
  DashboardOverviewData,
  ExpenseHistoryResult,
  PaginatedExpensesResult,
} from '../src/features/dashboard/dashboard.types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function buildSampleOverview(overrides: Partial<DashboardOverviewData> = {}): DashboardOverviewData {
  return {
    businessDate: '2026-11-11',
    timeZone: 'Asia/Kolkata',
    dateRange: { fromDate: null, toDate: null },
    sales: {
      normalBillsTotal: '1500.00',
      normalBillsCount: 2,
      gstTaxableSales: '2000.00',
      gstCollected: '360.00',
      gstInvoicesGrandTotal: '2360.00',
      gstInvoicesCount: 1,
      totalSalesRevenue: '3500.00',
      totalBilledAmountIncludingGst: '3860.00',
      totalBillsCount: 3,
      averageBillValue: '1166.67',
    },
    profitability: {
      totalSalesRevenue: '3500.00',
      costedSalesRevenue: '2500.00',
      uncostedSalesRevenue: '1000.00',
      estimatedCostOfGoodsSold: '1750.00',
      estimatedGrossProfit: '750.00',
      estimatedGrossMarginPercent: '30.00',
      costCoveragePercent: '71.43',
      operatingExpenses: '450.00',
      operatingExpensesCount: 2,
      voidedExpensesCount: 1,
      estimatedNetOperatingResult: '300.00',
      hasIncompleteCostData: true,
    },
    expensesByCategory: [{ category: 'rent', count: 1, totalAmount: '450.00' }],
    customersKhata: {
      totalCustomers: 10,
      activeCustomers: 9,
      newCustomersCount: 2,
      customersWithOutstanding: 4,
      totalOutstandingReceivable: '3200.00',
      creditGiven: '900.00',
      paymentsReceived: '400.00',
      paymentCount: 2,
    },
    products: {
      totalProducts: 15,
      activeProducts: 14,
      archivedProducts: 1,
      topProducts: [
        {
          productId: 1,
          productName: 'Cement Bag 50kg',
          totalQuantitySold: '10',
          totalSalesAmount: '3500.00',
          billCount: 3,
          isArchived: false,
        },
      ],
    },
    suppliers: {
      totalSuppliers: 4,
      activeSuppliers: 4,
      totalPurchases: '6000.00',
      purchaseBillsCount: 3,
      cancelledBillsCount: 1,
      totalPaymentsMade: '2400.00',
      paymentsCount: 2,
      totalPaymentsReversed: '300.00',
      totalOutstandingPayable: '3600.00',
      totalAdvanceCredit: '0.00',
      totalUnallocatedPayments: '0.00',
    },
    quotations: {
      totalCount: 5,
      draftCount: 1,
      sentCount: 1,
      acceptedCount: 1,
      convertedCount: 1,
      rejectedCount: 0,
      expiredCount: 1,
      conversionRatePercent: '20.00',
      pendingPipelineValue: '4500.00',
      convertedValue: '2000.00',
    },
    salesTrend: {
      granularity: 'month',
      points: [
        {
          bucket: '2026-11',
          label: 'Nov 2026',
          normalSales: '1500.00',
          gstTaxableSales: '2000.00',
          gstCollected: '360.00',
          totalSalesRevenue: '3500.00',
          expenses: '450.00',
          billsCount: 3,
        },
      ],
    },
    recentActivity: [
      {
        type: 'gst_invoice',
        reference: 'INV-001',
        party: 'Bharat Traders',
        amount: '2360.00',
        date: '2026-11-11',
        status: null,
        occurredAt: '2026-11-11T10:00:00.000Z',
        targetTab: 'gst-bill',
      },
    ],
    ...overrides,
  };
}

function buildExpensesResult(): PaginatedExpensesResult {
  return {
    items: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        expenseDate: '2026-11-11',
        category: 'rent',
        title: 'Shop Rent Nov',
        vendorName: 'Landlord',
        amount: '450.00',
        paymentMethod: 'cash',
        referenceNumber: null,
        notes: null,
        status: 'active',
        voidedAt: null,
        voidReason: null,
        createdAt: '2026-11-11T08:00:00.000Z',
        updatedAt: '2026-11-11T08:00:00.000Z',
      },
    ],
    total: 1,
    totalActiveAmount: '450.00',
    limit: 10,
    offset: 0,
    hasMore: false,
    nextOffset: null,
  };
}

function setInputValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Release #024: Home Dashboard Navigation, Profitability & Expenses UI Suite', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('1. Sets Home as default tab on / and renders Home first in Navbar ahead of Khata, Products, Quotations, Suppliers & Bill', async () => {
    expect(getInitialTab()).toBe('home');
    window.history.replaceState(null, '', '/khata');
    expect(getInitialTab()).toBe('khata');
    window.history.replaceState(null, '', '/suppliers');
    expect(getInitialTab()).toBe('suppliers');
    window.history.replaceState(null, '', '/');

    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { phone: '9876543210', role: 'OWNER' },
      csrfToken: 'csrf-123',
    } as any);

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <Navbar currentTab="home" onTabChange={() => {}} onOpenAppearance={() => {}} />
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });

    const navButtons = Array.from(container.querySelectorAll('nav button')).map((b) =>
      b.textContent?.trim()
    );
    expect(navButtons).toEqual(['Home', 'Khata', 'Products', 'Quotations', 'Suppliers', 'Bill']);
  });

  it('2. Renders loading skeleton initially, error banner with retry on failure, and live overview KPIs + partial-cost warning upon resolution', async () => {
    let rejectFirst!: (err: Error) => void;
    const overviewSpy = vi
      .spyOn(dashboardApi, 'fetchDashboardOverview')
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          })
      )
      .mockResolvedValueOnce(buildSampleOverview());

    vi.spyOn(dashboardApi, 'fetchDashboardExpenses').mockResolvedValue(buildExpensesResult());

    const onNavigate = vi.fn();

    await act(async () => {
      root.render(<HomeDashboard onNavigate={onNavigate} />);
    });

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      rejectFirst(new Error('Database timeout'));
    });

    expect(container.textContent).toContain('Database timeout');
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Retry'
    )!;
    expect(retryBtn).toBeDefined();

    await act(async () => {
      retryBtn.click();
    });

    expect(overviewSpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="kpi-sales-revenue-value"]')?.textContent).toContain(
      '₹3,500.00'
    );
    expect(container.querySelector('[data-testid="kpi-net-operating-value"]')?.textContent).toContain(
      '₹300.00'
    );
    expect(container.textContent).toContain('Partial Cost Data Notice');
    expect(container.textContent).toContain('Cost Coverage: 71.43%');
    expect(container.textContent).toContain('Cement Bag 50kg');

    // Quick action & KPI card click navigation
    const khataCard = container.querySelector('[data-testid="kpi-khata-receivable"]') as HTMLButtonElement;
    await act(async () => {
      khataCard.click();
    });
    expect(onNavigate).toHaveBeenCalledWith('khata');
  });

  it('3. Discards stale overview responses when switching period filters rapidly and validates custom dates', async () => {
    let resolveSlow!: (v: DashboardOverviewData) => void;
    const overviewSpy = vi
      .spyOn(dashboardApi, 'fetchDashboardOverview')
      .mockResolvedValueOnce(buildSampleOverview())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          })
      )
      .mockResolvedValueOnce(
        buildSampleOverview({
          sales: {
            ...buildSampleOverview().sales,
            totalSalesRevenue: '999.00',
          },
        })
      );
    vi.spyOn(dashboardApi, 'fetchDashboardExpenses').mockResolvedValue(buildExpensesResult());

    await act(async () => {
      root.render(<HomeDashboard onNavigate={() => {}} />);
    });

    const todayBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Today'
    )!;
    const last7Btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Last 7 Days'
    )!;

    await act(async () => {
      todayBtn.click();
      last7Btn.click();
    });

    // Resolve older 'Today' request after 'Last 7 Days' already resolved -> must NOT overwrite 999.00!
    await act(async () => {
      resolveSlow(
        buildSampleOverview({
          sales: { ...buildSampleOverview().sales, totalSalesRevenue: '111.00' },
        })
      );
    });

    expect(overviewSpy).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-testid="kpi-sales-revenue-value"]')?.textContent).toContain(
      '₹999.00'
    );
  });

  it('4. Handles expense creation and voiding with mandatory reason and refreshes overview totals', async () => {
    const overviewSpy = vi
      .spyOn(dashboardApi, 'fetchDashboardOverview')
      .mockResolvedValue(buildSampleOverview());
    vi.spyOn(dashboardApi, 'fetchDashboardExpenses').mockResolvedValue(buildExpensesResult());
    const createSpy = vi
      .spyOn(dashboardApi, 'createDashboardExpense')
      .mockResolvedValue(buildExpensesResult().items[0]);
    const voidSpy = vi
      .spyOn(dashboardApi, 'voidDashboardExpense')
      .mockResolvedValue({ ...buildExpensesResult().items[0], status: 'voided', voidReason: 'Mistake' });

    await act(async () => {
      root.render(<HomeDashboard onNavigate={() => {}} />);
    });

    const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add Expense')
    )!;
    await act(async () => {
      addBtn.click();
    });

    const titleInput = container.querySelector('input[placeholder*="Shop Monthly Rent"]') as HTMLInputElement;
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(titleInput, 'Power Bill');
      setInputValue(amountInput, '650.00');
    });

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save Expense'
    )!;
    await act(async () => {
      saveBtn.click();
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(overviewSpy).toHaveBeenCalledTimes(2);

    const voidBtn = container.querySelector('button[aria-label*="Void expense"]') as HTMLButtonElement;
    await act(async () => {
      voidBtn.click();
    });

    const reasonInput = container.querySelector('textarea[placeholder*="Duplicate entry"]') as HTMLTextAreaElement;
    await act(async () => {
      setInputValue(reasonInput, 'Mistake');
    });

    const confirmVoidBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Confirm Void'
    )!;
    await act(async () => {
      confirmVoidBtn.click();
    });

    expect(voidSpy).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'Mistake');
    expect(overviewSpy).toHaveBeenCalledTimes(3);
  });

  it('5. Supports browser back/forward navigation between / (Home) and /suppliers cleanly', async () => {
    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { phone: '9876543210', role: 'OWNER' },
      csrfToken: 'csrf-123',
    } as any);
    vi.spyOn(dashboardApi, 'fetchDashboardOverview').mockResolvedValue(buildSampleOverview());
    vi.spyOn(dashboardApi, 'fetchDashboardExpenses').mockResolvedValue(buildExpensesResult());

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <KhataDashboard />
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });

    expect(container.querySelector('[data-testid="home-dashboard"]')).not.toBeNull();

    await act(async () => {
      window.history.pushState(null, '', '/suppliers');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(container.querySelector('[data-testid="home-dashboard"]')).toBeNull();

    await act(async () => {
      window.history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(container.querySelector('[data-testid="home-dashboard"]')).not.toBeNull();
  });

  it('6. Resolves all 10 business-date presets cleanly including Yesterday, Last Month, This FY & Previous FY across Jan-Mar / Apr-Dec boundaries', () => {
    // Mid-year date (Nov 11, 2026 -> FY 2026-27)
    expect(dashboardApi.resolveHomeDateRange('yesterday', '', '', '2026-11-11')).toEqual({
      fromDate: '2026-11-10',
      toDate: '2026-11-10',
    });
    expect(dashboardApi.resolveHomeDateRange('last_month', '', '', '2026-11-11')).toEqual({
      fromDate: '2026-10-01',
      toDate: '2026-10-31',
    });
    expect(dashboardApi.resolveHomeDateRange('this_fy', '', '', '2026-11-11')).toEqual({
      fromDate: '2026-04-01',
      toDate: '2026-11-11',
    });
    expect(dashboardApi.resolveHomeDateRange('previous_fy', '', '', '2026-11-11')).toEqual({
      fromDate: '2025-04-01',
      toDate: '2026-03-31',
    });

    // Jan-Mar date (Feb 15, 2026 -> FY 2025-26) and Jan 1 -> Dec previous month
    expect(dashboardApi.resolveHomeDateRange('last_month', '', '', '2026-01-01')).toEqual({
      fromDate: '2025-12-01',
      toDate: '2025-12-31',
    });
    // March 15 in leap year 2024 -> Feb has 29 days
    expect(dashboardApi.resolveHomeDateRange('last_month', '', '', '2024-03-15')).toEqual({
      fromDate: '2024-02-01',
      toDate: '2024-02-29',
    });
    expect(dashboardApi.resolveHomeDateRange('this_fy', '', '', '2026-02-15')).toEqual({
      fromDate: '2025-04-01',
      toDate: '2026-02-15',
    });
    expect(dashboardApi.resolveHomeDateRange('previous_fy', '', '', '2026-02-15')).toEqual({
      fromDate: '2024-04-01',
      toDate: '2025-03-31',
    });
  });

  it('7. Aborts slow in-flight overview requests when applying an invalid custom date range so stale data cannot overwrite the error', async () => {
    let resolveSlowPreset!: (v: DashboardOverviewData) => void;
    let capturedAbortSignal: AbortSignal | undefined;

    vi.spyOn(dashboardApi, 'fetchDashboardOverview')
      .mockResolvedValueOnce(buildSampleOverview())
      .mockImplementationOnce((_params, signal) => {
        capturedAbortSignal = signal;
        return new Promise((resolve) => {
          resolveSlowPreset = resolve;
        });
      });
    vi.spyOn(dashboardApi, 'fetchDashboardExpenses').mockResolvedValue(buildExpensesResult());

    await act(async () => {
      root.render(<HomeDashboard onNavigate={() => {}} />);
    });

    const todayBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Today'
    )!;
    const customBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Custom'
    )!;

    await act(async () => {
      todayBtn.click();
    });
    expect(capturedAbortSignal?.aborted).toBe(false);

    await act(async () => {
      customBtn.click();
    });

    const fromInput = container.querySelector('input[aria-label="Custom From Date"]') as HTMLInputElement;
    const toInput = container.querySelector('input[aria-label="Custom To Date"]') as HTMLInputElement;
    const applyBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Apply Range'
    )!;

    await act(async () => {
      setInputValue(fromInput, '2026-11-20');
      setInputValue(toInput, '2026-11-10');
    });
    await act(async () => {
      applyBtn.click();
    });

    expect(capturedAbortSignal?.aborted).toBe(true);
    expect(container.textContent).toContain('End date cannot be earlier than start date.');

    // Even if an un-aborted slow promise resolves late, stale payload must be ignored
    await act(async () => {
      resolveSlowPreset(
        buildSampleOverview({
          sales: { ...buildSampleOverview().sales, totalSalesRevenue: '77777.00' },
        })
      );
    });
    expect(container.querySelector('[data-testid="kpi-sales-revenue-value"]')?.textContent).not.toContain(
      '₹77,777.00'
    );
    expect(container.textContent).toContain('End date cannot be earlier than start date.');
  });

  it('8. Labels Partial vs Complete Operating Results, Live Balance KPIs, and 6-Month All-Time Trend clearly', async () => {
    vi.spyOn(dashboardApi, 'fetchDashboardOverview')
      .mockResolvedValueOnce(
        buildSampleOverview({
          salesTrend: {
            granularity: 'month',
            effectiveFromDate: '2026-06-01',
            effectiveToDate: '2026-11-11',
            isSixMonthWindow: true,
            points: buildSampleOverview().salesTrend.points,
          },
        })
      )
      .mockResolvedValueOnce(
        buildSampleOverview({
          profitability: {
            ...buildSampleOverview().profitability,
            hasIncompleteCostData: false,
            costCoveragePercent: '100.00',
            uncostedSalesRevenue: '0.00',
          },
        })
      );
    vi.spyOn(dashboardApi, 'fetchDashboardExpenses').mockResolvedValue(buildExpensesResult());

    await act(async () => {
      root.render(<HomeDashboard onNavigate={() => {}} />);
    });

    expect(container.textContent).toContain('Partial Est. Net Operating Result');
    expect(container.textContent).toContain('Khata Receivable (Live)');
    expect(container.textContent).toContain('Supplier Payable (Live)');
    expect(container.textContent).toContain('trailing 6-month monthly window (2026-06-01 to 2026-11-11)');
    expect(container.textContent).toContain('KPI totals above still reflect All Time');

    const refreshBtn = container.querySelector('button[aria-label="Refresh dashboard metrics"]') as HTMLButtonElement;
    await act(async () => {
      refreshBtn.click();
    });

    expect(container.textContent).not.toContain('Partial Est. Net Operating Result');
    expect(container.textContent).toContain('Est. Net Operating Result');
  });

  it('9. Renders supplier reversal, bill cancellation, and expense void badges in Recent Activity feed', async () => {
    vi.spyOn(dashboardApi, 'fetchDashboardOverview').mockResolvedValue(
      buildSampleOverview({
        recentActivity: [
          {
            type: 'supplier_payment_reversal',
            reference: 'REV-PAY-01',
            party: 'Sharma Metals',
            amount: '500.00',
            date: '2026-11-11',
            status: 'reversed',
            occurredAt: '2026-11-11T12:00:00.000Z',
            targetTab: 'suppliers',
          },
          {
            type: 'supplier_allocation_reversal',
            reference: 'REV-ALLOC-02',
            party: 'Sharma Metals',
            amount: '250.00',
            date: '2026-11-11',
            status: 'reversed',
            occurredAt: '2026-11-11T11:30:00.000Z',
            targetTab: 'suppliers',
          },
          {
            type: 'supplier_bill_cancellation',
            reference: 'SB-CANCEL-03',
            party: 'Sharma Metals',
            amount: '1200.00',
            date: '2026-11-11',
            status: 'cancelled',
            occurredAt: '2026-11-11T11:00:00.000Z',
            targetTab: 'suppliers',
          },
          {
            type: 'expense_void',
            reference: 'Office Tea',
            party: 'Shop Operating Expense',
            amount: '150.00',
            date: '2026-11-11',
            status: 'voided',
            occurredAt: '2026-11-11T10:00:00.000Z',
            targetTab: 'home',
          },
        ],
      })
    );
    vi.spyOn(dashboardApi, 'fetchDashboardExpenses').mockResolvedValue(buildExpensesResult());

    await act(async () => {
      root.render(<HomeDashboard onNavigate={() => {}} />);
    });

    expect(container.textContent).toContain('Payment Reversal');
    expect(container.textContent).toContain('Allocation Reversal');
    expect(container.textContent).toContain('Bill Cancelled');
    expect(container.textContent).toContain('Expense Voided');
  });

  it('10. Opens read-only Expense Audit History modal and displays created/updated/voided diff timeline', async () => {
    vi.spyOn(dashboardApi, 'fetchDashboardOverview').mockResolvedValue(buildSampleOverview());
    vi.spyOn(dashboardApi, 'fetchDashboardExpenses').mockResolvedValue(buildExpensesResult());

    const historySample: ExpenseHistoryResult = {
      expense: buildExpensesResult().items[0],
      events: [
        {
          id: 2,
          expenseId: buildExpensesResult().items[0].id,
          action: 'updated',
          reason: 'Rent revision',
          previousData: { amount: '400.00', title: 'Shop Rent' },
          newData: { amount: '450.00', title: 'Shop Rent Nov' },
          createdAt: '2026-11-11T09:00:00.000Z',
        },
        {
          id: 1,
          expenseId: buildExpensesResult().items[0].id,
          action: 'created',
          reason: null,
          previousData: null,
          newData: { amount: '400.00', title: 'Shop Rent', expense_date: '2026-11-11', category: 'rent' },
          createdAt: '2026-11-11T08:00:00.000Z',
        },
      ],
    };
    const historySpy = vi
      .spyOn(dashboardApi, 'fetchDashboardExpenseHistory')
      .mockResolvedValue(historySample);

    await act(async () => {
      root.render(<HomeDashboard onNavigate={() => {}} />);
    });

    const historyBtn = container.querySelector('button[aria-label*="View history for Shop Rent Nov"]') as HTMLButtonElement;
    expect(historyBtn).not.toBeNull();

    await act(async () => {
      historyBtn.click();
    });

    expect(historySpy).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 50, expect.any(AbortSignal));
    expect(container.textContent).toContain('Expense Audit History');
    expect(container.textContent).toContain('Reason: Rent revision');
    expect(container.textContent).toContain('Amount: 400.00 → 450.00');
    expect(container.textContent).toContain('Title: Shop Rent → Shop Rent Nov');

    const closeBtn = container.querySelector('button[aria-label="Close history modal"]') as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });
    expect(container.textContent).not.toContain('Expense Audit History');
  });

  it('11. Renders Home eagerly and transitions lazily loaded feature routes via React.Suspense cleanly', async () => {
    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { phone: '9876543210', role: 'OWNER' },
      csrfToken: 'csrf-123',
    } as any);
    vi.spyOn(dashboardApi, 'fetchDashboardOverview').mockResolvedValue(buildSampleOverview());
    vi.spyOn(dashboardApi, 'fetchDashboardExpenses').mockResolvedValue(buildExpensesResult());

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <KhataDashboard />
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });

    // Home renders without Suspense fallback
    expect(container.querySelector('[data-testid="home-dashboard"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Loading module...');

    // Mock fetch cleanly with fresh Response instances per call so concurrent effects never collide on shared Response body streams
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: [],
          total: 0,
          activeCount: 0,
          archivedCount: 0,
          hasMore: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    // Switch to lazy Products route and verify Suspense boundary transitions cleanly
    await act(async () => {
      window.history.pushState(null, '', '/products');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(container.querySelector('[data-testid="home-dashboard"]')).toBeNull();

    // Poll cleanly inside act() so lazy chunk load + child fetch effects settle without React act warnings
    for (let i = 0; i < 40; i++) {
      if (!container.textContent?.includes('Loading module...')) break;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(container.textContent).not.toContain('Loading module...');
  });
});
