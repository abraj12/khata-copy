import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { gstInvoicesService } from './gstInvoices.service.js';

const router = Router();

// Protect all GST invoice endpoints with owner session
router.use(requireOwnerSession);

function isValidCalendarDate(val?: string | null): boolean {
  if (!val) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const [yStr, mStr, dStr] = val.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const optionalIntegerIdSchema = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((val) => {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return isNaN(n) ? null : n;
  })
  .refine((val) => val === null || (Number.isInteger(val) && val > 0), {
    message: 'Must be a positive integer ID',
  });

const gstInvoiceItemSchema = z.object({
  productId: optionalIntegerIdSchema,
  description: z.string().trim().min(1, 'Item description is required').max(255),
  hsnCode: z.string().trim().max(20).nullable().optional(),
  quantity: z.union([z.number(), z.string()]).refine((val) => {
    const n = Number(val);
    return Number.isFinite(n) && n > 0;
  }, 'Quantity must be a positive number'),
  unit: z.string().trim().max(20).nullable().optional(),
  rate: z.union([z.number(), z.string()]).refine((val) => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0;
  }, 'Rate cannot be negative'),
  rateUnit: z.string().trim().max(20).nullable().optional(),
});

const createGstInvoiceSchema = z.object({
  invoiceNumber: z.string().trim().max(50).optional(),
  invoiceDate: z.string().trim().refine(isValidCalendarDate, 'Invoice date must be a valid calendar date in YYYY-MM-DD format').optional(),
  state: z.string().trim().max(100).optional(),
  stateCode: z.string().trim().max(10).optional(),
  transportationMode: z.string().trim().max(100).nullable().optional(),
  vehicleNumber: z.string().trim().max(50).nullable().optional(),
  dateOfSupply: z.string().trim().max(20).refine(isValidCalendarDate, 'Date of supply must be a valid calendar date in YYYY-MM-DD format').nullable().optional(),
  placeOfSupply: z.string().trim().max(150).nullable().optional(),
  customerId: optionalIntegerIdSchema,
  customerName: z.string().trim().min(1, 'Customer name is required').max(255),
  customerAddress: z.string().trim().max(500).nullable().optional(),
  customerGstin: z.string().trim().max(20).nullable().optional(),
  customerState: z.string().trim().max(100).optional(),
  customerStateCode: z.string().trim().max(10).optional(),
  gstRate: z.union([z.number(), z.string()]).refine((val) => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 && n <= 100;
  }, 'GST rate must be between 0 and 100'),
  subtotalAmount: z.union([z.number(), z.string()]).optional(),
  discountType: z.enum(['percentage', 'fixed']).nullable().optional(),
  discountValue: z.union([z.number(), z.string()]).optional(),
  discountAmount: z.union([z.number(), z.string()]).optional(),
  items: z.array(gstInvoiceItemSchema).min(1, 'At least one item is required in the invoice').max(20, 'A single invoice can have at most 20 line items to ensure standard A4 print layout integrity'),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const listInvoicesQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  dateFrom: z.string().trim().refine(isValidCalendarDate, 'dateFrom must be a valid calendar date in YYYY-MM-DD format').optional(),
  dateTo: z.string().trim().refine(isValidCalendarDate, 'dateTo must be a valid calendar date in YYYY-MM-DD format').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/v1/gst-invoices/next-number - Suggest next sequential invoice number
 */
router.get('/next-number', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const nextInvoiceNumber = await gstInvoicesService.getNextInvoiceNumber();
    res.json({ success: true, nextInvoiceNumber });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/gst-invoices - Create, validate, calculate, generate PDF, and store invoice
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createGstInvoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid GST invoice input.',
        errors: parsed.error.errors,
      });
      return;
    }

    const created = await gstInvoicesService.createInvoice(parsed.data);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/gst-invoices/preview-pdf - Generates and streams PDF on-the-fly without saving to database
 */
router.post('/preview-pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createGstInvoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid GST invoice input.',
      });
      return;
    }

    const { buffer, filename } = await gstInvoicesService.generateDraftPdf(parsed.data);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/gst-invoices - List invoices with pagination, filtering & search
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listInvoicesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid search query.',
      });
      return;
    }

    const result = await gstInvoicesService.listInvoices(parsed.data);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/gst-invoices/:id - Get single invoice with full items snapshot
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid invoice ID.' });
      return;
    }

    const invoice = await gstInvoicesService.getInvoiceById(id);
    if (!invoice) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Invoice not found.' });
      return;
    }

    res.json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/gst-invoices/:id/pdf - Secure PDF stream or download
 */
router.get('/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid invoice ID.' });
      return;
    }

    const isDownload = req.query.download === 'true';
    const { buffer, filename } = await gstInvoicesService.getInvoicePdf(id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${isDownload ? 'attachment' : 'inline'}; filename="${filename}"`
    );
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

export default router;
