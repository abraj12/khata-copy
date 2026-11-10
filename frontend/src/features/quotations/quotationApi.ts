import { apiClient, apiClientBlob } from '../../lib/apiClient.js';
import {
  Quotation,
  QuotationSettings,
  CreateQuotationPayload,
  QuotationStatus,
  QuotationSummaryCounts,
} from './quotation.types.js';

export function toQuotationSettingsPayload(
  settings: Partial<QuotationSettings> | Record<string, any>
): Record<string, any> {
  const payload: Record<string, any> = {};
  const map: Record<string, string> = {
    company_name: 'companyName',
    logo_url: 'logoUrl',
    state_code: 'stateCode',
    bank_name: 'bankName',
    bank_account_number: 'bankAccountNumber',
    bank_ifsc: 'bankIfsc',
    bank_branch: 'bankBranch',
    standard_validity_days: 'standardValidityDays',
    standard_payment_terms: 'standardPaymentTerms',
    standard_delivery_terms: 'standardDeliveryTerms',
    standard_warranty_terms: 'standardWarrantyTerms',
    standard_declaration: 'standardDeclaration',
    signatory_title: 'signatoryTitle',
  };

  Object.entries(settings).forEach(([key, val]) => {
    const targetKey = map[key] || key;
    if (val !== undefined) {
      payload[targetKey] = val;
    }
  });

  return payload;
}

export async function fetchNextQuotationNumber(): Promise<string> {
  const res = await apiClient<{ success: boolean; data: { nextNumber: string } }>(
    '/api/v1/quotations/next-number',
    { method: 'GET' }
  );
  return res.data?.data?.nextNumber || 'QT-001';
}

export async function fetchQuotationSettings(): Promise<QuotationSettings> {
  const res = await apiClient<{ success: boolean; data: QuotationSettings }>(
    '/api/v1/quotations/settings',
    { method: 'GET' }
  );
  return res.data?.data;
}

export async function updateQuotationSettings(
  settings: Partial<QuotationSettings>
): Promise<QuotationSettings> {
  const payload = toQuotationSettingsPayload(settings);
  const res = await apiClient<{ success: boolean; data: QuotationSettings }>(
    '/api/v1/quotations/settings',
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    }
  );
  return res.data?.data;
}

export async function fetchQuotations(query?: {
  status?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  quotations: Quotation[];
  pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
  summaryCounts: QuotationSummaryCounts;
}> {
  const params = new URLSearchParams();
  if (query?.status) params.set('status', query.status);
  if (query?.search) params.set('search', query.search);
  if (query?.startDate) params.set('startDate', query.startDate);
  if (query?.endDate) params.set('endDate', query.endDate);
  if (query?.limit) params.set('limit', String(query.limit));
  if (query?.offset) params.set('offset', String(query.offset));

  const url = `/api/v1/quotations${params.toString() ? `?${params.toString()}` : ''}`;
  const res = await apiClient<{
    success: boolean;
    data: Quotation[];
    pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
    summaryCounts: QuotationSummaryCounts;
  }>(url, { method: 'GET' });

  return {
    quotations: res.data?.data || [],
    pagination: res.data?.pagination || { limit: 25, offset: 0, hasMore: false, nextOffset: null },
    summaryCounts: res.data?.summaryCounts || {
      total: 0,
      draft: 0,
      sent: 0,
      accepted: 0,
      converted: 0,
      rejectedOrExpired: 0,
    },
  };
}

export async function fetchQuotationById(id: number): Promise<Quotation> {
  const res = await apiClient<{ success: boolean; data: Quotation }>(
    `/api/v1/quotations/${id}`,
    { method: 'GET' }
  );
  return res.data?.data;
}

export async function createQuotation(payload: CreateQuotationPayload): Promise<Quotation> {
  const res = await apiClient<{ success: boolean; data: Quotation }>(
    '/api/v1/quotations',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  return res.data?.data;
}

export async function updateQuotationStatus(
  id: number,
  status: QuotationStatus
): Promise<Quotation> {
  const res = await apiClient<{ success: boolean; data: Quotation }>(
    `/api/v1/quotations/${id}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }
  );
  return res.data?.data;
}

export async function convertQuotationToBill(
  id: number,
  billType: 'normal' | 'gst',
  force: boolean = false,
  gstRateOverride?: number | string,
  customerState?: string,
  customerStateCode?: string
): Promise<{ quotation: Quotation; billType: 'normal' | 'gst'; billId: number; billNumber: string }> {
  const res = await apiClient<{
    success: boolean;
    data: { quotation: Quotation; billType: 'normal' | 'gst'; billId: number; billNumber: string };
  }>(`/api/v1/quotations/${id}/convert-to-bill`, {
    method: 'POST',
    body: JSON.stringify({ billType, force, gstRateOverride, customerState, customerStateCode }),
  });
  return res.data?.data;
}

/**
 * Preview PDF on the fly: fetches PDF blob using CSRF-protected apiClientBlob.
 */
export async function previewQuotationPdf(payload: CreateQuotationPayload): Promise<Blob> {
  return apiClientBlob('/api/v1/quotations/preview-pdf', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Fetch saved quotation PDF as Blob for printing / downloading
 */
export async function fetchSavedQuotationPdfBlob(id: number): Promise<Blob> {
  return apiClientBlob(`/api/v1/quotations/${id}/pdf`, {
    method: 'GET',
  });
}
