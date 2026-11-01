import { createApp } from './app.js';
import { env } from './config/env.js';
import { runPendingMigrations } from './config/migrator.js';

async function bootstrap() {
  try {
    await runPendingMigrations();
  } catch (err) {
    console.error('[KHATA SERVER] Fatal migration error on startup:', err);
    process.exit(1);
  }

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`[KHATA SERVER] Running in ${env.NODE_ENV} mode on port ${env.PORT}`);
    console.log(`[KHATA SERVER] Bound frontend origin: ${env.FRONTEND_URL}`);
  });

  process.on('SIGTERM', () => {
    console.log('[KHATA SERVER] SIGTERM signal received: closing HTTP server');
    server.close(() => {
      console.log('[KHATA SERVER] HTTP server closed');
    });
  });
}

bootstrap().catch((err) => {
  console.error('[KHATA SERVER] Bootstrap error:', err);
  process.exit(1);
});
