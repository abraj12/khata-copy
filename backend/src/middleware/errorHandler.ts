import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export function errorHandler(
  err: Error & { status?: number; statusCode?: number; type?: string },
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  // Handle CORS unauthorized origin errors
  if (err.message && err.message.includes('CORS origin')) {
    res.status(403).json({
      success: false,
      message: 'CSRF/CORS validation error: Origin not permitted.',
    });
    return;
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    res.status(400).json({
      success: false,
      message: 'Malformed request payload. Invalid JSON format.',
    });
    return;
  }

  // Handle payload too large
  if (err.type === 'entity.too.large') {
    res.status(413).json({
      success: false,
      message: 'Request payload exceeds allowed limit.',
    });
    return;
  }

  const statusCode = err.status || err.statusCode || 500;

  if (env.NODE_ENV !== 'production') {
    console.error('[UNHANDLED ERROR]', err);
  }

  res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 && env.NODE_ENV === 'production'
      ? 'An unexpected internal server error occurred.'
      : err.message || 'Internal Server Error',
  });
}
