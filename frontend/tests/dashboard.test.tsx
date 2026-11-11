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
import type { DashboardOverviewData, PaginatedExpensesResult } from '../src/features/dashboard/dashboard.types.js';

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
});
