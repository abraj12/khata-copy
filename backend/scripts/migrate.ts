import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';
import { runPendingMigrations, runPendingMigrationsWithRetry } from '../src/config/migrator.js';

// Pre-load .env and .env.local from current directory or backend directory
const envFiles = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), 'backend/.env'),
  path.resolve(process.cwd(), 'backend/.env.local'),
];
for (const envFile of envFiles) {
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: true });
  }
}

async function resolveConnectionString(): Promise<string | undefined> {
  // 1. CLI argument: npm run migrate -- "postgresql://..."
  const cliUrl = process.argv.slice(2).find((arg) => arg.startsWith('postgres://') || arg.startsWith('postgresql://'));
  if (cliUrl) return cliUrl;

  // 2. Environment variable if not a placeholder
  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('dummy')) {
    return process.env.DATABASE_URL;
  }

  // 3. Interactive prompt in terminal
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question('\x1b[36mEnter Neon Direct Connection String (DATABASE_URL):\x1b[0m\n> ', (answer) => {
        rl.close();
        const trimmed = answer.trim().replace(/^['"]|['"]$/g, '');
        resolve(trimmed || undefined);
      });
    });
  }

  return undefined;
}

async function main() {
  const customDbUrl = await resolveConnectionString();
  await runPendingMigrationsWithRetry(customDbUrl);
}

main().catch((err) => {
  console.error('[MIGRATION ERROR]', err);
  process.exit(1);
});
