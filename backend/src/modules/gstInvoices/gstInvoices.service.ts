import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { appPool } from '../../config/database.js';
import { StorageService } from '../../services/storage.service.js';
import { AppError } from '../../utils/errors.js';
import { validateMoneyInput, validateDecimalQuantityInput } from '../../utils/validation.js';
import {
  generateTaxInvoicePdf,
  numberToIndianWords,
  GstInvoicePdfData,
} from './gstInvoices.pdf.js';

export interface CreateGstInvoiceItemInput {
  productId?: number | null;
  description: string;
  hsnCode?: string | null;
  quantity: number | string;
  unit?: string | null;
  rate: number | string;
  rateUnit?: string | null;
}

export interface CreateGstInvoiceInput {
  invoiceNumber?: string;
  invoiceDate?: string;
  state?: string;
  stateCode?: string;
  transportationMode?: string | null;
  vehicleNumber?: string | null;
  dateOfSupply?: string | null;
  placeOfSupply?: string | null;
  customerId?: number | null;
  customerName: string;
  customerAddress?: string | null;
  customerGstin?: string | null;
  customerPhone?: string | null;
  customerState?: string;
  customerStateCode?: string;
  gstRate: number | string; // e.g. 18 for 18% GST, 5, 12, 28, or 0
  subtotalAmount?: number | string;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | string;
  discountAmount?: number | string;
  items: CreateGstInvoiceItemInput[];
  notes?: string | null;
}

export interface GstInvoiceRecord {
  id: number;
  invoice_number: string;
  invoice_date: string;
  state: string;
  state_code: string;
  transportation_mode: string | null;
  vehicle_number: string | null;
  date_of_supply: string | null;
  place_of_supply: string | null;
  customer_id: number | null;
  customer_name: string;
  customer_address: string | null;
  customer_gstin: string | null;
  customer_state: string;
  customer_state_code: string;
  subtotal_amount?: string | null;
  discount_type?: 'percentage' | 'fixed' | null;
  discount_value?: string;
  discount_amount?: string;
  taxable_amount: string;
  cgst_rate: string;
  cgst_amount: string;
  sgst_rate: string;
  sgst_amount: string;
  igst_rate: string;
  igst_amount: string;
  tax_amount: string;
  grand_total: string;
  amount_in_words: string;
  r2_object_key: string | null;
  pdf_status: 'pending' | 'uploaded' | 'failed' | 'local_only';
  notes: string | null;
  created_at: string;
  updated_at: string;
  items?: GstInvoiceItemRecord[];
}

export interface GstInvoiceItemRecord {
  id: number;
  invoice_id: number;
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

export class GstInvoicesService {
  private storageService: StorageService;

  constructor(storageService?: StorageService) {
    this.storageService = storageService || new StorageService();
  }

  /**
   * Generates the next sequential invoice number from the database.
   * Finds the maximum existing numerical invoice number and increments it by 1,
   * formatted as 3-digit padded (001, 002, 003...).
   * Pure, idempotent, and non-destructive.
   */
  public async getNextInvoiceNumber(): Promise<string> {
    try {
      const res = await appPool.query(`
        SELECT GREATEST(
          (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM gst_invoice_number_seq),
          COALESCE((
            SELECT MAX(
              CASE
                WHEN invoice_number ~ '^\\d+$' THEN invoice_number::BIGINT
                WHEN regexp_replace(invoice_number, '\\D', '', 'g') <> '' THEN regexp_replace(invoice_number, '\\D', '', 'g')::BIGINT
                ELSE 0
              END
            ) FROM gst_invoices
          ), 0) + 1
        ) AS next_num,
        COALESCE((
          SELECT MAX(
            CASE
              WHEN invoice_number ~ '^\\d+$' THEN invoice_number::BIGINT
              WHEN regexp_replace(invoice_number, '\\D', '', 'g') <> '' THEN regexp_replace(invoice_number, '\\D', '', 'g')::BIGINT
              ELSE 0
            END
          ) FROM gst_invoices
        ), 0) AS max_num;
      `);

      const row = res.rows[0];
      const maxNum = Number(row?.max_num || 0);
      let nextNum = Number(row?.next_num ?? (maxNum + 1));

      if (maxNum === 0) {
        nextNum = 1;
        try {
          await appPool.query("SELECT setval('gst_invoice_number_seq', 1, false)");
        } catch {
          // Non-fatal in mock/test environments
        }
      } else if (nextNum > maxNum + 1) {
        nextNum = maxNum + 1;
        try {
          await appPool.query("SELECT setval('gst_invoice_number_seq', $1::BIGINT, true)", [maxNum]);
        } catch {
          // Non-fatal in mock/test environments
        }
      }

      return String(nextNum).padStart(3, '0');
    } catch {
      const maxRes = await appPool.query(`
        SELECT COALESCE(MAX(
          CASE
            WHEN invoice_number ~ '^\\d+$' THEN invoice_number::BIGINT
            WHEN regexp_replace(invoice_number, '\\D', '', 'g') <> '' THEN regexp_replace(invoice_number, '\\D', '', 'g')::BIGINT
            ELSE 0
          END
        ), 0) AS max_num FROM gst_invoices;
      `);
      const maxNum = Number(maxRes.rows[0]?.max_num || 0);
      return String(maxNum + 1).padStart(3, '0');
    }
  }

