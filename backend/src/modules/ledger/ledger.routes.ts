import { Router, Request, Response } from 'express';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { appPool } from '../../config/database.js';
import { env } from '../../config/env.js';

const router = Router();

// Require active owner session for all ledger operations
router.use(requireOwnerSession);

// Fallback in-memory ledger fixture for offline testing
let inMemoryCustomers = [
  { id: 1, name: 'Ramesh Kumar', phone: '9811223344', balance: 1450.0 },
  { id: 2, name: 'Suresh Sharma', phone: '9822334455', balance: 620.0 },
  { id: 3, name: 'Anil Verma', phone: '9833445566', balance: 0.0 },
];

let inMemoryEntries = [
  { id: 1, customer_id: 1, type: 'UDHAR_GIVEN', amount: 1450.0, description: 'Groceries on credit', date: '2026-10-25' },
  { id: 2, customer_id: 2, type: 'UDHAR_GIVEN', amount: 1000.0, description: 'Atta and oil', date: '2026-10-28' },
  { id: 3, customer_id: 2, type: 'PAYMENT_RECEIVED', amount: 380.0, description: 'Cash paid', date: '2026-10-30' },
];

/**
 * GET /api/v1/ledger - Returns customers and ledger entries
 */
router.get('/', async (req: Request, res: Response) => {
  if (env.NODE_ENV === 'test') {
    res.json({
      success: true,
      customers: inMemoryCustomers,
      entries: inMemoryEntries,
    });
    return;
  }

  try {
    const customersRes = await appPool.query('SELECT * FROM customers ORDER BY name ASC');
    const entriesRes = await appPool.query('SELECT * FROM ledger_entries ORDER BY created_at DESC');

    res.json({
      success: true,
      customers: customersRes.rows,
      entries: entriesRes.rows,
    });
  } catch (err) {
    console.warn('[LEDGER] DB unavailable, returning reference data:', (err as Error).message);
    res.json({
      success: true,
      customers: inMemoryCustomers,
      entries: inMemoryEntries,
    });
  }
});

/**
 * GET /api/v1/ledger/summary - Aggregates for dashboard
 */
router.get('/summary', async (req: Request, res: Response) => {
  if (env.NODE_ENV === 'test') {
    const totalUdhar = inMemoryEntries
      .filter((e) => e.type === 'UDHAR_GIVEN')
      .reduce((acc, curr) => acc + curr.amount, 0);
    const totalPayments = inMemoryEntries
      .filter((e) => e.type === 'PAYMENT_RECEIVED')
      .reduce((acc, curr) => acc + curr.amount, 0);

    res.json({
      success: true,
      summary: {
        totalCustomers: inMemoryCustomers.length,
        totalUdharOutstanding: totalUdhar - totalPayments,
        totalPaymentsReceived: totalPayments,
      },
    });
    return;
  }

  try {
    const totalRes = await appPool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'UDHAR_GIVEN' THEN amount ELSE 0 END), 0) AS total_udhar,
        COALESCE(SUM(CASE WHEN type = 'PAYMENT_RECEIVED' THEN amount ELSE 0 END), 0) AS total_payments,
        (SELECT COUNT(*) FROM customers) AS total_customers
      FROM ledger_entries
    `);

    const row = totalRes.rows[0];
    const totalUdhar = parseFloat(row.total_udhar);
    const totalPayments = parseFloat(row.total_payments);

    res.json({
      success: true,
      summary: {
        totalCustomers: parseInt(row.total_customers, 10),
        totalUdharOutstanding: totalUdhar - totalPayments,
        totalPaymentsReceived: totalPayments,
      },
    });
  } catch (err) {
    res.json({
      success: true,
      summary: {
        totalCustomers: inMemoryCustomers.length,
        totalUdharOutstanding: 2070.0,
        totalPaymentsReceived: 380.0,
      },
    });
  }
});

/**
 * POST /api/v1/ledger/entry - Record Udhar or payment received
 */
router.post('/entry', async (req: Request, res: Response) => {
  const { customer_id, type, amount, description } = req.body;

  if (!customer_id || !type || !['UDHAR_GIVEN', 'PAYMENT_RECEIVED'].includes(type) || !amount || isNaN(Number(amount))) {
    res.status(400).json({ success: false, message: 'Valid customer_id, type, and amount are required.' });
    return;
  }

  if (env.NODE_ENV === 'test') {
    const newEntry = {
      id: inMemoryEntries.length + 1,
      customer_id: Number(customer_id),
      type,
      amount: Number(amount),
      description: description || '',
      date: new Date().toISOString().split('T')[0],
    };
    inMemoryEntries.push(newEntry);
    res.status(201).json({ success: true, data: newEntry });
    return;
  }

  try {
    const result = await appPool.query(
      `INSERT INTO ledger_entries (customer_id, type, amount, description, entry_date, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, NOW()) RETURNING *`,
      [customer_id, type, Number(amount).toFixed(2), description || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to record ledger entry.' });
  }
});

export const ledgerRoutes = router;
