import * as mongodbConfig from '../src/config/mongodb.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import session from 'express-session';
import cookieSignature from 'cookie-signature';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';

class RecordingSessionStore extends session.Store {
  public sessions = new Map<string, session.SessionData>();
  public destroyCalls: string[] = [];
  public shouldFailDestroy = false;

  get(sid: string, fn: (err?: unknown, session?: session.SessionData | null) => void): void {
    const data = this.sessions.get(sid);
    fn(null, data ? JSON.parse(JSON.stringify(data)) : null);
  }

  set(sid: string, sess: session.SessionData, fn?: (err?: unknown) => void): void {
    this.sessions.set(sid, JSON.parse(JSON.stringify(sess)));
    if (fn) fn(null);
  }

  destroy(sid: string, fn?: (err?: unknown) => void): void {
    this.destroyCalls.push(sid);
    if (this.shouldFailDestroy) {
      if (fn) fn(new Error('Simulated PostgreSQL session deletion failure'));
      return;
    }
    this.sessions.delete(sid);
    if (fn) fn(null);
  }

  touch(sid: string, sess: session.SessionData, fn?: () => void): void {
    const existing = this.sessions.get(sid);
    if (existing) {
      existing.cookie = sess.cookie;
    }
    if (fn) fn();
  }
}

describe('Server-Side Logout Session Revocation Test Suite', () => {
  const TEST_SESSION_ID = 'sess_test_revocation_123456789';
  const VALID_CSRF_TOKEN = 'test_csrf_token_abcdef0123456789abcdef0123456789';

  function createSignedCookieHeader(sessionId: string): string {
    const signedValue = 's:' + cookieSignature.sign(sessionId, env.SESSION_SECRET);
    return `${env.SESSION_COOKIE_NAME}=${encodeURIComponent(signedValue)}`;
  }

  function seedAuthenticatedSession(store: RecordingSessionStore, sessionId: string, csrfToken: string) {
    store.sessions.set(sessionId, {
      cookie: {
        originalMaxAge: 2592000000,
        maxAge: 2592000000,
        expires: new Date(Date.now() + 2592000000),
        httpOnly: true,
        path: '/',
      } as unknown as session.Cookie,
      authenticated: true,
      role: 'OWNER',
      ownerPhone: '9876543210',
      csrfToken,
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(true);
  });

  it('1. Successfully revokes session server-side on POST /api/v1/auth/logout', async () => {
    const store = new RecordingSessionStore();
    seedAuthenticatedSession(store, TEST_SESSION_ID, VALID_CSRF_TOKEN);
    const cookieHeader = createSignedCookieHeader(TEST_SESSION_ID);

    const app = createApp({ customStore: store });

    // Step 1: Confirm session is authenticated before logout
    const preRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookieHeader);
    expect(preRes.status).toBe(200);
    expect(preRes.body.authenticated).toBe(true);

    // Step 2: Perform server-side logout
    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://erp.algions.in')
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', VALID_CSRF_TOKEN);

    // Step 3: Verify HTTP 200 and unauthenticated response
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body).toEqual({
      success: true,
      authenticated: false,
      message: 'Logged out successfully.',
    });

    // Step 4: Verify store.destroy() was called with exact session ID
    expect(store.destroyCalls).toEqual([TEST_SESSION_ID]);

    // Step 5: Verify session record was physically deleted from store
    expect(store.sessions.has(TEST_SESSION_ID)).toBe(false);

    // Step 6: Verify khata_session cookie was cleared in response header
    const clearedCookies = logoutRes.headers['set-cookie'];
    expect(clearedCookies).toBeDefined();
    const clearCookieHeader = clearedCookies[0];
    expect(clearCookieHeader).toContain('khata_session=;');
    // Max-Age=0 or past date
    expect(
      clearCookieHeader.includes('Max-Age=0') ||
      clearCookieHeader.includes('Thu, 01 Jan 1970')
    ).toBe(true);

    // Step 7: Replay old cookie against /api/v1/auth/me -> strictly returns HTTP 401
    const replayMeRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookieHeader);

    expect(replayMeRes.status).toBe(401);
    expect(replayMeRes.body.authenticated).toBe(false);

    // Step 8: Replay old cookie against protected products endpoint -> strictly returns HTTP 401
    const replayProdRes = await request(app)
      .get('/api/v1/products')
      .set('Cookie', cookieHeader);

    expect(replayProdRes.status).toBe(401);
    expect(replayProdRes.body.success).toBe(false);
  });

  it('2. Preserves session and returns HTTP 500 if store.destroy() encounters an error', async () => {
    const store = new RecordingSessionStore();
    seedAuthenticatedSession(store, TEST_SESSION_ID, VALID_CSRF_TOKEN);
    store.shouldFailDestroy = true; // Simulate store deletion error

    const cookieHeader = createSignedCookieHeader(TEST_SESSION_ID);
    const app = createApp({ customStore: store });

    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://erp.algions.in')
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', VALID_CSRF_TOKEN);

    expect(logoutRes.status).toBe(500);
    expect(logoutRes.body.success).toBe(false);
    expect(logoutRes.body.authenticated).toBe(true);
    expect(logoutRes.body.message).toBe('Failed to destroy session.');

    // Cookie must NOT be cleared when destroy fails
    const setCookieHeaders = logoutRes.headers['set-cookie'];
    if (setCookieHeaders) {
      expect(setCookieHeaders.join(';')).not.toContain('Max-Age=0');
    }
  });

  it('3. Rejects logout without valid CSRF token with HTTP 403 and does NOT destroy session', async () => {
    const store = new RecordingSessionStore();
    seedAuthenticatedSession(store, TEST_SESSION_ID, VALID_CSRF_TOKEN);

    const cookieHeader = createSignedCookieHeader(TEST_SESSION_ID);
    const app = createApp({ customStore: store });

    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://erp.algions.in')
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', 'tampered_invalid_csrf_token');

    expect(logoutRes.status).toBe(403);
    // Destroy was NOT called
    expect(store.destroyCalls).toEqual([]);
    // Session is still active in store
    expect(store.sessions.has(TEST_SESSION_ID)).toBe(true);
  });
  it('4. Successfully logs out and destroys session during MongoDB outage (HTTP 200 preserved)', async () => {
    vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(false);
    vi.spyOn(mongodbConfig, 'getMongoAvailabilityState').mockReturnValue('disconnected');

    const store = new RecordingSessionStore();
    seedAuthenticatedSession(store, TEST_SESSION_ID, VALID_CSRF_TOKEN);
    const cookieHeader = createSignedCookieHeader(TEST_SESSION_ID);

    const app = createApp({ customStore: store });

    // Step 1: Confirm regular business route fails with 503 MANDATORY_SERVICE_UNAVAILABLE
    const bizRes = await request(app)
      .get('/api/v1/products')
      .set('Cookie', cookieHeader);
    expect(bizRes.status).toBe(503);
    expect(bizRes.body.code).toBe('MANDATORY_SERVICE_UNAVAILABLE');

    // Step 2: Confirm POST /api/v1/auth/logout succeeds with 200 despite MongoDB outage
    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://erp.algions.in')
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', VALID_CSRF_TOKEN);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);
    expect(store.destroyCalls).toEqual([TEST_SESSION_ID]);
    expect(store.sessions.has(TEST_SESSION_ID)).toBe(false);
  });
});
