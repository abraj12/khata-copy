import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import type session from 'express-session';
import { env } from './config/env.js';
import { createSessionMiddleware } from './config/session.js';
import { checkDatabaseReadiness } from './config/database.js';
import { checkMongoReadiness, getMongoAvailabilityState } from './config/mongodb.js';
import { csrfProtection, isAllowedOrigin } from './middleware/csrf.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requireMandatoryServices } from './middleware/requireMandatoryServices.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { productsRoutes } from './modules/products/products.routes.js';
import { khataRoutes } from './modules/khata/khata.routes.js';
import { realtimeRoutes } from './modules/realtime/realtime.service.js';
import { offlineBillsRoutes } from './modules/offlineBills/offlineBills.routes.js';
import gstInvoicesRoutes from './modules/gstInvoices/gstInvoices.routes.js';
import normalBillsRoutes from './modules/normalBills/normalBills.routes.js';
import quotationsRoutes from './modules/quotations/quotations.routes.js';
import { suppliersRoutes } from './modules/suppliers/suppliers.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { appDataRouter } from './modules/appData/appData.routes.js';
import { readModelSyncRouter } from './modules/readModels/readModelSync.routes.js';

export function createApp(options?: { useMemoryStoreInTest?: boolean; customStore?: session.Store }) {
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
  app.use(express.json({ limit: '250kb' }));
  app.use(express.urlencoded({ extended: true, limit: '250kb' }));
  app.use(cookieParser());

  // 5. Public Health & Readiness Probes (zero queries on liveness; explicit readiness checks)
  app.get('/api/v1/health/live', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(200).json({
      status: 'alive',
      process: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  app.get('/api/v1/health/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const [dbStatus, mongoStatus] = await Promise.all([
      checkDatabaseReadiness(),
      checkMongoReadiness(),
    ]);

    const isPostgresReady = dbStatus.isReady;
    const isMongoOverallReady = !mongoStatus.enabled || mongoStatus.isReady;

    if (!isPostgresReady || !isMongoOverallReady) {
      console.warn('[SERVICE READINESS UNREADY]', {
        postgresReady: isPostgresReady,
        postgresLatencyMs: dbStatus.latencyMs,
        mongodbEnabled: mongoStatus.enabled,
        mongodbReady: mongoStatus.isReady,
        mongodbState: mongoStatus.state,
        mongodbLatencyMs: mongoStatus.latencyMs,
      });

      const reason = !isPostgresReady
        ? 'POSTGRES_UNAVAILABLE'
        : 'MANDATORY_MONGODB_UNAVAILABLE';

      res.status(503).json({
        status: 'unready',
        ready: false,
        services: {
          postgres: isPostgresReady ? 'ready' : 'unavailable',
          mongodb: mongoStatus.state,
        },
        reason,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      status: 'ready',
      ready: true,
      services: {
        postgres: 'ready',
        mongodb: mongoStatus.enabled ? 'ready' : 'disabled',
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/v1/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(200).json({
      status: 'healthy',
      process: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // 6. Session Middleware (PostgreSQL store with 30-day rolling TTL)
  app.use(createSessionMiddleware(options));

  // 7. CSRF and Origin Protection
  app.use(csrfProtection);

  // 8. Global Mandatory Dependencies Gate (blocks all business routes with 503 if MongoDB is down, except health and logout)
  app.use(requireMandatoryServices);

  // 9. Application Routes
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/products', productsRoutes);
  app.use('/api/v1/khata', khataRoutes);
  app.use('/api/v1/ledger', khataRoutes); // Backward compatibility
  app.use('/api/v1/realtime', realtimeRoutes);
  app.use('/api/v1/offline-bills', offlineBillsRoutes);
  app.use('/api/v1/gst-invoices', gstInvoicesRoutes);
  app.use('/api/v1/normal-bills', normalBillsRoutes);
  app.use('/api/v1/quotations', quotationsRoutes);
  app.use('/api/v1/suppliers', suppliersRoutes);
  app.use('/api/v1/dashboard', dashboardRoutes);
  app.use('/api/v1/read-model-sync', readModelSyncRouter);
  app.use('/api/v1', appDataRouter);

  // 10. Centralized Error Handler
  app.use(errorHandler);

  return app;
}
