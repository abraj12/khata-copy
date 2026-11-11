import Decimal from 'decimal.js';
import { apiClient } from '../../lib/apiClient.js';
import { fetchAuthorizedBlob, fetchPostPdfBlob } from '../../lib/pdfFetch.js';
import { downloadBlobSafely } from '../../utils/blobDownload.js';
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
  subtotalAmount?: number | string | null;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | string | null;
  discountAmount?: number | string | null;
  gstRate: number | string;
  items: GstInvoiceItemPayload[];
  notes?: string | null;
  idempotencyKey?: string | null;
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
  subtotal_amount?: string;
  discount_type?: 'percentage' | 'fixed' | null;
  discount_value?: string;
  discount_amount?: string;
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

export async function retryGstInvoicePdf(id: number): Promise<GstInvoiceRecord> {
  const { data } = await apiClient<{ success: boolean; data: GstInvoiceRecord }>(
    `/api/v1/gst-invoices/${id}/retry-pdf`,
    { method: 'POST' }
  );
  return data.data;
}

export async function fetchInvoicePdfBlob(id: number, signal?: AbortSignal): Promise<Blob> {
  return fetchAuthorizedBlob(
    `/api/v1/gst-invoices/${id}/pdf?download=true`,
    'Failed to fetch invoice PDF',
    signal
  );
}

export async function fetchDraftPdfBlob(
  payload: CreateGstInvoicePayload,
  signal?: AbortSignal
): Promise<Blob> {
  return fetchPostPdfBlob(
    '/api/v1/gst-invoices/preview-pdf',
    payload,
    'Failed to generate draft invoice PDF',
    signal
  );
}

export async function downloadInvoicePdf(id: number, invoiceNumber: string): Promise<void> {
  const blob = await fetchInvoicePdfBlob(id);
  downloadBlobSafely(blob, `Invoice_${invoiceNumber}.pdf`);
}

export async function downloadDraftPdf(payload: CreateGstInvoicePayload): Promise<void> {
  const blob = await fetchDraftPdfBlob(payload);
  downloadBlobSafely(blob, `Invoice_${payload.invoiceNumber || 'Draft'}.pdf`);
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

export function mapRecordToInvoiceProps(
  record: GstInvoiceRecord,
  company?: {
    name?: string;
    address?: string | null;
    gstin?: string | null;
    phone?: string | null;
    jurisdiction?: string | null;
  }
): MannatInvoiceProps {
  const discountDec = toDecSafe(record.discount_amount);
  const taxableDec = toDecSafe(record.taxable_amount);
  const derivedSubtotal = record.subtotal_amount
    ? toDecSafe(record.subtotal_amount).toFixed(2)
    : taxableDec.plus(discountDec).toFixed(2);

  return {
    id: record.id,
    invoiceNumber: record.invoice_number,
    invoiceDate: record.invoice_date,
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
      subtotal: derivedSubtotal,
      discountType: record.discount_type ?? null,
      discountValue: record.discount_value ?? '0.00',
      discountAmount: record.discount_amount ?? '0.00',
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
