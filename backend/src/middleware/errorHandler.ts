import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export function errorHandler(
  err: Error & { status?: number; statusCode?: number; type?: string; code?: string; candidates?: unknown[] },
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();

  // Handle CORS unauthorized origin errors
  if (err.message && err.message.includes('CORS origin')) {
    res.status(403).json({
      success: false,
      code: 'CORS_FORBIDDEN',
      message: 'CSRF/CORS validation error: Origin not permitted.',
      requestId,
    });
    return;
  }

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    res.status(400).json({
      success: false,
      code: 'MALFORMED_JSON',
      message: 'Malformed request payload. Invalid JSON format.',
      requestId,
    });
    return;
  }

  // Handle payload too large
  if (err.type === 'entity.too.large') {
    res.status(413).json({
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request payload exceeds allowed limit.',
      requestId,
    });
    return;
  }

  const statusCode = err.status || err.statusCode || 500;
  const errorCode = err.code || (
    statusCode === 400 ? 'VALIDATION_ERROR' :
    statusCode === 401 ? 'UNAUTHORIZED' :
    statusCode === 403 ? 'FORBIDDEN' :
    statusCode === 404 ? 'NOT_FOUND' :
    statusCode === 409 ? 'CONFLICT' :
    statusCode === 429 ? 'TOO_MANY_REQUESTS' :
    statusCode === 503 ? 'SERVICE_UNAVAILABLE' :
    'INTERNAL_SERVER_ERROR'
  );

  // Redact raw database or connection string leaks from messages
  let publicMessage = err.message || 'Internal Server Error';
  if (
    publicMessage.includes('password') ||
    publicMessage.includes('postgresql://') ||
    publicMessage.includes('syntax error at or near') ||
    publicMessage.includes('pg_') ||
    (statusCode >= 500 && statusCode !== 503 && env.NODE_ENV === 'production')
  ) {
    publicMessage = statusCode === 503
      ? 'The service is temporarily unavailable. Please retry shortly.'
      : 'An unexpected internal server error occurred.';
  }

  if (statusCode >= 500) {
    console.error(`[UNHANDLED SERVER ERROR] [${requestId}]`, err);
  } else if (env.NODE_ENV === 'development') {
    console.warn(`[CLIENT ERROR ${statusCode}] [${requestId}] ${err.message}`);
  }

  const responseBody: Record<string, unknown> = {
    success: false,
    code: errorCode,
    message: publicMessage,
    requestId,
  };

  if (err.candidates) {
    responseBody.candidates = err.candidates;
  }

  res.status(statusCode).json(responseBody);
}
