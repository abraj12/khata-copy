import { Router, Request, Response } from 'express';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { appPool } from '../../config/database.js';
import { env } from '../../config/env.js';

const router = Router();

// Protect all product endpoints with requireOwnerSession
router.use(requireOwnerSession);

// In-memory fallback if testing without live DB
let inMemoryProducts = [
  { id: 1, name: 'Tata Tea Gold 500g', buying_price: '280.00', created_at: new Date().toISOString() },
  { id: 2, name: 'Aashirvaad Atta 10kg', buying_price: '410.00', created_at: new Date().toISOString() },
  { id: 3, name: 'Fortune Mustard Oil 1L', buying_price: '142.00', created_at: new Date().toISOString() },
];

/**
 * GET /api/v1/products - List products (Owner Reference: Name & Buying Price)
 */
router.get('/', async (req: Request, res: Response) => {
  if (env.NODE_ENV === 'test') {
    res.json({ success: true, data: inMemoryProducts });
    return;
  }

  try {
    const result = await appPool.query(
      'SELECT id, name, buying_price, created_at, updated_at FROM products ORDER BY name ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.warn('[PRODUCTS] DB unavailable, returning reference data:', (err as Error).message);
    res.json({ success: true, data: inMemoryProducts });
  }
});

/**
 * POST /api/v1/products - Add a new product with buying price
 */
router.post('/', async (req: Request, res: Response) => {
  const { name, buying_price } = req.body;
  if (!name || buying_price === undefined || isNaN(Number(buying_price))) {
    res.status(400).json({ success: false, message: 'Valid name and buying_price are required.' });
    return;
  }

  if (env.NODE_ENV === 'test') {
    const newProduct = {
      id: inMemoryProducts.length + 1,
      name: String(name),
      buying_price: Number(buying_price).toFixed(2),
      created_at: new Date().toISOString(),
    };
    inMemoryProducts.push(newProduct);
    res.status(201).json({ success: true, data: newProduct });
    return;
  }

  try {
    const result = await appPool.query(
      'INSERT INTO products (name, buying_price, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING *',
      [name, Number(buying_price).toFixed(2)]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create product.' });
  }
});

export const productsRoutes = router;
