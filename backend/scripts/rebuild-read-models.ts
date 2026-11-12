import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Pre-load env files with override: false (highest-priority .env.local first) so shell/CI env vars always win
const envFiles = Array.from(
  new Set([
    path.resolve(process.cwd(), 'backend/.env.local'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), 'backend/.env'),
    path.resolve(process.cwd(), '.env'),
  ])
);
for (const envFile of envFiles) {
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: false });
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const confirmed = args.has('--confirm') || args.has('--yes');
  if (!confirmed) {
    console.error(
      '[READ-MODEL REBUILD] Refusing to run full PostgreSQL -> MongoDB rebuild without --confirm flag.'
    );
    console.error('Usage: npm run rebuild:read-models -- --confirm');
    process.exit(1);
  }

  const [{ connectMongo, disconnectMongo, ensureMongoIndexes }, { closeDatabasePools }, { readModelSyncService }] =
    await Promise.all([
      import('../src/config/mongodb.js'),
      import('../src/config/database.js'),
      import('../src/modules/readModels/readModelSync.service.js'),
    ]);

  try {
    const conn = await connectMongo({ maxRetries: 2 });
    if (!conn.connected) {
      throw new Error(
        `MongoDB must be enabled (MONGODB_ENABLED=true) before running rebuild: ${conn.reason || 'disabled'}`
      );
    }
    await ensureMongoIndexes();
    const result = await readModelSyncService.rebuildAllReadModels({ confirm: true });
    console.log('[READ-MODEL REBUILD] Completed successfully:', result);
  } finally {
    await disconnectMongo().catch(() => {});
    await closeDatabasePools().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[READ-MODEL REBUILD ERROR]', err);
  process.exit(1);
});
