import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { appPool } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { validateMoneyInput, validateDecimalQuantityInput, escapeLike } from '../../utils/validation.js';
import { numberToIndianWords } from '../gstInvoices/gstInvoices.pdf.js';
import { normalBillsService } from '../normalBills/normalBills.service.js';
import { gstInvoicesService } from '../gstInvoices/gstInvoices.service.js';
import { QuotationCompanySnapshot } from './quotations.pdf.js';

export interface QuotationItemRecord {
  id: number;
  quotation_id: number;
  product_id: number | null;
  item_index: number;
  description: string;
  hsn_code: string | null;
  barcode: string | null;
  quantity: string;
  unit: string | null;
  rate: string;
  rate_unit: string | null;
  amount: string;
  created_at: string;
}

export interface QuotationRecord {
  id: number;
  quotation_number: string;
  quotation_date: string;
  valid_until: string | null;
  customer_id: number | null;
  customer_name: string;
  customer_address: string | null;
  customer_phone: string | null;
  customer_gstin: string | null;
  customer_state: string;
  customer_state_code: string;
  project_title: string | null;
  subject: string | null;
  company_snapshot: QuotationCompanySnapshot;
  subtotal: string;
  discount_type: 'percentage' | 'fixed' | null;
  discount_value: string;
  discount_amount: string;
  taxable_amount: string;
  gst_enabled: boolean;
  gst_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  tax_amount: string;
  grand_total: string;
  amount_in_words: string;
  terms_and_conditions: string | null;
  notes: string | null;
  status: 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'converted';
  converted_normal_bill_id: number | null;
  converted_gst_invoice_id: number | null;
  created_at: string;
  updated_at: string;
  items?: QuotationItemRecord[];
}

export interface QuotationSettingsRecord {
  id: number;
  company_name: string;
  logo_url: string | null;
  cin: string | null;
  gstin: string | null;
  address: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  state: string;
  state_code: string;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_branch: string | null;
  standard_validity_days: number;
  standard_payment_terms: string | null;
  standard_delivery_terms: string | null;
  standard_warranty_terms: string | null;
  standard_declaration: string | null;
  signatory_title: string;
  updated_at: string;
}

export interface QuotationItemInput {
  productId?: number | null;
  description: string;
  hsnCode?: string | null;
  barcode?: string | null;
  quantity: number | string;
  unit?: string | null;
  rate: number | string;
  rateUnit?: string | null;
}

export interface CreateQuotationInput {
  quotationNumber?: string;
  quotationDate?: string;
  validUntil?: string | null;
  initialStatus?: 'draft' | 'sent';
  customerId?: number | null;
  customerName: string;
  customerAddress?: string | null;
  customerPhone?: string | null;
  customerGstin?: string | null;
  customerState?: string;
  customerStateCode?: string;
  projectTitle?: string | null;
  subject?: string | null;
  items: QuotationItemInput[];
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | string;
  gstEnabled?: boolean;
  gstRate?: number | string;
  termsAndConditions?: string | null;
  notes?: string | null;
}

export class QuotationsService {
  /**
   * Retrieves active company profile & quotation defaults from quotation_settings
   */
  public async getSettings(): Promise<QuotationSettingsRecord> {
    const res = await appPool.query('SELECT * FROM quotation_settings WHERE id = 1');
    if (res.rows.length === 0) {
      const fallback = await appPool.query(`
        INSERT INTO quotation_settings (id)
        VALUES (1)
        ON CONFLICT (id) DO NOTHING
        RETURNING *
      `);
      if (fallback.rows.length > 0) return fallback.rows[0];
      const recheck = await appPool.query('SELECT * FROM quotation_settings WHERE id = 1');
      return recheck.rows[0];
    }
    return res.rows[0];
  }

