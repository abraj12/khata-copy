import mongoose from 'mongoose';
import { env } from './env.js';
import { READ_MODEL_MODELS } from '../modules/readModels/models.js';
import { APP_DATA_MODELS } from '../modules/appData/models.js';

let listenersAttached = false;

/**
 * Masks credentials inside a MongoDB URI before emitting any safe diagnostics.
 */
export function redactMongoUri(uri: string | undefined): string {
  if (!uri) return 'unconfigured';
  try {
    const parsed = new URL(uri);
    const hasAuth = Boolean(parsed.username || parsed.password);
    const authMask = hasAuth ? '***:***@' : '';
    return `${parsed.protocol}//${authMask}${parsed.host}${parsed.pathname || ''}`;
  } catch {
    return 'redacted-uri';
  }
}

export function isMongoEnabled(): boolean {
  return Boolean(env.MONGODB_ENABLED);
}

/**
 * Mongoose readyState 1 === connected.
 */
export function isMongoReady(): boolean {
  return isMongoEnabled() && mongoose.connection.readyState === 1;
}

export function getMongoConnectionState(): {
  enabled: boolean;
  readyState: number;
  readyStateLabel: 'disconnected' | 'connected' | 'connecting' | 'disconnecting';
  databaseName: string | null;
} {
  const stateMap: Record<number, 'disconnected' | 'connected' | 'connecting' | 'disconnecting'> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  const readyState = mongoose.connection.readyState;
  return {
    enabled: isMongoEnabled(),
    readyState,
    readyStateLabel: stateMap[readyState] ?? 'disconnected',
    databaseName: readyState === 1 ? mongoose.connection.name || env.MONGODB_DATABASE : null,
  };
}

function attachConnectionListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on('connected', () => {
    console.log(`[MONGODB] Connected to database '${mongoose.connection.name || env.MONGODB_DATABASE}'`);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[MONGODB] Connection disconnected');
  });

  mongoose.connection.on('error', (err) => {
    console.error('[MONGODB ERROR]', (err as Error).message);
  });
}

/**
 * Safely migrates legacy sparse notifications dedupeKey unique index to a partial string index
 * and removes legacy dedupeKey: null fields without touching valid string dedupeKey documents
 * or calling destructive syncIndexes().
 */
export async function migrateNotificationDedupeIndex(): Promise<{
  droppedLegacyIndex: boolean;
  unsetNullCount: number;
}> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return { droppedLegacyIndex: false, unsetNullCount: 0 };
  }

  const collection = mongoose.connection.db.collection('notifications');
  let droppedLegacyIndex = false;

  try {
    const indexes = await collection.indexes();
    const existingDedupeIndex = indexes.find(
      (idx) => idx.name === 'idx_notifications_dedupe_unique'
    ) as
      | {
          name?: string;
          sparse?: boolean;
          partialFilterExpression?: { dedupeKey?: { $type?: string } };
        }
      | undefined;

    if (existingDedupeIndex) {
      const hasPartialStringFilter =
        existingDedupeIndex.partialFilterExpression?.dedupeKey?.$type === 'string';
      if (existingDedupeIndex.sparse === true || !hasPartialStringFilter) {
        await collection.dropIndex('idx_notifications_dedupe_unique');
        droppedLegacyIndex = true;
      }
    }
  } catch (err: any) {
    if (err?.code !== 26 && err?.codeName !== 'NamespaceNotFound') {
      throw err;
    }
  }

  const unsetRes = await collection.updateMany(
    { dedupeKey: null },
    { $unset: { dedupeKey: '' } }
  );

  return {
    droppedLegacyIndex,
    unsetNullCount: Number(unsetRes.modifiedCount || 0),
  };
}

/**
 * Explicitly builds controlled indexes across all read-model and app collections.
 * Uses createIndexes() intentionally instead of blind syncIndexes() to avoid dropping
 * custom indexes unintentionally during rolling deployments.
 */
export async function ensureMongoIndexes(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  await migrateNotificationDedupeIndex();
  const allModels = [...READ_MODEL_MODELS, ...APP_DATA_MODELS];
  for (const model of allModels) {
    await model.createIndexes();
  }
}

export interface ConnectMongoOptions {
  uri?: string;
  dbName?: string;
  maxRetries?: number;
}

/**
 * Connects to MongoDB with bounded connection pool and server selection timeouts.
 * Returns cleanly when MONGODB_ENABLED=false in dev/test; fails closed in production if unreachable.
 */
export async function connectMongo(options: ConnectMongoOptions = {}): Promise<{
  connected: boolean;
  reason?: string;
}> {
  if (!isMongoEnabled() && !options.uri) {
    return { connected: false, reason: 'MONGODB_ENABLED=false' };
  }

  const targetUri = options.uri || env.MONGODB_URI;
  const targetDb = options.dbName || env.MONGODB_DATABASE;
  if (!targetUri) {
    throw new Error('[MONGODB] Connection requested without MONGODB_URI.');
  }

  if (mongoose.connection.readyState === 1) {
    await ensureMongoIndexes();
    return { connected: true };
  }

  attachConnectionListeners();

  const maxAttempts = Math.max(1, options.maxRetries ?? 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await mongoose.connect(targetUri, {
        dbName: targetDb,
        maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
        minPoolSize: env.MONGODB_MIN_POOL_SIZE,
        serverSelectionTimeoutMS: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
        connectTimeoutMS: env.MONGODB_CONNECT_TIMEOUT_MS,
        autoIndex: false,
        autoCreate: false,
      });
      await ensureMongoIndexes();
      return { connected: true };
    } catch (err) {
      lastError = err;
      console.warn(
        `[MONGODB CONNECT RETRY] attempt=${attempt}/${maxAttempts} target=${redactMongoUri(targetUri)} error=${(err as Error).message}`
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000, attempt * 600)));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('[MONGODB] Failed to establish MongoDB connection.');
}

/**
 * Closes Mongoose connections gracefully on shutdown or integration test teardown.
 */
export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * Performs an explicit admin ping ONLY for readiness checks (/api/v1/health/ready).
 * Never invoked on /api/v1/health/live or background keepalives.
 */
export async function checkMongoReadiness(): Promise<{
  enabled: boolean;
  isReady: boolean;
  latencyMs: number;
  error?: string;
}> {
  if (!isMongoEnabled()) {
    return { enabled: false, isReady: true, latencyMs: 0 };
  }

  const start = Date.now();
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      return {
        enabled: true,
        isReady: false,
        latencyMs: Date.now() - start,
        error: 'MongoDB client is not connected',
      };
    }

    await mongoose.connection.db.admin().ping();
    return {
      enabled: true,
      isReady: true,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      enabled: true,
      isReady: false,
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}
