import Decimal from 'decimal.js';
import {
  API_BASE_URL,
  ApiClientError,
  apiClient,
  apiClientBlob,
  fetchCsrfToken,
  getCsrfToken,
} from '../../lib/apiClient.js';
import { formatCurrency, safeDecimal } from '../../lib/formatters.js';
import type {
  CatalogProductOption,
  CreatePurchaseBillPayload,
  CreateSupplierPaymentPayload,
  CreateSupplierPayload,
  PaginationMeta,
  PurchaseBillDetail,
  PurchaseBillSummary,
  SupplierDashboardData,
  SupplierPaymentMethod,
  SupplierPaymentRecord,
  SupplierRecord,
  SupplierStatementData,
  UpdatePurchaseBillPayload,
} from './suppliers.types.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{8,128}$/;

export function createSupplierIdempotencyKey(prefix = 'sup'): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 16) || 'sup';
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${safePrefix}_${crypto.randomUUID()}`;
  }
  return `${safePrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isValidIdempotencyKeyFormat(key: string): boolean {
  return IDEMPOTENCY_KEY_REGEX.test(key.trim());
}

/**
 * Collects all paginated records across backend 200-row pages without truncation.
 */
export async function fetchAllPages<T>(
  loadPage: (
    offset: number,
    limit: number
  ) => Promise<{ items: T[]; hasMore: boolean; nextOffset: number | null }>,
  limit = 200
): Promise<T[]> {
  const collected: T[] = [];
  let offset = 0;
  let pagesFetched = 0;
  while (pagesFetched < 200) {
    pagesFetched += 1;
    const page = await loadPage(offset, limit);
    collected.push(...page.items);
    if (!page.hasMore || page.nextOffset === null || page.items.length === 0) {
      break;
    }
    offset = page.nextOffset;
  }
  return collected;
}

export function formatAbsRupees(value: unknown): string {
  return formatCurrency(safeDecimal(value).abs().toFixed(2));
}

/**
 * Pure draft purchase bill totals preview synchronized with backend accounting module.
 */
export function computeDraftPurchaseBillTotals(
  items: Array<{ quantity: string | number; purchaseRate: string | number }>,
  discountAmountInput: string | number = 0,
  gstRateInput: string | number = 0
): {
  lineTotals: string[];
  subtotalAmount: string;
  discountAmount: string;
  taxableAmount: string;
  gstAmount: string;
  grandTotal: string;
} {
  let subtotal = new Decimal(0);
  const lineTotals = items.map((item) => {
    const qty = safeDecimal(item.quantity);
    const rate = safeDecimal(item.purchaseRate);
    if (qty.lessThanOrEqualTo(0) || rate.isNegative()) return '0.00';
    const lineTotal = qty.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    subtotal = subtotal.plus(lineTotal);
    return lineTotal.toFixed(2);
  });

  const discount = Decimal.max(safeDecimal(discountAmountInput), new Decimal(0)).toDecimalPlaces(
    2,
    Decimal.ROUND_HALF_UP
  );
  const taxable = Decimal.max(subtotal.minus(discount), new Decimal(0)).toDecimalPlaces(
    2,
    Decimal.ROUND_HALF_UP
  );
  const gstRate = Decimal.min(
    Decimal.max(safeDecimal(gstRateInput), new Decimal(0)),
    new Decimal(100)
  );
  const gstAmount = taxable.times(gstRate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const grandTotal = taxable.plus(gstAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    lineTotals,
    subtotalAmount: subtotal.toFixed(2),
    discountAmount: discount.toFixed(2),
    taxableAmount: taxable.toFixed(2),
    gstAmount: gstAmount.toFixed(2),
    grandTotal: grandTotal.toFixed(2),
  };
}

/**
 * Allocates a payment amount chronologically across open bills (used by Auto-Allocate FIFO button).
 */
export function computeAutoFifoBillAllocations(
  paymentAmountInput: string | number,
  openBills: Array<{ id: number; remainingAmount: string; invoiceDate: string }>
): Record<number, string> {
  let remainingPayment = safeDecimal(paymentAmountInput);
  if (remainingPayment.lessThanOrEqualTo(0)) return {};

  const sorted = [...openBills].sort((a, b) => {
    if (a.invoiceDate !== b.invoiceDate) return a.invoiceDate < b.invoiceDate ? -1 : 1;
    return a.id - b.id;
  });

  const allocations: Record<number, string> = {};
  for (const bill of sorted) {
    if (remainingPayment.lessThanOrEqualTo(0)) break;
    const billDue = safeDecimal(bill.remainingAmount);
    if (billDue.lessThanOrEqualTo(0)) continue;
    const alloc = Decimal.min(remainingPayment, billDue).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (alloc.greaterThan(0)) {
      allocations[bill.id] = alloc.toFixed(2);
      remainingPayment = remainingPayment.minus(alloc);
    }
  }
  return allocations;
}

export function isDigitalSupplierPaymentMethod(method: SupplierPaymentMethod): boolean {
  return method === 'upi' || method === 'bank_transfer' || method === 'cheque';
}

export function getSupplierPaymentReferenceFieldMeta(method: SupplierPaymentMethod): {
  required: boolean;
  label: string;
  placeholder: string;
} {
  if (method === 'upi') {
    return {
      required: true,
      label: 'UPI Transaction ID',
      placeholder: 'Enter UPI Transaction ID',
    };
  }
  if (method === 'bank_transfer') {
    return {
      required: true,
      label: 'UTR / Bank Reference',
      placeholder: 'Enter UTR / Bank reference number',
    };
  }
  if (method === 'cheque') {
    return {
      required: true,
      label: 'Cheque Number',
      placeholder: 'Enter cheque number',
    };
  }
  if (method === 'cash') {
    return {
      required: false,
      label: 'Reference / Voucher Note (Optional)',
      placeholder: 'Optional cash receipt or voucher note',
    };
  }
  return {
    required: false,
    label: 'Reference / Note (Optional)',
    placeholder: 'Optional payment reference',
  };
}

export function validateSupplierPaymentFormInput(input: {
  supplierArchivedAt: string | null;
  amount: string | number;
  paymentMethod: SupplierPaymentMethod;
  transactionReference?: string | null;
  allocatedAmountTotal: string | number;
  allocationCount: number;
}): {
  referenceError: string | null;
  allocationError: string | null;
} {
  const refMeta = getSupplierPaymentReferenceFieldMeta(input.paymentMethod);
  const trimmedRef = (input.transactionReference || '').trim();
  const referenceError =
    refMeta.required && !trimmedRef ? `${refMeta.label} is required.` : null;

  let allocationError: string | null = null;
  if (input.supplierArchivedAt) {
    const payAmt = safeDecimal(input.amount);
    const allocTotal = safeDecimal(input.allocatedAmountTotal);
    if (input.allocationCount === 0 || allocTotal.lessThanOrEqualTo(0)) {
      allocationError =
        'Archived suppliers cannot receive unallocated advances. Allocate the full payment to existing finalized bills.';
    } else if (!allocTotal.equals(payAmt)) {
      allocationError = `Archived supplier settlement must allocate exact full amount (${payAmt.toFixed(2)}) across existing bills (currently ${allocTotal.toFixed(2)}).`;
    }
  }

  return { referenceError, allocationError };
}

export async function fetchSupplierDashboard(params?: {
  fromDate?: string;
  toDate?: string;
}): Promise<SupplierDashboardData> {
  const qs = new URLSearchParams();
  if (params?.fromDate) qs.set('fromDate', params.fromDate);
  if (params?.toDate) qs.set('toDate', params.toDate);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await apiClient<{ success: boolean; data: SupplierDashboardData }>(
    `/api/v1/suppliers/dashboard${suffix}`
  );
  return res.data.data;
}

export async function listSuppliersApi(params?: {
  search?: string;
  status?: 'active' | 'archived' | 'all';
  limit?: number;
  offset?: number;
}): Promise<{ suppliers: SupplierRecord[]; total: number; pagination?: PaginationMeta }> {
  const qs = new URLSearchParams();
  if (params?.search?.trim()) qs.set('search', params.search.trim());
  if (params?.status) qs.set('status', params.status);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset !== undefined && params.offset > 0) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await apiClient<{
    success: boolean;
    data: { suppliers: SupplierRecord[]; total: number; pagination?: PaginationMeta };
  }>(`/api/v1/suppliers${suffix}`);
  return res.data.data;
}

export async function listAllSuppliersApi(params?: {
  search?: string;
  status?: 'active' | 'archived' | 'all';
}): Promise<SupplierRecord[]> {
  return fetchAllPages(async (offset, limit) => {
    const res = await listSuppliersApi({ ...params, limit, offset });
    const total = res.total ?? res.suppliers.length;
    const hasMore = res.pagination?.hasMore ?? offset + res.suppliers.length < total;
    const nextOffset =
      res.pagination?.nextOffset ?? (hasMore ? offset + res.suppliers.length : null);
    return { items: res.suppliers, hasMore, nextOffset };
  });
}

export async function getSupplierApi(id: string): Promise<SupplierRecord> {
  const res = await apiClient<{ success: boolean; data: SupplierRecord }>(
    `/api/v1/suppliers/${id}`
  );
  return res.data.data;
}

export async function createSupplierApi(
  payload: CreateSupplierPayload
): Promise<SupplierRecord> {
  const res = await apiClient<{ success: boolean; data: SupplierRecord }>('/api/v1/suppliers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.data.data;
}

export async function updateSupplierApi(
  id: string,
  payload: Partial<CreateSupplierPayload>
): Promise<SupplierRecord> {
  const res = await apiClient<{ success: boolean; data: SupplierRecord }>(
    `/api/v1/suppliers/${id}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    }
  );
  return res.data.data;
}

export async function archiveSupplierApi(id: string): Promise<SupplierRecord> {
  const res = await apiClient<{ success: boolean; data: SupplierRecord }>(
    `/api/v1/suppliers/${id}/archive`,
    { method: 'POST' }
  );
  return res.data.data;
}

export async function restoreSupplierApi(id: string): Promise<SupplierRecord> {
  const res = await apiClient<{ success: boolean; data: SupplierRecord }>(
    `/api/v1/suppliers/${id}/restore`,
    { method: 'POST' }
  );
  return res.data.data;
}

export async function deleteSupplierApi(id: string): Promise<void> {
  await apiClient(`/api/v1/suppliers/${id}`, { method: 'DELETE' });
}

export async function listPurchaseBillsApi(params?: {
  supplierId?: string;
  status?: 'finalized' | 'cancelled' | 'all';
  search?: string;
  fromDate?: string;
  toDate?: string;
  openOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ purchaseBills: PurchaseBillSummary[]; total: number; pagination?: PaginationMeta }> {
  const qs = new URLSearchParams();
  if (params?.supplierId) qs.set('supplierId', params.supplierId);
  if (params?.status) qs.set('status', params.status);
  if (params?.search?.trim()) qs.set('search', params.search.trim());
  if (params?.fromDate) qs.set('fromDate', params.fromDate);
  if (params?.toDate) qs.set('toDate', params.toDate);
  if (params?.openOnly) qs.set('openOnly', 'true');
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset !== undefined && params.offset > 0) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await apiClient<{
    success: boolean;
    data: { purchaseBills: PurchaseBillSummary[]; total: number; pagination?: PaginationMeta };
  }>(`/api/v1/suppliers/purchase-bills${suffix}`);
  return res.data.data;
}

export async function listAllOpenPurchaseBillsForSupplierApi(
  supplierId: string
): Promise<PurchaseBillSummary[]> {
  return fetchAllPages(async (offset, limit) => {
    const res = await listPurchaseBillsApi({
      supplierId,
      openOnly: true,
      limit,
      offset,
    });
    const total = res.total ?? res.purchaseBills.length;
    const hasMore = res.pagination?.hasMore ?? offset + res.purchaseBills.length < total;
    const nextOffset =
      res.pagination?.nextOffset ?? (hasMore ? offset + res.purchaseBills.length : null);
    return { items: res.purchaseBills, hasMore, nextOffset };
  });
}

export async function getPurchaseBillApi(billId: number): Promise<PurchaseBillDetail> {
  const res = await apiClient<{ success: boolean; data: PurchaseBillDetail }>(
    `/api/v1/suppliers/purchase-bills/${billId}`
  );
  return res.data.data;
}

export async function createPurchaseBillApi(
  payload: CreatePurchaseBillPayload
): Promise<PurchaseBillDetail> {
  const res = await apiClient<{ success: boolean; data: PurchaseBillDetail }>(
    '/api/v1/suppliers/purchase-bills',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  return res.data.data;
}

export async function updatePurchaseBillApi(
  billId: number,
  payload: UpdatePurchaseBillPayload
): Promise<PurchaseBillDetail> {
  const res = await apiClient<{ success: boolean; data: PurchaseBillDetail }>(
    `/api/v1/suppliers/purchase-bills/${billId}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    }
  );
  return res.data.data;
}

export async function cancelPurchaseBillApi(
  billId: number,
  reason: string
): Promise<PurchaseBillDetail> {
  const res = await apiClient<{ success: boolean; data: PurchaseBillDetail }>(
    `/api/v1/suppliers/purchase-bills/${billId}/cancel`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }
  );
  return res.data.data;
}