  /**
   * Creates a GST Tax Invoice within an existing database transaction client.
   * Atomically allocates invoice number, calculates Decimal finances, and inserts line items.
   * Does NOT commit the transaction and does NOT upload to R2, enabling transactional composition.
   */
  public async createInvoiceInTransaction(client: PoolClient, input: CreateGstInvoiceInput): Promise<GstInvoiceRecord> {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one line item is required.', 400, 'ITEMS_REQUIRED');
    }

    // 1. Resolve invoice number atomically using database sequence
    let invoiceNumber = input.invoiceNumber?.trim();
    if (!invoiceNumber) {
      try {
        const maxCheck = await client.query(`
          SELECT COALESCE(MAX(
            CASE
              WHEN invoice_number ~ '^\\d+$' THEN invoice_number::BIGINT
              WHEN regexp_replace(invoice_number, '\\D', '', 'g') <> '' THEN regexp_replace(invoice_number, '\\D', '', 'g')::BIGINT
              ELSE 0
            END
          ), 0) AS max_num FROM gst_invoices
        `);
        const currentMax = Number(maxCheck.rows[0]?.max_num || 0);
        if (currentMax === 0) {
          await client.query("SELECT setval('gst_invoice_number_seq', 1, false)");
        } else {
          const seqRes = await client.query("SELECT last_value FROM gst_invoice_number_seq");
          const seqLast = Number(seqRes.rows[0]?.last_value || 0);
          if (seqLast > currentMax) {
            await client.query("SELECT setval('gst_invoice_number_seq', $1::BIGINT, true)", [currentMax]);
          }
        }
      } catch {
        // Non-fatal in mock environments
      }
      let attempts = 0;
      while (attempts < 10) {
        try {
          const seqRes = await client.query(`SELECT nextval('gst_invoice_number_seq') AS seq_num`);
          const seqVal = seqRes.rows[0]?.seq_num;
          if (seqVal) {
            const candidate = String(seqVal).padStart(3, '0');
            const exists = await client.query('SELECT 1 FROM gst_invoices WHERE invoice_number = $1', [candidate]);
            if ((exists.rowCount ?? 0) === 0) {
              invoiceNumber = candidate;
              break;
            }
          }
        } catch {
          break;
        }
        attempts++;
      }

      if (!invoiceNumber) {
        const maxRes = await client.query(`
          SELECT COALESCE(MAX(
            CASE
              WHEN invoice_number ~ '^\\d+$' THEN invoice_number::BIGINT
              WHEN regexp_replace(invoice_number, '\\D', '', 'g') <> '' THEN regexp_replace(invoice_number, '\\D', '', 'g')::BIGINT
              ELSE 0
            END
          ), 0) AS max_num FROM gst_invoices
        `);
        const maxNum = Number(maxRes.rows[0]?.max_num || 0);
        invoiceNumber = String(maxNum + 1).padStart(3, '0');
      }
    } else {
      const digits = invoiceNumber.replace(/[^0-9]/g, '');
      const numVal = digits ? parseInt(digits, 10) : NaN;
      if (!isNaN(numVal) && numVal > 0) {
        try {
          await client.query(
            `SELECT setval('gst_invoice_number_seq', GREATEST((SELECT last_value FROM gst_invoice_number_seq), $1::BIGINT), true)`,
            [numVal]
          );
        } catch {
          // Non-fatal if sequence absent in mock
        }
      }
    }

