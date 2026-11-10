export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'converted';

export interface QuotationCompanySnapshot {
  companyName: string;
  logoUrl?: string | null;
  cin?: string | null;
  gstin?: string | null;
  address: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  state?: string;
  stateCode?: string;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  bankBranch?: string | null;
  signatoryTitle?: string;
}

export interface QuotationItem {
  id?: number;
  productId?: number | null;
  itemIndex?: number;
  description: string;
  hsnCode?: string | null;
  barcode?: string | null;
  quantity: number | string;
  unit?: string | null;
  rate: number | string;
  rateUnit?: string | null;
  amount?: number | string;
}

export interface Quotation {
  id: number;
  quotation_number: string;
  quotation_date: string;
  valid_until: string | null;
  customer_id: number | null;
  customer_name: string;
  customer_address: string | null;
  customer_phone: string | null;
  customer_gstin: string | null;
  project_title: string | null;
  subject: string | null;
  company_snapshot: QuotationCompanySnapshot;
  subtotal: string;
  discount_type: 'percentage' | 'fixed' | null;
  discount_value: string;
  discount_amount: string;
  taxable_amount: string;
  gst_enabled: boolean;
  gst_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  tax_amount: string;
  grand_total: string;
  amount_in_words: string;
  terms_and_conditions: string | null;
  notes: string | null;
  status: QuotationStatus;
  converted_normal_bill_id: number | null;
  converted_gst_invoice_id: number | null;
  created_at: string;
  updated_at: string;
  items?: QuotationItem[];
}

export interface QuotationSettings {
  id: number;
  company_name: string;
  logo_url: string | null;
  cin: string | null;
  gstin: string | null;
  address: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  state: string;
  state_code: string;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_branch: string | null;
  standard_validity_days: number;
  standard_payment_terms: string | null;
  standard_delivery_terms: string | null;
  standard_warranty_terms: string | null;
  standard_declaration: string | null;
  signatory_title: string;
  updated_at: string;
}

export interface CreateQuotationPayload {
  quotationNumber?: string;
  quotationDate?: string;
  validUntil?: string | null;
  customerId?: number | null;
  customerName: string;
  customerAddress?: string | null;
  customerPhone?: string | null;
  customerGstin?: string | null;
  customerState?: string;
  customerStateCode?: string;
  projectTitle?: string | null;
  subject?: string | null;
  items: QuotationItem[];
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | string;
  gstEnabled?: boolean;
  gstRate?: number | string;
  termsAndConditions?: string | null;
  notes?: string | null;
  initialStatus?: 'draft' | 'sent';
}

export interface QuotationSummaryCounts {
  total: number;
  draft: number;
  sent: number;
  accepted: number;
  converted: number;
  rejectedOrExpired: number;
}
