import { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { AppError } from '../../utils/errors.js';
import { appDataService } from './appData.service.js';
import { ReadModelUnavailableError } from '../readModels/readModelsQuery.service.js';

export const appDataRouter = Router();

appDataRouter.get('/preferences', requireOwnerSession, async (_req: Request, res: Response) => {
  try {
    const result = await appDataService.getUserPreferences();
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err) {
    if (err instanceof ReadModelUnavailableError) {
      res.status(503).json({
        success: false,
        code: err.code,
        message: err.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: 'Failed to load user preferences.',
    });
  }
});

appDataRouter.put('/preferences', requireOwnerSession, async (req: Request, res: Response) => {
  try {
    const result = await appDataService.updateUserPreferences(req.body);
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid preferences payload.',
        details: err.issues,
      });
      return;
    }
    if (err instanceof ReadModelUnavailableError) {
      res.status(503).json({
        success: false,
        code: err.code,
        message: err.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: 'Failed to update user preferences.',
    });
  }
});

appDataRouter.get('/notifications', requireOwnerSession, async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const unreadOnly = req.query.unreadOnly === 'true' || req.query.unreadOnly === '1';
    const result = await appDataService.listNotifications({
      limit: Number.isFinite(limit) ? limit : undefined,
      unreadOnly,
    });
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err) {
    if (err instanceof ReadModelUnavailableError) {
      res.status(503).json({
        success: false,
        code: err.code,
        message: err.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: 'Failed to load notifications.',
    });
  }
});

appDataRouter.post('/notifications/read-all', requireOwnerSession, async (_req: Request, res: Response) => {
  try {
    const result = await appDataService.markNotificationsRead('all');
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err) {
    if (err instanceof ReadModelUnavailableError) {
      res.status(503).json({
        success: false,
        code: err.code,
        message: err.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: 'Failed to mark notifications as read.',
    });
  }
});

appDataRouter.post('/notifications/:id/read', requireOwnerSession, async (req: Request, res: Response) => {
  try {
    const targetId = String(req.params.id || '').trim();
    if (!targetId) {
      res.status(400).json({
        success: false,
        message: 'Notification identifier is required.',
      });
      return;
    }
    const result = await appDataService.markNotificationsRead(targetId);
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.status).json({
        success: false,
        code: err.code,
        message: err.message,
      });
      return;
    }
    if (err instanceof ReadModelUnavailableError) {
      res.status(503).json({
        success: false,
        code: err.code,
        message: err.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read.',
    });
  }
});

appDataRouter.post('/telemetry', requireOwnerSession, async (req: Request, res: Response) => {
  try {
    const result = await appDataService.recordTelemetry(req.body);
    res.status(202).json({
      success: true,
      ...result,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid telemetry payload.',
        details: err.issues,
      });
      return;
    }
    res.status(202).json({
      success: true,
      recorded: false,
    });
  }
});
