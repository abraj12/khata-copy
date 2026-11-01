import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { offlineBillsService } from './offlineBills.service.js';
import { storageService } from '../../services/storage.service.js';

// Multer: memory storage, 10 MB limit for offline bill images
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

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
 * POST /api/v1/offline-bills/upload - Server-side proxy upload + create bill in one step
 * Accepts multipart/form-data with fields: image (file), customerName, customerPhone
 */
router.post(
  '/upload',
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('image')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            success: false,
            code: 'FILE_TOO_LARGE',
            message: 'Offline bill image must not exceed 10 MB.',
          });
          return;
        }
        res.status(400).json({ success: false, code: 'UPLOAD_ERROR', message: err.message });
        return;
      }
      if (err) return next(err);
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'No image file provided. Send field named "image".' });
        return;
      }

      const customerName = (req.body.customerName || '').trim();
      const customerPhone = (req.body.customerPhone || '').trim();
      const originalFilename = req.file.originalname || undefined;

      if (!customerName || customerName.length > 255) {
        res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Customer name is required (max 255 chars).' });
        return;
      }
      if (!customerPhone || customerPhone.length > 20) {
        res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Customer phone is required (max 20 chars).' });
        return;
      }

      const { objectKey } = await storageService.validateAndUploadBuffer({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        folder: 'offline-bills',
        referenceId: 'tmp',
      });

      const newBill = await offlineBillsService.createOfflineBill({
        customerName,
        customerPhone,
        imageObjectKey: objectKey,
        originalFilename,
      });

      res.status(201).json({ success: true, data: newBill });
    } catch (err) {
      next(err);
    }
  }
);

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
 * GET /api/v1/offline-bills/:id/image - Directly stream offline bill image from storage
 */
router.get('/:id/image', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid bill ID.' });
      return;
    }

    const bill = await offlineBillsService.getOfflineBillById(id);
    if (!bill || !bill.image_object_key) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Offline bill image not found.' });
      return;
    }

    const isDownload = req.query.download === 'true' || req.query.download === '1';
    const { stream, contentType, contentLength } = await storageService.getObjectStream(bill.image_object_key);

    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    if (isDownload) {
      const filename = bill.original_filename || `offline-bill-${id}.jpg`;
      const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${sanitized}"`);
    } else {
      res.setHeader('Cache-Control', 'private, max-age=3600');
    }

    (stream as any).on('error', (err: unknown) => {
      if (!res.headersSent) next(err);
    });
    res.on('close', () => {
      if (typeof (stream as any).destroy === 'function') {
        (stream as any).destroy();
      }
    });

    (stream as any).pipe(res);
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.code === 'NoSuchKey') {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Bill image not found in storage.' });
      return;
    }
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