export async function uploadPurchaseBillAttachmentApi(
  billId: number,
  file: File
): Promise<PurchaseBillDetail> {
  let csrfToken = getCsrfToken();
  if (!csrfToken) {
    csrfToken = await fetchCsrfToken();
  }

  const formData = new FormData();
  formData.append('file', file);

  const sendUpload = async (token: string | null) =>
    fetch(`${API_BASE_URL}/api/v1/suppliers/purchase-bills/${billId}/attachment`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { 'X-CSRF-Token': token } : {},
      body: formData,
    });

  let response = await sendUpload(csrfToken);
  if (response.status === 403) {
    const refreshed = await fetchCsrfToken();
    if (refreshed) {
      response = await sendUpload(refreshed);
    }
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiClientError(payload.message || 'Failed to upload purchase bill attachment.', {
      status: response.status,
      code: payload.code || 'UPLOAD_ERROR',
      payload,
    });
  }
  return payload.data;
}

export async function fetchPurchaseBillAttachmentBlob(
  billId: number,
  download = false
): Promise<Blob> {
  return apiClientBlob(
    `/api/v1/suppliers/purchase-bills/${billId}/attachment${download ? '?download=true' : ''}`
  );
}

export async function deletePurchaseBillAttachmentApi(
  billId: number
): Promise<PurchaseBillDetail> {
  const res = await apiClient<{ success: boolean; data: PurchaseBillDetail }>(
    `/api/v1/suppliers/purchase-bills/${billId}/attachment`,
    { method: 'DELETE' }
  );
  return res.data.data;
}

