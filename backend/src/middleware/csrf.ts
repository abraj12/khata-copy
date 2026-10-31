import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env.js';

const ALLOWED_ORIGINS = new Set([
  env.FRONTEND_URL,
  'https://khata.algions.in',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
]);

/**
 * Generates a cryptographically strong 32-byte CSRF token.
 */
export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Checks whether an origin or referer is allowed.
 */
export function isAllowedOrigin(originHeader?: string, refererHeader?: string): boolean {
  if (originHeader) {
    return ALLOWED_ORIGINS.has(originHeader);
  }
  if (refererHeader) {
    try {
      const url = new URL(refererHeader);
      return ALLOWED_ORIGINS.has(url.origin);
    } catch {
      return false;
    }
  }
  // If neither origin nor referer is provided (e.g. some native apps or direct server-to-server),
  // in development/test allow, but in production fail closed on browser state-changing requests
  return env.NODE_ENV !== 'production';
}

/**
 * CSRF and Origin Protection Middleware
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  if (safeMethods.has(req.method)) {
    return next();
  }

  // 1. Strict Origin / Referer check on all state-changing requests
  const origin = req.headers.origin as string | undefined;
  const referer = req.headers.referer as string | undefined;

  if (origin || referer) {
    if (!isAllowedOrigin(origin, referer)) {
      res.status(403).json({
        success: false,
        message: 'CSRF validation error: Unauthorized request origin.',
      });
      return;
    }
  }

  // 2. Login endpoint (/api/v1/auth/login) is exempt from session CSRF token check
  // because the session does not exist prior to login. Origin check is already performed above.
  if (req.path === '/api/v1/auth/login' || req.originalUrl?.includes('/auth/login')) {
    return next();
  }

  // 3. For all other state-changing requests, validate synchronizer token
  const clientToken = (req.headers['x-csrf-token'] as string) || (req.body?._csrf as string);
  const sessionToken = req.session?.csrfToken;

  if (!clientToken || !sessionToken || clientToken !== sessionToken) {
    res.status(403).json({
      success: false,
      message: 'CSRF validation error: Missing or invalid CSRF token.',
    });
    return;
  }

  next();
}
