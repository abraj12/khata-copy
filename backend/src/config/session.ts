import type { Request, Response, NextFunction, RequestHandler } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { appPool } from './database.js';
import { env } from './env.js';

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 2592000000 ms (30 days)
export const SESSION_PRUNE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours cooldown for opportunistic cleanup

const PgSessionStore = connectPgSimple(session);

let lastPrunedAt = 0;
let pruneInFlight: Promise<void> | null = null;
let activeSessionStore: session.Store | null = null;

export function getActiveSessionStore(): session.Store | null {
  return activeSessionStore;
}

export class SessionStoreError extends Error {
  public readonly status = 503;
  public readonly statusCode = 503;
  public readonly code = 'SESSION_STORE_UNAVAILABLE';

  constructor(
    message = 'Authentication session store is temporarily unavailable. Please retry.',
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SessionStoreError';
  }
}

/**
 * Checks whether an error is caused by a session store outage or database connectivity drop.
 * Only genuine transient connection failures are classified as session store outages.
 * Deterministic SQL errors (such as 42P01 undefined table or 42601 syntax errors) return false.
 */
export function isSessionStoreError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  if (err instanceof SessionStoreError) {
    return true;
  }

  const error = err as {
    code?: string;
    message?: string;
    name?: string;
  };

  if (
    error.name === 'SessionStoreError' ||
    error.code === 'SESSION_STORE_UNAVAILABLE'
  ) {
    return true;
  }

  const transientPgCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    'EAI_AGAIN',
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08007',
    '57P01',
    '57P02',
    '57P03',
    '53300',
  ]);

  if (error.code && transientPgCodes.has(error.code)) {
    return true;
  }

  const message = (error.message || '').toLowerCase();

  const connectionFailurePatterns = [
    'connection terminated unexpectedly',
    'connection timeout',
    'timeout exceeded when trying to connect',
    'connection lost',
    'cannot connect now',
    'server closed the connection unexpectedly',
    'could not connect to server',
    'read econnreset',
    'connect econnrefused',
    'socket has been ended',
  ];

  return connectionFailurePatterns.some((pattern) =>
    message.includes(pattern)
  );
}

/**
 * Opportunistically prunes expired sessions using connect-pg-simple pruneSessions().
 * Enforces a 24-hour cooldown and single-flight execution to minimize Neon compute queries.
 * Safe, non-blocking, and never fails or blocks caller requests.
 */
export function pruneExpiredSessionsOpportunistically(
  storeToPrune?: session.Store,
  options?: { now?: () => number }
): Promise<void> {
  const targetStore = (storeToPrune || activeSessionStore) as (session.Store & {
    pruneSessions?: (cb: (err?: Error) => void) => void;
  }) | null;

  if (!targetStore || typeof targetStore.pruneSessions !== 'function') {
    return Promise.resolve();
  }

  const now = options?.now ? options.now() : Date.now();

  if (now - lastPrunedAt < SESSION_PRUNE_COOLDOWN_MS) {
    return Promise.resolve();
  }

  if (pruneInFlight) {
    return pruneInFlight;
  }

  pruneInFlight = new Promise<void>((resolve) => {
    try {
      targetStore.pruneSessions!((err?: Error) => {
        if (err) {
          console.error('[SESSION PRUNE ERROR] Opportunistic session cleanup failed:', err.message);
        } else {
          lastPrunedAt = now;
        }
        resolve();
      });
    } catch (unexpectedErr) {
      console.error('[SESSION PRUNE ERROR] Unexpected failure during session prune:', unexpectedErr);
      resolve();
    }
  }).finally(() => {
    pruneInFlight = null;
  });

  return pruneInFlight;
}

export function _resetSessionPruneStateForTesting(): void {
  lastPrunedAt = 0;
  pruneInFlight = null;
  activeSessionStore = null;
}

export function createSessionMiddleware(options?: {
  useMemoryStoreInTest?: boolean;
  customStore?: session.Store;
}): RequestHandler {
  let store: session.Store;

  if (options?.customStore) {
    store = options.customStore;
  } else if (env.NODE_ENV === 'test' && options?.useMemoryStoreInTest) {
    store = new session.MemoryStore();
  } else {
    if (env.NODE_ENV === 'production' && options?.useMemoryStoreInTest) {
      throw new Error('[SECURITY FATAL] Express MemoryStore is strictly prohibited in production.');
    }
    const pgStore = new PgSessionStore({
      pool: appPool,
      tableName: 'session',
      createTableIfMissing: false, // Migrations manage table creation
      pruneSessionInterval: false, // Controlled cleanup: Disable background interval timer to prevent unnecessary Neon compute wakeups
      ttl: Math.floor(env.SESSION_MAX_AGE_MS / 1000), // In seconds (2,592,000s = 30 days)
    });

    pgStore.on('error', (err) => {
      console.error('[SESSION STORE ERROR] connect-pg-simple error:', (err as Error).message);
    });

    store = pgStore;
  }

  activeSessionStore = store;

  const rawSession = session({
    name: env.SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // Refreshes 30-day inactivity TTL on valid activity
    store,
    cookie: {
      httpOnly: env.SESSION_COOKIE_HTTP_ONLY,
      secure: env.SESSION_COOKIE_SECURE,
      sameSite: env.SESSION_COOKIE_SAME_SITE,
      path: '/',
      maxAge: env.SESSION_MAX_AGE_MS,
      // Host-only cookie: Do NOT set domain attribute!
    },
  });

  return (req: Request, res: Response, next: NextFunction) => {
    rawSession(req, res, (err) => {
      if (err) {
        if (isSessionStoreError(err)) {
          // Log structured diagnostic without leaking session ID or credentials
          console.error('[SESSION STORE ERROR] Session retrieval failed in middleware:', (err as Error).message);

          if (req.originalUrl?.includes('/api/v1/auth/me') || req.path?.includes('/me')) {
            console.log('[AUTH ME] status=503 error=SESSION_STORE_UNAVAILABLE source=middleware');
          }

          return next(
            new SessionStoreError(
              'Authentication session store is temporarily unavailable. Please retry.',
              err
            )
          );
        }
        return next(err);
      }
      next();
    });
  };
}