export async function listSupplierPaymentsApi(params?: {
  supplierId?: string;
  paymentMethod?: SupplierPaymentMethod;
  status?: 'active' | 'reversed' | 'all';
  search?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}): Promise<{ payments: SupplierPaymentRecord[]; total: number; pagination?: PaginationMeta }> {
  const qs = new URLSearchParams();
  if (params?.supplierId) qs.set('supplierId', params.supplierId);
  if (params?.paymentMethod) qs.set('paymentMethod', params.paymentMethod);
  if (params?.status) qs.set('status', params.status);
  if (params?.search?.trim()) qs.set('search', params.search.trim());
  if (params?.fromDate) qs.set('fromDate', params.fromDate);
  if (params?.toDate) qs.set('toDate', params.toDate);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset !== undefined && params.offset > 0) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await apiClient<{
    success: boolean;
    data: { payments: SupplierPaymentRecord[]; total: number; pagination?: PaginationMeta };
  }>(`/api/v1/suppliers/payments${suffix}`);
  return res.data.data;
}

export async function getSupplierPaymentApi(paymentId: number): Promise<SupplierPaymentRecord> {
  const res = await apiClient<{ success: boolean; data: SupplierPaymentRecord }>(
    `/api/v1/suppliers/payments/${paymentId}`
  );
  return res.data.data;
}

