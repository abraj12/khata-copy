import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import session from 'express-session';
import signature from 'cookie-signature';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  SessionStoreError,
  isSessionStoreError,
} from '../src/config/session.js';

describe('PostgreSQL Session Store Error Handling Test Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. isSessionStoreError correctly identifies genuine store connection failures', () => {
    expect(isSessionStoreError(new SessionStoreError())).toBe(true);
    expect(isSessionStoreError({ code: 'SESSION_STORE_UNAVAILABLE' })).toBe(true);
    expect(isSessionStoreError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isSessionStoreError({ code: '57P03' })).toBe(true);
    expect(isSessionStoreError({ code: '08006' })).toBe(true);
    expect(isSessionStoreError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isSessionStoreError(new Error('connection timeout'))).toBe(true);
    expect(isSessionStoreError(new Error('read ECONNRESET'))).toBe(true);
    expect(isSessionStoreError(new Error('server closed the connection unexpectedly'))).toBe(true);

    // Unrelated errors
    expect(isSessionStoreError(new Error('User not found'))).toBe(false);
    expect(isSessionStoreError({ code: 'VALIDATION_ERROR' })).toBe(false);
    expect(isSessionStoreError(null)).toBe(false);
    expect(isSessionStoreError(undefined)).toBe(false);
    expect(isSessionStoreError('string error')).toBe(false);
  });

  it('2. Does not classify arbitrary messages containing "session" or deterministic SQL errors as transient', () => {
    expect(
      isSessionStoreError(
        new Error('Invalid session configuration supplied')
      )
    ).toBe(false);

    expect(
      isSessionStoreError(
        new Error('Session table does not exist')
      )
    ).toBe(false);

    expect(
      isSessionStoreError({
        code: '42P01',
        message: 'relation session does not exist',
      })
    ).toBe(false);

    expect(
      isSessionStoreError({
        code: '42601',
        message: 'syntax error at or near "FROM" in session query',
      })
    ).toBe(false);

    expect(
      isSessionStoreError({
        code: '23505',
        message: 'duplicate key value violates unique constraint on session',
      })
    ).toBe(false);
  });

  it('3. Returns HTTP 503 when session retrieval in middleware fails before authController.me', async () => {
    // Create a mock store where store.get fails with a database connection error
    let getCalled = false;
    class FailingSessionStore extends session.Store {
      get(_sid: string, fn: (err?: unknown, session?: session.SessionData | null) => void): void {
        getCalled = true;
        const dbErr = new Error('Connection terminated unexpectedly while fetching session');
        (dbErr as { code?: string }).code = 'ECONNRESET';
        fn(dbErr);
      }
      set(_sid: string, _session: session.SessionData, fn?: (err?: unknown) => void): void {
        if (fn) fn();
      }
      destroy(_sid: string, fn?: (err?: unknown) => void): void {
        if (fn) fn();
      }
    }

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = createApp({ customStore: new FailingSessionStore() });

    // Sign the session cookie with env.SESSION_SECRET so express-session validates it and calls store.get
    const rawSid = 'some-session-id-token';
    const signedVal = 's:' + signature.sign(rawSid, env.SESSION_SECRET);

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `${env.SESSION_COOKIE_NAME}=${signedVal}`)
      .set('Origin', 'https://erp.algions.in');

    expect(getCalled).toBe(true);
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.code).toBe('SESSION_STORE_UNAVAILABLE');
    expect(res.body.message).toContain('temporarily unavailable');

    // Never leak database errors or session IDs in the response
    expect(JSON.stringify(res.body)).not.toContain('some-session-id-token');
    expect(JSON.stringify(res.body)).not.toContain('ECONNRESET');

    // Verify diagnostic log was emitted
    const logs = consoleLogSpy.mock.calls.map((c) => c.join(' '));
    const diagLog = logs.find((l) => l.includes('[AUTH ME]') && l.includes('status=503'));
    expect(diagLog).toBeDefined();
    expect(diagLog).toContain('SESSION_STORE_UNAVAILABLE');
  });

  it('4. Preserves secure error handling and redacts sensitive cookie and credential tokens', async () => {
    class FailingSaveSessionStore extends session.Store {
      get(_sid: string, fn: (err?: unknown, session?: session.SessionData | null) => void): void {
        fn(null, {
          cookie: { originalMaxAge: 1000, expires: new Date(Date.now() + 1000) } as session.Cookie,
          authenticated: true,
          role: 'OWNER',
          ownerPhone: '9876543210',
          csrfToken: 'secret-csrf-token',
        });
      }
      set(_sid: string, _session: session.SessionData, fn?: (err?: unknown) => void): void {
        fn?.(new Error('FATAL pg_connection postgresql://owner:secretpass@neon.db/khata with cookie sid=secret-cookie'));
      }
      destroy(_sid: string, fn?: (err?: unknown) => void): void {
        if (fn) fn();
      }
    }

    const app = createApp({ customStore: new FailingSaveSessionStore() });

    const rawSid = 'authenticated-sid';
    const signedVal = 's:' + signature.sign(rawSid, env.SESSION_SECRET);

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `${env.SESSION_COOKIE_NAME}=${signedVal}`)
      .set('Origin', 'https://erp.algions.in');

    // Response should be safe
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('secretpass');
    expect(bodyStr).not.toContain('postgresql://');
    expect(bodyStr).not.toContain('secret-cookie');
  });
});
