import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { appPool } from '../../config/database.js';
import { enqueueOutboxEvent, notifyOutboxCommitted } from '../readModels/outbox.service.js';
import { env } from '../../config/env.js';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import {
  allocateDocumentNumber,
  getSuggestedNextDocumentNumber,
  GST_INVOICE_NUMBERING_CONFIG,
} from '../billing/numbering.js';
import { resolveProductCostSnapshots } from '../billing/costSnapshot.js';
import { resolveValidatedState, validateGstinForState } from '../../utils/indianTax.js';
import { getCompanyTaxProfile } from '../../services/companyTaxProfile.service.js';
import {
  acquireIdempotencyLock,
  checkIdempotencyRecord,
  cleanupExpiredIdempotencyKeys,
  hashIdempotencyPayload,
  storeIdempotencyRecord,
  updateIdempotencyResponse,
} from '../../services/idempotency.service.js';
import { StorageService } from '../../services/storage.service.js';
import { AppError } from '../../utils/errors.js';
import {
  validateMoneyInput,
  validateDecimalQuantityInput,
  resolveValidatedDiscount,
  calculateGstBreakdown,
  escapeLike,
} from '../../utils/validation.js';
import {
  generateTaxInvoicePdf,
  numberToIndianWords,
  GstInvoicePdfCompany,
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
  state?: string | null;
  stateCode?: string | null;
  transportationMode?: string | null;
  vehicleNumber?: string | null;
  dateOfSupply?: string | null;
  placeOfSupply?: string | null;
  customerId?: number | null;
  customerName: string;
  customerAddress?: string | null;
  customerGstin?: string | null;
  customerPhone?: string | null;
  customerState?: string | null;
  customerStateCode?: string | null;
  gstRate: number | string; // e.g. 18 for 18% GST, 5, 12, 28, or 0
  subtotalAmount?: number | string | null;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | string | null;
  discountAmount?: number | string | null;
  items: CreateGstInvoiceItemInput[];
  notes?: string | null;
  idempotencyKey?: string | null;
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
  cost_rate_snapshot?: string | null;
  created_at: string;
}

function buildNormalizedInvoiceHashPayload(input: CreateGstInvoiceInput) {
  return {
    invoiceNumber: input.invoiceNumber?.trim() || null,
    invoiceDate: input.invoiceDate?.trim() || null,
    state: input.state?.trim() || null,
    stateCode: input.stateCode?.trim() || null,
    transportationMode: input.transportationMode?.trim() || null,
    vehicleNumber: input.vehicleNumber?.trim() || null,
    dateOfSupply: input.dateOfSupply?.trim() || null,
    placeOfSupply: input.placeOfSupply?.trim() || null,
    customerId: input.customerId ?? null,
    customerName: input.customerName?.trim() || '',
    customerAddress: input.customerAddress?.trim() || null,
    customerPhone: input.customerPhone?.trim() || null,
    customerGstin: input.customerGstin?.trim()?.toUpperCase() || null,
    customerState: input.customerState?.trim() || null,
    customerStateCode: input.customerStateCode?.trim() || null,
    gstRate: String(input.gstRate ?? ''),
    subtotalAmount:
      input.subtotalAmount !== undefined && input.subtotalAmount !== null ? String(input.subtotalAmount) : null,
    discountType: input.discountType ?? null,
    discountValue:
      input.discountValue !== undefined && input.discountValue !== null ? String(input.discountValue) : null,
    discountAmount:
      input.discountAmount !== undefined && input.discountAmount !== null ? String(input.discountAmount) : null,
    notes: input.notes?.trim() || null,
    items: (input.items || []).map((item) => ({
      productId: item.productId ?? null,
      description: item.description?.trim() || '',
      hsnCode: item.hsnCode?.trim() || null,
      quantity: String(item.quantity ?? ''),
      unit: item.unit?.trim() || null,
      rate: String(item.rate ?? ''),
      rateUnit: item.rateUnit?.trim() || null,
    })),
  };
}

export class GstInvoicesService {
  private storageService: StorageService;

  constructor(storageService?: StorageService) {
    this.storageService = storageService || new StorageService();
  }