export async function createSupplierPaymentApi(
  payload: CreateSupplierPaymentPayload,
  idempotencyKey?: string
): Promise<SupplierPaymentRecord> {
  const key = idempotencyKey || createSupplierIdempotencyKey('spay');
  const res = await apiClient<{ success: boolean; data: SupplierPaymentRecord }>(
    '/api/v1/suppliers/payments',
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload),
    }
  );
  return res.data.data;
}

export async function allocateSupplierAdvanceApi(
  paymentId: number,
  allocations: Array<{ purchaseBillId: number; amount: string | number }>,
  idempotencyKey?: string
): Promise<SupplierPaymentRecord> {
  const key = idempotencyKey || createSupplierIdempotencyKey('salloc');
  const res = await apiClient<{ success: boolean; data: SupplierPaymentRecord }>(
    `/api/v1/suppliers/payments/${paymentId}/allocate`,
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ allocations }),
    }
  );
  return res.data.data;
}

export async function reverseSupplierPaymentApi(
  paymentId: number,
  reason: string,
  idempotencyKey?: string
): Promise<SupplierPaymentRecord> {
  const key = idempotencyKey || createSupplierIdempotencyKey('srev');
  const res = await apiClient<{ success: boolean; data: SupplierPaymentRecord }>(
    `/api/v1/suppliers/payments/${paymentId}/reverse`,
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ reason }),
    }
  );
  return res.data.data;
}

