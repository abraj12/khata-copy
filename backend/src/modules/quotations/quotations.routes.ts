import { Router, Request, Response, NextFunction } from 'express';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { env } from '../../config/env.js';
import { getBusinessDateISO } from '../../utils/businessDate.js';
import { resolveValidatedState, validateGstin, validateGstinForState } from '../../utils/indianTax.js';
import { getCompanyTaxProfile } from '../../services/companyTaxProfile.service.js';
import { quotationsService } from './quotations.service.js';
import { generateQuotationPdf } from './quotations.pdf.js';
import {
  createQuotationSchema,
  updateQuotationStatusSchema,
  quotationSettingsSchema,
  convertToBillSchema,
  quotationQuerySchema,
} from './quotations.validation.js';

const router = Router();

// Protect all quotation endpoints with owner authentication
router.use(requireOwnerSession);

/**
 * GET /api/v1/quotations/next-number - Suggests the next sequential quotation number
 */
router.get('/next-number', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const nextNumber = await quotationsService.getNextQuotationNumber();
    res.json({ success: true, data: { nextNumber } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/quotations/settings - Retrieves configurable company profile & default terms
 */
router.get('/settings', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await quotationsService.getSettings();
    res.json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/quotations/settings - Updates configurable company profile & terms
 */
router.put('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = quotationSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid settings payload.',
      });
      return;
    }

    const updated = await quotationsService.updateSettings(parsed.data);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/quotations/preview-pdf - Generates a quotation PDF on the fly without saving
 */
router.post('/preview-pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createQuotationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid quotation payload for preview.',
      });
      return;
    }

    const companyProfile = await getCompanyTaxProfile();
    const resolvedCustomerState = resolveValidatedState({
      state: parsed.data.customerState,
      stateCode: parsed.data.customerStateCode,
      required: parsed.data.gstEnabled,
      fieldLabel: 'Customer',
    });

    const validatedCustomerGstin = parsed.data.customerGstin
      ? resolvedCustomerState.stateCode
        ? validateGstinForState(parsed.data.customerGstin, resolvedCustomerState.stateCode)
        : validateGstin(parsed.data.customerGstin)
      : null;

    const calc = quotationsService.calculateQuotationTotals(
      parsed.data.items,
      parsed.data.discountType,
      parsed.data.discountValue,
      parsed.data.gstEnabled,
      parsed.data.gstRate,
      companyProfile.stateCode,
      resolvedCustomerState.stateCode
    );

    const quotationNumber = parsed.data.quotationNumber || 'PREVIEW-QT';
    const quotationDate = parsed.data.quotationDate || getBusinessDateISO(env.BUSINESS_TIME_ZONE);

    const pdfBuffer = await generateQuotationPdf({
      quotationNumber,
      quotationDate,
      validUntil: parsed.data.validUntil || null,
      company: {
        companyName: companyProfile.companyName,
        logoUrl: companyProfile.logoUrl,
        cin: companyProfile.cin,
        gstin: companyProfile.gstin,
        address: companyProfile.address,
        email: companyProfile.email,
        phone: companyProfile.phone,
        website: companyProfile.website,
        state: companyProfile.state,
        stateCode: companyProfile.stateCode,
        bankName: companyProfile.bankName,
        bankAccountNumber: companyProfile.bankAccountNumber,
        bankIfsc: companyProfile.bankIfsc,
        bankBranch: companyProfile.bankBranch,
        signatoryTitle: companyProfile.signatoryTitle,
      },
      customer: {
        name: parsed.data.customerName,
        address: parsed.data.customerAddress,
        phone: parsed.data.customerPhone,
        gstin: validatedCustomerGstin,
        state: resolvedCustomerState.state ?? undefined,
        stateCode: resolvedCustomerState.stateCode ?? undefined,
      },
      projectTitle: parsed.data.projectTitle,
      subject: parsed.data.subject,
      items: calc.items.map((it, idx) => ({
        itemIndex: idx,
        description: it.description,
        hsnCode: it.hsnCode,
        barcode: it.barcode,
        quantity: it.quantity,
        unit: it.unit,
        rate: it.rate,
        rateUnit: it.rateUnit,
        amount: it.amount,
      })),
      totals: {
        subtotal: calc.subtotal,
        discountType: calc.discountType,
        discountValue: calc.discountValue,
        discountAmount: calc.discountAmount,
        taxableAmount: calc.taxableAmount,
        gstEnabled: calc.gstEnabled,
        gstRate: calc.gstRate,
        cgstAmount: calc.cgstAmount,
        sgstAmount: calc.sgstAmount,
        igstAmount: calc.igstAmount,
        taxAmount: calc.taxAmount,
        grandTotal: calc.grandTotal,
      },
      amountInWords: calc.amountInWords,
      termsAndConditions: parsed.data.termsAndConditions || null,
      notes: parsed.data.notes || null,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Quotation-Preview.pdf"');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/quotations - List quotations with filters & metrics
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = quotationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid query parameters.',
      });
      return;
    }

    const result = await quotationsService.listQuotations(parsed.data);
    res.json({ success: true, data: result.quotations, pagination: result.pagination, summaryCounts: result.summaryCounts });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/quotations/:id/pdf - Download or stream PDF for saved quotation
 */
