import Decimal from 'decimal.js';
import { apiClient } from '../../lib/apiClient.js';
import { fetchAuthorizedBlob, fetchPostPdfBlob } from '../../lib/pdfFetch.js';
import { downloadBlobSafely } from '../../utils/blobDownload.js';
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
  customerState?: string | null;
  customerStateCode?: string | null;
  subtotalAmount?: number | string | null;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | string | null;
  discountAmount?: number | string | null;
  items: NormalBillItemPayload[];
  notes?: string | null;
  idempotencyKey?: string | null;
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
  customer_state: string | null;
  customer_state_code: string | null;
  subtotal_amount?: string;
  discount_type?: 'percentage' | 'fixed' | null;
  discount_value?: string;
  discount_amount?: string;
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

export async function retryNormalBillPdf(id: number): Promise<NormalBillRecord> {
  const { data } = await apiClient<{ success: boolean; bill: NormalBillRecord }>(
    `/api/v1/normal-bills/${id}/retry-pdf`,
    { method: 'POST' }
  );
  return data.bill;
}

export async function fetchNormalBillPdfBlob(id: number, signal?: AbortSignal): Promise<Blob> {
  return fetchAuthorizedBlob(
    `/api/v1/normal-bills/${id}/pdf?download=true`,
    'Failed to fetch normal bill PDF',
    signal
  );
}

export async function fetchNormalBillDraftPdfBlob(
  payload: CreateNormalBillPayload,
  signal?: AbortSignal
): Promise<Blob> {
  return fetchPostPdfBlob(
    '/api/v1/normal-bills/preview-pdf',
    payload,
    'Failed to generate draft bill PDF',
    signal
  );
}

export async function downloadNormalBillPdf(id: number, billNumber: string): Promise<void> {
  const blob = await fetchNormalBillPdfBlob(id);
  downloadBlobSafely(blob, `Normal_Bill_${billNumber}.pdf`);
}

export async function downloadNormalBillDraftPdf(payload: CreateNormalBillPayload): Promise<void> {
  const blob = await fetchNormalBillDraftPdfBlob(payload);
  downloadBlobSafely(blob, `Normal_Bill_${payload.billNumber || 'Draft'}.pdf`);
}

function toDecSafe(value: string | number | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  try {
    const parsed = new Decimal(String(value).trim());
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

export function mapNormalBillToInvoiceProps(
  record: NormalBillRecord,
  company?: {
    name?: string;
    address?: string | null;
    gstin?: string | null;
    phone?: string | null;
    jurisdiction?: string | null;
  }
): MannatInvoiceProps {
  const discountDec = toDecSafe(record.discount_amount);
  const totalDec = toDecSafe(record.total_amount);
  const derivedSubtotal = record.subtotal_amount
    ? toDecSafe(record.subtotal_amount).toFixed(2)
    : totalDec.plus(discountDec).toFixed(2);

  return {
    id: record.id,
    invoiceNumber: record.bill_number,
    invoiceDate: record.bill_date,
    transportationMode: record.transportation_mode,
    vehicleNumber: record.vehicle_number,
    dateOfSupply: record.date_of_supply,
    placeOfSupply: record.place_of_supply,
    company: {
      name: company?.name,
      address: company?.address,
      gstin: company?.gstin,
      phone: company?.phone,
      jurisdiction: company?.jurisdiction,
      state: record.state,
      stateCode: record.state_code,
    },
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
      subtotal: derivedSubtotal,
      discountType: record.discount_type ?? null,
      discountValue: record.discount_value ?? '0.00',
      discountAmount: record.discount_amount ?? '0.00',
      taxableAmount: record.total_amount,
      taxAmount: 0,
      grandTotal: record.total_amount,
    },
    amountInWords: record.amount_in_words,
  };
}
