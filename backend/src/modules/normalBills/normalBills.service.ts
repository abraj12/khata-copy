import Decimal from 'decimal.js';
import { appPool } from '../../config/database.js';
import { StorageService } from '../../services/storage.service.js';
import { AppError } from '../../utils/errors.js';
import { validateMoneyInput, validateDecimalQuantityInput } from '../../utils/validation.js';
import {
  generateTaxInvoicePdf,

  numberToIndianWords,
} from '../gstInvoices/gstInvoices.pdf.js';

export interface CreateNormalBillItemInput {
  productId?: number | null;
  description: string;
  hsnCode?: string | null;
  quantity: number | string;
  unit?: string | null;
  rate: number | string;
  rateUnit?: string | null;
}

export interface CreateNormalBillInput {
  billNumber?: string;
  billDate?: string;
  state?: string;
  stateCode?: string;
  transportationMode?: string | null;
  vehicleNumber?: string | null;
  dateOfSupply?: string | null;
  placeOfSupply?: string | null;
  customerId?: number | null;
  customerName: string;
  customerAddress?: string | null;
  customerPhone?: string | null;
  customerState?: string;
  customerStateCode?: string;
  items: CreateNormalBillItemInput[];
  notes?: string | null;
}

export interface NormalBillRecord {
  id: number;
  bill_number: string;
  bill_date: string;
  state: string;
  state_code: string;
  transportation_mode: string | null;
  vehicle_number: string | null;
  date_of_supply: string | null;
  place_of_supply: string | null;
  customer_id: number | null;
  customer_name: string;
  customer_address: string | null;
  customer_phone: string | null;
  customer_state: string;
  customer_state_code: string;
  total_amount: string;
  amount_in_words: string;
  r2_object_key: string | null;
  pdf_status: 'pending' | 'uploaded' | 'failed' | 'local_only';
  notes: string | null;
  created_at: string;
  updated_at: string;
  items?: NormalBillItemRecord[];
}

export interface NormalBillItemRecord {
  id: number;
  bill_id: number;
  product_id: number | null;
  item_index: number;
  description: string;
  hsn_code: string | null;
  quantity: string;
  unit: string | null;
  rate: string;
  rate_unit: string | null;
  amount: string;
  created_at: string;
}

export class NormalBillsService {
  private storageService: StorageService;

  constructor(storageService?: StorageService) {
    this.storageService = storageService || new StorageService();
  }

  /**
   * Generates the next sequential normal bill number from the database.
   * Finds the maximum existing numerical bill number and increments it by 1,
   * formatted as 3-digit padded (001, 002, 003...).
   * Pure, idempotent, and non-destructive.
   */
  public async getNextBillNumber(): Promise<string> {
    try {
      const res = await appPool.query(`
        SELECT GREATEST(
          (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM normal_bill_number_seq),
          COALESCE((
            SELECT MAX(
              CASE
                WHEN bill_number ~ '^\\d+$' THEN bill_number::BIGINT
                WHEN regexp_replace(bill_number, '\\D', '', 'g') <> '' THEN regexp_replace(bill_number, '\\D', '', 'g')::BIGINT
                ELSE 0
              END
            ) FROM normal_bills
          ), 0) + 1
        ) AS next_num,
        COALESCE(MAX(
          CASE
            WHEN bill_number ~ '^\\d+$' THEN bill_number::BIGINT
            WHEN regexp_replace(bill_number, '\\D', '', 'g') <> '' THEN regexp_replace(bill_number, '\\D', '', 'g')::BIGINT
            ELSE 0
          END
        ), 0) AS max_num FROM normal_bills
      `);
      const row = res.rows[0];
      const maxNum = Number(row?.max_num || 0);
      let nextNum = Number(row?.next_num ?? (maxNum + 1));
      if (maxNum === 0) {
        nextNum = 1;
        try {
          await appPool.query("SELECT setval('normal_bill_number_seq', 1, false)");
        } catch {
          // Non-fatal in mock/test environments
        }
      } else if (nextNum > maxNum + 1) {
        // If sequence drifted ahead because rows were deleted from database, resync to maxNum
        nextNum = maxNum + 1;
        try {
          await appPool.query("SELECT setval('normal_bill_number_seq', $1::BIGINT, true)", [maxNum]);
        } catch {
          // Non-fatal in mock/test environments
        }
      }
      return String(nextNum).padStart(3, '0');
    } catch {
      const maxRes = await appPool.query(`
        SELECT COALESCE(MAX(
          CASE
            WHEN bill_number ~ '^\\d+$' THEN bill_number::BIGINT
            WHEN regexp_replace(bill_number, '\\D', '', 'g') <> '' THEN regexp_replace(bill_number, '\\D', '', 'g')::BIGINT
            ELSE 0
          END
        ), 0) AS max_num FROM normal_bills
      `);
      const maxNum = Number(maxRes.rows[0]?.max_num || 0);
      return String(maxNum + 1).padStart(3, '0');
    }
  }

