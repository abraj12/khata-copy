import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { offlineBillsService } from './offlineBills.service.js';

const router = Router();

// Protect all offline bill endpoints with requireOwnerSession
router.use(requireOwnerSession);

const searchBillsQuerySchema = z.object({
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const uploadIntentSchema = z.object({
  contentType: z.string().trim().min(1, 'Content-Type is required'),
  sizeBytes: z.coerce.number().int().positive('Size must be positive'),
  originalFilename: z.string().max(255).optional(),
});

const createBillSchema = z.object({
  customerName: z.string().trim().min(1, 'Customer name is required').max(255),
  customerPhone: z.string().trim().min(1, 'Customer phone is required').max(20),
  imageObjectKey: z.string().trim().min(1, 'Image object key is required'),
  originalFilename: z.string().max(255).optional(),
});

/**
 * POST /api/v1/offline-bills/upload-intent - Generate presigned PUT URL to upload offline bill image to R2
 */
router.post('/upload-intent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = uploadIntentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid upload intent payload.',
      });
      return;
    }

    const intent = await offlineBillsService.getUploadIntent({
      contentType: parsed.data.contentType,
      sizeBytes: parsed.data.sizeBytes,
      originalFilename: parsed.data.originalFilename,
    });

    res.json({ success: true, data: intent });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/offline-bills - Create an offline bill record (Zero financial impact)
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createBillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid bill creation payload.',
      });
      return;
    }

    const newBill = await offlineBillsService.createOfflineBill(parsed.data);
    res.status(201).json({ success: true, data: newBill });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/offline-bills - List previous offline bills with search & pagination
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = searchBillsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid search parameters.',
      });
      return;
    }

    const { bills, pagination } = await offlineBillsService.listOfflineBills(parsed.data);
    res.json({ success: true, data: bills, pagination });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/offline-bills/:id - Get offline bill record by ID
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid bill ID.' });
      return;
    }

    const bill = await offlineBillsService.getOfflineBillById(id);
    if (!bill) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Offline bill record not found.' });
      return;
    }

    res.json({ success: true, data: bill });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/offline-bills/:id/image-url - Get presigned view or download URL
 */
router.get('/:id/image-url', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid bill ID.' });
      return;
    }

    const isDownload = req.query.download === 'true' || req.query.download === '1';
    const data = await offlineBillsService.getOfflineBillImageUrl(id, isDownload);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/offline-bills/:id - Delete an offline bill record and R2 image
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid bill ID.' });
      return;
    }

    await offlineBillsService.deleteOfflineBill(id);
    res.json({ success: true, message: 'Offline bill deleted successfully.' });
  } catch (err) {
    next(err);
  }
});

export const offlineBillsRoutes = router;
