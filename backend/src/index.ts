import { createApp } from './app.js';
import { closeDatabasePools, inspectSearchIndexCapabilities } from './config/database.js';
import { env } from './config/env.js';
import { disconnectMongo } from './config/mongodb.js';
import { runPendingMigrationsWithRetry } from './config/migrator.js';
import { mongoConnectionSupervisor } from './services/mongoConnectionSupervisor.js';
import { storageCleanupWorker } from './services/storageCleanup.worker.js';

async function bootstrap() {
  // 1. Run authoritative PostgreSQL migrations (fail-closed if schema cannot be applied)
  try {
    await runPendingMigrationsWithRetry();
  } catch (err) {
    console.error('[KHATA SERVER] Fatal migration error on startup:', err);
    process.exit(1);
  }

  // 2. Inspect search index capabilities (non-fatal, reports degraded if pg_trgm absent)
  void inspectSearchIndexCapabilities({ warnOnMissing: true }).catch(() => {});

  // 3. Start background storage cleanup worker
  storageCleanupWorker.start();

  // 4. Create and start HTTP listener immediately so liveness/readiness/503 probes respond
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`[KHATA SERVER] Running in ${env.NODE_ENV} mode on port ${env.PORT}`);
    console.log(`[KHATA SERVER] Bound frontend origin: ${env.FRONTEND_URL}`);
  });

  // 5. Start supervised MongoDB connection manager
  // If MongoDB is temporarily down, the Node process remains alive, returns 503 for business APIs,
  // and supervisor retries with exponential backoff + jitter until ready.
  void mongoConnectionSupervisor.start().catch((err) => {
    console.warn('[KHATA SERVER] Initial MongoDB supervisor startup warning:', (err as Error)?.message);
  });

  // 6. Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[KHATA SERVER] ${signal} signal received: shutting down gracefully`);

    await Promise.all([
      mongoConnectionSupervisor.stop().catch(() => {}),
      storageCleanupWorker.stop().catch(() => {}),
    ]);

    await new Promise<void>((resolve) => {
      server.close(() => {
        console.log('[KHATA SERVER] HTTP server closed');
        resolve();
      });
    });

    await disconnectMongo().catch(() => {});
    await closeDatabasePools().catch(() => {});
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

bootstrap();
