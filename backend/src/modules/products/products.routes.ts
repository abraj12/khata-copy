import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { productsService } from './products.service.js';

const router = Router();

// Protect all product endpoints with requireOwnerSession
router.use(requireOwnerSession);

const createProductSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(255),
  buying_price: z.union([z.number(), z.string()]).transform((val) => {
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(num) || num < 0) {
      throw new Error('Buying price must be a non-negative number.');
    }
    return num;
  }),
});

const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  buying_price: z.union([z.number(), z.string()]).transform((val) => {
    const num = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(num) || num < 0) {
      throw new Error('Buying price must be a non-negative number.');
    }
    return num;
  }).optional(),
});

/**
 * GET /api/v1/products - List active products (Owner Reference: Name & Buying Price)
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string | undefined;
    const products = await productsService.listActiveProducts(search);
    res.json({ success: true, data: products });
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
        message: parsed.error.errors[0]?.message || 'Invalid product payload.',
      });
      return;
    }

    const { name, buying_price } = parsed.data;
    const newProduct = await productsService.createProduct(name, buying_price);
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
      res.status(400).json({ success: false, message: 'Invalid product ID.' });
      return;
    }

    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.error.errors[0]?.message || 'Invalid product update payload.',
      });
      return;
    }

    const updated = await productsService.updateProduct(id, {
      name: parsed.data.name,
      buyingPrice: parsed.data.buying_price,
    });

    if (!updated) {
      res.status(404).json({ success: false, message: 'Product not found or archived.' });
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
      res.status(400).json({ success: false, message: 'Invalid product ID.' });
      return;
    }

    const success = await productsService.archiveProduct(id);
    if (!success) {
      res.status(404).json({ success: false, message: 'Product not found or already archived.' });
      return;
    }

    res.json({ success: true, message: 'Product archived successfully.' });
  } catch (err) {
    next(err);
  }
});

export const productsRoutes = router;
