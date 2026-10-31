import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env.js';

const PRODUCTION_ALLOWED_ORIGINS = new Set([
  env.FRONTEND_URL,
  'https://khata.algions.in',
  'capacitor://localhost',
  'https://localhost',
]);

const DEV_ALLOWED_ORIGINS = new Set([
  ...PRODUCTION_ALLOWED_ORIGINS,
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
 * Strict in production: localhost and dev origins are forbidden.
 */
export function isAllowedOrigin(originHeader?: string, refererHeader?: string): boolean {
  const allowedSet = env.NODE_ENV === 'production' ? PRODUCTION_ALLOWED_ORIGINS : DEV_ALLOWED_ORIGINS;

  if (originHeader) {
    return allowedSet.has(originHeader);
  }
  if (refererHeader) {
    try {
      const url = new URL(refererHeader);
      return allowedSet.has(url.origin);
    } catch {
      return false;
    }
  }
  // If neither origin nor referer is provided:
  // In development/test allow, but in production fail closed on browser state-changing requests
  return (env.NODE_ENV as string) !== 'production';
}

/**
 * Constant-time comparison for CSRF tokens
 */
function safeTokenCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
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
        message: 'Origin or Referer not permitted.',
      });
      return;
    }
  } else if (env.NODE_ENV === 'production') {
    // In production, require Origin or Referer on state-changing requests
    res.status(403).json({
      success: false,
      message: 'State-changing requests must supply a valid Origin or Referer header.',
    });
    return;
  }

  // 2. CSRF Token verification for session-authenticated state-changing requests
  // Login endpoint does not require CSRF token since session is not established yet
  if (req.path === '/api/v1/auth/login' || req.originalUrl === '/api/v1/auth/login') {
    return next();
  }

  // If a session exists and has a csrfToken, verify the token
  if (req.session && req.session.authenticated) {
    const headerToken = req.headers['x-csrf-token'] as string | undefined;
    const bodyToken = (req.body && (req.body._csrf || req.body.csrfToken)) as string | undefined;
    const submittedToken = headerToken || bodyToken;

    if (!submittedToken || !req.session.csrfToken || !safeTokenCompare(submittedToken, req.session.csrfToken)) {
      res.status(403).json({
        success: false,
        message: 'Invalid or missing CSRF token.',
      });
      return;
    }
  }

  next();
}
