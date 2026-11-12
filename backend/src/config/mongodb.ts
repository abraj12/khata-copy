import mongoose from 'mongoose';
import { env } from './env.js';
import { READ_MODEL_MODELS } from '../modules/readModels/models.js';
import { APP_DATA_MODELS } from '../modules/appData/models.js';

export type MongoAvailabilityState =
  | 'disabled'
  | 'connecting'
  | 'initializing'
  | 'ready'
  | 'degraded'
  | 'disconnected';

let mongoConnectionReady = false;
let mongoInitializationReady = false;
let mongoAvailabilityState: MongoAvailabilityState = 'disconnected';
let testMongoReadyOverride: boolean | null = null;

export function setForceMongoReadyInTests(value: boolean | null): void {
  if (env.NODE_ENV !== 'test') {
    throw new Error('MongoDB readiness override is only available in test mode.');
  }
  testMongoReadyOverride = value;
}

export function resetForceMongoReadyInTests(): void {
  testMongoReadyOverride = null;
}

type MongoUnreadyListener = (err?: unknown) => void;
const mongoUnreadyListeners = new Set<MongoUnreadyListener>();

export function registerMongoUnreadyListener(listener: MongoUnreadyListener): () => void {
  mongoUnreadyListeners.add(listener);
  return () => {
    mongoUnreadyListeners.delete(listener);
  };
}

export function notifyMongoUnreadyListeners(err?: unknown): void {
  for (const listener of mongoUnreadyListeners) {
    try {
      listener(err);
    } catch (e) {
      console.error('[MONGODB] Error in unready listener:', e);
    }
  }
}

export function markMongoUnavailable(error?: unknown): void {
  mongoConnectionReady = false;
  mongoInitializationReady = false;
  mongoAvailabilityState = 'degraded';

  if (error) {
    console.warn('[MONGODB] Health verification failed:', {
      message: (error as Error)?.message,
    });
  }

  notifyMongoUnreadyListeners(error);
}

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
 * Mongoose connection is ready ONLY when enabled, connected, and initialization/indexes succeeded.
 */
export function isMongoReady(): boolean {
  if (env.NODE_ENV === 'test' && testMongoReadyOverride !== null) {
    return testMongoReadyOverride;
  }
  return (
    isMongoEnabled() &&
    mongoConnectionReady &&
    mongoInitializationReady &&
    mongoose.connection.readyState === 1
  );
}

export function getMongoAvailabilityState(): MongoAvailabilityState {
  if (!isMongoEnabled()) return 'disabled';
  return mongoAvailabilityState;
}

export function setMongoAvailabilityState(
  state: MongoAvailabilityState,
  options?: { connectionReady?: boolean; initializationReady?: boolean }
): void {
  mongoAvailabilityState = state;
  if (options?.connectionReady !== undefined) {
    mongoConnectionReady = options.connectionReady;
  } else if (state === 'ready') {
    mongoConnectionReady = true;
  } else if (state === 'disconnected') {
    mongoConnectionReady = false;
  }
  if (options?.initializationReady !== undefined) {
    mongoInitializationReady = options.initializationReady;
  } else if (state === 'ready') {
    mongoInitializationReady = true;
  } else if (state === 'disconnected') {
    mongoInitializationReady = false;
  }
}

export function getMongoConnectionState(): {
  enabled: boolean;
  readyState: number;
  readyStateLabel: 'disconnected' | 'connected' | 'connecting' | 'disconnecting';
  availabilityState: MongoAvailabilityState;
  connectionReady: boolean;
  initializationReady: boolean;
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
    availabilityState: getMongoAvailabilityState(),
    connectionReady: mongoConnectionReady,
    initializationReady: mongoInitializationReady,
    databaseName: readyState === 1 ? mongoose.connection.name || env.MONGODB_DATABASE : null,
  };
}

function attachConnectionListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on('connected', () => {
    mongoConnectionReady = true;
    console.log(`[MONGODB] Connected to database '${mongoose.connection.name || env.MONGODB_DATABASE}'`);
  });

  mongoose.connection.on('disconnected', () => {
    mongoConnectionReady = false;
    mongoInitializationReady = false;
    mongoAvailabilityState = 'disconnected';
    console.warn('[MONGODB] Connection disconnected');
    notifyMongoUnreadyListeners(new Error('MongoDB disconnected'));
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
 * Updates initialization state appropriately.
 */
export async function ensureMongoIndexes(): Promise<{ success: boolean; error?: string }> {
  if (mongoose.connection.readyState !== 1) {
    mongoConnectionReady = false;
    mongoInitializationReady = false;
    mongoAvailabilityState = 'disconnected';
    return { success: false, error: 'MongoDB connection is not established' };
  }

  try {
    mongoConnectionReady = true;
    mongoAvailabilityState = 'initializing';
    await migrateNotificationDedupeIndex();
    const allModels = [...READ_MODEL_MODELS, ...APP_DATA_MODELS];
    for (const model of allModels) {
      await model.createIndexes();
    }
    mongoInitializationReady = true;
    mongoAvailabilityState = 'ready';
    return { success: true };
  } catch (err) {
    const errorMsg = (err as Error)?.message || 'Failed to initialize MongoDB indexes';
    console.error('[MONGODB ERROR] Index initialization failed:', errorMsg);
    mongoInitializationReady = false;
    mongoAvailabilityState = 'degraded';
    return { success: false, error: errorMsg };
  }
}

export interface ConnectMongoOptions {
  uri?: string;
  dbName?: string;
  maxRetries?: number;
}

/**
 * Connects to MongoDB with bounded connection pool and server selection timeouts.
 * Initializes indexes and sets readiness states on success.
 */
export async function connectMongo(options: ConnectMongoOptions = {}): Promise<{
  connected: boolean;
  reason?: string;
}> {
  if (!isMongoEnabled() && !options.uri) {
    mongoAvailabilityState = 'disabled';
    return { connected: false, reason: 'MONGODB_ENABLED=false' };
  }

  const targetUri = options.uri || env.MONGODB_URI;
  const targetDb = options.dbName || env.MONGODB_DATABASE;
  if (!targetUri) {
    mongoAvailabilityState = 'disconnected';
    throw new Error('[MONGODB] Connection requested without MONGODB_URI.');
  }

  mongoAvailabilityState = 'connecting';
  attachConnectionListeners();

  if (mongoose.connection.readyState === 1) {
    mongoConnectionReady = true;
    const indexRes = await ensureMongoIndexes();
    if (!indexRes.success) {
      throw new Error(`[MONGODB] Index creation failed: ${indexRes.error}`);
    }
    return { connected: true };
  }

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
      mongoConnectionReady = true;
      const indexRes = await ensureMongoIndexes();
      if (!indexRes.success) {
        throw new Error(`[MONGODB] Index creation failed: ${indexRes.error}`);
      }
      return { connected: true };
    } catch (err) {
      lastError = err;
      mongoConnectionReady = false;
      mongoInitializationReady = false;
      mongoAvailabilityState = attempt === maxAttempts ? 'disconnected' : 'connecting';
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
  mongoConnectionReady = false;
  mongoInitializationReady = false;
  mongoAvailabilityState = 'disconnected';
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * Performs an explicit admin ping ONLY for readiness checks (/api/v1/health/ready).
 * Never invoked on /api/v1/health/live or background keepalives.
 * Verifies both connection and initialization readiness.
 */
export async function checkMongoReadiness(): Promise<{
  enabled: boolean;
  isReady: boolean;
  state: MongoAvailabilityState;
  latencyMs: number;
  error?: string;
}> {
  if (!isMongoEnabled()) {
    return { enabled: false, isReady: true, state: 'disabled', latencyMs: 0 };
  }

  if (env.NODE_ENV === 'test' && testMongoReadyOverride !== null) {
    if (testMongoReadyOverride === true) {
      return { enabled: true, isReady: true, state: 'ready', latencyMs: 0 };
    } else {
      return {
        enabled: true,
        isReady: false,
        state: 'disconnected',
        latencyMs: 0,
        error: 'MongoDB readiness verification failed.',
      };
    }
  }

  const start = Date.now();
  try {
    if (!isMongoReady() || !mongoose.connection.db) {
      return {
        enabled: true,
        isReady: false,
        state: getMongoAvailabilityState(),
        latencyMs: Date.now() - start,
        error: `MongoDB is not ready (state=${getMongoAvailabilityState()}, readyState=${mongoose.connection.readyState})`,
      };
    }

    await mongoose.connection.db.admin().ping();
    return {
      enabled: true,
      isReady: true,
      state: 'ready',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    markMongoUnavailable(err);
    return {
      enabled: true,
      isReady: false,
      state: getMongoAvailabilityState(),
      latencyMs: Date.now() - start,
      error: 'MongoDB readiness verification failed.',
    };
  }
}