router.get('/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid quotation ID.' });
      return;
    }

    const quotation = await quotationsService.getQuotationById(id);
    if (!quotation) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Quotation not found.' });
      return;
    }

    const pdfBuffer = await generateQuotationPdf({
      quotationNumber: quotation.quotation_number,
      quotationDate: quotation.quotation_date,
      validUntil: quotation.valid_until,
      company: quotation.company_snapshot,
      customer: {
        name: quotation.customer_name,
        address: quotation.customer_address,
        phone: quotation.customer_phone,
        gstin: quotation.customer_gstin,
        state: quotation.customer_state ?? undefined,
        stateCode: quotation.customer_state_code ?? undefined,
      },
      projectTitle: quotation.project_title,
      subject: quotation.subject,
      items: (quotation.items || []).map((it) => ({
        itemIndex: it.item_index,
        description: it.description,
        hsnCode: it.hsn_code,
        barcode: it.barcode,
        quantity: it.quantity,
        unit: it.unit,
        rate: it.rate,
        rateUnit: it.rate_unit,
        amount: it.amount,
      })),
      totals: {
        subtotal: quotation.subtotal,
        discountType: quotation.discount_type,
        discountValue: quotation.discount_value,
        discountAmount: quotation.discount_amount,
        taxableAmount: quotation.taxable_amount,
        gstEnabled: quotation.gst_enabled,
        gstRate: quotation.gst_rate,
        cgstAmount: quotation.cgst_amount,
        sgstAmount: quotation.sgst_amount,
        igstAmount: quotation.igst_amount,
        taxAmount: quotation.tax_amount,
        grandTotal: quotation.grand_total,
      },
      amountInWords: quotation.amount_in_words,
      termsAndConditions: quotation.terms_and_conditions,
      notes: quotation.notes,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Quotation-${quotation.quotation_number}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/quotations/:id - Retrieve full quotation by ID
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid quotation ID.' });
      return;
    }

    const quotation = await quotationsService.getQuotationById(id);
    if (!quotation) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Quotation not found.' });
      return;
    }

    res.json({ success: true, data: quotation });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/quotations - Create a new quotation
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createQuotationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid quotation payload.',
      });
      return;
    }

    const created = await quotationsService.createQuotation(parsed.data);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/quotations/:id/status - Update quotation status
 */
router.patch('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid quotation ID.' });
      return;
    }

    const parsed = updateQuotationStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid status payload.',
      });
      return;
    }

    const updated = await quotationsService.updateQuotationStatus(id, parsed.data.status);
    if (!updated) {
      res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Quotation not found.' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/quotations/:id/convert-to-bill - Convert accepted quotation to Normal Bill or GST Invoice
 */
router.post('/:id/convert-to-bill', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid quotation ID.' });
      return;
    }

    const parsed = convertToBillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: parsed.error.errors[0]?.message || 'Invalid conversion payload.',
      });
      return;
    }

    const result = await quotationsService.convertToBill(id, parsed.data);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
