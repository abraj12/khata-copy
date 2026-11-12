import type { Request, Response, NextFunction } from 'express';
import * as mongodbConfig from '../config/mongodb.js';

const EXEMPT_PATHS = new Set([
  '/api/v1/health/live',
  '/api/v1/health/ready',
  '/api/v1/health',
]);

/**
 * Global availability gate ensuring business operations never execute while
 * mandatory database services (specifically MongoDB read models and collections)
 * are unavailable or disconnected.
 *
 * Excludes only public monitoring/health probe paths.
 */
export function requireMandatoryServices(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Normalize path without trailing slashes
  const normalizedPath = req.path.replace(/\/+$/, '') || '/';

  if (EXEMPT_PATHS.has(normalizedPath) || EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  if (!mongodbConfig.isMongoReady()) {
    const mongoState = mongodbConfig.getMongoAvailabilityState();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.status(503).json({
      success: false,
      code: 'MANDATORY_SERVICE_UNAVAILABLE',
      message:
        'Khata ERP is temporarily unavailable because a mandatory database service is not ready.',
      services: {
        mongodb: mongoState,
      },
      retryable: true,
    });
    return;
  }

  next();
}
