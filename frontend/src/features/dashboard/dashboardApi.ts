import { apiClient } from '../../lib/apiClient.js';
import {
  addBusinessCalendarDays,
  getBusinessDateISO,
  getIndianFinancialYearRange,
  getPreviousBusinessMonthRange,
} from '../../utils/businessDate.js';
import type {
  BusinessExpenseRecord,
  DashboardDatePreset,
  DashboardOverviewData,
  ExpenseCategory,
  ExpenseHistoryResult,
  ExpensePaymentMethod,
  PaginatedExpensesResult,
  SaveExpensePayload,
} from './dashboard.types.js';

export const EXPENSE_CATEGORY_OPTIONS: Array<{ value: ExpenseCategory; label: string }> = [
  { value: 'rent', label: 'Rent & Premises' },
  { value: 'electricity', label: 'Electricity & Utilities' },
  { value: 'salaries', label: 'Staff Salaries' },
  { value: 'transport', label: 'Transport & Freight' },
  { value: 'packaging', label: 'Packaging & Supplies' },
  { value: 'maintenance', label: 'Repairs & Maintenance' },
  { value: 'marketing', label: 'Marketing & Promotion' },
  { value: 'misc', label: 'Miscellaneous' },
];

export const EXPENSE_PAYMENT_METHOD_OPTIONS: Array<{
  value: ExpensePaymentMethod;
  label: string;
}> = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'other', label: 'Other' },
];

export function formatExpenseCategoryLabel(category: ExpenseCategory): string {
  return EXPENSE_CATEGORY_OPTIONS.find((item) => item.value === category)?.label || category;
}

export function formatExpenseMethodLabel(method: ExpensePaymentMethod): string {
  return EXPENSE_PAYMENT_METHOD_OPTIONS.find((item) => item.value === method)?.label || method;
}

export function resolveHomeDateRange(
  preset: DashboardDatePreset,
  customFrom: string,
  customTo: string,
  todayISO: string = getBusinessDateISO()
): { fromDate?: string; toDate?: string } {
  if (preset === 'today') {
    return { fromDate: todayISO, toDate: todayISO };
  }
  if (preset === 'yesterday') {
    const yesterdayISO = addBusinessCalendarDays(-1, todayISO);
    return { fromDate: yesterdayISO, toDate: yesterdayISO };
  }
  if (preset === 'last_7_days') {
    return {
      fromDate: addBusinessCalendarDays(-6, todayISO),
      toDate: todayISO,
    };
  }
  if (preset === 'last_30_days') {
    return {
      fromDate: addBusinessCalendarDays(-29, todayISO),
      toDate: todayISO,
    };
  }
  if (preset === 'this_month') {
    return {
      fromDate: `${todayISO.slice(0, 7)}-01`,
      toDate: todayISO,
    };
  }
  if (preset === 'last_month') {
    return getPreviousBusinessMonthRange(todayISO);
  }
  if (preset === 'this_fy') {
    return getIndianFinancialYearRange(0, todayISO);
  }
  if (preset === 'previous_fy') {
    return getIndianFinancialYearRange(-1, todayISO);
  }
  if (preset === 'custom') {
    return {
      fromDate: customFrom.trim() || undefined,
      toDate: customTo.trim() || undefined,
    };
  }
  return {};
}

export async function fetchDashboardOverview(
  params: { fromDate?: string; toDate?: string } = {},
  signal?: AbortSignal
): Promise<DashboardOverviewData> {
  const qs = new URLSearchParams();
  if (params.fromDate) qs.set('fromDate', params.fromDate);
  if (params.toDate) qs.set('toDate', params.toDate);
  const queryStr = qs.toString();
  const endpoint = `/api/v1/dashboard/overview${queryStr ? `?${queryStr}` : ''}`;

  const { data } = await apiClient<{ success: boolean; data: DashboardOverviewData }>(endpoint, {
    method: 'GET',
    signal,
  });
  return data.data;
}

export async function fetchDashboardExpenses(
  params: {
    search?: string;
    category?: ExpenseCategory | 'all';
    status?: 'active' | 'voided' | 'all';
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
  } = {},
  signal?: AbortSignal
): Promise<PaginatedExpensesResult> {
  const qs = new URLSearchParams();
  if (params.search && params.search.trim()) qs.set('search', params.search.trim());
  if (params.category && params.category !== 'all') qs.set('category', params.category);
  if (params.status) qs.set('status', params.status);
  if (params.fromDate) qs.set('fromDate', params.fromDate);
  if (params.toDate) qs.set('toDate', params.toDate);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));

  const queryStr = qs.toString();
  const endpoint = `/api/v1/dashboard/expenses${queryStr ? `?${queryStr}` : ''}`;
  const { data } = await apiClient<{ success: boolean; data: PaginatedExpensesResult }>(endpoint, {
    method: 'GET',
    signal,
  });
  return data.data;
}

export async function createDashboardExpense(
  payload: SaveExpensePayload
): Promise<BusinessExpenseRecord> {
  const { data } = await apiClient<{ success: boolean; data: BusinessExpenseRecord }>(
    '/api/v1/dashboard/expenses',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  return data.data;
}

export async function updateDashboardExpense(
  id: string,
  payload: SaveExpensePayload
): Promise<BusinessExpenseRecord> {
  const { data } = await apiClient<{ success: boolean; data: BusinessExpenseRecord }>(
    `/api/v1/dashboard/expenses/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    }
  );
  return data.data;
}

export async function voidDashboardExpense(
  id: string,
  reason: string
): Promise<BusinessExpenseRecord> {
  const { data } = await apiClient<{ success: boolean; data: BusinessExpenseRecord }>(
    `/api/v1/dashboard/expenses/${encodeURIComponent(id)}/void`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }
  );
  return data.data;
}

export async function fetchDashboardExpenseHistory(
  id: string,
  limit = 50,
  signal?: AbortSignal
): Promise<ExpenseHistoryResult> {
  const { data } = await apiClient<{ success: boolean; data: ExpenseHistoryResult }>(
    `/api/v1/dashboard/expenses/${encodeURIComponent(id)}/history?limit=${Math.max(1, Math.min(100, Math.trunc(limit)))}`,
    {
      method: 'GET',
      signal,
    }
  );
  return data.data;
}
