import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { normalBillsService } from './normalBills.service.js';

const router = Router();

// Protect all Normal Bill endpoints with owner session
router.use(requireOwnerSession);

const normalBillItemSchema = z.object({
  productId: z.number().int().positive().nullable().optional(),
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

const createNormalBillSchema = z.object({
  billNumber: z.string().trim().max(50).optional(),
  billDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bill date must be YYYY-MM-DD').optional(),
  state: z.string().trim().max(100).optional(),
  stateCode: z.string().trim().max(10).optional(),
  transportationMode: z.string().trim().max(100).nullable().optional(),
  vehicleNumber: z.string().trim().max(50).nullable().optional(),
  dateOfSupply: z.string().trim().max(20).nullable().optional(),
  placeOfSupply: z.string().trim().max(150).nullable().optional(),
  customerId: z.number().int().positive().nullable().optional(),
  customerName: z.string().trim().min(1, 'Customer name is required').max(255),
  customerAddress: z.string().trim().max(500).nullable().optional(),
  customerPhone: z.string().trim().max(20).nullable().optional(),
  customerState: z.string().trim().max(100).optional(),
  customerStateCode: z.string().trim().max(10).optional(),
  items: z.array(normalBillItemSchema).min(1, 'At least one item is required in the bill'),
  notes: z.string().trim().max(1000).nullable().optional(),
});

const listBillsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  dateFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/v1/normal-bills/next-number - Suggest next sequential bill number
 */
router.get('/next-number', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nextBillNumber = await normalBillsService.getNextBillNumber();
    res.json({
      success: true,
      nextBillNumber,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/normal-bills - Create a new normal bill (Non-GST)
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createNormalBillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid bill input.',
        errors: parsed.error.errors,
      });
      return;
    }

    const bill = await normalBillsService.createBill(parsed.data);

    res.status(201).json({
      success: true,
      message: `Normal bill ${bill.bill_number} created successfully.`,
      bill,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/normal-bills/preview-pdf - Generates and streams PDF on-the-fly without saving to database
 */
router.post('/preview-pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createNormalBillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid bill input.',
        errors: parsed.error.errors,
      });
      return;
    }

    const { buffer, filename } = await normalBillsService.generateDraftPdf(parsed.data);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/normal-bills - List normal bills with search and pagination
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listBillsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid query parameters.',
        errors: parsed.error.errors,
      });
      return;
    }

    const result = await normalBillsService.listBills(parsed.data);

    res.json({
      success: true,
      bills: result.bills,
      pagination: {
        total: result.totalCount,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        hasMore: parsed.data.offset + result.bills.length < result.totalCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/normal-bills/:id - Get bill details by ID
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid bill ID' });
      return;
    }

    const bill = await normalBillsService.getBillById(id);
    res.json({
      success: true,
      bill,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/normal-bills/:id/pdf - Stream PDF bill download
 */
router.get('/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid bill ID' });
      return;
    }

    const isDownload = req.query.download === 'true';
    const { buffer, filename } = await normalBillsService.getBillPdf(id);

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
