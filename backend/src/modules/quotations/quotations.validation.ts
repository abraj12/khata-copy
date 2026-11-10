import { z } from 'zod';

import { isValidCalendarDate } from '../../utils/businessDate.js';
export { isValidCalendarDate };

export const quantityValidator = z.union([z.number(), z.string()]).refine((val) => {
  const s = String(val).trim();
  if (!s || isNaN(Number(s))) return false;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return false;
  const parts = s.split('.');
  if (parts.length > 1 && parts[1].length > 3) return false;
  return true;
}, 'Quantity must be a positive number with at most 3 decimal places');

export const rateValidator = z.union([z.number(), z.string()]).refine((val) => {
  const s = String(val).trim();
  if (!s || isNaN(Number(s))) return false;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return false;
  const parts = s.split('.');
  if (parts.length > 1 && parts[1].length > 2) return false;
  return true;
}, 'Rate must be a non-negative number with at most 2 decimal places');

export const discountValueValidator = z.union([z.number(), z.string()]).refine((val) => {
  const s = String(val).trim();
  if (!s || isNaN(Number(s))) return false;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return false;
  const parts = s.split('.');
  if (parts.length > 1 && parts[1].length > 2) return false;
  return true;
}, 'Discount value must be a non-negative number with at most 2 decimal places');

export const gstRateValidator = z.union([z.number(), z.string()]).refine((val) => {
  const s = String(val).trim();
  if (!s || isNaN(Number(s))) return false;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) return false;
  const parts = s.split('.');
  if (parts.length > 1 && parts[1].length > 2) return false;
  return true;
}, 'GST rate must be between 0 and 100 with at most 2 decimal places');

export const quotationItemInputSchema = z.object({
  productId: z.coerce.number().int().positive().nullable().optional(),
  description: z.string().trim().min(1, 'Item description is required').max(255),
  hsnCode: z.string().trim().max(20, 'HSN code cannot exceed 20 characters').nullable().optional(),
  barcode: z.string().trim().max(64, 'Barcode cannot exceed 64 characters').nullable().optional(),
  quantity: quantityValidator,
  unit: z.string().trim().max(20).nullable().optional(),
  rate: rateValidator,
  rateUnit: z.string().trim().max(20).nullable().optional(),
});

export const createQuotationSchema = z.object({
  quotationNumber: z.string().trim().max(50).optional(),
  quotationDate: z.string().refine(isValidCalendarDate, 'Quotation date must be a valid calendar date in YYYY-MM-DD format').optional(),
  validUntil: z.string().refine(isValidCalendarDate, 'Valid until must be a valid calendar date in YYYY-MM-DD format').nullable().optional(),
  initialStatus: z.enum(['draft', 'sent']).optional().default('draft'),
  customerId: z.coerce.number().int().positive().nullable().optional(),
  customerName: z.string().trim().min(1, 'Customer name is required').max(255),
  customerAddress: z.string().trim().nullable().optional(),
  customerPhone: z.string().trim().max(20).nullable().optional(),
  customerGstin: z.string().trim().max(20).nullable().optional(),
  customerState: z.string().trim().max(100).optional(),
  customerStateCode: z.string().trim().max(10).optional(),
  projectTitle: z.string().trim().max(255).nullable().optional(),
  subject: z.string().trim().nullable().optional(),
  items: z.array(quotationItemInputSchema).min(1, 'At least one line item is required'),
  discountType: z.enum(['percentage', 'fixed']).nullable().optional(),
  discountValue: discountValueValidator.optional().default(0),
  gstEnabled: z.boolean().optional().default(false),
  gstRate: gstRateValidator.optional().default(18),
  termsAndConditions: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
});

export const updateQuotationStatusSchema = z.object({
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']),
});

export const convertToBillSchema = z.object({
  billType: z.enum(['normal', 'gst']),
  force: z.boolean().optional().default(false),
  gstRateOverride: gstRateValidator.optional(),
  customerState: z.string().trim().max(100).optional(),
  customerStateCode: z.string().trim().max(10).optional(),
});

export const quotationSettingsSchema = z.object({
  companyName: z.string().trim().min(1, 'Company name is required').max(255),
  logoUrl: z.string().trim().nullable().optional(),
  cin: z.string().trim().max(50).nullable().optional(),
  gstin: z.string().trim().max(20).nullable().optional(),
  address: z.string().trim().min(1, 'Address is required'),
  email: z.string().trim().email().nullable().optional().or(z.literal('')),
  phone: z.string().trim().max(20).nullable().optional(),
  website: z.string().trim().max(255).nullable().optional(),
  state: z.string().trim().max(100).default('Bihar'),
  stateCode: z.string().trim().max(10).default('10'),
  bankName: z.string().trim().max(255).nullable().optional(),
  bankAccountNumber: z.string().trim().max(100).nullable().optional(),
  bankIfsc: z.string().trim().max(50).nullable().optional(),
  bankBranch: z.string().trim().max(255).nullable().optional(),
  standardValidityDays: z.coerce.number().int().min(1).max(365).default(30),
  standardPaymentTerms: z.string().trim().nullable().optional(),
  standardDeliveryTerms: z.string().trim().nullable().optional(),
  standardWarrantyTerms: z.string().trim().nullable().optional(),
  standardDeclaration: z.string().trim().nullable().optional(),
  signatoryTitle: z.string().trim().max(100).default('Authorized Signatory'),
});

export const quotationQuerySchema = z.object({
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted', 'rejected_or_expired']).optional(),
  search: z.string().trim().max(100).optional(),
  startDate: z.string().refine(isValidCalendarDate, 'Start date must be a valid calendar date in YYYY-MM-DD format').optional(),
  endDate: z.string().refine(isValidCalendarDate, 'End date must be a valid calendar date in YYYY-MM-DD format').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
