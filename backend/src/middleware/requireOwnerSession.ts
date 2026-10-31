import { Request, Response, NextFunction } from 'express';

// Augment express-session types to include owner session properties
declare module 'express-session' {
  interface SessionData {
    authenticated?: boolean;
    role?: 'OWNER';
    ownerPhone?: string;
    csrfToken?: string;
    loginTime?: number;
  }
}

/**
 * Guard middleware requiring an active, valid server-side owner session.
 * Always fails closed and sets Cache-Control: no-store.
 */
export function requireOwnerSession(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  if (!req.session || !req.session.authenticated || req.session.role !== 'OWNER') {
    res.status(401).json({
      success: false,
      authenticated: false,
      message: 'Authentication required. Active owner session not found.',
    });
    return;
  }

  next();
}
