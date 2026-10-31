import { appPool } from '../../config/database.js';

export interface ProductRecord {
  id: number;
  name: string;
  buying_price: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export class ProductsService {
  /**
   * Lists all active products, with optional search filter
   */
  public async listActiveProducts(search?: string): Promise<ProductRecord[]> {
    if (search && search.trim()) {
      const result = await appPool.query(
        `SELECT id, name, buying_price, created_at, updated_at, archived_at
         FROM products
         WHERE archived_at IS NULL AND name ILIKE $1
         ORDER BY name ASC`,
        [`%${search.trim()}%`]
      );
      return result.rows;
    }

    const result = await appPool.query(
      `SELECT id, name, buying_price, created_at, updated_at, archived_at
       FROM products
       WHERE archived_at IS NULL
       ORDER BY name ASC`
    );
    return result.rows;
  }

  /**
   * Retrieves an active product by ID
   */
  public async getProductById(id: number): Promise<ProductRecord | null> {
    const result = await appPool.query(
      `SELECT id, name, buying_price, created_at, updated_at, archived_at
       FROM products
       WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Creates a new reference product
   */
  public async createProduct(name: string, buyingPrice: string | number): Promise<ProductRecord> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Product name cannot be empty.');

    const priceNum = Number(buyingPrice);
    if (isNaN(priceNum) || priceNum < 0) {
      throw new Error('Buying price must be a valid non-negative number.');
    }

    const formattedPrice = priceNum.toFixed(2);

    const result = await appPool.query(
      `INSERT INTO products (name, buying_price, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       RETURNING id, name, buying_price, created_at, updated_at, archived_at`,
      [trimmed, formattedPrice]
    );
    return result.rows[0];
  }

  /**
   * Updates an existing product's name and/or buying price
   */
  public async updateProduct(
    id: number,
    data: { name?: string; buyingPrice?: string | number }
  ): Promise<ProductRecord | null> {
    const existing = await this.getProductById(id);
    if (!existing || existing.archived_at) return null;

    const newName = data.name !== undefined ? data.name.trim() : existing.name;
    let newPrice = existing.buying_price;

    if (data.buyingPrice !== undefined) {
      const p = Number(data.buyingPrice);
      if (isNaN(p) || p < 0) {
        throw new Error('Buying price must be a valid non-negative number.');
      }
      newPrice = p.toFixed(2);
    }

    const result = await appPool.query(
      `UPDATE products
       SET name = $1, buying_price = $2, updated_at = NOW()
       WHERE id = $3 AND archived_at IS NULL
       RETURNING id, name, buying_price, created_at, updated_at, archived_at`,
      [newName, newPrice, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Safely archives a product without deleting historical references
   */
  public async archiveProduct(id: number): Promise<boolean> {
    const result = await appPool.query(
      `UPDATE products
       SET archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND archived_at IS NULL`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export const productsService = new ProductsService();
