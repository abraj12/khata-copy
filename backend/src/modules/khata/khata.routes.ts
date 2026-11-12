import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { khataService } from './khata.service.js';
import {
  InvalidPaginationCursorError,
  readModelsQueryService,
  ReadModelUnavailableError,
} from '../readModels/readModelsQuery.service.js';
import { appDataService } from '../appData/appData.service.js';

const router = Router();

// Protect all Khata endpoints with requireOwnerSession
router.use(requireOwnerSession);

const createTransactionSchema = z.object({
  customer: z.object({
    id: z.number().nullable().optional(),
    name: z.string().trim().min(1, 'Customer name is required'),
    phone: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    state: z.string().trim().max(100).nullable().optional(),
    stateCode: z.string().trim().max(10).nullable().optional(),
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

const customerCreateSchema = z.object({
  name: z.string().trim().min(1, 'Customer name is required').max(255),
  phone: z.string().trim().max(20).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  stateCode: z.string().trim().max(10).nullable().optional(),
});

const customerUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'Customer name cannot be empty').max(255).optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    state: z.string().trim().max(100).nullable().optional(),
    stateCode: z.string().trim().max(10).nullable().optional(),
  })
  .refine(
    (obj) =>
      obj.name !== undefined ||
      obj.phone !== undefined ||
      obj.address !== undefined ||
      obj.state !== undefined ||
      obj.stateCode !== undefined,
    'At least one customer field must be provided for update.'
  );

const recordPaymentSchema = z.object({
  amount: z.union([z.number(), z.string()]),
  note: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
});

const customerSearchQuerySchema = z.object({
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.string().max(512).optional(),
});

function handleStructuredKhataError(err: unknown, res: Response, next: NextFunction) {
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

/**
 * GET /api/v1/khata / GET /api/v1/ledger - Backward-compatible root endpoint
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = customerSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid customer search parameters.',
      });
      return;
    }
    const result = await readModelsQueryService.listCustomersFromMongo(parsed.data);
    res.json({
      success: true,
      customers: result.customers,
      pagination: {
        total: result.total,
        totalIsExact: result.totalIsExact ?? (result.total !== null),
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
        nextCursor: result.nextCursor ?? null,
      },
      syncStatus: result.syncStatus,
    });
  } catch (err) {
    if (err instanceof InvalidPaginationCursorError) {
      res.status(400).json({ success: false, code: err.code, message: err.message });
      return;
    }
    if (err instanceof ReadModelUnavailableError) {
      res.status(503).json({ success: false, code: err.code, message: err.message });
      return;
    }
    next(err);
  }
});

/**
 * GET /api/v1/khata/summary - Dashboard KPIs
 */
router.get('/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await readModelsQueryService.getKhataSummaryFromMongo();
    res.status(200).json({ success: true, summary, data: summary, syncStatus: summary.syncStatus });
  } catch (err) {
    if (err instanceof ReadModelUnavailableError) {
      res.status(503).json({ success: false, code: err.code, message: err.message });
      return;
    }
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

    const startedAt = Date.now();
    const result = await readModelsQueryService.listCustomersFromMongo(parsed.data);
    if (parsed.data.search && parsed.data.search.trim()) {
      const searchCategory = appDataService.classifyCustomerSearchQuery(parsed.data.search);
      void appDataService.recordSearchAnalytics({
        module: 'customers',
        query: searchCategory,
        resultCount: result.customers.length,
        source: 'mongodb',
        durationMs: Date.now() - startedAt,
      });
    }
    res.json({
      success: true,
      customers: result.customers,
      pagination: {
        total: result.total,
        totalIsExact: result.totalIsExact ?? (result.total !== null),
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
        nextCursor: result.nextCursor ?? null,
      },
      syncStatus: result.syncStatus,
    });
  } catch (err) {
    if (err instanceof InvalidPaginationCursorError) {
      res.status(400).json({ success: false, code: err.code, message: err.message });
      return;
    }
    if (err instanceof ReadModelUnavailableError) {
      res.status(503).json({ success: false, code: err.code, message: err.message });
      return;
    }
    next(err);
  }
});

/**
 * POST /api/v1/khata/customers - Create a customer profile with optional validated state
 */
router.post('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = customerCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid customer payload.',
      });
      return;
    }

    const customer = await khataService.createCustomer(parsed.data);
    res.status(201).json({ success: true, customer });
  } catch (err) {
    handleStructuredKhataError(err, res, next);
  }
});

/**
 * GET /api/v1/khata/customers/:customerId - Customer details & balance
 */
router.get('/customers/:customerId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (isNaN(customerId) || customerId <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid customer ID.' });
      return;
    }

    const customer = await khataService.getCustomerDetail(customerId);
    if (!customer) {
      res.status(404).json({ success: false, code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
      return;
    }

    res.json({ success: true, customer });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/khata/customers/:customerId - Update customer details including nullable state/stateCode
 */
router.patch('/customers/:customerId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (isNaN(customerId) || customerId <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid customer ID.' });
      return;
    }

    const parsed = customerUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid customer update payload.',
      });
      return;
    }

    const customer = await khataService.updateCustomer(customerId, parsed.data);
    res.json({ success: true, customer });
  } catch (err) {
    handleStructuredKhataError(err, res, next);
  }
});

/**
 * GET /api/v1/khata/customers/:customerId/history - Complete chronological ledger history
 */
router.get('/customers/:customerId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (isNaN(customerId) || customerId <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid customer ID.' });
      return;
    }

    const history = await khataService.getCustomerHistory(customerId);
    if (!history) {
      res.status(404).json({ success: false, code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
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
        code: 'VALIDATION_ERROR',
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
    handleStructuredKhataError(err, res, next);
  }
});

/**
 * POST /api/v1/khata/customers/:customerId/payments - Record customer payment with FIFO allocation
 */
router.post('/customers/:customerId/payments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (isNaN(customerId) || customerId <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid customer ID.' });
      return;
    }

    const parsed = recordPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
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
    handleStructuredKhataError(err, res, next);
  }
});

export const khataRoutes = router;