export async function reverseSupplierAllocationApi(
  paymentId: number,
  allocationId: number,
  payload: { amount: string | number; reason: string },
  idempotencyKey?: string
): Promise<SupplierPaymentRecord> {
  const key = idempotencyKey || createSupplierIdempotencyKey('sarev');
  const res = await apiClient<{ success: boolean; data: SupplierPaymentRecord }>(
    `/api/v1/suppliers/payments/${paymentId}/allocations/${allocationId}/reverse`,
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload),
    }
  );
  return res.data.data;
}

export async function fetchSupplierStatementApi(
  supplierId: string,
  params?: { fromDate?: string; toDate?: string }
): Promise<SupplierStatementData> {
  const qs = new URLSearchParams();
  if (params?.fromDate) qs.set('fromDate', params.fromDate);
  if (params?.toDate) qs.set('toDate', params.toDate);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await apiClient<{ success: boolean; data: SupplierStatementData }>(
    `/api/v1/suppliers/${supplierId}/statement${suffix}`
  );
  return res.data.data;
}

export async function downloadSupplierStatementCsvApi(
  supplierId: string,
  supplierName: string,
  params?: { fromDate?: string; toDate?: string }
): Promise<void> {
  const qs = new URLSearchParams();
  if (params?.fromDate) qs.set('fromDate', params.fromDate);
  if (params?.toDate) qs.set('toDate', params.toDate);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const blob = await apiClientBlob(`/api/v1/suppliers/${supplierId}/statement/export${suffix}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const slug =
    supplierName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'supplier';
  a.href = url;
  a.download = `supplier-statement-${slug}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function fetchCatalogProductsForSupplierBills(
  search?: string
): Promise<CatalogProductOption[]> {
  const qs = new URLSearchParams();
  qs.set('limit', '200');
  if (search?.trim()) qs.set('search', search.trim());
  const res = await apiClient<{
    success: boolean;
    data: { products: CatalogProductOption[] };
  }>(`/api/v1/products?${qs.toString()}`);
  return res.data.data?.products || [];
}
