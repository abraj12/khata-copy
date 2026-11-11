import { Request, Response, NextFunction } from 'express';
import { suppliersService } from './suppliers.service.js';
import { storageService } from '../../services/storage.service.js';
import {
  allocateAdvanceSchema,
  cancelPurchaseBillSchema,
  createPurchaseBillSchema,
  createSupplierPaymentSchema,
  createSupplierSchema,
  extractAndValidateIdempotencyKey,
  listPurchaseBillsQuerySchema,
  listSupplierPaymentsQuerySchema,
  listSuppliersQuerySchema,
  reversePaymentAllocationSchema,
  reversePaymentSchema,
  supplierStatementQuerySchema,
  supplierDashboardQuerySchema,
  updatePurchaseBillSchema,
  updateSupplierSchema,
  uuidParamSchema,
} from './suppliers.validation.js';

function parsePositiveIntId(raw: string, label: string): number | null {
  const id = parseInt(raw, 10);
  if (Number.isNaN(id) || id <= 0 || String(id) !== raw.trim()) {
    return null;
  }
  return id;
}

function sendValidationError(res: Response, message: string): void {
  res.status(400).json({
    success: false,
    code: 'VALIDATION_ERROR',
    message,
  });
}

export const suppliersController = {
  async getDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = supplierDashboardQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid dashboard query.');
        return;
      }
      const data = await suppliersService.getDashboard(parsed.data);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async listSuppliers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = listSuppliersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid supplier query.');
        return;
      }
      const data = await suppliersService.listSuppliers(parsed.data);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async getSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsedId = uuidParamSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        sendValidationError(res, parsedId.error.errors[0]?.message || 'Invalid supplier ID.');
        return;
      }
      const supplier = await suppliersService.getSupplierById(parsedId.data);
      res.json({ success: true, data: supplier });
    } catch (err) {
      next(err);
    }
  },

  async createSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = createSupplierSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid supplier payload.');
        return;
      }
      const supplier = await suppliersService.createSupplier(parsed.data);
      res.status(201).json({ success: true, data: supplier });
    } catch (err) {
      next(err);
    }
  },

  async updateSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsedId = uuidParamSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        sendValidationError(res, parsedId.error.errors[0]?.message || 'Invalid supplier ID.');
        return;
      }
      const parsed = updateSupplierSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid supplier update payload.');
        return;
      }
      const supplier = await suppliersService.updateSupplier(parsedId.data, parsed.data);
      res.json({ success: true, data: supplier });
    } catch (err) {
      next(err);
    }
  },

  async archiveSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsedId = uuidParamSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        sendValidationError(res, parsedId.error.errors[0]?.message || 'Invalid supplier ID.');
        return;
      }
      const supplier = await suppliersService.archiveSupplier(parsedId.data);
      res.json({ success: true, data: supplier });
    } catch (err) {
      next(err);
    }
  },

  async restoreSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsedId = uuidParamSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        sendValidationError(res, parsedId.error.errors[0]?.message || 'Invalid supplier ID.');
        return;
      }
      const supplier = await suppliersService.restoreSupplier(parsedId.data);
      res.json({ success: true, data: supplier });
    } catch (err) {
      next(err);
    }
  },

  async deleteSupplier(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsedId = uuidParamSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        sendValidationError(res, parsedId.error.errors[0]?.message || 'Invalid supplier ID.');
        return;
      }
      await suppliersService.deleteSupplier(parsedId.data);
      res.json({ success: true, message: 'Supplier deleted permanently.' });
    } catch (err) {
      next(err);
    }
  },

  async listPurchaseBills(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = listPurchaseBillsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid purchase bills query.');
        return;
      }
      const openOnly = req.query.openOnly === 'true' || req.query.openOnly === '1';
      const data = await suppliersService.listPurchaseBills({ ...parsed.data, openOnly });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async getPurchaseBill(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const billId = parsePositiveIntId(req.params.billId, 'purchase bill ID');
      if (!billId) {
        sendValidationError(res, 'Invalid purchase bill ID.');
        return;
      }
      const bill = await suppliersService.getPurchaseBillById(billId);
      res.json({ success: true, data: bill });
    } catch (err) {
      next(err);
    }
  },

  async createPurchaseBill(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = createPurchaseBillSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid purchase bill payload.');
        return;
      }
      const bill = await suppliersService.createPurchaseBill(parsed.data);
      res.status(201).json({ success: true, data: bill });
    } catch (err) {
      next(err);
    }
  },

  async updatePurchaseBill(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const billId = parsePositiveIntId(req.params.billId, 'purchase bill ID');
      if (!billId) {
        sendValidationError(res, 'Invalid purchase bill ID.');
        return;
      }
      const parsed = updatePurchaseBillSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid purchase bill update payload.');
        return;
      }
      const bill = await suppliersService.updatePurchaseBill(billId, parsed.data);
      res.json({ success: true, data: bill });
    } catch (err) {
      next(err);
    }
  },

  async cancelPurchaseBill(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const billId = parsePositiveIntId(req.params.billId, 'purchase bill ID');
      if (!billId) {
        sendValidationError(res, 'Invalid purchase bill ID.');
        return;
      }
      const parsed = cancelPurchaseBillSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Cancellation reason is required.');
        return;
      }
      const bill = await suppliersService.cancelPurchaseBill(billId, parsed.data.reason);
      res.json({ success: true, data: bill });
    } catch (err) {
      next(err);
    }
  },

  async uploadPurchaseBillAttachment(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const billId = parsePositiveIntId(req.params.billId, 'purchase bill ID');
      if (!billId) {
        sendValidationError(res, 'Invalid purchase bill ID.');
        return;
      }
      if (!req.file) {
        sendValidationError(res, 'No attachment file provided. Send field named "file".');
        return;
      }

      // Verify bill exists before writing to R2
      await suppliersService.getPurchaseBillAttachmentMeta(billId);

      const uploaded = await storageService.validateAndUploadBuffer({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        folder: 'supplier-bills',
        referenceId: billId,
      });

      try {
        const updatedBill = await suppliersService.setPurchaseBillAttachment(billId, {
          objectKey: uploaded.objectKey,
          contentType: uploaded.contentType,
          sizeBytes: uploaded.sizeBytes,
          filename: req.file.originalname || `purchase-bill-${billId}`,
        });
        res.json({ success: true, data: updatedBill });
      } catch (dbErr) {
        await storageService.deleteObject(uploaded.objectKey);
        throw dbErr;
      }
    } catch (err) {
      next(err);
    }
  },

  async streamPurchaseBillAttachment(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const billId = parsePositiveIntId(req.params.billId, 'purchase bill ID');
      if (!billId) {
        sendValidationError(res, 'Invalid purchase bill ID.');
        return;
      }

      const meta = await suppliersService.getPurchaseBillAttachmentMeta(billId);
      if (!meta.attachmentObjectKey) {
        res.status(404).json({
          success: false,
          code: 'NOT_FOUND',
          message: 'No attachment found for this purchase bill.',
        });
        return;
      }

      const isDownload = req.query.download === 'true' || req.query.download === '1';
      const { stream, contentType, contentLength } = await storageService.getObjectStream(
        meta.attachmentObjectKey
      );

      res.setHeader('Content-Type', meta.attachmentContentType || contentType);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (contentLength) res.setHeader('Content-Length', contentLength);

      const fallbackExt = (meta.attachmentContentType || contentType).includes('pdf') ? 'pdf' : 'jpg';
      const filename = meta.attachmentFilename || `purchase-bill-${billId}.${fallbackExt}`;
      const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

      if (isDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${sanitized}"`);
      } else {
        res.setHeader('Content-Disposition', `inline; filename="${sanitized}"`);
        res.setHeader('Cache-Control', 'private, max-age=3600');
      }

      (stream as any).on('error', (err: unknown) => {
        if (!res.headersSent) next(err);
      });
      res.on('close', () => {
        if (typeof (stream as any).destroy === 'function') {
          (stream as any).destroy();
        }
      });

      (stream as any).pipe(res);
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.code === 'NoSuchKey') {
        res.status(404).json({
          success: false,
          code: 'NOT_FOUND',
          message: 'Purchase bill attachment not found in storage.',
        });
        return;
      }
      next(err);
    }
  },

  async deletePurchaseBillAttachment(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const billId = parsePositiveIntId(req.params.billId, 'purchase bill ID');
      if (!billId) {
        sendValidationError(res, 'Invalid purchase bill ID.');
        return;
      }
      const updated = await suppliersService.removePurchaseBillAttachment(billId);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  },

  async listPayments(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = listSupplierPaymentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid payments query.');
        return;
      }
      const data = await suppliersService.listSupplierPayments(parsed.data);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async getPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const paymentId = parsePositiveIntId(req.params.paymentId, 'payment ID');
      if (!paymentId) {
        sendValidationError(res, 'Invalid payment ID.');
        return;
      }
      const payment = await suppliersService.getSupplierPaymentById(paymentId);
      res.json({ success: true, data: payment });
    } catch (err) {
      next(err);
    }
  },

  async createPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const idempotencyKey = extractAndValidateIdempotencyKey(req.headers['idempotency-key'], true);
      const parsed = createSupplierPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid payment payload.');
        return;
      }
      const payment = await suppliersService.createSupplierPayment({
        ...parsed.data,
        idempotencyKey,
      });
      res.status(201).json({ success: true, data: payment });
    } catch (err) {
      next(err);
    }
  },

  async allocateAdvance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const paymentId = parsePositiveIntId(req.params.paymentId, 'payment ID');
      if (!paymentId) {
        sendValidationError(res, 'Invalid payment ID.');
        return;
      }
      const idempotencyKey = extractAndValidateIdempotencyKey(req.headers['idempotency-key'], true);
      const parsed = allocateAdvanceSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid allocation payload.');
        return;
      }
      const payment = await suppliersService.allocateAdvancePayment(
        paymentId,
        parsed.data.allocations,
        idempotencyKey
      );
      res.json({ success: true, data: payment });
    } catch (err) {
      next(err);
    }
  },

  async reversePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const paymentId = parsePositiveIntId(req.params.paymentId, 'payment ID');
      if (!paymentId) {
        sendValidationError(res, 'Invalid payment ID.');
        return;
      }
      const idempotencyKey = extractAndValidateIdempotencyKey(req.headers['idempotency-key'], true);
      const parsed = reversePaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, parsed.error.errors[0]?.message || 'Invalid payment reversal payload.');
        return;
      }
      const payment = await suppliersService.reverseSupplierPayment(
        paymentId,
        parsed.data.reason,
        idempotencyKey
      );
      res.json({ success: true, data: payment });
    } catch (err) {
      next(err);
    }
  },

  async reversePaymentAllocation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const paymentId = parsePositiveIntId(req.params.paymentId, 'payment ID');
      if (!paymentId) {
        sendValidationError(res, 'Invalid payment ID.');
        return;
      }
      const allocationId = parsePositiveIntId(req.params.allocationId, 'allocation ID');
      if (!allocationId) {
        sendValidationError(res, 'Invalid allocation ID.');
        return;
      }
      const idempotencyKey = extractAndValidateIdempotencyKey(req.headers['idempotency-key'], true);
      const parsed = reversePaymentAllocationSchema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(
          res,
          parsed.error.errors[0]?.message || 'Invalid allocation reversal payload.'
        );
        return;
      }
      const payment = await suppliersService.reversePaymentAllocation(
        paymentId,
        allocationId,
        parsed.data,
        idempotencyKey
      );
      res.json({ success: true, data: payment });
    } catch (err) {
      next(err);
    }
  },

  async getStatement(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsedId = uuidParamSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        sendValidationError(res, parsedId.error.errors[0]?.message || 'Invalid supplier ID.');
        return;
      }
      const parsedQuery = supplierStatementQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        sendValidationError(res, parsedQuery.error.errors[0]?.message || 'Invalid statement filter.');
        return;
      }
      const statement = await suppliersService.getSupplierStatement(parsedId.data, {
        fromDate: parsedQuery.data.fromDate,
        toDate: parsedQuery.data.toDate,
      });
      res.json({ success: true, data: statement });
    } catch (err) {
      next(err);
    }
  },

  async exportStatementCsv(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsedId = uuidParamSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        sendValidationError(res, parsedId.error.errors[0]?.message || 'Invalid supplier ID.');
        return;
      }
      const parsedQuery = supplierStatementQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        sendValidationError(res, parsedQuery.error.errors[0]?.message || 'Invalid statement filter.');
        return;
      }
      const statement = await suppliersService.getSupplierStatement(parsedId.data, {
        fromDate: parsedQuery.data.fromDate,
        toDate: parsedQuery.data.toDate,
      });
      const csv = suppliersService.formatStatementCsv(statement);
      const safeSlug = statement.supplier.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'supplier';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="supplier-statement-${safeSlug}.csv"`
      );
      res.send(csv);
    } catch (err) {
      next(err);
    }
  },
};
