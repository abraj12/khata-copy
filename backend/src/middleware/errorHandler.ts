import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { isSessionStoreError } from '../config/session.js';

/**
 * Checks whether an error is a PostgreSQL connection, transport, or server-shutdown error.
 * Recognizes SQLSTATE class 08, 57P01/02/03, 53300, and standard Node socket errors.
 * Preserves normal application/validation/foreign-key errors.
 */
export function isDatabaseConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as {
    code?: string;
    routine?: string;
    message?: string;
    name?: string;
  };
  const code = anyErr.code;
  if (typeof code === 'string') {
    // SQLSTATE class 08: Connection Exception (08000, 08003, 08006, 08001, 08004, 08007, 08P01)
    if (code.startsWith('08')) return true;
    // 57P01 (admin_shutdown), 57P02 (crash_shutdown), 57P03 (cannot_connect_now)
    if (code.startsWith('57P')) return true;
    // 53300 (too_many_connections)
    if (code === '53300') return true;
    // Common transport error codes
    if (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENOTFOUND'
    ) {
      return true;
    }
  }

  const msg = anyErr.message;
  if (typeof msg === 'string') {
    if (
      msg.includes('Connection terminated unexpectedly') ||
      msg.includes('timeout exceeded when connecting to database') ||
      msg.includes('Client was closed and is not available') ||
      msg.includes('Connection terminated due to connection timeout')
    ) {
      return true;
    }
  }

  return false;
}

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

  // Handle Session store errors and database connection failures affecting authentication
  if (isSessionStoreError(err) || err.code === 'SESSION_STORE_UNAVAILABLE' || err.name === 'SessionStoreError') {
    if (req.originalUrl?.includes('/api/v1/auth/me') || req.path?.includes('/me')) {
      console.log('[AUTH ME] status=503 error=SESSION_STORE_UNAVAILABLE source=errorHandler');
    }

    res.status(503).json({
      success: false,
      authenticated: false,
      code: 'SESSION_STORE_UNAVAILABLE',
      message: 'Authentication session store is temporarily unavailable. Please retry.',
      requestId,
    });
    return;
  }

  // Handle PostgreSQL connection/transient infrastructure failures
  if (isDatabaseConnectionError(err)) {
    console.warn(`[DATABASE UNAVAILABLE] [${requestId}] ${err.message}`);
    res.status(503).json({
      success: false,
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database service is temporarily unavailable.',
      retryable: true,
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

  // Redact raw database or connection string leaks from messages, including session IDs and cookies
  let publicMessage = err.message || 'Internal Server Error';
  if (
    publicMessage.includes('password') ||
    publicMessage.includes('postgresql://') ||
    publicMessage.includes('syntax error at or near') ||
    publicMessage.includes('pg_') ||
    publicMessage.includes('sid') ||
    publicMessage.includes('cookie') ||
    publicMessage.includes('session') ||
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
