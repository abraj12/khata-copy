import { Router } from 'express';
import { authController } from './auth.controller.js';

const router = Router();

router.post('/login', authController.login);
router.get('/me', authController.me);
router.get('/csrf-token', authController.getCsrfToken);
router.post('/logout', authController.logout);

export const authRoutes = router;
