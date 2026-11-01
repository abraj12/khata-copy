import Decimal from 'decimal.js';
import { appPool } from '../../config/database.js';
import { StorageService } from '../../services/storage.service.js';
import { AppError } from '../../utils/errors.js';
import {
  generateMannatInvoicePdf,
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
  customerState?: string;
  customerStateCode?: string;
  gstRate: number | string; // e.g. 18 for 18% GST, 5, 12, 28, or 0
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
   * Generates next collision-free invoice number using sequence
   */
  public async getNextInvoiceNumber(): Promise<string> {
    const res = await appPool.query("SELECT nextval('gst_invoice_number_seq') AS next_val");
    const num = Number(res.rows[0]?.next_val || 1);
    const candidate = String(num).padStart(3, '0');

    // Check if candidate already exists in database
    const checkRes = await appPool.query(
      'SELECT id FROM gst_invoices WHERE invoice_number = $1',
      [candidate]
    );

    if ((checkRes.rowCount ?? 0) === 0) {
      return candidate;
    }

    // If candidate exists, find maximum existing numeric invoice number + 1
    const maxRes = await appPool.query(
      "SELECT MAX(NULLIF(regexp_replace(invoice_number, '\\D', '', 'g'), '')::INT) as max_num FROM gst_invoices"
    );
    const nextMax = (Number(maxRes.rows[0]?.max_num) || num) + 1;
    return String(nextMax).padStart(3, '0');
  }

  /**
   * Creates a GST Invoice with financial safety, tax calculation, and PDF storage
   */
  public async createInvoice(input: CreateGstInvoiceInput): Promise<GstInvoiceRecord> {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one line item is required.', 400, 'ITEMS_REQUIRED');
    }

    const client = await appPool.connect();

    try {
      await client.query('BEGIN');

      // 1. Resolve invoice number
      let invoiceNumber = input.invoiceNumber?.trim();
      if (!invoiceNumber) {
        const nextValRes = await client.query("SELECT nextval('gst_invoice_number_seq') AS next_val");
        const num = Number(nextValRes.rows[0]?.next_val || 1);
        invoiceNumber = String(num).padStart(3, '0');

        // Check collision
        const existsRes = await client.query('SELECT 1 FROM gst_invoices WHERE invoice_number = $1', [invoiceNumber]);
        if ((existsRes.rowCount ?? 0) > 0) {
          const maxRes = await client.query(
            "SELECT MAX(NULLIF(regexp_replace(invoice_number, '\\D', '', 'g'), '')::INT) as max_num FROM gst_invoices"
          );
          const nextMax = (Number(maxRes.rows[0]?.max_num) || num) + 1;
          invoiceNumber = String(nextMax).padStart(3, '0');
        }
      } else {
        // Verify uniqueness
        const existsRes = await client.query('SELECT 1 FROM gst_invoices WHERE invoice_number = $1', [invoiceNumber]);
        if ((existsRes.rowCount ?? 0) > 0) {
          throw new AppError(`Invoice number "${invoiceNumber}" already exists.`, 409, 'DUPLICATE_INVOICE_NUMBER');
        }
      }

      // 2. Calculate item amounts and total taxable value using Decimal.js
      let taxableAmountDec = new Decimal(0);
      const computedItems: Array<CreateGstInvoiceItemInput & { amount: string }> = [];

      for (const item of input.items) {
        const qtyDec = new Decimal(item.quantity);
        if (qtyDec.isNegative() || qtyDec.isZero() || !qtyDec.isFinite()) {
          throw new AppError('Item quantity must be a positive number.', 400, 'INVALID_QUANTITY');
        }
        const rateDec = new Decimal(item.rate);
        if (rateDec.isNegative() || !rateDec.isFinite()) {
          throw new AppError('Item rate cannot be negative.', 400, 'INVALID_RATE');
        }

        const lineAmountDec = qtyDec.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        taxableAmountDec = taxableAmountDec.plus(lineAmountDec);

        computedItems.push({
          ...item,
          quantity: qtyDec.toFixed(3),
          rate: rateDec.toFixed(2),
          amount: lineAmountDec.toFixed(2),
        });
      }

      // 3. Tax calculations (Intra-state vs Inter-state)
      const shopStateCode = (input.stateCode || '09').trim();
      const customerStateCode = (input.customerStateCode || '09').trim();
      const isIntraState = shopStateCode === customerStateCode;

      const gstRateDec = new Decimal(input.gstRate || 0);
      if (gstRateDec.isNegative() || !gstRateDec.isFinite()) {
        throw new AppError('GST rate cannot be negative.', 400, 'INVALID_GST_RATE');
      }

      let cgstRateDec = new Decimal(0);
      let cgstAmountDec = new Decimal(0);
      let sgstRateDec = new Decimal(0);
      let sgstAmountDec = new Decimal(0);
      let igstRateDec = new Decimal(0);
      let igstAmountDec = new Decimal(0);

      if (isIntraState) {
        // Intra-state: CGST (half) + SGST (half)
        cgstRateDec = gstRateDec.dividedBy(2);
        sgstRateDec = gstRateDec.dividedBy(2);
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

      // 4. Insert into gst_invoices
      const invoiceDate = input.invoiceDate || new Date().toISOString().slice(0, 10);
      const insertInvoiceSql = `
        INSERT INTO gst_invoices (
          invoice_number, invoice_date, state, state_code,
          transportation_mode, vehicle_number, date_of_supply, place_of_supply,
          customer_id, customer_name, customer_address, customer_gstin,
          customer_state, customer_state_code,
          taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
          igst_rate, igst_amount, tax_amount, grand_total, amount_in_words,
          pdf_status, notes
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14,
          $15, $16, $17, $18, $19,
          $20, $21, $22, $23, $24,
          'pending', $25
        ) RETURNING *
      `;

      const invoiceRes = await client.query(insertInvoiceSql, [
        invoiceNumber,
        invoiceDate,
        input.state || 'Uttar Pradesh',
        shopStateCode,
        input.transportationMode || null,
        input.vehicleNumber || null,
        input.dateOfSupply || invoiceDate,
        input.placeOfSupply || 'Uttar Pradesh',
        input.customerId || null,
        input.customerName.trim(),
        input.customerAddress?.trim() || null,
        input.customerGstin?.trim() || null,
        input.customerState || 'Uttar Pradesh',
        customerStateCode,
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

      // 5. Insert Line Items
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
            itm.hsnCode?.trim() || null,
            itm.quantity,
            itm.unit || null,
            itm.rate,
            itm.rateUnit || null,
            itm.amount,
          ]
        );
        insertedItems.push(itemRes.rows[0]);
      }

      // 6. Generate PDF Buffer and store in Cloudflare R2
      const pdfData: GstInvoicePdfData = {
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
        items: insertedItems.map((itm) => ({
          name: itm.description,
          hsn: itm.hsn_code,
          quantity: itm.quantity,
          unit: itm.unit,
          rate: itm.rate,
          rateUnit: itm.rate_unit,
          amount: itm.amount,
        })),
        totals: {
          taxableAmount: createdInvoice.taxable_amount,
          cgstRate: Number(createdInvoice.cgst_rate) > 0 ? createdInvoice.cgst_rate : undefined,
          cgstAmount: createdInvoice.cgst_amount,
          sgstRate: Number(createdInvoice.sgst_rate) > 0 ? createdInvoice.sgst_rate : undefined,
          sgstAmount: createdInvoice.sgst_amount,
          igstRate: Number(createdInvoice.igst_rate) > 0 ? createdInvoice.igst_rate : undefined,
          igstAmount: createdInvoice.igst_amount,
          taxAmount: createdInvoice.tax_amount,
          grandTotal: createdInvoice.grand_total,
        },
        amountInWords: createdInvoice.amount_in_words,
      };

      const pdfBuffer = await generateMannatInvoicePdf(pdfData);

      // Upload to R2 if configured
      let r2Key: string | null = null;
      let pdfStatus: GstInvoiceRecord['pdf_status'] = 'local_only';

      if (this.storageService.isConfigured()) {
        const year = new Date().getFullYear();
        const month = String(new Date().getMonth() + 1).padStart(2, '0');
        r2Key = `invoices/${year}/${month}/${createdInvoice.id}.pdf`;

        try {
          await this.storageService.uploadBufferToR2({
            buffer: pdfBuffer,
            objectKey: r2Key,
            contentType: 'application/pdf',
          });
          pdfStatus = 'uploaded';
        } catch (uploadErr) {
          console.error('[GST INVOICE] R2 PDF Upload failed:', uploadErr);
          pdfStatus = 'failed';
        }
      }

      await client.query(
        'UPDATE gst_invoices SET r2_object_key = $1, pdf_status = $2, updated_at = NOW() WHERE id = $3',
        [r2Key, pdfStatus, createdInvoice.id]
      );

      await client.query('COMMIT');

      createdInvoice.r2_object_key = r2Key;
      createdInvoice.pdf_status = pdfStatus;
      createdInvoice.items = insertedItems;

      return createdInvoice;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * List invoices with pagination, date filtering, and customer search
   */
  public async listInvoices(opts: {
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ invoices: GstInvoiceRecord[]; pagination: { total: number; limit: number; offset: number } }> {
    const limit = Math.max(1, Math.min(100, opts.limit || 25));
    const offset = Math.max(0, opts.offset || 0);

    let whereSql = 'WHERE 1=1';
    const params: any[] = [];

    if (opts.search && opts.search.trim()) {
      params.push(`%${opts.search.trim()}%`);
      whereSql += ` AND (invoice_number ILIKE $${params.length} OR customer_name ILIKE $${params.length})`;
    }

    if (opts.dateFrom) {
      params.push(opts.dateFrom);
      whereSql += ` AND invoice_date >= $${params.length}`;
    }

    if (opts.dateTo) {
      params.push(opts.dateTo);
      whereSql += ` AND invoice_date <= $${params.length}`;
    }

    const countRes = await appPool.query(
      `SELECT COUNT(*)::INT AS total FROM gst_invoices ${whereSql}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;

    const listSql = `
      SELECT id, invoice_number, invoice_date, state, state_code,
             transportation_mode, vehicle_number, date_of_supply, place_of_supply,
             customer_id, customer_name, customer_address, customer_gstin,
             customer_state, customer_state_code,
             taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
             igst_rate, igst_amount, tax_amount, grand_total, amount_in_words,
             r2_object_key, pdf_status, notes, created_at, updated_at
      FROM gst_invoices
      ${whereSql}
      ORDER BY invoice_date DESC, id DESC
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
    const res = await appPool.query('SELECT * FROM gst_invoices WHERE id = $1', [id]);
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
        taxableAmount: invoice.taxable_amount,
        cgstRate: Number(invoice.cgst_rate) > 0 ? invoice.cgst_rate : undefined,
        cgstAmount: invoice.cgst_amount,
        sgstRate: Number(invoice.sgst_rate) > 0 ? invoice.sgst_rate : undefined,
        sgstAmount: invoice.sgst_amount,
        igstRate: Number(invoice.igst_rate) > 0 ? invoice.igst_rate : undefined,
        igstAmount: invoice.igst_amount,
        taxAmount: invoice.tax_amount,
        grandTotal: invoice.grand_total,
      },
      amountInWords: invoice.amount_in_words,
    };

    const buffer = await generateMannatInvoicePdf(pdfData);
    return { buffer, filename };
  }
}

export const gstInvoicesService = new GstInvoicesService();
