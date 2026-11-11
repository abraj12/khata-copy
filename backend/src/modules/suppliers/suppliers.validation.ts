import { z } from 'zod';
import { isValidCalendarDate } from '../../utils/businessDate.js';
import { validateDecimalQuantityInput, validateMoneyInput } from '../../utils/validation.js';
import { AppError } from '../../utils/errors.js';

export const uuidParamSchema = z.string().uuid('Invalid supplier identifier (UUID expected).');

const optionalTrimmedString = (maxLength: number) =>
  z.string().trim().max(maxLength).nullable().optional();

const nonNegativeMoneyValidator = (fieldName: string) =>
  z.union([z.number(), z.string()]).refine((val) => {
    try {
      validateMoneyInput(val, fieldName, { allowZero: true });
      return true;
    } catch {
      return false;
    }
  }, `${fieldName} must be a non-negative amount with at most 2 decimal places`);

const positiveMoneyValidator = (fieldName: string) =>
  z.union([z.number(), z.string()]).refine((val) => {
    try {
      validateMoneyInput(val, fieldName, { allowZero: false });
      return true;
    } catch {
      return false;
    }
  }, `${fieldName} must be greater than 0 with at most 2 decimal places`);

const quantityValidator = z.union([z.number(), z.string()]).refine((val) => {
  try {
    validateDecimalQuantityInput(val, 'Quantity');
    return true;
  } catch {
    return false;
  }
}, 'Quantity must be greater than 0 and up to 1,000,000 with at most 2 decimal places');

const gstRateValidator = z.union([z.number(), z.string()]).refine((val) => {
  const s = String(val).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(s)) return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}, 'GST rate must be between 0 and 100 with at most 2 decimal places');

const calendarDateSchema = z
  .string()
  .refine(isValidCalendarDate, 'Date must be a valid calendar date in YYYY-MM-DD format');

const nullableOptionalDateSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  calendarDateSchema.nullable().optional()
);

const optionalQueryDateSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  calendarDateSchema.optional()
);

const optionalQueryUuidSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().uuid().optional()
);

/**
 * Normalizes supplier names for canonical comparison and duplicate detection.
 */
export function normalizeSupplierName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Normalizes supplier invoice numbers per supplier for duplicate detection.
 */
export function normalizeSupplierInvoiceNumber(invoiceNumber: string): string {
  return invoiceNumber.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Normalizes and validates an Indian mobile phone number (+91XXXXXXXXXX), or returns null when omitted.
 */
export function normalizeSupplierPhone(phone?: string | null): string | null {
  if (phone === null || phone === undefined) return null;
  if (typeof phone !== 'string') {
    throw new AppError('Supplier mobile number must be a string.', 400, 'INVALID_PHONE_FORMAT');
  }
  const trimmed = phone.trim();
  if (!trimmed) return null;

  let cleaned = trimmed.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+91')) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith('91') && cleaned.length === 12) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.slice(1);
  }

  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return `+91${cleaned}`;
  }

  throw new AppError(
    'Invalid mobile number format. Must be a valid 10-digit Indian mobile number.',
    400,
    'INVALID_PHONE_FORMAT'
  );
}

/**
 * Normalizes optional email string; null when omitted/blank.
 */
export function normalizeOptionalEmail(email?: string | null): string | null {
  if (email === null || email === undefined) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

export const createSupplierSchema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(255),
  contactPerson: optionalTrimmedString(255),
  phone: optionalTrimmedString(20),
  email: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() || null : v),
    z.string().email('Please enter a valid email address').max(255).nullable().optional()
  ),
  address: optionalTrimmedString(2000),
  state: optionalTrimmedString(100),
  stateCode: optionalTrimmedString(10),
  gstin: optionalTrimmedString(20),
  notes: optionalTrimmedString(2000),
});

export const updateSupplierSchema = createSupplierSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, 'At least one supplier field must be provided.');

export const listSuppliersQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'archived', 'all']).optional().default('active'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const purchaseBillItemSchema = z.object({
  productId: z.coerce.number().int().positive().nullable().optional(),
  description: z.string().trim().min(1, 'Item description is required').max(255),
  quantity: quantityValidator,
  purchaseRate: nonNegativeMoneyValidator('Purchase rate'),
  updateProductBuyingPrice: z.boolean().optional().default(false),
});

export const createPurchaseBillSchema = z
  .object({
    supplierId: z.string().uuid('Valid supplier ID is required'),
    invoiceNumber: z.string().trim().min(1, 'Supplier invoice number is required').max(100),
    invoiceDate: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      calendarDateSchema.optional()
    ),
    dueDate: nullableOptionalDateSchema,
    items: z.array(purchaseBillItemSchema).min(1, 'At least one purchase item is required').max(200),
    discountAmount: nonNegativeMoneyValidator('Discount amount').optional().default(0),
    gstRate: gstRateValidator.optional().default(0),
    notes: optionalTrimmedString(2000),
  })
  .superRefine((data, ctx) => {
    if (data.dueDate && data.invoiceDate && data.dueDate < data.invoiceDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueDate'],
        message: 'Due date cannot be earlier than invoice date.',
      });
    }
  });

