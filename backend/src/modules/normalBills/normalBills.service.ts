import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { appPool } from '../../config/database.js';
import { env } from '../../config/env.js';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import { resolveValidatedState } from '../../utils/indianTax.js';
import { getCompanyTaxProfile } from '../../services/companyTaxProfile.service.js';
import {
  acquireIdempotencyLock,
  checkIdempotencyRecord,
  cleanupExpiredIdempotencyKeys,
  hashIdempotencyPayload,
  storeIdempotencyRecord,
  updateIdempotencyResponse,
} from '../../services/idempotency.service.js';
import {
  allocateDocumentNumber,
  getSuggestedNextDocumentNumber,
  NORMAL_BILL_NUMBERING_CONFIG,
} from '../billing/numbering.js';
import { StorageService } from '../../services/storage.service.js';
import { AppError } from '../../utils/errors.js';
import { validateMoneyInput, validateDecimalQuantityInput, resolveValidatedDiscount } from '../../utils/validation.js';
import {
  generateTaxInvoicePdf,
  GstInvoicePdfCompany,
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
  state?: string | null;
  stateCode?: string | null;
  transportationMode?: string | null;
  vehicleNumber?: string | null;
  dateOfSupply?: string | null;
  placeOfSupply?: string | null;
  customerId?: number | null;
  customerName: string;
  customerAddress?: string | null;
  customerPhone?: string | null;
  customerState?: string | null;
  customerStateCode?: string | null;
  subtotalAmount?: number | string | null;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | string | null;
  discountAmount?: number | string | null;
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
  customer_state: string | null;
  customer_state_code: string | null;
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

function buildNormalizedBillHashPayload(input: CreateNormalBillInput) {
  return {
    billNumber: input.billNumber?.trim() || null,
    billDate: input.billDate?.trim() || null,
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
    customerState: input.customerState?.trim() || null,
    customerStateCode: input.customerStateCode?.trim() || null,
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
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Creates a Normal Bill within an existing database transaction client.
   * Atomically validates seller/buyer state, calculates Decimal finances,
   * allocates bill number, and inserts line items.
   */
  public async createBillInTransaction(client: PoolClient, input: CreateNormalBillInput): Promise<NormalBillRecord> {
    if (!input.items || input.items.length === 0) {
      throw new AppError('At least one line item is required.', 400, 'ITEMS_REQUIRED');
    }

    // 1. Validate supplier & optional buyer state cleanly BEFORE consuming sequence
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
      required: false,
      fieldLabel: 'Customer',
    });

    // 2. Calculate item amounts and subtotal using Decimal.js with 2-decimal scale
    let subtotalDec = new Decimal(0);
    const computedItems: Array<CreateNormalBillItemInput & { amount: string }> = [];

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

    const totalAmountDec = subtotalDec.minus(discountAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const amountInWords = numberToIndianWords(totalAmountDec.toFixed(2));

    // 4. Resolve bill number atomically AFTER validation passes
    const billNumber = await allocateDocumentNumber(client, NORMAL_BILL_NUMBERING_CONFIG, input.billNumber);

    // Auto-update customer address if linked customer lacks one
    if (input.customerId && input.customerAddress?.trim()) {
      await client.query(
        `UPDATE customers SET address = $1, updated_at = NOW() WHERE id = $2 AND (address IS NULL OR address = '')`,
        [input.customerAddress.trim(), input.customerId]
      );
    }

    // 5. Insert Normal Bill Header using configured business date (IST) & nullable buyer state
    const billDate = input.billDate || getBusinessDateISO(env.BUSINESS_TIME_ZONE);
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
        $2::DATE,
        $3,
        $4,
        $5,
        $6,
        $7::DATE,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
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
      billDate,
      supplierState,
      supplierStateCode,
      input.transportationMode || null,
      input.vehicleNumber || null,
      input.dateOfSupply || null,
      input.placeOfSupply?.trim() || null,
      input.customerId || null,
      input.customerName.trim(),
      input.customerAddress?.trim() || null,
      input.customerPhone?.trim() || null,
      resolvedCustomer.state,
      resolvedCustomer.stateCode,
      subtotalDec.toFixed(2),
      discountType,
      discountValDec.toFixed(2),
      discountAmountDec.toFixed(2),
      totalAmountDec.toFixed(2),
      amountInWords,
      input.notes || null,
    ]);

    const billRecord: NormalBillRecord = billRes.rows[0];

    // 6. Insert line items
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
   * Creates a Normal Bill without GST calculations, manages transaction boundaries + 24h TTL idempotency, and generates PDF.
   */
  public async createBill(input: CreateNormalBillInput): Promise<NormalBillRecord> {
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    const requestHash = idempotencyKey
      ? hashIdempotencyPayload(buildNormalizedBillHashPayload(input))
      : null;

    const client = await appPool.connect();
    let billRecord: NormalBillRecord;
    let companyForPdf: GstInvoicePdfCompany | undefined;

    try {
      await client.query('BEGIN');

      if (idempotencyKey && requestHash) {
        await acquireIdempotencyLock(client, idempotencyKey);
        const existingIdemp = await checkIdempotencyRecord<NormalBillRecord>(
          client,
          idempotencyKey,
          'CREATE_NORMAL_BILL',
          requestHash
        );
        if (existingIdemp.found && !existingIdemp.expired) {
          await client.query('COMMIT');
          const replayed = existingIdemp.responseBody;
          if (replayed && typeof replayed.id === 'number') {
            const fresh = await this.getBillById(replayed.id).catch(() => null);
            if (fresh) return fresh;
          }
          return replayed;
        }
        await cleanupExpiredIdempotencyKeys(client, 100);
      }

      companyForPdf = await this.getOptionalPdfCompany(client);
      billRecord = await this.createBillInTransaction(client, input);

      if (idempotencyKey && requestHash) {
        await storeIdempotencyRecord(client, {
          key: idempotencyKey,
          action: 'CREATE_NORMAL_BILL',
          requestHash,
          responseStatus: 201,
          responseBody: billRecord,
        });
      }

      await client.query('COMMIT');
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

    // Generate Normal Bill PDF (No GST calculations) outside of database transaction
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
        company: companyForPdf,
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

      if (this.storageService.isConfigured()) {
        const [year, month] = getBusinessDateISO(env.BUSINESS_TIME_ZONE).split('-');
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

    // Update PDF status in DB and sync stored idempotency response
    try {
      await appPool.query(
        `UPDATE normal_bills SET pdf_status = $1, r2_object_key = $2, updated_at = NOW() WHERE id = $3`,
        [pdfStatus, r2Key, billRecord.id]
      );
      billRecord.pdf_status = pdfStatus;
      billRecord.r2_object_key = r2Key;

      if (idempotencyKey && requestHash) {
        await updateIdempotencyResponse(appPool, {
          key: idempotencyKey,
          action: 'CREATE_NORMAL_BILL',
          requestHash,
          responseStatus: 201,
          responseBody: billRecord,
        });
      }
    } catch (statusUpdateErr) {
      console.warn('[NORMAL BILL STATUS UPDATE NON-FATAL]', (statusUpdateErr as Error).message);
    }

    return billRecord;
  }

  /**
   * Generates a preview PDF buffer for normal bills on-the-fly without database writes.
   */
  public async generateDraftPdf(input: CreateNormalBillInput): Promise<{ buffer: Buffer; filename: string }> {
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
      required: false,
      fieldLabel: 'Customer',
    });

    let subtotalDec = new Decimal(0);
    const computedItems: Array<CreateNormalBillItemInput & { amount: string }> = [];

    for (const item of input.items) {
      const qtyDec = validateDecimalQuantityInput(item.quantity, 'Quantity');
      const rateDec = validateMoneyInput(item.rate, 'Rate', { allowZero: true });
      const lineAmountDec = qtyDec.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      subtotalDec = subtotalDec.plus(lineAmountDec);

      computedItems.push({
        ...item,
        quantity: qtyDec.toFixed(2),
        rate: rateDec.toFixed(2),
        amount: lineAmountDec.toFixed(2),
      });
    }

    const {
      discountType,
      discountValueDec: discountValDec,
      discountAmountDec,
    } = resolveValidatedDiscount(subtotalDec, input);

    const totalAmountDec = subtotalDec.minus(discountAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const billNumber = input.billNumber || 'Draft';
    const amountInWords = numberToIndianWords(totalAmountDec.toFixed(2));

    const buffer = await generateTaxInvoicePdf({
      invoiceNumber: billNumber,
      invoiceDate: input.billDate || getBusinessDateISO(env.BUSINESS_TIME_ZONE),
      state: resolvedSupplier.state!,
      stateCode: resolvedSupplier.stateCode!,
      transportationMode: input.transportationMode || null,
      vehicleNumber: input.vehicleNumber || null,
      dateOfSupply: input.dateOfSupply || null,
      placeOfSupply: input.placeOfSupply?.trim() || null,
      company: {
        companyName: companyProfile.companyName,
        address: companyProfile.address,
        gstin: companyProfile.gstin,
        phone: companyProfile.phone,
        state: companyProfile.state,
        stateCode: companyProfile.stateCode,
      },
      customer: {
        name: input.customerName || 'Valued Customer',
        address: input.customerAddress || null,
        phone: input.customerPhone || null,
        state: resolvedCustomer.state,
        stateCode: resolvedCustomer.stateCode,
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

    const countRes = await appPool.query(
      `SELECT COUNT(*)::INT AS total FROM normal_bills b WHERE ${whereClause}`,
      params
    );
    const totalCount = countRes.rows[0]?.total || 0;

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

    const company = await this.getOptionalPdfCompany();
    const buffer = await generateTaxInvoicePdf({
      invoiceNumber: bill.bill_number,
      invoiceDate: bill.bill_date,
      state: bill.state,
      stateCode: bill.state_code,
      transportationMode: bill.transportation_mode,
      vehicleNumber: bill.vehicle_number,
      dateOfSupply: bill.date_of_supply,
      placeOfSupply: bill.place_of_supply,
      company,
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
