import { NextFunction, Request, Response, Router } from 'express';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { dashboardService } from './dashboard.service.js';
import {
  createExpenseSchema,
  dashboardOverviewQuerySchema,
  expenseHistoryQuerySchema,
  expenseIdParamSchema,
  listExpensesQuerySchema,
  updateExpenseSchema,
  voidExpenseSchema,
} from './dashboard.validation.js';

const router = Router();

router.use(requireOwnerSession);
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

function sendValidationError(res: Response, message: string): void {
  res.status(400).json({
    success: false,
    code: 'VALIDATION_ERROR',
    message,
  });
}

/**
 * GET /api/v1/dashboard/overview
 * Returns consistent cross-module KPIs, profitability analytics, trends & recent activity.
 */
router.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = dashboardOverviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid dashboard date filter.');
      return;
    }

    const data = await dashboardService.getOverview(parsed.data);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/dashboard/expenses
 * Lists business operating expenses with search, category, status, date & pagination filters.
 */
router.get('/expenses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listExpensesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid expense filter query.');
      return;
    }

    const data = await dashboardService.listExpenses(parsed.data);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/dashboard/expenses/:id/history
 * Returns read-only immutable audit history events for an operating expense.
 */
router.get('/expenses/:id/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idCheck = expenseIdParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      sendValidationError(res, idCheck.error.errors[0]?.message || 'Invalid expense ID.');
      return;
    }

    const queryCheck = expenseHistoryQuerySchema.safeParse(req.query);
    if (!queryCheck.success) {
      sendValidationError(res, queryCheck.error.errors[0]?.message || 'Invalid history query.');
      return;
    }

    const history = await dashboardService.getExpenseHistory(idCheck.data, queryCheck.data);
    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/dashboard/expenses
 * Records a new operating expense and appends an audit event.
 */
router.post('/expenses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createExpenseSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid expense payload.');
      return;
    }

    const created = await dashboardService.createExpense(parsed.data);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/dashboard/expenses/:id
 * Updates an active operating expense and logs before/after audit state.
 */
router.put('/expenses/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idCheck = expenseIdParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      sendValidationError(res, idCheck.error.errors[0]?.message || 'Invalid expense ID.');
      return;
    }

    const parsed = updateExpenseSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid expense update payload.');
      return;
    }

    const updated = await dashboardService.updateExpense(idCheck.data, parsed.data);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/dashboard/expenses/:id/void
 * Soft-voids an active expense with mandatory reason (never deletes financial history).
 */
router.post('/expenses/:id/void', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idCheck = expenseIdParamSchema.safeParse(req.params.id);
    if (!idCheck.success) {
      sendValidationError(res, idCheck.error.errors[0]?.message || 'Invalid expense ID.');
      return;
    }

    const parsed = voidExpenseSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.errors[0]?.message || 'Void reason is required.');
      return;
    }

    const voided = await dashboardService.voidExpense(idCheck.data, parsed.data.reason);
    res.json({ success: true, data: voided });
  } catch (err) {
    next(err);
  }
});

export const dashboardRoutes = router;