  /**
   * Updates company quotation configuration profile
   */
  public async updateSettings(data: Record<string, any>): Promise<QuotationSettingsRecord> {
    const fields: string[] = [];
    const params: any[] = [];

    const fieldMap: Record<string, string> = {
      companyName: 'company_name',
      logoUrl: 'logo_url',
      cin: 'cin',
      gstin: 'gstin',
      address: 'address',
      email: 'email',
      phone: 'phone',
      website: 'website',
      state: 'state',
      stateCode: 'state_code',
      bankName: 'bank_name',
      bankAccountNumber: 'bank_account_number',
      bankIfsc: 'bank_ifsc',
      bankBranch: 'bank_branch',
      standardValidityDays: 'standard_validity_days',
      standardPaymentTerms: 'standard_payment_terms',
      standardDeliveryTerms: 'standard_delivery_terms',
      standardWarrantyTerms: 'standard_warranty_terms',
      standardDeclaration: 'standard_declaration',
      signatoryTitle: 'signatory_title',
    };

    Object.entries(data).forEach(([key, val]) => {
      const dbCol = fieldMap[key] || key;
      if (val !== undefined) {
        params.push(val);
        fields.push(`"${dbCol}" = $${params.length}`);
      }
    });

    if (fields.length === 0) {
      return this.getSettings();
    }

    fields.push('updated_at = NOW()');

    const sql = `
      UPDATE quotation_settings
      SET ${fields.join(', ')}
      WHERE id = 1
      RETURNING *
    `;

    const res = await appPool.query(sql, params);
    return res.rows[0];
  }

  /**
   * Generates next sequential quotation number in QT-001 format.
   * Concurrency-safe and sequence backed.
   */
  public async getNextQuotationNumber(): Promise<string> {
    try {
      const seqRes = await appPool.query("SELECT nextval('quotation_number_seq') AS seq_num");
      const seqVal = seqRes.rows[0]?.seq_num;
      if (seqVal) {
        return `QT-${String(seqVal).padStart(3, '0')}`;
      }
    } catch {
      // Sequence call failed, fall back to MAX check
    }

    try {
      const maxRes = await appPool.query(`
        SELECT COALESCE(MAX(
          CASE
            WHEN quotation_number ~ '^QT-\\d+$' THEN SUBSTRING(quotation_number FROM 4)::BIGINT
            WHEN quotation_number ~ '^\\d+$' THEN quotation_number::BIGINT
            ELSE 0
          END
        ), 0) AS max_num FROM quotations
      `);
      const currentMax = Number(maxRes.rows[0]?.max_num || 0);
      return `QT-${String(currentMax + 1).padStart(3, '0')}`;
    } catch {
      return 'QT-001';
    }
  }