  /**
   * Generates the next sequential invoice number suggestion from the database.
   * Pure, read-only, idempotent, and non-destructive. Never calls setval() or nextval().
   */
  public async getNextInvoiceNumber(): Promise<string> {
    return getSuggestedNextDocumentNumber(appPool, GST_INVOICE_NUMBERING_CONFIG);
  }

  private async getOptionalPdfCompany(dbClient?: PoolClient): Promise<GstInvoicePdfCompany | undefined> {
    try {
      const profile = await getCompanyTaxProfile(dbClient);
      return {
        companyName: profile.companyName,
        address: profile.address,
        gstin: profile.gstin,
        phone: profile.phone,
        state: profile.state,
        stateCode: profile.stateCode,
        jurisdiction: profile.jurisdiction,
      };
    } catch {
      return undefined;
    }
  }

  private buildPdfDataFromRecord(
    invoice: GstInvoiceRecord,
    company?: GstInvoicePdfCompany
  ): GstInvoicePdfData {
    return {
      invoiceNumber: invoice.invoice_number,
      invoiceDate: invoice.invoice_date,
      state: invoice.state,
      stateCode: invoice.state_code,
      transportationMode: invoice.transportation_mode,
      vehicleNumber: invoice.vehicle_number,
      dateOfSupply: invoice.date_of_supply,
      placeOfSupply: invoice.place_of_supply,
      company,
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
  }

  /**
   * Creates a GST Tax Invoice within an existing database transaction client.
   * Atomically validates seller/buyer state & GSTIN, computes Decimal finances,
   * allocates invoice number, and inserts line items.
   */
  public async createInvoiceInTransaction(client: PoolClient, input: CreateGstInvoiceInput): Promise<GstInvoiceRecord> {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one line item is required.', 400, 'ITEMS_REQUIRED');
    }

    // 1. Validate supplier & buyer tax states cleanly BEFORE allocating invoice number
    let supplierState: string;
    let supplierStateCode: string;
    if (input.state || input.stateCode) {
      const resolvedSupplier = resolveValidatedState({
        state: input.state,
        stateCode: input.stateCode,
        required: true,
        fieldLabel: 'Company',
      });
      supplierState = resolvedSupplier.state!;
      supplierStateCode = resolvedSupplier.stateCode!;
    } else {
      const companyProfile = await getCompanyTaxProfile(client);
      supplierState = companyProfile.state;
      supplierStateCode = companyProfile.stateCode;
    }

    const resolvedCustomer = resolveValidatedState({
      state: input.customerState,
      stateCode: input.customerStateCode,
      required: true,
      fieldLabel: 'Customer',
    });
    const customerState = resolvedCustomer.state!;
    const customerStateCode = resolvedCustomer.stateCode!;

    const validatedCustomerGstin = validateGstinForState(input.customerGstin, customerStateCode);
    const isIntraState = supplierStateCode === customerStateCode;

    // 2. Calculate item amounts and subtotal using Decimal.js with 2-decimal scale
    let subtotalDec = new Decimal(0);
    const computedItems: Array<CreateGstInvoiceItemInput & { amount: string }> = [];

    for (const item of input.items) {
      const qtyDec = validateDecimalQuantityInput(item.quantity, `Item "${item.description}" quantity`);
      const rateDec = validateMoneyInput(item.rate, `Item "${item.description}" rate`, { allowZero: true });

      const lineAmountDec = qtyDec.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      subtotalDec = subtotalDec.plus(lineAmountDec);

      computedItems.push({
        ...item,
        quantity: qtyDec.toFixed(2),
        rate: rateDec.toFixed(2),
        amount: lineAmountDec.toFixed(2),
      });
    }

    // 3. Strict discount validation and Decimal.js calculation
    const {
      discountType,
      discountValueDec: discountValDec,
      discountAmountDec,
    } = resolveValidatedDiscount(subtotalDec, input);

    // Taxable amount is subtotal minus discount
    const taxableAmountDec = subtotalDec.minus(discountAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    // 4. Strict GST rate validation and Intra-state / Inter-state split
    const {
      cgstRateDec,
      cgstAmountDec,
      sgstRateDec,
      sgstAmountDec,
      igstRateDec,
      igstAmountDec,
      totalTaxDec,
    } = calculateGstBreakdown(taxableAmountDec, input.gstRate, isIntraState);
    const grandTotalDec = taxableAmountDec.plus(totalTaxDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const amountInWords = numberToIndianWords(grandTotalDec.toFixed(2));

    // 5. Resolve invoice number atomically AFTER validation passes
    const invoiceNumber = await allocateDocumentNumber(client, GST_INVOICE_NUMBERING_CONFIG, input.invoiceNumber);

    // Auto-update customer address if linked customer lacks one
    if (input.customerId && input.customerAddress?.trim()) {
      await client.query(
        `UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2 AND (address IS NULL OR address = '')`,
        [input.customerAddress.trim(), input.customerId]
      );
    }

    // 6. Insert into gst_invoices using configured business date (IST)
    const invoiceDate = input.invoiceDate || getBusinessDateISO(env.BUSINESS_TIME_ZONE);
    const placeOfSupply = input.placeOfSupply?.trim() || customerState;
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
      supplierState,
      supplierStateCode,
      input.transportationMode || null,
      input.vehicleNumber || null,
      input.dateOfSupply || invoiceDate,
      placeOfSupply,
      input.customerId || null,
      input.customerName.trim(),
      input.customerAddress?.trim() || null,
      validatedCustomerGstin,
      customerState,
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

    // 7. Capture historical buying-price snapshots for linked products and batch insert line items
    const productCostMap = await resolveProductCostSnapshots(client, computedItems);
    const insertedItems: GstInvoiceItemRecord[] =
      computedItems.length > 0
        ? (
            await client.query(
              `INSERT INTO gst_invoice_items (
                invoice_id, product_id, item_index, description, hsn_code,
                quantity, unit, rate, rate_unit, amount, cost_rate_snapshot
              )
              SELECT * FROM UNNEST(
                $1::bigint[],
                $2::bigint[],
                $3::int[],
                $4::text[],
                $5::text[],
                $6::numeric[],
                $7::text[],
                $8::numeric[],
                $9::text[],
                $10::numeric[],
                $11::numeric[]
              )
              RETURNING *`,
              [
                computedItems.map(() => createdInvoice.id),
                computedItems.map((itm) => itm.productId || null),
                computedItems.map((_, idx) => idx + 1),
                computedItems.map((itm) => itm.description.trim()),
                computedItems.map((itm) => itm.hsnCode || null),
                computedItems.map((itm) => itm.quantity),
                computedItems.map((itm) => itm.unit || null),
                computedItems.map((itm) => itm.rate),
                computedItems.map((itm) => itm.rateUnit || null),
                computedItems.map((itm) => itm.amount),
                computedItems.map((itm) =>
                  itm.productId ? productCostMap.get(Number(itm.productId)) ?? null : null
                ),
              ]
            )
          ).rows
        : [];

    createdInvoice.items = insertedItems;
    await enqueueOutboxEvent(client, {
      aggregateType: 'gst_invoice',
      aggregateId: createdInvoice.id,
      eventType: 'gst_invoice.created',
      businessDate: invoiceDate,
      payload: {
        customerId: input.customerId ?? null,
        productIds: computedItems
          .map((item) => item.productId)
          .filter((pid): pid is number => typeof pid === 'number' && pid > 0),
      },
    });
    return createdInvoice;
  }

  /**
   * Creates a GST Tax Invoice, manages transaction boundaries + 24h TTL idempotency, and generates PDF.
   */
  public async createInvoice(input: CreateGstInvoiceInput): Promise<GstInvoiceRecord> {
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    const requestHash = idempotencyKey
      ? hashIdempotencyPayload(buildNormalizedInvoiceHashPayload(input))
      : null;

    const client = await appPool.connect();
    let createdInvoice: GstInvoiceRecord;
    let companyForPdf: GstInvoicePdfCompany | undefined;

    try {
      await client.query('BEGIN');

      if (idempotencyKey && requestHash) {
        await acquireIdempotencyLock(client, idempotencyKey);
        const existingIdemp = await checkIdempotencyRecord<GstInvoiceRecord>(
          client,
          idempotencyKey,
          'CREATE_GST_INVOICE',
          requestHash
        );
        if (existingIdemp.found && !existingIdemp.expired) {
          await client.query('COMMIT');
          const replayed = existingIdemp.responseBody;
          if (replayed && typeof replayed.id === 'number') {
            const fresh = await this.getInvoiceById(replayed.id).catch(() => null);
            if (fresh) return fresh;
          }
          return replayed;
        }
        await cleanupExpiredIdempotencyKeys(client, 100);
      }

      companyForPdf = await this.getOptionalPdfCompany(client);
      createdInvoice = await this.createInvoiceInTransaction(client, input);

      if (idempotencyKey && requestHash) {
        await storeIdempotencyRecord(client, {
          key: idempotencyKey,
          action: 'CREATE_GST_INVOICE',
          requestHash,
          responseStatus: 201,
          responseBody: createdInvoice,
        });
      }

      await client.query('COMMIT');
      notifyOutboxCommitted();
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }

    // Generate PDF and upload to Cloudflare R2 outside database transaction
    let pdfStatus: 'uploaded' | 'local_only' | 'failed' = 'local_only';
    let r2ObjectKey: string | null = null;

    try {
      const pdfBuffer = await generateTaxInvoicePdf(
        this.buildPdfDataFromRecord(createdInvoice, companyForPdf)
      );

      if (this.storageService.isConfigured()) {
        const [year, month] = getBusinessDateISO(env.BUSINESS_TIME_ZONE).split('-');
        const candidateKey = `gst-invoices/${year}/${month}/${createdInvoice.id}.pdf`;

        try {
          await this.storageService.uploadBufferToR2({
            buffer: pdfBuffer,
            objectKey: candidateKey,
            contentType: 'application/pdf',
          });
          r2ObjectKey = candidateKey;
          pdfStatus = 'uploaded';
        } catch (uploadErr) {
          console.error('[GST INVOICE R2 UPLOAD] Upload failed:', uploadErr);
          r2ObjectKey = null;
          pdfStatus = 'failed';
        }
      }
    } catch (pdfErr) {
      console.error('[GST INVOICE PDF GENERATION] PDF generation failed:', pdfErr);
      r2ObjectKey = null;
      pdfStatus = 'failed';
    }

    try {
      await appPool.query(
        'UPDATE gst_invoices SET pdf_status = $1, r2_object_key = $2, updated_at = NOW() WHERE id = $3',
        [pdfStatus, r2ObjectKey, createdInvoice.id]
      );
      createdInvoice.pdf_status = pdfStatus;
      createdInvoice.r2_object_key = r2ObjectKey;

      if (idempotencyKey && requestHash) {
        await updateIdempotencyResponse(appPool, {
          key: idempotencyKey,
          action: 'CREATE_GST_INVOICE',
          requestHash,
          responseStatus: 201,
          responseBody: createdInvoice,
        });
      }
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
      params.push(`%${escapeLike(paramsIn.search.trim())}%`);
      conditions.push(`(i.invoice_number ILIKE $${params.length} ESCAPE '\\' OR i.customer_name ILIKE $${params.length} ESCAPE '\\')`);
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

    const countRes = await appPool.query(`SELECT COUNT(*)::INT AS total FROM gst_invoices i ${whereSql}`, params);
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

    const company = await this.getOptionalPdfCompany();
    const buffer = await generateTaxInvoicePdf(this.buildPdfDataFromRecord(invoice, company));
    return { buffer, filename };
  }

  /**
   * Idempotently retries PDF generation & R2 upload for a failed or pending GST invoice
   * outside of any database transaction. Never persists r2_object_key unless R2 upload succeeds.
   */
  public async retryInvoicePdf(id: number): Promise<GstInvoiceRecord> {
    this.storageService.assertConfigured();
    const invoice = await this.getInvoiceById(id);
    if (!invoice) {
      throw new AppError('Invoice not found.', 404, 'NOT_FOUND');
    }

    if (invoice.pdf_status === 'uploaded' && invoice.r2_object_key) {
      return invoice;
    }

    const company = await this.getOptionalPdfCompany();
    const pdfBuffer = await generateTaxInvoicePdf(this.buildPdfDataFromRecord(invoice, company));

    const dateStr =
      typeof invoice.invoice_date === 'string' && /^\d{4}-\d{2}/.test(invoice.invoice_date)
        ? invoice.invoice_date
        : getBusinessDateISO(env.BUSINESS_TIME_ZONE);
    const [year, month] = dateStr.split('-');
    const candidateKey = `gst-invoices/${year}/${month}/${invoice.id}.pdf`;

    try {
      await this.storageService.uploadBufferToR2({
        buffer: pdfBuffer,
        objectKey: candidateKey,
        contentType: 'application/pdf',
      });
    } catch (uploadErr) {
      await appPool.query(
        'UPDATE gst_invoices SET pdf_status = $1, r2_object_key = NULL, updated_at = NOW() WHERE id = $2',
        ['failed', invoice.id]
      );
      throw new AppError(
        `Failed to upload invoice PDF to storage: ${(uploadErr as Error).message}`,
        502,
        'PDF_UPLOAD_FAILED'
      );
    }

    await appPool.query(
      'UPDATE gst_invoices SET pdf_status = $1, r2_object_key = $2, updated_at = NOW() WHERE id = $3',
      ['uploaded', candidateKey, invoice.id]
    );
    return {
      ...invoice,
      pdf_status: 'uploaded',
      r2_object_key: candidateKey,
    };
  }

  /**
   * Generates a preview PDF in-memory without database mutation
   */
  public async generateDraftPdf(input: CreateGstInvoiceInput): Promise<{ buffer: Buffer; filename: string }> {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one line item is required.', 400, 'ITEMS_REQUIRED');
    }

    const companyProfile = await getCompanyTaxProfile();
    const resolvedSupplier =
      input.state || input.stateCode
        ? resolveValidatedState({
            state: input.state,
            stateCode: input.stateCode,
            required: true,
            fieldLabel: 'Company',
          })
        : { state: companyProfile.state, stateCode: companyProfile.stateCode };

    const resolvedCustomer = resolveValidatedState({
      state: input.customerState,
      stateCode: input.customerStateCode,
      required: true,
      fieldLabel: 'Customer',
    });

    const validatedCustomerGstin = validateGstinForState(input.customerGstin, resolvedCustomer.stateCode!);

    let subtotalDec = new Decimal(0);
    const pdfItems: GstInvoicePdfData['items'] = [];

    for (const item of input.items) {
      const qtyDec = validateDecimalQuantityInput(item.quantity, 'Quantity');
      const rateDec = validateMoneyInput(item.rate, 'Rate', { allowZero: true });
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

    const {
      discountType,
      discountValueDec: discountValDec,
      discountAmountDec,
    } = resolveValidatedDiscount(subtotalDec, input);

    const taxableAmountDec = subtotalDec.minus(discountAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const shopStateCode = resolvedSupplier.stateCode!;
    const customerStateCode = resolvedCustomer.stateCode!;
    const isIntraState = shopStateCode === customerStateCode;
    const {
      cgstRateDec,
      cgstAmountDec,
      sgstRateDec,
      sgstAmountDec,
      igstRateDec,
      igstAmountDec,
      totalTaxDec,
    } = calculateGstBreakdown(taxableAmountDec, input.gstRate, isIntraState);
    const grandTotalDec = taxableAmountDec.plus(totalTaxDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const amountInWords = numberToIndianWords(grandTotalDec.toFixed(2));
    const invoiceNumber = input.invoiceNumber || 'Draft';

    const pdfData: GstInvoicePdfData = {
      invoiceNumber,
      invoiceDate: input.invoiceDate || getBusinessDateISO(env.BUSINESS_TIME_ZONE),
      state: resolvedSupplier.state!,
      stateCode: shopStateCode,
      transportationMode: input.transportationMode || null,
      vehicleNumber: input.vehicleNumber || null,
      dateOfSupply: input.dateOfSupply || null,
      placeOfSupply: input.placeOfSupply?.trim() || resolvedCustomer.state!,
      company: {
        companyName: companyProfile.companyName,
        address: companyProfile.address,
        gstin: companyProfile.gstin,
        phone: companyProfile.phone,
        state: companyProfile.state,
        stateCode: companyProfile.stateCode,
        jurisdiction: companyProfile.jurisdiction,
      },
      customer: {
        name: input.customerName || 'Valued Customer',
        address: input.customerAddress || null,
        gstin: validatedCustomerGstin,
        state: resolvedCustomer.state!,
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
