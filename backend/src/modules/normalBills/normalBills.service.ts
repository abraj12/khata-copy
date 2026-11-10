import crypto from 'crypto';
import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { appPool } from '../../config/database.js';
import {
  allocateDocumentNumber,
  getSuggestedNextDocumentNumber,
  NORMAL_BILL_NUMBERING_CONFIG,
} from '../billing/numbering.js';
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
  subtotalAmount?: number | string;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | string;
  discountAmount?: number | string;
  items: CreateNormalBillItemInput[];
  notes?: string | null;
  idempotencyKey?: string | null;
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
  subtotal_amount?: string | null;
  discount_type?: 'percentage' | 'fixed' | null;
  discount_value?: string;
  discount_amount?: string;
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
   * Generates the next sequential normal bill number suggestion from the database.
   * Pure, read-only, idempotent, and non-destructive. Never calls setval() or nextval().
   */
  public async getNextBillNumber(): Promise<string> {
    return getSuggestedNextDocumentNumber(appPool, NORMAL_BILL_NUMBERING_CONFIG);
  }

  private hashPayload(payload: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /**
   * Creates a Normal Bill within an existing database transaction client.
   * Atomically allocates bill number, calculates Decimal finances, and inserts line items.
   * Does NOT commit the transaction and does NOT upload to R2, enabling transactional composition.
   */
  public async createBillInTransaction(client: PoolClient, input: CreateNormalBillInput): Promise<NormalBillRecord> {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one line item is required.', 400, 'ITEMS_REQUIRED');
    }

    // 1. Resolve bill number atomically using sequence advisory lock allocator
    const billNumber = await allocateDocumentNumber(client, NORMAL_BILL_NUMBERING_CONFIG, input.billNumber);

    // Auto-update customer address if linked customer lacks one
    if (input.customerId && input.customerAddress?.trim()) {
      await client.query(
        `UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2 AND (address IS NULL OR address = '')`,
        [input.customerAddress.trim(), input.customerId]
      );
    }

    // 2. Calculate item amounts and subtotal value using Decimal.js with 2-decimal scale
    let subtotalDec = new Decimal(0);
    const computedItems: Array<CreateNormalBillItemInput & { amount: string }> = [];

    for (const item of input.items) {
      const qtyDec = validateDecimalQuantityInput(item.quantity, `Item "${item.description}" quantity`);
      const rateDec = validateMoneyInput(item.rate, `Item "${item.description}" rate`);

      const lineAmountDec = qtyDec.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      subtotalDec = subtotalDec.plus(lineAmountDec);

      computedItems.push({
        ...item,
        quantity: qtyDec.toFixed(2),
        rate: rateDec.toFixed(2),
        amount: lineAmountDec.toFixed(2),
      });
    }

    // 3. Discount calculations
    const discountType = input.discountType || null;
    let discountValDec = new Decimal(input.discountValue || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    let discountAmountDec = new Decimal(0);

    if (discountType === 'percentage') {
      if (discountValDec.isNegative() || discountValDec.greaterThan(100)) {
        throw new AppError('Discount percentage must be between 0 and 100.', 400, 'INVALID_DISCOUNT');
      }
      discountAmountDec = subtotalDec.times(discountValDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else if (discountType === 'fixed') {
      if (discountValDec.isNegative()) {
        throw new AppError('Discount fixed amount cannot be negative.', 400, 'INVALID_DISCOUNT');
      }
      discountAmountDec = Decimal.min(discountValDec, subtotalDec);
    } else if (input.discountAmount) {
      discountAmountDec = validateMoneyInput(input.discountAmount, 'Discount amount');
      discountAmountDec = Decimal.min(discountAmountDec, subtotalDec);
    }

    const totalAmountDec = subtotalDec.minus(discountAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
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
        subtotal_amount,
        discount_type,
        discount_value,
        discount_amount,
        total_amount,
        amount_in_words,
        pdf_status,
        notes
      ) VALUES (
        $1,
        COALESCE($2::DATE, CURRENT_DATE),
        COALESCE($3, 'Bihar'),
        COALESCE($4, '10'),
        $5,
        $6,
        $7::DATE,
        $8,
        $9,
        $10,
        $11,
        $12,
        COALESCE($13, 'Bihar'),
        COALESCE($14, '10'),
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        'pending',
        $21
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
        subtotal_amount,
        discount_type,
        discount_value,
        discount_amount,
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
      input.state || 'Bihar',
      input.stateCode || '10',
      input.transportationMode || null,
      input.vehicleNumber || null,
      input.dateOfSupply || null,
      input.placeOfSupply || null,
      input.customerId || null,
      input.customerName.trim(),
      input.customerAddress || null,
      input.customerPhone || null,
      input.customerState || 'Bihar',
      input.customerStateCode || '10',
      subtotalDec.toFixed(2),
      discountType,
      discountValDec.toFixed(2),
      discountAmountDec.toFixed(2),
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

    billRecord.items = insertedItems;
    return billRecord;
  }

  /**
   * Creates a Normal Bill without GST calculations, manages transaction boundaries, and generates PDF.
   */
  public async createBill(input: CreateNormalBillInput): Promise<NormalBillRecord> {
    const idempotencyPayload = {
      customerId: input.customerId,
      customerName: input.customerName?.trim(),
      customerAddress: input.customerAddress,
      customerPhone: input.customerPhone,
      items: input.items,
      discountType: input.discountType,
      discountValue: input.discountValue,
      discountAmount: input.discountAmount,
      billNumber: input.billNumber,
      billDate: input.billDate,
    };
    const currentHash = this.hashPayload(idempotencyPayload);

    const client = await appPool.connect();
    let billRecord: NormalBillRecord;

    try {
      await client.query('BEGIN');

      if (input.idempotencyKey) {
        const idempRes = await client.query(
          'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1',
          [input.idempotencyKey]
        );
        if (idempRes.rows.length > 0) {
          const row = idempRes.rows[0];
          if (row.request_hash === currentHash) {
            await client.query('COMMIT');
            return row.response_body;
          } else {
            throw new AppError('Idempotency key reused with different request payload.', 409, 'IDEMPOTENCY_CONFLICT');
          }
        }
      }

      billRecord = await this.createBillInTransaction(client, input);

      if (input.idempotencyKey) {
        await client.query(
          `INSERT INTO idempotency_keys (key, action, request_hash, response_status, response_body, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [input.idempotencyKey, 'CREATE_NORMAL_BILL', currentHash, 201, JSON.stringify(billRecord)]
        );
      }

      await client.query('COMMIT');
    } catch (err: any) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }

      if (input.idempotencyKey && err?.code === '23505' && err?.constraint?.includes('idempotency')) {
        try {
          const checkRes = await appPool.query(
            'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1',
            [input.idempotencyKey]
          );
          if (checkRes.rows.length > 0) {
            const row = checkRes.rows[0];
            if (row.request_hash === currentHash) {
              return row.response_body;
            } else {
              throw new AppError('Idempotency key reused with different request payload.', 409, 'IDEMPOTENCY_CONFLICT');
            }
          }
        } catch (innerErr) {
          if (innerErr instanceof AppError) throw innerErr;
        }
        throw new AppError('A request with this idempotency key is currently processing. Please retry in a moment.', 409, 'IDEMPOTENCY_IN_FLIGHT');
      }

      throw err;
    } finally {
      client.release();
    }

    // 6. Generate Normal Bill PDF (No GST calculations) outside of database transaction
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
        items: (billRecord.items || []).map((item) => ({
          name: item.description,
          hsn: item.hsn_code,
          quantity: item.quantity,
          unit: item.unit,
          rate: item.rate,
          rateUnit: item.rate_unit,
          amount: item.amount,
        })),
        totals: {
          subtotal: billRecord.subtotal_amount || billRecord.total_amount,
          discountType: billRecord.discount_type,
          discountValue: billRecord.discount_value,
          discountAmount: billRecord.discount_amount,
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
      console.error('[NORMAL BILL PDF GENERATION] PDF generation failed:', pdfErr);
      pdfStatus = 'failed';
    }

    // Update PDF status in DB
    try {
      await appPool.query(
        `UPDATE normal_bills SET pdf_status = $1, r2_object_key = $2, updated_at = NOW() WHERE id = $3`,
        [pdfStatus, r2Key, billRecord.id]
      );
      billRecord.pdf_status = pdfStatus;
      billRecord.r2_object_key = r2Key;
    } catch (statusUpdateErr) {
      console.warn('[NORMAL BILL STATUS UPDATE NON-FATAL]', (statusUpdateErr as Error).message);
    }

    return billRecord;
  }

  /**
   * Generates a preview PDF buffer for normal bills on-the-fly without database writes.
   */
  public async generateDraftPdf(input: CreateNormalBillInput): Promise<{ buffer: Buffer; filename: string }> {
    let subtotalDec = new Decimal(0);
    const computedItems: Array<CreateNormalBillItemInput & { amount: string }> = [];

    for (const item of input.items || []) {
      const qtyDec = validateDecimalQuantityInput(item.quantity || 1, 'Quantity');
      const rateDec = validateMoneyInput(item.rate || 0, 'Rate');
      const lineAmountDec = qtyDec.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      subtotalDec = subtotalDec.plus(lineAmountDec);

      computedItems.push({
        ...item,
        quantity: qtyDec.toFixed(2),
        rate: rateDec.toFixed(2),
        amount: lineAmountDec.toFixed(2),
      });
    }

    const discountType = input.discountType || null;
    let discountValDec = new Decimal(input.discountValue || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    let discountAmountDec = new Decimal(0);

    if (discountType === 'percentage') {
      discountAmountDec = subtotalDec.times(discountValDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else if (discountType === 'fixed') {
      discountAmountDec = Decimal.min(discountValDec, subtotalDec);
    } else if (input.discountAmount) {
      discountAmountDec = Decimal.min(new Decimal(input.discountAmount || 0), subtotalDec);
    }

    const totalAmountDec = subtotalDec.minus(discountAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const billNumber = input.billNumber || 'Draft';
    const amountInWords = numberToIndianWords(totalAmountDec.toNumber());

    const buffer = await generateTaxInvoicePdf({
      invoiceNumber: billNumber,
      invoiceDate: input.billDate || new Date().toISOString().slice(0, 10),
      state: input.state || 'Bihar',
      stateCode: input.stateCode || '10',
      transportationMode: input.transportationMode || null,
      vehicleNumber: input.vehicleNumber || null,
      dateOfSupply: input.dateOfSupply || null,
      placeOfSupply: input.placeOfSupply || null,
      customer: {
        name: input.customerName || 'Valued Customer',
        address: input.customerAddress || null,
        phone: input.customerPhone || null,
        state: input.customerState || 'Bihar',
        stateCode: input.customerStateCode || '10',
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
        subtotal: subtotalDec.toFixed(2),
        discountType,
        discountValue: discountValDec.toFixed(2),
        discountAmount: discountAmountDec.toFixed(2),
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
    const totalCount = countRes.rows[0]?.total || 0;

    // 2. Data rows query
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
        b.subtotal_amount,
        b.discount_type,
        b.discount_value,
        b.discount_amount,
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
        b.subtotal_amount,
        b.discount_type,
        b.discount_value,
        b.discount_amount,
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
        subtotal: bill.subtotal_amount || bill.total_amount,
        discountType: bill.discount_type,
        discountValue: bill.discount_value,
        discountAmount: bill.discount_amount,
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
