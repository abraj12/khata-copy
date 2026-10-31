import { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env.js';
import { authService } from './auth.service.js';
import { loginSchema } from './auth.validation.js';
import { loginAttemptStore } from './loginAttemptStore.js';
import { generateCsrfToken } from '../../middleware/csrf.js';

export class AuthController {
  /**
   * Helper to retrieve client IP using Express req.ip (which respects trust proxy)
   */
  private getClientIp(req: Request): string {
    return req.ip || req.socket.remoteAddress || '127.0.0.1';
  }

  /**
   * POST /api/v1/auth/login
   */
  public login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    try {
      // 1. Validate request body schema
      const parseResult = loginSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          success: false,
          message: parseResult.error.errors[0]?.message || 'Invalid login payload format.',
        });
        return;
      }

      const { phone, password } = parseResult.data;
      const clientIp = this.getClientIp(req);

      // 2. Persistent lockout check
      const lockout = await loginAttemptStore.checkLockout(clientIp, phone);
      if (lockout.isLocked) {
        res.status(429).json({
          success: false,
          isLocked: true,
          remainingMs: lockout.remainingMs,
          message: lockout.message || 'Too many failed login attempts. Please try again later.',
        });
        return;
      }

      // 3. Verify owner credentials (Argon2id + constant-time dummy verification on unknown phone)
      const { success, normalizedPhone } = await authService.verifyCredentials(phone, password);

      if (!success || !normalizedPhone) {
        // Record failed attempt
        await loginAttemptStore.recordAttempt(clientIp, normalizedPhone || phone, false);

        // Uniform generic error response (no account enumeration)
        res.status(401).json({
          success: false,
          authenticated: false,
          message: 'Invalid mobile number or password.',
        });
        return;
      }

      // Record successful attempt
      await loginAttemptStore.recordAttempt(clientIp, normalizedPhone, true);

      // 4. Regenerate session to eliminate session fixation
      req.session.regenerate((err) => {
        if (err) {
          console.error('[AUTH ERROR] Session regeneration failure:', err);
          res.status(500).json({ success: false, message: 'Authentication session error.' });
          return;
        }

        // 5. Store authenticated owner state in server-side session
        req.session.authenticated = true;
        req.session.role = 'OWNER';
        req.session.ownerPhone = normalizedPhone;
        req.session.csrfToken = generateCsrfToken();
        req.session.loginTime = Date.now();

        // 6. Explicitly save session before returning HTTP 200
        req.session.save((saveErr) => {
          if (saveErr) {
            console.error('[AUTH ERROR] Session save failure:', saveErr);
            res.status(500).json({ success: false, message: 'Failed to establish session.' });
            return;
          }

          // Return minimal JSON, opaque cookie is set by Express session
          res.status(200).json({
            success: true,
            authenticated: true,
            owner: {
              role: 'OWNER',
            },
          });
        });
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/auth/me
   */
  public me = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    if (!req.session || !req.session.authenticated || req.session.role !== 'OWNER') {
      res.status(401).json({
        success: false,
        authenticated: false,
        message: 'No active authenticated session found.',
      });
      return;
    }

    res.status(200).json({
      success: true,
      authenticated: true,
      owner: {
        role: 'OWNER',
        phone: req.session.ownerPhone,
      },
    });
  };

  /**
   * GET /api/v1/auth/csrf-token
   */
  public getCsrfToken = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    if (!req.session.csrfToken) {
      req.session.csrfToken = generateCsrfToken();
      await new Promise<void>((resolve) => req.session.save(() => resolve()));
    }

    res.status(200).json({
      success: true,
      csrfToken: req.session.csrfToken,
    });
  };

  /**
   * POST /api/v1/auth/logout
   */
  public logout = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    req.session.destroy((err) => {
      if (err) {
        console.error('[AUTH ERROR] Session destroy error:', err);
      }

      // Clear cookie with exact matching options
      res.clearCookie(env.SESSION_COOKIE_NAME, {
        path: '/',
        httpOnly: env.SESSION_COOKIE_HTTP_ONLY,
        secure: env.SESSION_COOKIE_SECURE,
        sameSite: env.SESSION_COOKIE_SAME_SITE,
      });

      res.status(200).json({
        success: true,
        authenticated: false,
        message: 'Logged out successfully.',
      });
    });
  };
}

export const authController = new AuthController();