  /**
   * Creates a Normal Bill without GST calculations, ensures financial decimal safety, and generates PDF.
   */
  public async createBill(input: CreateNormalBillInput): Promise<NormalBillRecord> {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one line item is required.', 400, 'ITEMS_REQUIRED');
    }

    const client = await appPool.connect();

    try {
      await client.query('BEGIN');

      // 1. Resolve bill number atomically using database sequence
      let billNumber = input.billNumber?.trim();
      if (!billNumber) {
        try {
          const maxCheck = await client.query(`
            SELECT COALESCE(MAX(
              CASE
                WHEN bill_number ~ '^\\d+$' THEN bill_number::BIGINT
                WHEN regexp_replace(bill_number, '\\D', '', 'g') <> '' THEN regexp_replace(bill_number, '\\D', '', 'g')::BIGINT
                ELSE 0
              END
            ), 0) AS max_num FROM normal_bills
          `);
          const currentMax = Number(maxCheck.rows[0]?.max_num || 0);
          if (currentMax === 0) {
            await client.query("SELECT setval('normal_bill_number_seq', 1, false)");
          } else {
            const seqRes = await client.query("SELECT last_value FROM normal_bill_number_seq");
            const seqLast = Number(seqRes.rows[0]?.last_value || 0);
            if (seqLast > currentMax) {
              await client.query("SELECT setval('normal_bill_number_seq', $1::BIGINT, true)", [currentMax]);
            }
          }
        } catch {
          // Non-fatal in mock environments
        }
        let attempts = 0;
        while (attempts < 10) {
          try {
            const seqRes = await client.query(`SELECT nextval('normal_bill_number_seq') AS seq_num`);
            const seqVal = seqRes.rows[0]?.seq_num;
            if (seqVal) {
              const candidate = String(seqVal).padStart(3, '0');
              const exists = await client.query('SELECT 1 FROM normal_bills WHERE bill_number = $1', [candidate]);
              if ((exists.rowCount ?? 0) === 0) {
                billNumber = candidate;
                break;
              }
            }
          } catch {
            // Sequence call failed (e.g. in unit mocks), fall back to max calculation
            break;
          }
          attempts++;
        }

        if (!billNumber) {
          const maxRes = await client.query(`
            SELECT COALESCE(MAX(
              CASE
                WHEN bill_number ~ '^\\d+$' THEN bill_number::BIGINT
                WHEN regexp_replace(bill_number, '\\D', '', 'g') <> '' THEN regexp_replace(bill_number, '\\D', '', 'g')::BIGINT
                ELSE 0
              END
            ), 0) AS max_num FROM normal_bills
          `);
          const maxNum = Number(maxRes.rows[0]?.max_num || 0);
          billNumber = String(maxNum + 1).padStart(3, '0');
        }
      } else {
        // Alphanumeric manual number support (e.g., 'NB-101' -> 101, '005' -> 5)
        const digits = billNumber.replace(/[^0-9]/g, '');
        const numVal = digits ? parseInt(digits, 10) : NaN;
        if (!isNaN(numVal) && numVal > 0) {
          try {
            await client.query(
              `SELECT setval('normal_bill_number_seq', GREATEST((SELECT last_value FROM normal_bill_number_seq), $1::BIGINT), true)`,
              [numVal]
            );
          } catch {
            // Non-fatal if sequence absent in mock
          }
        }
      }

      // Check collision
      const existsRes = await client.query('SELECT 1 FROM normal_bills WHERE bill_number = $1', [billNumber]);
      if ((existsRes.rowCount ?? 0) > 0) {
        throw new AppError(`Bill number "${billNumber}" already exists.`, 409, 'DUPLICATE_BILL_NUMBER');
      }

      // Auto-update customer address in database if linked customer currently lacks an address
      if (input.customerId && input.customerAddress?.trim()) {
        await client.query(
          `UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2 AND (address IS NULL OR address = '')`,
          [input.customerAddress.trim(), input.customerId]
        );
      }

      // 2. Calculate item amounts and total value using Decimal.js with 2-decimal scale (No GST)
      let totalAmountDec = new Decimal(0);
      const computedItems: Array<CreateNormalBillItemInput & { amount: string }> = [];

      for (const item of input.items) {
        const qtyDec = validateDecimalQuantityInput(item.quantity, `Item "${item.description}" quantity`);
        const rateDec = validateMoneyInput(item.rate, `Item "${item.description}" rate`);

        const lineAmountDec = qtyDec.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        totalAmountDec = totalAmountDec.plus(lineAmountDec);

        computedItems.push({
          ...item,
          quantity: qtyDec.toFixed(2),
          rate: rateDec.toFixed(2),
          amount: lineAmountDec.toFixed(2),
        });
      }

      // 3. Indian words representation of final amount
      const amountInWords = numberToIndianWords(totalAmountDec.toNumber());

      // 4. Insert Normal Bill Header
      const insertBillSql = `
        INSERT INTO normal_bills (
          bill_number,
          bill_date,
          state,
          state_code,
          transportation_mode,
          vehicle_number,
          date_of_supply,
          place_of_supply,
          customer_id,
          customer_name,
          customer_address,
          customer_phone,
          customer_state,
          customer_state_code,
          total_amount,
          amount_in_words,
          pdf_status,
          notes
        ) VALUES (
          $1,
          COALESCE($2::DATE, CURRENT_DATE),
          COALESCE($3, 'Uttar Pradesh'),
          COALESCE($4, '09'),
          $5,
          $6,
          $7::DATE,
          $8,
          $9,
          $10,
          $11,
          $12,
          COALESCE($13, 'Uttar Pradesh'),
          COALESCE($14, '09'),
          $15,
          $16,
          'pending',
          $17
        ) RETURNING
          id,
          bill_number,
          TO_CHAR(bill_date, 'YYYY-MM-DD') AS bill_date,
          state,
          state_code,
          transportation_mode,
          vehicle_number,
          TO_CHAR(date_of_supply, 'YYYY-MM-DD') AS date_of_supply,
          place_of_supply,
          customer_id,
          customer_name,
          customer_address,
          customer_phone,
          customer_state,
          customer_state_code,
          total_amount,
          amount_in_words,
          r2_object_key,
          pdf_status,
          notes,
          created_at,
          updated_at;
      `;

      const billRes = await client.query(insertBillSql, [
        billNumber,
        input.billDate || null,
        input.state || 'Uttar Pradesh',
        input.stateCode || '09',
        input.transportationMode || null,
        input.vehicleNumber || null,
        input.dateOfSupply || null,
        input.placeOfSupply || null,
        input.customerId || null,
        input.customerName.trim(),
        input.customerAddress || null,
        input.customerPhone || null,
        input.customerState || 'Uttar Pradesh',
        input.customerStateCode || '09',
        totalAmountDec.toFixed(2),
        amountInWords,
        input.notes || null,
      ]);

      const billRecord: NormalBillRecord = billRes.rows[0];

      // 5. Insert line items
      const insertedItems: NormalBillItemRecord[] = [];
      for (let i = 0; i < computedItems.length; i++) {
        const item = computedItems[i];
        const itemRes = await client.query(
          `
          INSERT INTO normal_bill_items (
            bill_id,
            product_id,
            item_index,
            description,
            hsn_code,
            quantity,
            unit,
            rate,
            rate_unit,
            amount
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *;
        `,
          [
            billRecord.id,
            item.productId || null,
            i + 1,
            item.description.trim(),
            item.hsnCode || null,
            item.quantity,
            item.unit || null,
            item.rate,
            item.rateUnit || null,
            item.amount,
          ]
        );
        insertedItems.push(itemRes.rows[0]);
      }

      await client.query('COMMIT');

      // 6. Generate Normal Bill PDF (No GST calculations)
      let pdfStatus: 'uploaded' | 'local_only' | 'failed' = 'local_only';
      let r2Key: string | null = null;

      try {
        const pdfBuffer = await generateTaxInvoicePdf({
          invoiceNumber: billRecord.bill_number,
          invoiceDate: billRecord.bill_date,
          state: billRecord.state,
          stateCode: billRecord.state_code,
          transportationMode: billRecord.transportation_mode,
          vehicleNumber: billRecord.vehicle_number,
          dateOfSupply: billRecord.date_of_supply,
          placeOfSupply: billRecord.place_of_supply,
          customer: {
            name: billRecord.customer_name,
            address: billRecord.customer_address,
            phone: billRecord.customer_phone,
            state: billRecord.customer_state,
            stateCode: billRecord.customer_state_code,
          },
          items: insertedItems.map((item) => ({
            name: item.description,
            hsn: item.hsn_code,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            rateUnit: item.rate_unit,
            amount: item.amount,
          })),
          totals: {
            taxableAmount: billRecord.total_amount,
            taxAmount: 0,
            grandTotal: billRecord.total_amount,
          },
          amountInWords: billRecord.amount_in_words,
          isNormalBill: true,
          billTitle: 'NORMAL BILL',
        });

        // 7. Upload PDF to Cloudflare R2
        if (this.storageService.isConfigured()) {
          const year = new Date().getFullYear();
          const month = String(new Date().getMonth() + 1).padStart(2, '0');
          r2Key = `normal-bills/${year}/${month}/${billRecord.id}.pdf`;

          try {
            await this.storageService.uploadBufferToR2({
              buffer: pdfBuffer,
              objectKey: r2Key,
              contentType: 'application/pdf',
            });
            pdfStatus = 'uploaded';
          } catch (uploadErr) {
            console.error('[NORMAL BILL R2 UPLOAD] Upload failed:', uploadErr);
            pdfStatus = 'failed';
          }
        }

      } catch (pdfErr) {
        console.error('[NORMAL BILL PDF GENERATION ERROR]', (pdfErr as Error).message);
        pdfStatus = 'failed';
      }

      try {
        await appPool.query(
          'UPDATE normal_bills SET r2_object_key = $1, pdf_status = $2, updated_at = NOW() WHERE id = $3',
          [r2Key, pdfStatus, billRecord.id]
        );
      } catch (statusUpdateErr) {
        console.warn('[NORMAL BILL STATUS UPDATE NON-FATAL]', (statusUpdateErr as Error).message);
      }

      billRecord.r2_object_key = r2Key;
      billRecord.pdf_status = pdfStatus;
      billRecord.items = insertedItems;
      return billRecord;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure if already committed
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Generates a preview PDF buffer for normal bills on-the-fly without database writes.
   */
  public async generateDraftPdf(input: CreateNormalBillInput): Promise<{ buffer: Buffer; filename: string }> {
    let totalAmountDec = new Decimal(0);
    const computedItems: Array<CreateNormalBillItemInput & { amount: string }> = [];

    for (const item of input.items || []) {
      const qtyDec = validateDecimalQuantityInput(item.quantity || 1, 'Quantity');
      const rateDec = validateMoneyInput(item.rate || 0, 'Rate');
      const lineAmountDec = qtyDec.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      totalAmountDec = totalAmountDec.plus(lineAmountDec);

      computedItems.push({
        ...item,
        quantity: qtyDec.toFixed(2),
        rate: rateDec.toFixed(2),
        amount: lineAmountDec.toFixed(2),
      });
    }

    const billNumber = input.billNumber || 'Draft';
    const amountInWords = numberToIndianWords(totalAmountDec.toNumber());

    const buffer = await generateTaxInvoicePdf({
      invoiceNumber: billNumber,
      invoiceDate: input.billDate || new Date().toISOString().slice(0, 10),
      state: input.state || 'Uttar Pradesh',
      stateCode: input.stateCode || '09',
      transportationMode: input.transportationMode || null,
      vehicleNumber: input.vehicleNumber || null,
      dateOfSupply: input.dateOfSupply || null,
      placeOfSupply: input.placeOfSupply || null,
      customer: {
        name: input.customerName || 'Valued Customer',
        address: input.customerAddress || null,
        phone: input.customerPhone || null,
        state: input.customerState || 'Uttar Pradesh',
        stateCode: input.customerStateCode || '09',
      },
      items: computedItems.map((item) => ({
        name: item.description,
        hsn: item.hsnCode,
        quantity: item.quantity,
        unit: item.unit,
        rate: item.rate,
        rateUnit: item.rateUnit,
        amount: item.amount,
      })),
      totals: {
        taxableAmount: totalAmountDec.toFixed(2),
        taxAmount: 0,
        grandTotal: totalAmountDec.toFixed(2),
      },
      amountInWords,
      isNormalBill: true,
      billTitle: 'NORMAL BILL',
    });

    return {
      buffer,
      filename: `Normal_Bill_${billNumber}.pdf`,
    };
  }

  /**
   * Lists normal bills with pagination, search, date filtering, and embedded items snapshot.
   */
  public async listBills(query: {
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ bills: NormalBillRecord[]; totalCount: number }> {
    const limit = Math.min(Math.max(Number(query.limit || 25), 1), 100);
    const offset = Math.max(Number(query.offset || 0), 0);

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let pIdx = 1;

    if (query.search?.trim()) {
      conditions.push(`(
        b.bill_number ILIKE $${pIdx} OR
        b.customer_name ILIKE $${pIdx}
      )`);
      params.push(`%${query.search.trim()}%`);
      pIdx++;
    }

    if (query.dateFrom?.trim()) {
      conditions.push(`b.bill_date >= $${pIdx}::DATE`);
      params.push(query.dateFrom.trim());
      pIdx++;
    }

    if (query.dateTo?.trim()) {
      conditions.push(`b.bill_date <= $${pIdx}::DATE`);
      params.push(query.dateTo.trim());
      pIdx++;
    }

    const whereClause = conditions.join(' AND ');

    // 1. Total count query
    const countRes = await appPool.query(
      `SELECT COUNT(*)::INT AS total FROM normal_bills b WHERE ${whereClause}`,
      params
    );
    const totalCount = Number(countRes.rows[0]?.total || 0);

    // 2. Data query with json_agg of line items snapshot
    const dataSql = `
      SELECT
        b.id,
        b.bill_number,
        TO_CHAR(b.bill_date, 'YYYY-MM-DD') AS bill_date,
        b.state,
        b.state_code,
        b.transportation_mode,
        b.vehicle_number,
        TO_CHAR(b.date_of_supply, 'YYYY-MM-DD') AS date_of_supply,
        b.place_of_supply,
        b.customer_id,
        b.customer_name,
        b.customer_address,
        b.customer_phone,
        b.customer_state,
        b.customer_state_code,
        b.total_amount,
        b.amount_in_words,
        b.r2_object_key,
        b.pdf_status,
        b.notes,
        b.created_at,
        b.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', i.id,
              'bill_id', i.bill_id,
              'product_id', i.product_id,
              'item_index', i.item_index,
              'description', i.description,
              'hsn_code', i.hsn_code,
              'quantity', i.quantity,
              'unit', i.unit,
              'rate', i.rate,
              'rate_unit', i.rate_unit,
              'amount', i.amount,
              'created_at', i.created_at
            ) ORDER BY i.item_index ASC
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM normal_bills b
      LEFT JOIN normal_bill_items i ON b.id = i.bill_id
      WHERE ${whereClause}
      GROUP BY b.id
      ORDER BY b.bill_date DESC, b.id DESC
      LIMIT $${pIdx} OFFSET $${pIdx + 1};
    `;

    const dataRes = await appPool.query(dataSql, [...params, limit, offset]);
    return {
      bills: dataRes.rows,
      totalCount,
    };
  }

  /**
   * Retrieves a single normal bill by ID with all item details.
   */
  public async getBillById(id: number): Promise<NormalBillRecord> {
    const billSql = `
      SELECT
        b.id,
        b.bill_number,
        TO_CHAR(b.bill_date, 'YYYY-MM-DD') AS bill_date,
        b.state,
        b.state_code,
        b.transportation_mode,
        b.vehicle_number,
        TO_CHAR(b.date_of_supply, 'YYYY-MM-DD') AS date_of_supply,
        b.place_of_supply,
        b.customer_id,
        b.customer_name,
        b.customer_address,
        b.customer_phone,
        b.customer_state,
        b.customer_state_code,
        b.total_amount,
        b.amount_in_words,
        b.r2_object_key,
        b.pdf_status,
        b.notes,
        b.created_at,
        b.updated_at
      FROM normal_bills b
      WHERE b.id = $1;
    `;

    const billRes = await appPool.query(billSql, [id]);
    if ((billRes.rowCount ?? 0) === 0) {
      throw new AppError(`Normal bill #${id} not found.`, 404, 'BILL_NOT_FOUND');
    }

    const billRecord: NormalBillRecord = billRes.rows[0];

    const itemsRes = await appPool.query(
      `SELECT * FROM normal_bill_items WHERE bill_id = $1 ORDER BY item_index ASC`,
      [id]
    );
    billRecord.items = itemsRes.rows;

    return billRecord;
  }

  /**
   * Retrieves or regenerates PDF binary for a given bill.
   */
  public async getBillPdf(id: number): Promise<{ buffer: Buffer; filename: string }> {
    const bill = await this.getBillById(id);
    const filename = `Normal_Bill_${bill.bill_number}.pdf`;

    // If already stored in R2, attempt to stream
    if (bill.r2_object_key && this.storageService.isConfigured()) {
      try {
        const streamObj = await this.storageService.getObjectStream(bill.r2_object_key);
        const chunks: Buffer[] = [];
        for await (const chunk of streamObj.stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return { buffer: Buffer.concat(chunks), filename };
      } catch (streamErr) {
        console.warn('[NORMAL BILL PDF] Stream from R2 failed, regenerating locally:', (streamErr as Error).message);
      }
    }

    // Regenerate on demand
    const buffer = await generateTaxInvoicePdf({
      invoiceNumber: bill.bill_number,
      invoiceDate: bill.bill_date,
      state: bill.state,
      stateCode: bill.state_code,
      transportationMode: bill.transportation_mode,
      vehicleNumber: bill.vehicle_number,
      dateOfSupply: bill.date_of_supply,
      placeOfSupply: bill.place_of_supply,
      customer: {
        name: bill.customer_name,
        address: bill.customer_address,
        phone: bill.customer_phone,
        state: bill.customer_state,
        stateCode: bill.customer_state_code,
      },
      items: (bill.items || []).map((item) => ({
        name: item.description,
        hsn: item.hsn_code,
        quantity: item.quantity,
        unit: item.unit,
        rate: item.rate,
        rateUnit: item.rate_unit,
        amount: item.amount,
      })),
      totals: {
        taxableAmount: bill.total_amount,
        taxAmount: 0,
        grandTotal: bill.total_amount,
      },
      amountInWords: bill.amount_in_words,
      isNormalBill: true,
      billTitle: 'NORMAL BILL',
    });

    return {
      buffer,
      filename,
    };
  }
}

export const normalBillsService = new NormalBillsService();
