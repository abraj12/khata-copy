import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { suppliersController } from './suppliers.controller.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = Router();

// All supplier endpoints require authenticated owner session
router.use(requireOwnerSession);

// Dashboard overview & aggregate KPIs
router.get('/dashboard', suppliersController.getDashboard);

// Purchase bills (mounted before :id UUID routes for clean route matching)
router.get('/purchase-bills', suppliersController.listPurchaseBills);
router.post('/purchase-bills', suppliersController.createPurchaseBill);
router.get('/purchase-bills/:billId', suppliersController.getPurchaseBill);
router.put('/purchase-bills/:billId', suppliersController.updatePurchaseBill);
router.post('/purchase-bills/:billId/cancel', suppliersController.cancelPurchaseBill);

// Purchase bill document attachment (R2 image/PDF)
router.post(
  '/purchase-bills/:billId/attachment',
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({
            success: false,
            code: 'FILE_TOO_LARGE',
            message: 'Purchase bill attachment must not exceed 10 MB.',
          });
          return;
        }
        res.status(400).json({ success: false, code: 'UPLOAD_ERROR', message: err.message });
        return;
      }
      if (err) return next(err);
      next();
    });
  },
  suppliersController.uploadPurchaseBillAttachment
);
router.get('/purchase-bills/:billId/attachment', suppliersController.streamPurchaseBillAttachment);
router.delete('/purchase-bills/:billId/attachment', suppliersController.deletePurchaseBillAttachment);

// Supplier payments & advance allocations
router.get('/payments', suppliersController.listPayments);
router.post('/payments', suppliersController.createPayment);
router.get('/payments/:paymentId', suppliersController.getPayment);
router.post('/payments/:paymentId/allocate', suppliersController.allocateAdvance);

// Supplier master CRUD, archive/restore, and statements
router.get('/', suppliersController.listSuppliers);
router.post('/', suppliersController.createSupplier);
router.get('/:id', suppliersController.getSupplier);
router.put('/:id', suppliersController.updateSupplier);
router.post('/:id/archive', suppliersController.archiveSupplier);
router.post('/:id/restore', suppliersController.restoreSupplier);
router.delete('/:id', suppliersController.deleteSupplier);
router.get('/:id/statement', suppliersController.getStatement);
router.get('/:id/statement/export', suppliersController.exportStatementCsv);

export const suppliersRoutes = router;