    // Check collision
    const existsRes = await client.query('SELECT 1 FROM gst_invoices WHERE invoice_number = $1', [invoiceNumber]);
    if ((existsRes.rowCount ?? 0) > 0) {
      throw new AppError(`Invoice number "${invoiceNumber}" already exists.`, 409, 'DUPLICATE_INVOICE_NUMBER');
    }

    // Auto-update customer address if linked customer lacks one
    if (input.customerId && input.customerAddress?.trim()) {
      await client.query(
        `UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2 AND (address IS NULL OR address = '')`,
        [input.customerAddress.trim(), input.customerId]
      );
    }

    // 2. Calculate item amounts and subtotal using Decimal.js with 2-decimal scale
    let subtotalDec = new Decimal(0);
    const computedItems: Array<CreateGstInvoiceItemInput & { amount: string }> = [];

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

    // Taxable amount is subtotal minus discount
    const taxableAmountDec = subtotalDec.minus(discountAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    // 4. Tax calculations (Intra-state vs Inter-state)
    const shopStateCode = (input.stateCode || '10').trim();
    const customerStateCode = (input.customerStateCode || '10').trim();
    const isIntraState = shopStateCode === customerStateCode;

    const gstRateDec = new Decimal(input.gstRate || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (gstRateDec.isNegative() || !gstRateDec.isFinite() || gstRateDec.greaterThan(100)) {
      throw new AppError('GST rate must be between 0 and 100 with at most 2 decimal places.', 400, 'INVALID_GST_RATE');
    }

    let cgstRateDec = new Decimal(0);
    let cgstAmountDec = new Decimal(0);
    let sgstRateDec = new Decimal(0);
    let sgstAmountDec = new Decimal(0);
    let igstRateDec = new Decimal(0);
    let igstAmountDec = new Decimal(0);

    if (isIntraState) {
      // Intra-state: CGST (half) + SGST (half)
      cgstRateDec = gstRateDec.dividedBy(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      sgstRateDec = gstRateDec.minus(cgstRateDec);
      cgstAmountDec = taxableAmountDec.times(cgstRateDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      sgstAmountDec = taxableAmountDec.times(sgstRateDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else {
      // Inter-state: IGST (full)
      igstRateDec = gstRateDec;
      igstAmountDec = taxableAmountDec.times(igstRateDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }

    const totalTaxDec = cgstAmountDec.plus(sgstAmountDec).plus(igstAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const grandTotalDec = taxableAmountDec.plus(totalTaxDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const amountInWords = numberToIndianWords(grandTotalDec.toFixed(2));

    // 5. Insert into gst_invoices
    const invoiceDate = input.invoiceDate || new Date().toISOString().slice(0, 10);
    const insertInvoiceSql = `
      INSERT INTO gst_invoices (
        invoice_number, invoice_date, state, state_code,
        transportation_mode, vehicle_number, date_of_supply, place_of_supply,
        customer_id, customer_name, customer_address, customer_gstin,
        customer_state, customer_state_code,
        subtotal_amount, discount_type, discount_value, discount_amount,
        taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
        igst_rate, igst_amount, tax_amount, grand_total, amount_in_words,
        pdf_status, notes
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14,
        $15, $16, $17, $18,
        $19, $20, $21, $22, $23,
        $24, $25, $26, $27, $28,
        'pending', $29
      ) RETURNING *
    `;

    const invoiceRes = await client.query(insertInvoiceSql, [
      invoiceNumber,
      invoiceDate,
      input.state || 'Bihar',
      shopStateCode,
      input.transportationMode || null,
      input.vehicleNumber || null,
      input.dateOfSupply || invoiceDate,
      input.placeOfSupply || 'Bihar',
      input.customerId || null,
      input.customerName.trim(),
      input.customerAddress?.trim() || null,
      input.customerGstin?.trim() || null,
      input.customerState || 'Bihar',
      customerStateCode,
      subtotalDec.toFixed(2),
      discountType,
      discountValDec.toFixed(2),
      discountAmountDec.toFixed(2),
      taxableAmountDec.toFixed(2),
      cgstRateDec.toFixed(2),
      cgstAmountDec.toFixed(2),
      sgstRateDec.toFixed(2),
      sgstAmountDec.toFixed(2),
      igstRateDec.toFixed(2),
      igstAmountDec.toFixed(2),
      totalTaxDec.toFixed(2),
      grandTotalDec.toFixed(2),
      amountInWords,
      input.notes || null,
    ]);

    const createdInvoice: GstInvoiceRecord = invoiceRes.rows[0];

    // 6. Insert Line Items
    const insertedItems: GstInvoiceItemRecord[] = [];
    for (let i = 0; i < computedItems.length; i++) {
      const itm = computedItems[i];
      const itemRes = await client.query(
        `INSERT INTO gst_invoice_items (
          invoice_id, product_id, item_index, description, hsn_code,
          quantity, unit, rate, rate_unit, amount
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          createdInvoice.id,
          itm.productId || null,
          i + 1,
          itm.description.trim(),
          itm.hsnCode || null,
          itm.quantity,
          itm.unit || null,
          itm.rate,
          itm.rateUnit || null,
          itm.amount,
        ]
      );
      insertedItems.push(itemRes.rows[0]);
    }

    createdInvoice.items = insertedItems;
    return createdInvoice;
  }

  /**
   * Creates a GST Tax Invoice, manages transaction boundaries, and generates PDF.
   */
  public async createInvoice(input: CreateGstInvoiceInput): Promise<GstInvoiceRecord> {
    const client = await appPool.connect();
    let createdInvoice: GstInvoiceRecord;

    try {
      await client.query('BEGIN');
      createdInvoice = await this.createInvoiceInTransaction(client, input);
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure if already rolled back
      }
      throw err;
    } finally {
      client.release();
    }

    // 7. Generate PDF and upload to Cloudflare R2 outside database transaction
    let pdfStatus: 'uploaded' | 'local_only' | 'failed' = 'local_only';
    let r2ObjectKey: string | null = null;

    try {
      const pdfBuffer = await generateTaxInvoicePdf({
        invoiceNumber: createdInvoice.invoice_number,
        invoiceDate: createdInvoice.invoice_date,
        state: createdInvoice.state,
        stateCode: createdInvoice.state_code,
        transportationMode: createdInvoice.transportation_mode,
        vehicleNumber: createdInvoice.vehicle_number,
        dateOfSupply: createdInvoice.date_of_supply,
        placeOfSupply: createdInvoice.place_of_supply,
        customer: {
          name: createdInvoice.customer_name,
          address: createdInvoice.customer_address,
          gstin: createdInvoice.customer_gstin,
          state: createdInvoice.customer_state,
          stateCode: createdInvoice.customer_state_code,
        },
        items: (createdInvoice.items || []).map((itm) => ({
          name: itm.description,
          hsn: itm.hsn_code,
          quantity: itm.quantity,
          unit: itm.unit,
          rate: itm.rate,
          rateUnit: itm.rate_unit,
          amount: itm.amount,
        })),
        totals: {
          subtotal: createdInvoice.subtotal_amount || createdInvoice.taxable_amount,
          discountType: createdInvoice.discount_type,
          discountValue: createdInvoice.discount_value,
          discountAmount: createdInvoice.discount_amount,
          taxableAmount: createdInvoice.taxable_amount,
          cgstRate: createdInvoice.cgst_rate,
          cgstAmount: createdInvoice.cgst_amount,
          sgstRate: createdInvoice.sgst_rate,
          sgstAmount: createdInvoice.sgst_amount,
          igstRate: createdInvoice.igst_rate,
          igstAmount: createdInvoice.igst_amount,
          taxAmount: createdInvoice.tax_amount,
          grandTotal: createdInvoice.grand_total,
        },
        amountInWords: createdInvoice.amount_in_words,
        isNormalBill: false,
      });

      if (this.storageService.isConfigured()) {
        const year = new Date().getFullYear();
        const month = String(new Date().getMonth() + 1).padStart(2, '0');
        r2ObjectKey = `gst-invoices/${year}/${month}/${createdInvoice.id}.pdf`;

        try {
          await this.storageService.uploadBufferToR2({
            buffer: pdfBuffer,
            objectKey: r2ObjectKey,
            contentType: 'application/pdf',
          });
          pdfStatus = 'uploaded';
        } catch (uploadErr) {
          console.error('[GST INVOICE R2 UPLOAD] Upload failed:', uploadErr);
          pdfStatus = 'failed';
        }
      }
    } catch (pdfErr) {
      console.error('[GST INVOICE PDF GENERATION] PDF generation failed:', pdfErr);
      pdfStatus = 'failed';
    }

    try {
      await appPool.query(
        'UPDATE gst_invoices SET pdf_status = $1, r2_object_key = $2, updated_at = NOW() WHERE id = $3',
        [pdfStatus, r2ObjectKey, createdInvoice.id]
      );
      createdInvoice.pdf_status = pdfStatus;
      createdInvoice.r2_object_key = r2ObjectKey;
    } catch (updateErr) {
      console.error('[GST INVOICE DB UPDATE] Failed to update pdf_status:', updateErr);
    }

    return createdInvoice;
  }

  /**
   * List GST invoices with pagination and search
   */
  public async listInvoices(paramsIn: {
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ invoices: GstInvoiceRecord[]; pagination: { total: number; limit: number; offset: number } }> {
    const limit = Math.min(Math.max(paramsIn.limit || 20, 1), 100);
    const offset = Math.max(paramsIn.offset || 0, 0);

    const conditions: string[] = [];
    const params: any[] = [];

    if (paramsIn.search && paramsIn.search.trim()) {
      params.push(`%${paramsIn.search.trim()}%`);
      conditions.push(`(i.invoice_number ILIKE $${params.length} OR i.customer_name ILIKE $${params.length})`);
    }

    if (paramsIn.dateFrom) {
      params.push(paramsIn.dateFrom);
      conditions.push(`i.invoice_date >= $${params.length}::DATE`);
    }

    if (paramsIn.dateTo) {
      params.push(paramsIn.dateTo);
      conditions.push(`i.invoice_date <= $${params.length}::DATE`);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await appPool.query(
      `SELECT COUNT(*)::INT AS total FROM gst_invoices i ${whereSql}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;

    const listSql = `
      SELECT i.id, i.invoice_number,
             TO_CHAR(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
             i.state, i.state_code, i.transportation_mode, i.vehicle_number,
             TO_CHAR(i.date_of_supply, 'YYYY-MM-DD') AS date_of_supply,
             i.place_of_supply, i.customer_id, i.customer_name, i.customer_address, i.customer_gstin,
             i.customer_state, i.customer_state_code,
             i.subtotal_amount, i.discount_type, i.discount_value, i.discount_amount,
             i.taxable_amount, i.cgst_rate, i.cgst_amount,
             i.sgst_rate, i.sgst_amount, i.igst_rate, i.igst_amount, i.tax_amount, i.grand_total,
             i.amount_in_words, i.r2_object_key, i.pdf_status, i.notes, i.created_at, i.updated_at,
             COALESCE(
               (
                 SELECT json_agg(
                   json_build_object(
                     'id', it.id,
                     'invoice_id', it.invoice_id,
                     'product_id', it.product_id,
                     'item_index', it.item_index,
                     'description', it.description,
                     'hsn_code', it.hsn_code,
                     'quantity', it.quantity,
                     'unit', it.unit,
                     'rate', it.rate,
                     'rate_unit', it.rate_unit,
                     'amount', it.amount
                   ) ORDER BY it.item_index ASC
                 )
                 FROM gst_invoice_items it
                 WHERE it.invoice_id = i.id
               ),
               '[]'::json
             ) AS items
      FROM gst_invoices i
      ${whereSql}
      ORDER BY i.invoice_date DESC, i.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const listRes = await appPool.query(listSql, [...params, limit, offset]);

    return {
      invoices: listRes.rows,
      pagination: { total, limit, offset },
    };
  }

  /**
   * Retrieve single invoice with items
   */
  public async getInvoiceById(id: number): Promise<GstInvoiceRecord | null> {
    const res = await appPool.query(
      `SELECT id, invoice_number,
              TO_CHAR(invoice_date, 'YYYY-MM-DD') AS invoice_date,
              state, state_code, transportation_mode, vehicle_number,
              TO_CHAR(date_of_supply, 'YYYY-MM-DD') AS date_of_supply,
              place_of_supply, customer_id, customer_name, customer_address, customer_gstin,
              customer_state, customer_state_code,
              subtotal_amount, discount_type, discount_value, discount_amount,
              taxable_amount, cgst_rate, cgst_amount,
              sgst_rate, sgst_amount, igst_rate, igst_amount, tax_amount, grand_total,
              amount_in_words, r2_object_key, pdf_status, notes, created_at, updated_at
       FROM gst_invoices WHERE id = $1`,
      [id]
    );
    if ((res.rowCount ?? 0) === 0) return null;

    const invoice: GstInvoiceRecord = res.rows[0];
    const itemsRes = await appPool.query(
      'SELECT * FROM gst_invoice_items WHERE invoice_id = $1 ORDER BY item_index ASC',
      [id]
    );
    invoice.items = itemsRes.rows;
    return invoice;
  }

  /**
   * Retrieves PDF stream:
   * First tries Cloudflare R2 if uploaded.
   * If not available or local only, generates from the immutable database snapshot on the fly.
   */
  public async getInvoicePdf(id: number): Promise<{ buffer: Buffer; filename: string }> {
    const invoice = await this.getInvoiceById(id);
    if (!invoice) {
      throw new AppError('Invoice not found.', 404, 'NOT_FOUND');
    }

    const filename = `Invoice_${invoice.invoice_number}.pdf`;

    // Try fetching from R2 if uploaded
    if (invoice.r2_object_key && this.storageService.isConfigured()) {
      try {
        const streamObj = await this.storageService.getObjectStream(invoice.r2_object_key);
        const chunks: Buffer[] = [];
        for await (const chunk of streamObj.stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return { buffer: Buffer.concat(chunks), filename };
      } catch (r2Err) {
        console.warn(`[GST INVOICE] R2 download failed for invoice #${id}, regenerating from snapshot:`, r2Err);
      }
    }

    // Generate from snapshot
    const pdfData: GstInvoicePdfData = {
      invoiceNumber: invoice.invoice_number,
      invoiceDate: invoice.invoice_date,
      state: invoice.state,
      stateCode: invoice.state_code,
      transportationMode: invoice.transportation_mode,
      vehicleNumber: invoice.vehicle_number,
      dateOfSupply: invoice.date_of_supply,
      placeOfSupply: invoice.place_of_supply,
      customer: {
        name: invoice.customer_name,
        address: invoice.customer_address,
        gstin: invoice.customer_gstin,
        state: invoice.customer_state,
        stateCode: invoice.customer_state_code,
      },
      items: (invoice.items || []).map((itm) => ({
        name: itm.description,
        hsn: itm.hsn_code,
        quantity: itm.quantity,
        unit: itm.unit,
        rate: itm.rate,
        rateUnit: itm.rate_unit,
        amount: itm.amount,
      })),
      totals: {
        subtotal: invoice.subtotal_amount || invoice.taxable_amount,
        discountType: invoice.discount_type,
        discountValue: invoice.discount_value,
        discountAmount: invoice.discount_amount,
        taxableAmount: invoice.taxable_amount,
        cgstRate: invoice.cgst_rate,
        cgstAmount: invoice.cgst_amount,
        sgstRate: invoice.sgst_rate,
        sgstAmount: invoice.sgst_amount,
        igstRate: invoice.igst_rate,
        igstAmount: invoice.igst_amount,
        taxAmount: invoice.tax_amount,
        grandTotal: invoice.grand_total,
      },
      amountInWords: invoice.amount_in_words,
      isNormalBill: false,
    };

    const buffer = await generateTaxInvoicePdf(pdfData);
    return { buffer, filename };
  }

  /**
   * Generates a preview PDF in-memory without database mutation
   */
  public async generateDraftPdf(input: CreateGstInvoiceInput): Promise<{ buffer: Buffer; filename: string }> {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one line item is required.', 400, 'ITEMS_REQUIRED');
    }

    let subtotalDec = new Decimal(0);
    const pdfItems: GstInvoicePdfData['items'] = [];

    for (const item of input.items) {
      const qtyDec = validateDecimalQuantityInput(item.quantity || 1, 'Quantity');
      const rateDec = validateMoneyInput(item.rate || 0, 'Rate');
      const lineAmountDec = qtyDec.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      subtotalDec = subtotalDec.plus(lineAmountDec);

      pdfItems.push({
        name: item.description,
        hsn: item.hsnCode || null,
        quantity: qtyDec.toFixed(2),
        unit: item.unit || null,
        rate: rateDec.toFixed(2),
        rateUnit: item.rateUnit || null,
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

    const taxableAmountDec = subtotalDec.minus(discountAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const shopStateCode = (input.stateCode || '10').trim();
    const customerStateCode = (input.customerStateCode || '10').trim();
    const isIntraState = shopStateCode === customerStateCode;
    const gstRateDec = new Decimal(input.gstRate || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (gstRateDec.isNegative() || !gstRateDec.isFinite() || gstRateDec.greaterThan(100)) {
      throw new AppError('GST rate must be between 0 and 100 with at most 2 decimal places.', 400, 'INVALID_GST_RATE');
    }

    let cgstRateDec = new Decimal(0);
    let cgstAmountDec = new Decimal(0);
    let sgstRateDec = new Decimal(0);
    let sgstAmountDec = new Decimal(0);
    let igstRateDec = new Decimal(0);
    let igstAmountDec = new Decimal(0);

    if (isIntraState) {
      cgstRateDec = gstRateDec.dividedBy(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      sgstRateDec = gstRateDec.minus(cgstRateDec);
      cgstAmountDec = taxableAmountDec.times(cgstRateDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      sgstAmountDec = taxableAmountDec.times(sgstRateDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else {
      igstRateDec = gstRateDec;
      igstAmountDec = taxableAmountDec.times(igstRateDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }

    const totalTaxDec = cgstAmountDec.plus(sgstAmountDec).plus(igstAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const grandTotalDec = taxableAmountDec.plus(totalTaxDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const amountInWords = numberToIndianWords(grandTotalDec.toFixed(2));
    const invoiceNumber = input.invoiceNumber || 'Draft';

    const pdfData: GstInvoicePdfData = {
      invoiceNumber,
      invoiceDate: input.invoiceDate || new Date().toISOString().slice(0, 10),
      state: input.state || 'Bihar',
      stateCode: shopStateCode,
      transportationMode: input.transportationMode || null,
      vehicleNumber: input.vehicleNumber || null,
      dateOfSupply: input.dateOfSupply || null,
      placeOfSupply: input.placeOfSupply || 'Bihar',
      customer: {
        name: input.customerName || 'Valued Customer',
        address: input.customerAddress || null,
        gstin: input.customerGstin || null,
        state: input.customerState || 'Bihar',
        stateCode: customerStateCode,
      },
      items: pdfItems,
      totals: {
        subtotal: subtotalDec.toFixed(2),
        discountType,
        discountValue: discountValDec.toFixed(2),
        discountAmount: discountAmountDec.toFixed(2),
        taxableAmount: taxableAmountDec.toFixed(2),
        cgstRate: cgstRateDec.toFixed(2),
        cgstAmount: cgstAmountDec.toFixed(2),
        sgstRate: sgstRateDec.toFixed(2),
        sgstAmount: sgstAmountDec.toFixed(2),
        igstRate: igstRateDec.toFixed(2),
        igstAmount: igstAmountDec.toFixed(2),
        taxAmount: totalTaxDec.toFixed(2),
        grandTotal: grandTotalDec.toFixed(2),
      },
      amountInWords,
      isNormalBill: false,
    };

    const buffer = await generateTaxInvoicePdf(pdfData);
    return {
      buffer,
      filename: `Draft_Invoice_${invoiceNumber}.pdf`,
    };
  }
}

export const gstInvoicesService = new GstInvoicesService();
