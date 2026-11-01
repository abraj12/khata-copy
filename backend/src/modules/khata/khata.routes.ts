import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { khataService } from './khata.service.js';

const router = Router();

// Protect all Khata endpoints with requireOwnerSession
router.use(requireOwnerSession);

const createTransactionSchema = z.object({
  customer: z.object({
    id: z.number().nullable().optional(),
    name: z.string().trim().min(1, 'Customer name is required'),
    phone: z.string().nullable().optional(),
  }),
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        quantity: z.union([z.number(), z.string()]),
        sellingPrice: z.union([z.number(), z.string()]),
      })
    )
    .min(1, 'At least one item is required'),
  initialPayment: z.union([z.number(), z.string()]).nullable().optional(),
  note: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
});

const recordPaymentSchema = z.object({
  amount: z.union([z.number(), z.string()]),
  note: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
});

const customerSearchQuerySchema = z.object({
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/v1/khata / GET /api/v1/ledger - Backward-compatible root endpoint
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = customerSearchQuerySchema.safeParse(req.query);
    const options = parsed.success ? parsed.data : { limit: 50, offset: 0 };
    const { customers, pagination } = await khataService.listCustomers(options);
    res.json({ success: true, customers, pagination });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/khata/summary - Dashboard KPIs
 */
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await khataService.getSummary();
    res.json({ success: true, summary });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/khata/customers - Searchable customer list with lifetime Udhar, received, and balance
 */
router.get('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = customerSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid search query parameters.',
      });
      return;
    }

    const { customers, pagination } = await khataService.listCustomers(parsed.data);
    res.json({ success: true, customers, pagination });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/khata/customers/:customerId - Customer details & balance
 */
router.get('/customers/:customerId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (isNaN(customerId) || customerId <= 0) {
      res.status(400).json({ success: false, message: 'Invalid customer ID.' });
      return;
    }

    const customer = await khataService.getCustomerDetail(customerId);
    if (!customer) {
      res.status(404).json({ success: false, message: 'Customer not found.' });
      return;
    }

    res.json({ success: true, customer });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/khata/customers/:customerId/history - Complete chronological ledger history
 */
router.get('/customers/:customerId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (isNaN(customerId) || customerId <= 0) {
      res.status(400).json({ success: false, message: 'Invalid customer ID.' });
      return;
    }

    const history = await khataService.getCustomerHistory(customerId);
    if (!history) {
      res.status(404).json({ success: false, message: 'Customer not found.' });
      return;
    }

    res.json({ success: true, data: history, ...history });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/khata/transactions - Create new Udhar transaction with item lines & optional payment
 */
router.post('/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createTransactionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.error.errors[0]?.message || 'Invalid transaction payload.',
      });
      return;
    }

    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || parsed.data.idempotencyKey || null;

    const result = await khataService.createTransaction({
      ...parsed.data,
      idempotencyKey,
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    const errorObj = err as { status?: number; code?: string; candidates?: unknown[]; message?: string };
    if (errorObj.status) {
      res.status(errorObj.status).json({
        success: false,
        code: errorObj.code,
        message: errorObj.message,
        candidates: errorObj.candidates,
      });
      return;
    }
    next(err);
  }
});

/**
 * POST /api/v1/khata/customers/:customerId/payments - Record customer payment with FIFO allocation
 */
router.post('/customers/:customerId/payments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (isNaN(customerId) || customerId <= 0) {
      res.status(400).json({ success: false, message: 'Invalid customer ID.' });
      return;
    }

    const parsed = recordPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.error.errors[0]?.message || 'Invalid payment payload.',
      });
      return;
    }

    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || parsed.data.idempotencyKey || null;

    const result = await khataService.recordPayment(
      customerId,
      parsed.data.amount,
      parsed.data.note,
      idempotencyKey
    );
    res.status(201).json(result);
  } catch (err: unknown) {
    const errorObj = err as { status?: number; code?: string; message?: string };
    if (errorObj.status) {
      res.status(errorObj.status).json({
        success: false,
        code: errorObj.code,
        message: errorObj.message,
      });
      return;
    }
    next(err);
  }
});

export const khataRoutes = router;