export const updatePurchaseBillSchema = z
  .object({
    invoiceNumber: z.string().trim().min(1, 'Supplier invoice number is required').max(100),
    invoiceDate: calendarDateSchema,
    dueDate: nullableOptionalDateSchema,
    items: z.array(purchaseBillItemSchema).min(1, 'At least one purchase item is required').max(200),
    discountAmount: nonNegativeMoneyValidator('Discount amount').optional().default(0),
    gstRate: gstRateValidator.optional().default(0),
    notes: optionalTrimmedString(2000),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.dueDate && data.dueDate < data.invoiceDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueDate'],
        message: 'Due date cannot be earlier than invoice date.',
      });
    }
  });

export const cancelPurchaseBillSchema = z.object({
  reason: z.string().trim().min(1, 'Cancellation reason is required').max(500),
});

export const listPurchaseBillsQuerySchema = z.object({
  supplierId: optionalQueryUuidSchema,
  status: z.enum(['finalized', 'cancelled', 'all']).optional().default('all'),
  search: z.string().trim().max(120).optional(),
  fromDate: optionalQueryDateSchema,
  toDate: optionalQueryDateSchema,
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const paymentAllocationInputSchema = z.object({
  purchaseBillId: z.coerce.number().int().positive('Purchase bill ID is required'),
  amount: positiveMoneyValidator('Allocation amount'),
});

export const createSupplierPaymentSchema = z.object({
  supplierId: z.string().uuid('Valid supplier ID is required'),
  paymentDate: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    calendarDateSchema.optional()
  ),
  amount: positiveMoneyValidator('Payment amount'),
  paymentMethod: z.enum(['cash', 'upi', 'bank_transfer', 'cheque', 'other']),
  transactionReference: optionalTrimmedString(120),
  notes: optionalTrimmedString(2000),
  allocations: z.array(paymentAllocationInputSchema).optional().default([]),
});

export const allocateAdvanceSchema = z.object({
  allocations: z.array(paymentAllocationInputSchema).min(1, 'At least one bill allocation is required'),
});

export const reversePaymentSchema = z.object({
  reason: z.string().trim().min(1, 'Reversal reason is required').max(500),
});

export const reversePaymentAllocationSchema = z.object({
  amount: positiveMoneyValidator('Reversal amount'),
  reason: z.string().trim().min(1, 'Allocation reversal reason is required').max(500),
});

const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{8,128}$/;

export function normalizeTransactionReference(reference?: string | null): string | null {
  if (reference === null || reference === undefined) return null;
  const trimmed = reference.normalize('NFKC').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractAndValidateIdempotencyKey(
  rawHeader: unknown,
  required = true
): string | null {
  if (Array.isArray(rawHeader)) {
    throw new AppError('Duplicate Idempotency-Key headers are not allowed.', 400, 'INVALID_IDEMPOTENCY_KEY');
  }
  if (rawHeader === undefined || rawHeader === null || String(rawHeader).trim() === '') {
    if (required) {
      throw new AppError(
        'Idempotency-Key header is required for supplier payment operations.',
        400,
        'IDEMPOTENCY_KEY_REQUIRED'
      );
    }
    return null;
  }
  const key = String(rawHeader).trim();
  if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
    throw new AppError(
      'Idempotency-Key header must be 8-128 characters using letters, numbers, ., _, :, or -.',
      400,
      'INVALID_IDEMPOTENCY_KEY'
    );
  }
  return key;
}

export const listSupplierPaymentsQuerySchema = z.object({
  supplierId: optionalQueryUuidSchema,
  paymentMethod: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.enum(['cash', 'upi', 'bank_transfer', 'cheque', 'other']).optional()
  ),
  status: z.enum(['active', 'reversed', 'all']).optional().default('all'),
  fromDate: optionalQueryDateSchema,
  toDate: optionalQueryDateSchema,
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const supplierStatementQuerySchema = z
  .object({
    fromDate: optionalQueryDateSchema,
    toDate: optionalQueryDateSchema,
    includeArchived: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v !== 'false'),
  })
  .superRefine((data, ctx) => {
    if (data.fromDate && data.toDate && data.toDate < data.fromDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toDate'],
        message: 'End date cannot be earlier than start date.',
      });
    }
  });
