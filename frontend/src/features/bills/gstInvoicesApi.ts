import { apiClient, API_BASE_URL } from '../../lib/apiClient.js';
import { MannatInvoiceProps } from '../../components/MannatTaxInvoice/MannatTaxInvoice.js';

export interface GstInvoiceItemPayload {
  productId?: number | null;
  description: string;
  hsnCode?: string | null;
  quantity: number | string;
  unit?: string | null;
  rate: number | string;
  rateUnit?: string | null;
}

export interface CreateGstInvoicePayload {
  invoiceNumber?: string;
  invoiceDate?: string;
  state?: string;
  stateCode?: string;
  transportationMode?: string | null;
  vehicleNumber?: string | null;
  dateOfSupply?: string | null;
  placeOfSupply?: string | null;
  customerId?: number | null;
  customerName: string;
  customerAddress?: string | null;
  customerGstin?: string | null;
  customerState?: string;
  customerStateCode?: string;
  gstRate: number | string;
  items: GstInvoiceItemPayload[];
  notes?: string | null;
}

export interface GstInvoiceRecord {
  id: number;
  invoice_number: string;
  invoice_date: string;
  state: string;
  state_code: string;
  transportation_mode: string | null;
  vehicle_number: string | null;
  date_of_supply: string | null;
  place_of_supply: string | null;
  customer_id: number | null;
  customer_name: string;
  customer_address: string | null;
  customer_gstin: string | null;
  customer_state: string;
  customer_state_code: string;
  taxable_amount: string;
  cgst_rate: string;
  cgst_amount: string;
  sgst_rate: string;
  sgst_amount: string;
  igst_rate: string;
  igst_amount: string;
  tax_amount: string;
  grand_total: string;
  amount_in_words: string;
  r2_object_key: string | null;
  pdf_status: 'pending' | 'uploaded' | 'failed' | 'local_only';
  notes: string | null;
  created_at: string;
  updated_at: string;
  items?: Array<{
    id: number;
    invoice_id: number;
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

export async function getNextInvoiceNumber(): Promise<string> {
  const { data } = await apiClient<{ success: boolean; nextInvoiceNumber: string }>(
    '/api/v1/gst-invoices/next-number'
  );
  return data.nextInvoiceNumber;
}

export async function createGstInvoice(payload: CreateGstInvoicePayload): Promise<GstInvoiceRecord> {
  const { data } = await apiClient<{ success: boolean; data: GstInvoiceRecord }>(
    '/api/v1/gst-invoices',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
  return data.data;
}

export async function listGstInvoices(params: {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}): Promise<{ invoices: GstInvoiceRecord[]; pagination: { total: number; limit: number; offset: number } }> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.dateFrom) query.set('dateFrom', params.dateFrom);
  if (params.dateTo) query.set('dateTo', params.dateTo);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));

  const endpoint = `/api/v1/gst-invoices?${query.toString()}`;
  const { data } = await apiClient<{
    success: boolean;
    invoices: GstInvoiceRecord[];
    pagination: { total: number; limit: number; offset: number };
  }>(endpoint);

  return {
    invoices: data.invoices || [],
    pagination: data.pagination || { total: 0, limit: 25, offset: 0 },
  };
}

export async function getGstInvoiceById(id: number): Promise<GstInvoiceRecord> {
  const { data } = await apiClient<{ success: boolean; data: GstInvoiceRecord }>(
    `/api/v1/gst-invoices/${id}`
  );
  return data.data;
}

export async function downloadInvoicePdf(id: number, invoiceNumber: string): Promise<void> {
  const url = `${API_BASE_URL}/api/v1/gst-invoices/${id}/pdf?download=true`;
  const response = await fetch(url, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error('Failed to download invoice PDF');
  }

  const blob = await response.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `Invoice_${invoiceNumber}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(blobUrl);
}

export async function downloadDraftPdf(payload: CreateGstInvoicePayload): Promise<void> {
  const url = `${API_BASE_URL}/api/v1/gst-invoices/preview-pdf`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    throw new Error(errorJson.message || 'Failed to download draft PDF');
  }

  const blob = await response.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `Invoice_${payload.invoiceNumber || 'Draft'}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(blobUrl);
}

export function mapRecordToInvoiceProps(record: GstInvoiceRecord): MannatInvoiceProps {
  return {
    id: record.id,
    invoiceNumber: record.invoice_number,
    invoiceDate: record.invoice_date,
    transportationMode: record.transportation_mode,
    vehicleNumber: record.vehicle_number,
    dateOfSupply: record.date_of_supply,
    placeOfSupply: record.place_of_supply,
    customer: {
      name: record.customer_name,
      address: record.customer_address,
      gstin: record.customer_gstin,
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
      taxableAmount: record.taxable_amount,
      cgstRate: Number(record.cgst_rate) > 0 ? record.cgst_rate : '',
      cgstAmount: record.cgst_amount,
      sgstRate: Number(record.sgst_rate) > 0 ? record.sgst_rate : '',
      sgstAmount: record.sgst_amount,
      igstRate: Number(record.igst_rate) > 0 ? record.igst_rate : '',
      igstAmount: record.igst_amount,
      taxAmount: record.tax_amount,
      grandTotal: record.grand_total,
    },
    amountInWords: record.amount_in_words,
  };
}
