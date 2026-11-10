import { z } from 'zod';

export const quotationItemInputSchema = z.object({
  productId: z.coerce.number().int().positive().nullable().optional(),
  description: z.string().trim().min(1, 'Item description is required').max(255),
  hsnCode: z.string().trim().max(20, 'HSN code cannot exceed 20 characters').nullable().optional(),
  barcode: z.string().trim().max(64, 'Barcode cannot exceed 64 characters').nullable().optional(),
  quantity: z.union([z.number(), z.string()]).refine((val) => {
    const num = Number(val);
    return !isNaN(num) && num > 0;
  }, 'Quantity must be greater than 0'),
  unit: z.string().trim().max(20).nullable().optional(),
  rate: z.union([z.number(), z.string()]).refine((val) => {
    const num = Number(val);
    return !isNaN(num) && num >= 0;
  }, 'Rate must be a non-negative number'),
  rateUnit: z.string().trim().max(20).nullable().optional(),
});

export const createQuotationSchema = z.object({
  quotationNumber: z.string().trim().max(50).optional(),
  quotationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Valid until must be in YYYY-MM-DD format').nullable().optional(),
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
  discountValue: z.union([z.number(), z.string()]).optional().default(0),
  gstEnabled: z.boolean().optional().default(false),
  gstRate: z.union([z.number(), z.string()]).optional().default(18),
  termsAndConditions: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
});

export const updateQuotationStatusSchema = z.object({
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']),
});

export const convertToBillSchema = z.object({
  billType: z.enum(['normal', 'gst']),
  force: z.boolean().optional().default(false),
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
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted']).optional(),
  search: z.string().trim().max(100).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
