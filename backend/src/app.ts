import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { createSessionMiddleware } from './config/session.js';
import { checkDatabaseReadiness } from './config/database.js';
import { csrfProtection, isAllowedOrigin } from './middleware/csrf.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { productsRoutes } from './modules/products/products.routes.js';
import { khataRoutes } from './modules/khata/khata.routes.js';
import { realtimeRoutes } from './modules/realtime/realtime.service.js';
import { offlineBillsRoutes } from './modules/offlineBills/offlineBills.routes.js';
import gstInvoicesRoutes from './modules/gstInvoices/gstInvoices.routes.js';

export function createApp(options?: { useMemoryStoreInTest?: boolean }) {
  const app = express();

  // 1. Trust proxy configuration for Render
  app.set('trust proxy', env.TRUST_PROXY);

  // 2. HTTP Security Headers with Helmet
  app.use(
    helmet({
      contentSecurityPolicy: false, // CSP is configured on frontend layer / Vercel
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  // 3. Credentialed CORS configuration
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        // Allow requests with no origin (e.g. mobile apps or curl) in development/test
        if (!requestOrigin) {
          return callback(null, true);
        }

        if (isAllowedOrigin(requestOrigin)) {
          return callback(null, true);
        }

        return callback(new Error(`CORS origin ${requestOrigin} not permitted.`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-CSRF-Token',
        'X-Requested-With',
        'Idempotency-Key',
      ],
      exposedHeaders: ['Set-Cookie'],
      optionsSuccessStatus: 204,
    })
  );

  // 4. Request Body Parsers with strict size limits to prevent buffer resource abuse
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ extended: true, limit: '10kb' }));
  app.use(cookieParser());

  // 5. Session Middleware (PostgreSQL store with 7-day rolling TTL)
  app.use(createSessionMiddleware(options));

  // 6. CSRF and Origin Protection
  app.use(csrfProtection);

  // 7. Health & Readiness Probes
  // Liveness: lightweight process-alive probe (does not wake up sleeping Neon instance)
  app.get('/api/v1/health/live', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Readiness: verifies database connectivity, schema migrations table, applied migrations, and core tables
  app.get('/api/v1/health/ready', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const dbStatus = await checkDatabaseReadiness();

    if (!dbStatus.isReady) {
      res.status(503).json({
        status: 'unready',
        database: {
          isReady: false,
          latencyMs: dbStatus.latencyMs,
          checks: dbStatus.checks,
          error: dbStatus.error,
        },
        message: 'Database service is unready: missing tables or unapplied migrations.',
      });
      return;
    }

    res.json({
      status: 'ready',
      database: dbStatus,
      timestamp: new Date().toISOString(),
    });
  });

  // Legacy / backward-compatible health check
  app.get('/api/v1/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // 8. Application Routes
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/products', productsRoutes);
  app.use('/api/v1/khata', khataRoutes);
  app.use('/api/v1/ledger', khataRoutes); // Backward compatibility
  app.use('/api/v1/realtime', realtimeRoutes);
  app.use('/api/v1/offline-bills', offlineBillsRoutes);
  app.use('/api/v1/gst-invoices', gstInvoicesRoutes);

  // 9. Centralized Error Handler
  app.use(errorHandler);

  return app;
}
