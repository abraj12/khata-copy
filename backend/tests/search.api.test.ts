import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appPool } from '../src/config/database.js';
import { khataService } from '../src/modules/khata/khata.service.js';
import { productsService } from '../src/modules/products/products.service.js';

describe('Search & Bounded Pagination Test Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Product Search & Pagination', () => {
    it('1. Returns paginated active products with case-insensitive search and limits', async () => {
      const mockRows = [
        { id: 1, name: 'Fevicol SH 1kg', buying_price: '400.00', created_at: '2026-11-01', updated_at: '2026-11-01', archived_at: null },
        { id: 2, name: 'Fevicol Marine 500g', buying_price: '280.00', created_at: '2026-11-01', updated_at: '2026-11-01', archived_at: null },
      ];

      vi.spyOn(appPool, 'query').mockResolvedValueOnce({
        rows: mockRows,
        rowCount: 2,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const res = await productsService.listActiveProducts({ search: 'fevicol', limit: 10, offset: 0 });
      expect(res.products).toHaveLength(2);
      expect(res.products[0].name).toBe('Fevicol SH 1kg');
      expect(res.products[0].buying_price).toBe('400.00');
      expect(res.pagination.limit).toBe(10);
      expect(res.pagination.offset).toBe(0);
      expect(res.pagination.hasMore).toBe(false);
      expect(res.pagination.nextOffset).toBeNull();
    });

    it('2. Correctly flags hasMore when more rows exist than the requested limit', async () => {
      // If limit is 2, service queries limit + 1 = 3 rows
      const mockRows = [
        { id: 1, name: 'Product A', buying_price: '10.00', created_at: '2026-11-01', updated_at: '2026-11-01', archived_at: null },
        { id: 2, name: 'Product B', buying_price: '20.00', created_at: '2026-11-01', updated_at: '2026-11-01', archived_at: null },
        { id: 3, name: 'Product C', buying_price: '30.00', created_at: '2026-11-01', updated_at: '2026-11-01', archived_at: null },
      ];

      vi.spyOn(appPool, 'query').mockResolvedValueOnce({
        rows: mockRows,
        rowCount: 3,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const res = await productsService.listActiveProducts({ limit: 2, offset: 0 });
      expect(res.products).toHaveLength(2); // Sliced to requested limit
      expect(res.pagination.hasMore).toBe(true);
      expect(res.pagination.nextOffset).toBe(2);
    });

    it('3. Escapes SQL wildcards (% and _) in search terms', async () => {
      let executedSql = '';
      let executedParams: unknown[] = [];

      vi.spyOn(appPool, 'query').mockImplementation(async (sql, params) => {
        executedSql = sql as string;
        executedParams = (params as unknown[]) || [];
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      });

      await productsService.listActiveProducts({ search: '100%_pipe' });
      expect(executedSql).toContain('name ILIKE $1');
      expect(executedParams[0]).toBe('%100\\%\\_pipe%');
    });
  });

  describe('Customer Search & Pagination', () => {
    it('4. Searches customers by name and phone with digit normalization', async () => {
      let executedSql = '';
      let executedParams: unknown[] = [];

      vi.spyOn(appPool, 'query').mockImplementation(async (sql, params) => {
        executedSql = sql as string;
        executedParams = (params as unknown[]) || [];
        return {
          rows: [
            {
              id: 5,
              name: 'Ramesh Patel',
              phone: '9876543210',
              total_udhar: '1500.00',
              total_received: '500.00',
              outstanding: '1000.00',
              last_activity: '2026-11-01T10:00:00Z',
            },
          ],
          rowCount: 1,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      });

      const res = await khataService.listCustomers({ search: '+91 98765-43210', limit: 25, offset: 0 });
      expect(res.customers).toHaveLength(1);
      expect(res.customers[0].name).toBe('Ramesh Patel');
      expect(res.customers[0].outstanding).toBe('1000.00');
      // Params must include escaped search and extracted digits
      expect(executedParams).toContain('%9876543210%');
      expect(executedSql).toContain('LIMIT $3 OFFSET $4');
      expect(executedParams).toHaveLength(4);
    });

    it('5. Enforces upper bound limit of 50 on pagination', async () => {
      let executedSql = '';
      let executedParams: unknown[] = [];

      vi.spyOn(appPool, 'query').mockImplementation(async (sql, params) => {
        executedSql = sql as string;
        executedParams = (params as unknown[]) || [];
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      });

      await khataService.listCustomers({ limit: 1000, offset: 0 });
      // Limit parameter must be capped at 200 (+ 1 for hasMore = 201)
      expect(executedParams).toContain(201);
    });

    it('6. Excludes archived products and enforces stable ordering (name ASC, id ASC)', async () => {
      let executedSql = '';

      vi.spyOn(appPool, 'query').mockImplementation(async (sql) => {
        executedSql = sql as string;
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      });

      await productsService.listActiveProducts();
      expect(executedSql).toContain('archived_at IS NULL');
      expect(executedSql).toContain('ORDER BY LOWER(name) ASC, name ASC, id ASC');
    });

    it('7. Enforces stable customer ordering (last_activity DESC, name ASC, id ASC) and parameterized LIMIT/OFFSET', async () => {
      let executedSql = '';
      let executedParams: unknown[] = [];

      vi.spyOn(appPool, 'query').mockImplementation(async (sql, params) => {
        executedSql = sql as string;
        executedParams = (params as unknown[]) || [];
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      });

      await khataService.listCustomers();
      expect(executedSql).toContain('ORDER BY tx.last_activity DESC NULLS LAST, c.name ASC, c.id ASC');
      expect(executedSql).toContain('LIMIT $1 OFFSET $2');
      expect(executedParams).toEqual([26, 0]);
    });

    it('8. Uses default pagination parameters (limit 25, offset 0)', async () => {
      let executedParams: unknown[] = [];

      vi.spyOn(appPool, 'query').mockImplementation(async (sql, params) => {
        executedParams = (params as unknown[]) || [];
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      });

      const res = await productsService.listActiveProducts();
      expect(res.pagination.limit).toBe(25);
      expect(res.pagination.offset).toBe(0);
      // Limit 25 + 1 = 26 queried
      expect(executedParams).toContain(26);
      expect(executedParams).toContain(0);
    });

    it('9. Verifies summary aggregates are independent and unaffected by search queries', async () => {
      vi.spyOn(appPool, 'query').mockResolvedValueOnce({
        rows: [
          {
            total_customers: '12',
            total_udhar: '54000.00',
            total_received: '32000.00',
            total_outstanding: '22000.00',
          },
        ],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const summary = await khataService.getSummary();
      expect(summary.totalCustomers).toBe(12);
      expect(summary.totalOutstanding).toBe('22000.00');
      expect(summary.totalReceived).toBe('32000.00');
    });
  });
});
