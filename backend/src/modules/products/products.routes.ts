import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { productsService } from './products.service.js';
import { validateMoneyInput } from '../../utils/validation.js';
import { storageService } from '../../services/storage.service.js';

// Multer: memory storage, 5 MB limit for product images
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const router = Router();

/**
 * GET /api/v1/products/:id/image - Directly stream product photograph from storage
 * Public route for <img> tags to completely bypass Cloudflare R2 browser CORS,
 * domain resolution, and presigned URL expiration issues.
 */
router.get('/:id/image', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid product ID.' });
      return;
    }

    const product = await productsService.getProductById(id);
    if (!product || !product.image_object_key || product.archived_at) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Product image not found or archived.' });
      return;
    }

    const { stream, contentType, contentLength } = await storageService.getObjectStream(product.image_object_key);

    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    // Cache for 1 day in browser, revalidate in background up to 7 days
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

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
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Image object not found in storage.' });
      return;
    }
    next(err);
  }
});

// Protect all remaining product endpoints with requireOwnerSession
router.use(requireOwnerSession);

const productSearchQuerySchema = z.object({
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const createProductSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(255),
  buying_price: z.union([z.number(), z.string()]),
});

const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  buying_price: z.union([z.number(), z.string()]).optional(),
});

const uploadIntentSchema = z.object({
  contentType: z.string().trim().min(1, 'Content-Type is required'),
  sizeBytes: z.coerce.number().int().positive('Size must be positive'),
  originalFilename: z.string().max(255).optional(),
});

const completeImageSchema = z.object({
  objectKey: z.string().trim().min(1, 'Object key is required'),
});

/**
 * GET /api/v1/products - List active products with search & pagination (Owner Reference: Name & Buying Price)
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = productSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid search query parameters.',
      });
      return;
    }

    const { products, pagination } = await productsService.listActiveProducts(parsed.data);
    res.json({ success: true, data: products, pagination });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/products - Add a new product with buying price
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid product payload.',
      });
      return;
    }

    const { name, buying_price } = parsed.data;
    // Strict money validation (rejects >2 decimals, NaN, Infinity, negative)
    const priceDec = validateMoneyInput(buying_price, 'Buying price');
    const newProduct = await productsService.createProduct(name, priceDec.toFixed(2));
    res.status(201).json({ success: true, data: newProduct });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/products/:id - Update product name or buying price
 */
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid product ID.' });
      return;
    }

    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid product update payload.',
      });
      return;
    }

    let validatedPrice: string | undefined;
    if (parsed.data.buying_price !== undefined) {
      const priceDec = validateMoneyInput(parsed.data.buying_price, 'Buying price');
      validatedPrice = priceDec.toFixed(2);
    }

    const updated = await productsService.updateProduct(id, {
      name: parsed.data.name,
      buyingPrice: validatedPrice,
    });

    if (!updated) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Product not found or archived.' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/products/:id - Archive product safely (preserves historical snapshots)
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid product ID.' });
      return;
    }

    const success = await productsService.archiveProduct(id);
    if (!success) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Product not found or already archived.' });
      return;
    }

    res.json({ success: true, message: 'Product archived successfully.' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/products/:id/image/upload - Server-side proxy upload (browser → backend → R2)
 * Eliminates browser CORS restrictions by routing the upload through our own API.
 */
router.post(
  '/:id/image/upload',
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('image')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            success: false,
            code: 'FILE_TOO_LARGE',
            message: 'Product image must not exceed 5 MB.',
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
      const id = parseInt(req.params.id, 10);
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid product ID.' });
        return;
      }

      const existing = await productsService.getProductById(id);
      if (!existing || existing.archived_at) {
        res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Product not found or archived.' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'No image file provided. Send field named "image".' });
        return;
      }

      const { objectKey } = await storageService.validateAndUploadBuffer({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        folder: 'products',
        referenceId: id,
      });

      const updated = await productsService.attachProductImage(id, objectKey);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/products/:id/image/upload-intent - Generate presigned PUT URL to upload product image to R2
 */
router.post('/:id/image/upload-intent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid product ID.' });
      return;
    }

    const existing = await productsService.getProductById(id);
    if (!existing || existing.archived_at) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Product not found or archived.' });
      return;
    }

    const parsed = uploadIntentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid upload intent payload.',
      });
      return;
    }

    const intent = await storageService.getUploadIntent({
      folder: 'products',
      referenceId: id,
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
 * POST /api/v1/products/:id/image/complete - Verify and attach uploaded R2 image to product
 */
router.post('/:id/image/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid product ID.' });
      return;
    }

    const parsed = completeImageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid complete payload.',
      });
      return;
    }

    const updated = await productsService.attachProductImage(id, parsed.data.objectKey);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/products/:id/image-url - Get short-lived presigned GET view URL
 */
router.get('/:id/image-url', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid product ID.' });
      return;
    }

    const data = await productsService.getProductImageUrl(id);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/products/:id/image - Remove image from product without deleting product
 */
router.delete('/:id/image', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid product ID.' });
      return;
    }

    const updated = await productsService.removeProductImage(id);
    res.json({ success: true, message: 'Product image removed successfully.', data: updated });
  } catch (err) {
    next(err);
  }
});

export const productsRoutes = router;
