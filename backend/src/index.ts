import { createApp } from './app.js';
import { closeDatabasePools, inspectSearchIndexCapabilities } from './config/database.js';
import { env } from './config/env.js';
import { connectMongo, disconnectMongo, isMongoEnabled, isMongoReady } from './config/mongodb.js';
import { runPendingMigrationsWithRetry } from './config/migrator.js';
import { readModelOutboxWorker } from './modules/readModels/readModelOutbox.worker.js';
import { storageCleanupWorker } from './services/storageCleanup.worker.js';

async function bootstrap() {
  try {
    await runPendingMigrationsWithRetry();
  } catch (err) {
    console.error('[KHATA SERVER] Fatal migration error on startup:', err);
    process.exit(1);
  }

  try {
    await connectMongo();
  } catch (err) {
    console.error('[KHATA SERVER] Fatal MongoDB connection error on startup:', {
      message: (err as Error)?.message,
    });
    if (env.NODE_ENV === 'production' || isMongoEnabled()) {
      await closeDatabasePools().catch(() => {});
      process.exit(1);
    }
  }

  void inspectSearchIndexCapabilities({ warnOnMissing: true }).catch(() => {});
  storageCleanupWorker.start();

  if (isMongoEnabled() && isMongoReady()) {
    readModelOutboxWorker.start();
  }

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`[KHATA SERVER] Running in ${env.NODE_ENV} mode on port ${env.PORT}`);
    console.log(`[KHATA SERVER] Bound frontend origin: ${env.FRONTEND_URL}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[KHATA SERVER] ${signal} signal received: shutting down gracefully`);

    await Promise.all([
      readModelOutboxWorker.stop().catch(() => {}),
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
