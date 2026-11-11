import { z } from 'zod';
import { isValidCalendarDate } from '../../utils/businessDate.js';
import { validateMoneyInput } from '../../utils/validation.js';
import { AppError } from '../../utils/errors.js';

export const EXPENSE_CATEGORIES = [
  'rent',
  'electricity',
  'salaries',
  'transport',
  'packaging',
  'maintenance',
  'marketing',
  'misc',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_PAYMENT_METHODS = [
  'cash',
  'upi',
  'bank_transfer',
  'cheque',
  'other',
] as const;

export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

export const expenseIdParamSchema = z
  .string()
  .uuid('Invalid expense identifier (UUID expected).');

const calendarDateSchema = z
  .string()
  .trim()
  .refine(isValidCalendarDate, 'Date must be a valid calendar date in YYYY-MM-DD format.');

const optionalQueryDateSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  calendarDateSchema.optional()
);

const optionalTrimmedNullableString = (maxLength: number) =>
  z.preprocess(
    (v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      if (typeof v === 'string') {
        const trimmed = v.trim();
        return trimmed === '' ? null : trimmed;
      }
      return v;
    },
    z.string().max(maxLength).nullable().optional()
  );

const positiveMoneyValidator = z.union([z.number(), z.string()]).refine((val) => {
  try {
    validateMoneyInput(val, 'Amount', { allowZero: false });
    return true;
  } catch {
    return false;
  }
}, 'Amount must be greater than 0 with at most 2 decimal places.');

export function validateDateRangeOrder(fromDate?: string, toDate?: string): void {
  if (fromDate && !isValidCalendarDate(fromDate)) {
    throw new AppError('Start date must be a valid calendar date in YYYY-MM-DD format.', 400, 'VALIDATION_ERROR');
  }
  if (toDate && !isValidCalendarDate(toDate)) {
    throw new AppError('End date must be a valid calendar date in YYYY-MM-DD format.', 400, 'VALIDATION_ERROR');
  }
  if (fromDate && toDate && toDate < fromDate) {
    throw new AppError('End date cannot be earlier than start date.', 400, 'INVALID_DATE_RANGE');
  }
}

export const dashboardOverviewQuerySchema = z
  .object({
    fromDate: optionalQueryDateSchema,
    toDate: optionalQueryDateSchema,
  })
  .refine(
    (data) => !data.fromDate || !data.toDate || data.toDate >= data.fromDate,
    { message: 'End date cannot be earlier than start date.', path: ['toDate'] }
  );

export const listExpensesQuerySchema = z
  .object({
    search: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim() : undefined),
      z.string().max(120).optional()
    ),
    category: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.enum([...EXPENSE_CATEGORIES, 'all']).optional().default('all')
    ),
    status: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.enum(['active', 'voided', 'all']).optional().default('active')
    ),
    fromDate: optionalQueryDateSchema,
    toDate: optionalQueryDateSchema,
    limit: z.preprocess(
      (v) => (v === undefined || v === '' ? 25 : Number(v)),
      z.number().int().min(1).max(200)
    ),
    offset: z.preprocess(
      (v) => (v === undefined || v === '' ? 0 : Number(v)),
      z.number().int().min(0)
    ),
  })
  .refine(
    (data) => !data.fromDate || !data.toDate || data.toDate >= data.fromDate,
    { message: 'End date cannot be earlier than start date.', path: ['toDate'] }
  );

export const createExpenseSchema = z.object({
  expenseDate: calendarDateSchema,
  category: z.enum(EXPENSE_CATEGORIES, {
    errorMap: () => ({ message: 'Invalid expense category.' }),
  }),
  title: z
    .string()
    .trim()
    .min(1, 'Expense title is required.')
    .max(200, 'Expense title must not exceed 200 characters.'),
  vendorName: optionalTrimmedNullableString(160),
  amount: positiveMoneyValidator,
  paymentMethod: z.enum(EXPENSE_PAYMENT_METHODS, {
    errorMap: () => ({ message: 'Invalid payment method.' }),
  }),
  referenceNumber: optionalTrimmedNullableString(120),
  notes: optionalTrimmedNullableString(2000),
});

export const updateExpenseSchema = createExpenseSchema.extend({
  reason: optionalTrimmedNullableString(500),
});

export const voidExpenseSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Void reason is required.')
    .max(500, 'Void reason must not exceed 500 characters.'),
});

export const expenseHistoryQuerySchema = z.object({
  limit: z.preprocess(
    (v) => (v === undefined || v === '' ? 50 : Number(v)),
    z.number().int().min(1).max(100)
  ),
});

export type DashboardOverviewQuery = z.infer<typeof dashboardOverviewQuerySchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type VoidExpenseInput = z.infer<typeof voidExpenseSchema>;
export type ExpenseHistoryQuery = z.infer<typeof expenseHistoryQuerySchema>;
