import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { createSessionMiddleware } from './config/session.js';
import { csrfProtection, isAllowedOrigin } from './middleware/csrf.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { productsRoutes } from './modules/products/products.routes.js';
import { ledgerRoutes } from './modules/ledger/ledger.routes.js';
import { realtimeRoutes } from './modules/realtime/realtime.service.js';

export function createApp(options?: { useMemoryStoreInTest?: boolean }) {
  const app = express();

  // 1. Trust proxy configuration for Render
  app.set('trust proxy', env.TRUST_PROXY);

  // 2. HTTP Security Headers with Helmet
  app.use(
    helmet({
      contentSecurityPolicy: false, // CSP is configured on frontend layer / Vercel
      crossOriginEmbedderPolicy: false,
    })
  );

  // 3. Credentialed CORS configuration
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        // Allow requests with no origin (e.g. mobile apps or curl) in development/test
        if (!requestOrigin) {
          if (env.NODE_ENV === 'production') {
            return callback(null, true);
          }
          return callback(null, true);
        }

        if (isAllowedOrigin(requestOrigin)) {
          return callback(null, true);
        }

        return callback(new Error(`CORS origin ${requestOrigin} not permitted.`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With'],
      exposedHeaders: ['Set-Cookie'],
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

  // 7. Health Check
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
  app.use('/api/v1/ledger', ledgerRoutes);
  app.use('/api/v1/realtime', realtimeRoutes);

  // 9. Centralized Error Handler
  app.use(errorHandler);

  return app;
}
