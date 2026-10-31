import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { appPool } from './database.js';
import { env } from './env.js';

const PgSessionStore = connectPgSimple(session);

export function createSessionMiddleware(options?: { useMemoryStoreInTest?: boolean }) {
  let store: session.Store;

  if (env.NODE_ENV === 'test' && options?.useMemoryStoreInTest) {
    store = new session.MemoryStore();
  } else {
    if (env.NODE_ENV === 'production' && options?.useMemoryStoreInTest) {
      throw new Error('[SECURITY FATAL] Express MemoryStore is strictly prohibited in production.');
    }
    store = new PgSessionStore({
      pool: appPool,
      tableName: 'session',
      createTableIfMissing: false, // Migrations manage table creation
      pruneSessionInterval: 60 * 15, // Prune expired sessions every 15 minutes
      ttl: Math.floor(env.SESSION_MAX_AGE_MS / 1000), // In seconds
    });
  }

  return session({
    name: env.SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // Refreshes 7-day inactivity TTL on valid activity
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
}
