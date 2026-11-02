import { apiClient, API_BASE_URL, getCsrfToken, fetchCsrfToken } from '../../lib/apiClient.js';
import { MannatInvoiceProps } from '../../components/MannatTaxInvoice/MannatTaxInvoice.js';

export interface NormalBillItemPayload {
  productId?: number | null;
  description: string;
  hsnCode?: string | null;
  quantity: number | string;
  unit?: string | null;
  rate: number | string;
  rateUnit?: string | null;
}

export interface CreateNormalBillPayload {
  billNumber?: string;
  billDate?: string;
  state?: string;
  stateCode?: string;
  transportationMode?: string | null;
  vehicleNumber?: string | null;
  dateOfSupply?: string | null;
  placeOfSupply?: string | null;
  customerId?: number | null;
  customerName: string;
  customerAddress?: string | null;
  customerPhone?: string | null;
  customerState?: string;
  customerStateCode?: string;
  items: NormalBillItemPayload[];
  notes?: string | null;
}

export interface NormalBillRecord {
  id: number;
  bill_number: string;
  bill_date: string;
  state: string;
  state_code: string;
  transportation_mode: string | null;
  vehicle_number: string | null;
  date_of_supply: string | null;
  place_of_supply: string | null;
  customer_id: number | null;
  customer_name: string;
  customer_address: string | null;
  customer_phone: string | null;
  customer_state: string;
  customer_state_code: string;
  total_amount: string;
  amount_in_words: string;
  r2_object_key: string | null;
  pdf_status: 'pending' | 'uploaded' | 'failed' | 'local_only';
  notes: string | null;
  created_at: string;
  updated_at: string;
  items?: Array<{
    id: number;
    bill_id: number;
    product_id: number | null;
    item_index: number;
    description: string;
    hsn_code: string | null;
    quantity: string;
    unit: string | null;
    rate: string;
    rate_unit: string | null;
    amount: string;
  }>;
}

export async function getNextNormalBillNumber(): Promise<string> {
  const { data } = await apiClient<{ success: boolean; nextBillNumber: string }>(
    '/api/v1/normal-bills/next-number'
  );
  return data.nextBillNumber;
}

export async function createNormalBill(payload: CreateNormalBillPayload): Promise<NormalBillRecord> {
  const { data } = await apiClient<{ success: boolean; bill: NormalBillRecord }>(
    '/api/v1/normal-bills',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  return data.bill;
}

export async function listNormalBills(params: {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}): Promise<{ bills: NormalBillRecord[]; pagination: { total: number; limit: number; offset: number } }> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.dateFrom) query.set('dateFrom', params.dateFrom);
  if (params.dateTo) query.set('dateTo', params.dateTo);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));

  const endpoint = `/api/v1/normal-bills?${query.toString()}`;
  const { data } = await apiClient<{
    success: boolean;
    bills: NormalBillRecord[];
    pagination: { total: number; limit: number; offset: number };
  }>(endpoint);

  return {
    bills: data.bills || [],
    pagination: data.pagination || { total: 0, limit: 25, offset: 0 },
  };
}

export async function getNormalBillById(id: number): Promise<NormalBillRecord> {
  const { data } = await apiClient<{ success: boolean; bill: NormalBillRecord }>(
    `/api/v1/normal-bills/${id}`
  );
  return data.bill;
}

export async function downloadNormalBillPdf(id: number, billNumber: string): Promise<void> {
  const url = `${API_BASE_URL}/api/v1/normal-bills/${id}/pdf?download=true`;
  const response = await fetch(url, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('Failed to download bill PDF');
  }

  const blob = await response.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `Normal_Bill_${billNumber}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(blobUrl);
}

export async function downloadNormalBillDraftPdf(payload: CreateNormalBillPayload): Promise<void> {
  const url = `${API_BASE_URL}/api/v1/normal-bills/preview-pdf`;
  let csrfToken = getCsrfToken();
  if (!csrfToken) {
    csrfToken = await fetchCsrfToken();
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    throw new Error(errorJson.message || 'Failed to download draft bill PDF');
  }

  const blob = await response.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `Normal_Bill_${payload.billNumber || 'Draft'}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(blobUrl);
}

export function mapNormalBillToInvoiceProps(record: NormalBillRecord): MannatInvoiceProps {
  return {
    id: record.id,
    invoiceNumber: record.bill_number,
    invoiceDate: record.bill_date,
    transportationMode: record.transportation_mode,
    vehicleNumber: record.vehicle_number,
    dateOfSupply: record.date_of_supply,
    placeOfSupply: record.place_of_supply,
    customer: {
      name: record.customer_name,
      address: record.customer_address,
      phone: record.customer_phone,
      state: record.customer_state,
      stateCode: record.customer_state_code,
    },
    items: (record.items || []).map((itm) => ({
      id: itm.id,
      name: itm.description,
      hsn: itm.hsn_code,
      quantity: itm.quantity,
      unit: itm.unit,
      rate: itm.rate,
      rateUnit: itm.rate_unit,
      amount: itm.amount,
    })),
    totals: {
      taxableAmount: record.total_amount,
      subtotal: record.total_amount,
      taxAmount: 0,
      grandTotal: record.total_amount,
    },
    amountInWords: record.amount_in_words,
  };
}
