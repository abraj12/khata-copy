import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { productsService } from './products.service.js';
import { validateMoneyInput } from '../../utils/validation.js';

const router = Router();

// Protect all product endpoints with requireOwnerSession
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

export const productsRoutes = router;