  /**
   * Financial calculation engine using Decimal.js with ROUND_HALF_UP.
   * Calculates subtotal, discounts, taxable amount, intra/inter-state GST, and grand total.
   */
  public calculateQuotationTotals(
    items: QuotationItemInput[],
    discountType?: 'percentage' | 'fixed' | null,
    discountValue?: number | string,
    gstEnabled: boolean = false,
    gstRate: number | string = 18,
    supplierStateCode: string = '10',
    customerStateCode: string = '10'
  ) {
    if (!items || items.length === 0) {
      throw new AppError('At least one line item is required.', 400, 'VALIDATION_ERROR');
    }

    // 1. Calculate each item's amount
    let subtotalDec = new Decimal(0);
    const calculatedItems = items.map((item, idx) => {
      const qtyDec = validateDecimalQuantityInput(item.quantity, `Item ${idx + 1} quantity`);
      const rateDec = validateMoneyInput(item.rate, `Item ${idx + 1} rate`);
      const amountDec = qtyDec.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      subtotalDec = subtotalDec.plus(amountDec);

      return {
        ...item,
        quantity: qtyDec.toFixed(2),
        rate: rateDec.toFixed(2),
        amount: amountDec.toFixed(2),
      };
    });

    // 2. Calculate Commercial Discount
    let discountAmountDec = new Decimal(0);
    const discValDec = new Decimal(discountValue || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    if (discountType === 'percentage') {
      if (discValDec.isNegative() || discValDec.greaterThan(100)) {
        throw new AppError('Discount percentage must be between 0 and 100.', 400, 'INVALID_DISCOUNT');
      }
      discountAmountDec = subtotalDec.times(discValDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else if (discountType === 'fixed') {
      if (discValDec.isNegative()) {
        throw new AppError('Fixed discount amount cannot be negative.', 400, 'INVALID_DISCOUNT');
      }
      discountAmountDec = Decimal.min(discValDec, subtotalDec);
    }

    // 3. Taxable Amount (Subtotal minus discount, clamped at 0)
    const taxableAmountDec = Decimal.max(0, subtotalDec.minus(discountAmountDec)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    // 4. GST Calculations (Intra-State vs Inter-State)
    let cgstDec = new Decimal(0);
    let sgstDec = new Decimal(0);
    let igstDec = new Decimal(0);
    let taxAmountDec = new Decimal(0);
    const gstRateDec = new Decimal(gstRate || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    if (gstEnabled && gstRateDec.greaterThan(0)) {
      const isIntraState = supplierStateCode.trim() === customerStateCode.trim();

      if (isIntraState) {
        const halfRateDec = gstRateDec.dividedBy(2);
        cgstDec = taxableAmountDec.times(halfRateDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        sgstDec = taxableAmountDec.times(halfRateDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      } else {
        igstDec = taxableAmountDec.times(gstRateDec).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      }
      taxAmountDec = cgstDec.plus(sgstDec).plus(igstDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }

    // 5. Grand Total & Words
    const grandTotalDec = taxableAmountDec.plus(taxAmountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const amountInWords = numberToIndianWords(grandTotalDec.toFixed(2));

    return {
      items: calculatedItems,
      subtotal: subtotalDec.toFixed(2),
      discountType: discountType || null,
      discountValue: discValDec.toFixed(2),
      discountAmount: discountAmountDec.toFixed(2),
      taxableAmount: taxableAmountDec.toFixed(2),
      gstEnabled,
      gstRate: gstRateDec.toFixed(2),
      cgstAmount: cgstDec.toFixed(2),
      sgstAmount: sgstDec.toFixed(2),
      igstAmount: igstDec.toFixed(2),
      taxAmount: taxAmountDec.toFixed(2),
      grandTotal: grandTotalDec.toFixed(2),
      amountInWords,
    };
  }

  /**
   * Creates a new professional quotation with independent recalculated totals,
   * snapshot of company profile, and authoritative sequential numbering.
   */
  public async createQuotation(input: CreateQuotationInput): Promise<QuotationRecord> {
    const settings = await this.getSettings();

    const customerState = input.customerState?.trim() || settings.state || 'Bihar';
    const customerStateCode = input.customerStateCode?.trim() || settings.state_code || '10';

    // Calculate totals safely
    const calc = this.calculateQuotationTotals(
      input.items,
      input.discountType,
      input.discountValue,
      input.gstEnabled,
      input.gstRate,
      settings.state_code,
      customerStateCode
    );

    const client = await appPool.connect();

    try {
      await client.query('BEGIN');

      // Resolve quotation number using authoritative sequence
      let quotationNumber = input.quotationNumber?.trim();
      if (!quotationNumber) {
        try {
          const seqRes = await client.query("SELECT nextval('quotation_number_seq') AS seq_num");
          const seqVal = seqRes.rows[0]?.seq_num;
          quotationNumber = `QT-${String(seqVal).padStart(3, '0')}`;
        } catch {
          quotationNumber = await this.getNextQuotationNumber();
        }
      }

      // Check collision
      const checkExists = await client.query(
        'SELECT 1 FROM quotations WHERE quotation_number = $1',
        [quotationNumber]
      );
      if ((checkExists.rowCount ?? 0) > 0) {
        throw new AppError(`Quotation number "${quotationNumber}" already exists.`, 409, 'DUPLICATE_QUOTATION_NUMBER');
      }

      // Snapshot company profile
      const companySnapshot: QuotationCompanySnapshot = {
        companyName: settings.company_name,
        logoUrl: settings.logo_url,
        cin: settings.cin,
        gstin: settings.gstin,
        address: settings.address,
        email: settings.email,
        phone: settings.phone,
        website: settings.website,
        state: settings.state,
        stateCode: settings.state_code,
        bankName: settings.bank_name,
        bankAccountNumber: settings.bank_account_number,
        bankIfsc: settings.bank_ifsc,
        bankBranch: settings.bank_branch,
        signatoryTitle: settings.signatory_title,
      };

      const quotationDate = input.quotationDate || new Date().toISOString().split('T')[0];

      // Default validity if not specified: quotationDate + standardValidityDays
      let validUntil = input.validUntil || null;
      if (!validUntil && settings.standard_validity_days > 0) {
        const d = new Date(quotationDate);
        d.setDate(d.getDate() + settings.standard_validity_days);
        validUntil = d.toISOString().split('T')[0];
      }

      const termsAndConditions = input.termsAndConditions !== undefined
        ? input.termsAndConditions
        : [
            settings.standard_payment_terms ? `Payment: ${settings.standard_payment_terms}` : null,
            settings.standard_delivery_terms ? `Delivery: ${settings.standard_delivery_terms}` : null,
            settings.standard_warranty_terms ? `Warranty: ${settings.standard_warranty_terms}` : null,
          ].filter(Boolean).join('\n');

      const initialStatus = input.initialStatus === 'sent' ? 'sent' : 'draft';

      const insertRes = await client.query(
        `INSERT INTO quotations (
          quotation_number, quotation_date, valid_until,
          customer_id, customer_name, customer_address, customer_phone, customer_gstin,
          customer_state, customer_state_code,
          project_title, subject, company_snapshot,
          subtotal, discount_type, discount_value, discount_amount, taxable_amount,
          gst_enabled, gst_rate, cgst_amount, sgst_amount, igst_amount, tax_amount,
          grand_total, amount_in_words, terms_and_conditions, notes, status,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6, $7, $8,
          $9, $10,
          $11, $12, $13,
          $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24,
          $25, $26, $27, $28, $29,
          NOW(), NOW()
        ) RETURNING *`,
        [
          quotationNumber,
          quotationDate,
          validUntil,
          input.customerId || null,
          input.customerName.trim(),
          input.customerAddress?.trim() || null,
          input.customerPhone?.trim() || null,
          input.customerGstin?.trim() || null,
          customerState,
          customerStateCode,
          input.projectTitle?.trim() || null,
          input.subject?.trim() || null,
          JSON.stringify(companySnapshot),
          calc.subtotal,
          calc.discountType,
          calc.discountValue,
          calc.discountAmount,
          calc.taxableAmount,
          calc.gstEnabled,
          calc.gstRate,
          calc.cgstAmount,
          calc.sgstAmount,
          calc.igstAmount,
          calc.taxAmount,
          calc.grandTotal,
          calc.amountInWords,
          termsAndConditions || null,
          input.notes?.trim() || null,
          initialStatus,
        ]
      );

      const quotationRecord: QuotationRecord = insertRes.rows[0];

      // Insert line items
      const itemRecords: QuotationItemRecord[] = [];
      for (let i = 0; i < calc.items.length; i++) {
        const it = calc.items[i];
        const itemRes = await client.query(
          `INSERT INTO quotation_items (
            quotation_id, product_id, item_index, description,
            hsn_code, barcode, quantity, unit, rate, rate_unit, amount, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
          RETURNING *`,
          [
            quotationRecord.id,
            it.productId || null,
            i,
            it.description.trim(),
            it.hsnCode?.trim() || null,
            it.barcode?.trim() || null,
            it.quantity,
            it.unit?.trim() || null,
            it.rate,
            it.rateUnit?.trim() || null,
            it.amount,
          ]
        );
        itemRecords.push(itemRes.rows[0]);
      }

      await client.query('COMMIT');
      return { ...quotationRecord, items: itemRecords };
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
  }

  /**
   * Retrieves single quotation by ID with line items
   */
  public async getQuotationById(id: number): Promise<QuotationRecord | null> {
    const res = await appPool.query('SELECT * FROM quotations WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;

    const quotation: QuotationRecord = res.rows[0];
    const itemsRes = await appPool.query(
      'SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY item_index ASC',
      [id]
    );
    quotation.items = itemsRes.rows;
    return quotation;
  }

  /**
   * Lists quotations with search, date, status filters, and summary metrics.
   * Supports 'rejected_or_expired' compound filter and dashboard pagination.
   */
  public async listQuotations(query: {
    status?: 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'converted' | 'rejected_or_expired';
    search?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    quotations: QuotationRecord[];
    pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
    summaryCounts: {
      total: number;
      draft: number;
      sent: number;
      accepted: number;
      converted: number;
      rejectedOrExpired: number;
    };
  }> {
    const limit = Math.min(Math.max(query.limit || 25, 1), 100);
    const offset = Math.max(query.offset || 0, 0);

    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (query.status === 'rejected_or_expired') {
      conditions.push(`status IN ('rejected', 'expired')`);
    } else if (query.status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(query.status);
    }

    if (query.search && query.search.trim()) {
      const term = `%${escapeLike(query.search.trim())}%`;
      conditions.push(`(
        quotation_number ILIKE $${params.length + 1} OR
        customer_name ILIKE $${params.length + 1} OR
        project_title ILIKE $${params.length + 1} OR
        subject ILIKE $${params.length + 1}
      )`);
      params.push(term);
    }

    if (query.startDate) {
      conditions.push(`quotation_date >= $${params.length + 1}::DATE`);
      params.push(query.startDate);
    }

    if (query.endDate) {
      conditions.push(`quotation_date <= $${params.length + 1}::DATE`);
      params.push(query.endDate);
    }

    const whereClause = conditions.join(' AND ');

    // 1. Fetch paginated list
    const sql = `
      SELECT *
      FROM quotations
      WHERE ${whereClause}
      ORDER BY quotation_date DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit + 1, offset);

    const listRes = await appPool.query(sql, params);
    const hasMore = listRes.rows.length > limit;
    const rawQuotations = hasMore ? listRes.rows.slice(0, limit) : listRes.rows;

    // 2. Fetch metrics counts
    const countsRes = await appPool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'draft') AS draft,
        COUNT(*) FILTER (WHERE status = 'sent') AS sent,
        COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
        COUNT(*) FILTER (WHERE status = 'converted') AS converted,
        COUNT(*) FILTER (WHERE status IN ('rejected', 'expired')) AS rejected_or_expired
      FROM quotations
    `);

    const counts = countsRes.rows[0] || {};

    return {
      quotations: rawQuotations,
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
      summaryCounts: {
        total: Number(counts.total || 0),
        draft: Number(counts.draft || 0),
        sent: Number(counts.sent || 0),
        accepted: Number(counts.accepted || 0),
        converted: Number(counts.converted || 0),
        rejectedOrExpired: Number(counts.rejected_or_expired || 0),
      },
    };
  }

  /**
   * Updates a quotation's commercial status atomically.
   * Prevents changing status if already converted.
   */
  public async updateQuotationStatus(
    id: number,
    status: 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired'
  ): Promise<QuotationRecord | null> {
    const res = await appPool.query(
      `UPDATE quotations
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND status <> 'converted'
       RETURNING *`,
      [status, id]
    );

    if ((res.rowCount ?? 0) === 0) {
      const existing = await this.getQuotationById(id);
      if (!existing) return null;
      if (existing.status === 'converted') {
        throw new AppError('Cannot alter the status of an already converted quotation.', 400, 'ALREADY_CONVERTED');
      }
      return null;
    }

    return res.rows[0];
  }

  /**
   * Converts an accepted quotation into an official Normal Bill or GST Invoice.
   * Uses a single PostgreSQL connection and transaction boundary for atomic conversion.
   * Strictly prevents orphaned bills, double conversions, and un-discounted calculations.
   */
  public async convertToBill(
    id: number,
    input: { billType: 'normal' | 'gst'; force?: boolean; gstRateOverride?: number | string }
  ): Promise<{ quotation: QuotationRecord; billType: 'normal' | 'gst'; billId: number; billNumber: string }> {
    const client = await appPool.connect();

    try {
      await client.query('BEGIN');

      // 1. Lock quotation record for update
      const lockRes = await client.query('SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [id]);
      if (lockRes.rows.length === 0) {
        throw new AppError('Quotation not found.', 404, 'NOT_FOUND');
      }

      const quotation: QuotationRecord = lockRes.rows[0];

      // 2. Prevent double conversion
      if (
        quotation.status === 'converted' ||
        quotation.converted_normal_bill_id ||
        quotation.converted_gst_invoice_id
      ) {
        throw new AppError('This quotation has already been converted to a bill.', 409, 'ALREADY_CONVERTED');
      }

      // 3. Expiry check: if valid_until < CURRENT_DATE, reject unless forced
      const todayStr = new Date().toISOString().slice(0, 10);
      if (quotation.valid_until && quotation.valid_until < todayStr && !input.force) {
        throw new AppError(
          `This quotation expired on ${quotation.valid_until}. Set force=true to convert anyway.`,
          400,
          'EXPIRED_QUOTATION'
        );
      }

      // 4. Status check: must be accepted, unless explicitly forced
      if (quotation.status !== 'accepted' && !input.force) {
        throw new AppError(
          `Only accepted quotations can be converted to bills (Current status: "${quotation.status}"). Set force=true to override.`,
          400,
          'QUOTATION_NOT_ACCEPTED'
        );
      }

      // 5. Fetch quotation items
      const itemsRes = await client.query(
        'SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY item_index ASC',
        [id]
      );
      const items: QuotationItemRecord[] = itemsRes.rows;

      let billId: number;
      let billNumber: string;
      let updatedQuotation: QuotationRecord;

      if (input.billType === 'normal') {
        // Convert to Normal Bill within the SAME transaction
        const normalBill = await normalBillsService.createBillInTransaction(client, {
          customerName: quotation.customer_name,
          customerAddress: quotation.customer_address,
          customerPhone: quotation.customer_phone,
          customerId: quotation.customer_id,
          customerState: quotation.customer_state || 'Bihar',
          customerStateCode: quotation.customer_state_code || '10',
          subtotalAmount: quotation.subtotal,
          discountType: quotation.discount_type,
          discountValue: quotation.discount_value,
          discountAmount: quotation.discount_amount,
          notes: `Converted from Quotation ${quotation.quotation_number}`,
          items: items.map((it) => ({
            productId: it.product_id,
            description: it.description,
            hsnCode: it.hsn_code,
            quantity: it.quantity,
            unit: it.unit,
            rate: it.rate,
            rateUnit: it.rate_unit,
          })),
        });

        billId = normalBill.id;
        billNumber = normalBill.bill_number;

        const updateRes = await client.query(
          `UPDATE quotations
           SET status = 'converted',
               converted_normal_bill_id = $1,
               updated_at = NOW()
           WHERE id = $2 AND status <> 'converted'
           RETURNING *`,
          [normalBill.id, id]
        );

        if ((updateRes.rowCount ?? 0) === 0) {
          throw new AppError('Quotation conversion race condition detected.', 409, 'ALREADY_CONVERTED');
        }

        updatedQuotation = updateRes.rows[0];
      } else {
        // Convert to GST Invoice within the SAME transaction
        let appliedGstRate: number | string;
        if (quotation.gst_enabled) {
          appliedGstRate = quotation.gst_rate;
        } else {
          if (input.gstRateOverride === undefined || input.gstRateOverride === null || input.gstRateOverride === '') {
            throw new AppError(
              'Quotation does not have GST enabled. An explicit gstRateOverride is required to convert to a GST invoice.',
              400,
              'GST_RATE_REQUIRED'
            );
          }
          appliedGstRate = input.gstRateOverride;
        }

        const gstInvoice = await gstInvoicesService.createInvoiceInTransaction(client, {
          customerName: quotation.customer_name,
          customerAddress: quotation.customer_address,
          customerGstin: quotation.customer_gstin,
          customerPhone: quotation.customer_phone,
          customerState: quotation.customer_state || 'Bihar',
          customerStateCode: quotation.customer_state_code || '10',
          customerId: quotation.customer_id,
          gstRate: appliedGstRate,
          subtotalAmount: quotation.subtotal,
          discountType: quotation.discount_type,
          discountValue: quotation.discount_value,
          discountAmount: quotation.discount_amount,
          notes: `Converted from Quotation ${quotation.quotation_number}`,
          items: items.map((it) => ({
            productId: it.product_id,
            description: it.description,
            hsnCode: it.hsn_code,
            quantity: it.quantity,
            unit: it.unit,
            rate: it.rate,
            rateUnit: it.rate_unit,
          })),
        });

        billId = gstInvoice.id;
        billNumber = gstInvoice.invoice_number;

        const updateRes = await client.query(
          `UPDATE quotations
           SET status = 'converted',
               converted_gst_invoice_id = $1,
               updated_at = NOW()
           WHERE id = $2 AND status <> 'converted'
           RETURNING *`,
          [gstInvoice.id, id]
        );

        if ((updateRes.rowCount ?? 0) === 0) {
          throw new AppError('Quotation conversion race condition detected.', 409, 'ALREADY_CONVERTED');
        }

        updatedQuotation = updateRes.rows[0];
      }

      await client.query('COMMIT');

      // Post-commit: Asynchronously trigger background PDF generation/upload for the created bill
      // Never fail the conversion if R2 or background PDF generation fails
      try {
        if (input.billType === 'normal') {
          normalBillsService.getBillPdf(billId).catch((e) => console.warn('[CONVERT BILL PDF BG ERROR]', e));
        } else {
          gstInvoicesService.getInvoicePdf(billId).catch((e) => console.warn('[CONVERT INVOICE PDF BG ERROR]', e));
        }
      } catch {
        // Non-fatal
      }

      return {
        quotation: updatedQuotation,
        billType: input.billType,
        billId,
        billNumber,
      };
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
  }
}

export const quotationsService = new QuotationsService();
