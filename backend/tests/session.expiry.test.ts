import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import session from 'express-session';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  SESSION_MAX_AGE_MS,
  SESSION_PRUNE_COOLDOWN_MS,
  pruneExpiredSessionsOpportunistically,
  _resetSessionPruneStateForTesting,
} from '../src/config/session.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { loginAttemptStore } from '../src/modules/auth/loginAttemptStore.js';

describe('30-Day Rolling Session Expiry & Opportunistic Pruning Test Suite', () => {
  const TEST_PHONE = '9876543210';
  const TEST_PASSWORD = 'ValidOwnerPassword123!';

  beforeEach(() => {
    vi.restoreAllMocks();
    _resetSessionPruneStateForTesting();

    vi.spyOn(loginAttemptStore, 'checkLockout').mockResolvedValue({
      isLocked: false,
    });
    vi.spyOn(loginAttemptStore, 'recordAttempt').mockResolvedValue(undefined);
    vi.spyOn(authService, 'verifyCredentials').mockImplementation(async (phone, pass) => {
      if (phone === TEST_PHONE && pass === TEST_PASSWORD) {
        return { success: true, normalizedPhone: TEST_PHONE };
      }
      return { success: false };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetSessionPruneStateForTesting();
  });

  it('1. Confirms effective session expiry constant is exactly 30 days (2,592,000,000 ms / 2,592,000 seconds)', () => {
    const EXPECTED_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    expect(EXPECTED_30_DAYS_MS).toBe(2592000000);
    expect(SESSION_MAX_AGE_MS).toBe(2592000000);
    expect(env.SESSION_MAX_AGE_MS).toBe(2592000000);
    expect(Math.floor(env.SESSION_MAX_AGE_MS / 1000)).toBe(2592000);
  });

  it('2. Login response sets cookie with 30-day expiry (2,592,000s), HttpOnly, SameSite=Lax, host-only Path=/', async () => {
    const app = createApp({ useMemoryStoreInTest: true });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);

    const setCookieHeaders = res.headers['set-cookie'];
    expect(setCookieHeaders).toBeDefined();
    const cookieHeader = setCookieHeaders[0];

    // Verify cookie name
    expect(cookieHeader).toContain('khata_session=');
    // Verify HttpOnly
    expect(cookieHeader).toContain('HttpOnly');
    // Verify SameSite=Lax
    expect(cookieHeader).toContain('SameSite=Lax');
    // Verify Path=/
    expect(cookieHeader).toContain('Path=/');
    // Verify host-only (no domain attribute specified)
    expect(cookieHeader).not.toContain('Domain=');

    // Verify expiry date is exactly 30 days in the future (within 5 seconds)
    const expiresMatch = cookieHeader.match(/Expires=([^;]+)/);
    expect(expiresMatch).toBeDefined();
    const expiresDate = new Date(expiresMatch![1]);
    const diffMs = expiresDate.getTime() - Date.now();
    expect(Math.abs(diffMs - 2592000000)).toBeLessThan(5000);
  });

  it('3. Cookie includes Secure flag when SESSION_COOKIE_SECURE is true over HTTPS/proxy', async () => {
    const secureSpy = vi.spyOn(env, 'SESSION_COOKIE_SECURE', 'get').mockReturnValue(true);

    try {
      const app = createApp({ useMemoryStoreInTest: true });
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Origin', 'https://erp.algions.in')
        .set('X-Forwarded-Proto', 'https')
        .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

      expect(res.status).toBe(200);
      const setCookieHeaders = res.headers['set-cookie'];
      expect(setCookieHeaders).toBeDefined();
      const cookieHeader = setCookieHeaders[0];
      expect(cookieHeader).toContain('Secure');
    } finally {
      secureSpy.mockRestore();
    }
  });

  it('4. Rolling session renewal: a valid authenticated request resets the 30-day cookie timer', async () => {
    const app = createApp({ useMemoryStoreInTest: true });

    // Step 1: Login
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    const sessionCookie = loginRes.headers['set-cookie'][0];
    const initialExpiresMatch = sessionCookie.match(/Expires=([^;]+)/);
    const initialExpires = new Date(initialExpiresMatch![1]).getTime();

    // Step 2: Access /me with existing session cookie after short delay
    await new Promise((r) => setTimeout(r, 20));

    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', sessionCookie);

    expect(meRes.status).toBe(200);
    expect(meRes.body.authenticated).toBe(true);

    // rolling: true must issue a renewed Set-Cookie header with fresh 30-day expiry
    const renewedCookieHeaders = meRes.headers['set-cookie'];
    expect(renewedCookieHeaders).toBeDefined();
    expect(renewedCookieHeaders[0]).toContain('khata_session=');

    const renewedExpiresMatch = renewedCookieHeaders[0].match(/Expires=([^;]+)/);
    const renewedExpires = new Date(renewedExpiresMatch![1]).getTime();
    const diffMs = renewedExpires - Date.now();
    expect(Math.abs(diffMs - 2592000000)).toBeLessThan(5000);
    expect(renewedExpires).toBeGreaterThanOrEqual(initialExpires);
  });

  it('5. UptimeRobot liveness probes (/api/v1/health/live) do not renew session or return cookies', async () => {
    const app = createApp({ useMemoryStoreInTest: true });

    // Login to get a cookie
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    const sessionCookie = loginRes.headers['set-cookie'][0];

    // Probe health live endpoint with cookie attached
    const healthRes = await request(app)
      .get('/api/v1/health/live')
      .set('Cookie', sessionCookie);

    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe('alive');
    // Health probe must NEVER issue a set-cookie header or renew the session
    expect(healthRes.headers['set-cookie']).toBeUndefined();
  });

  it('6. Expired session returns HTTP 401 on /api/v1/auth/me and cannot access protected endpoints', async () => {
    // Custom store simulating an expired session
    class ExpiredSessionStore extends session.Store {
      get(_sid: string, fn: (err?: unknown, session?: session.SessionData | null) => void): void {
        // Database query filter (expire >= now) returned no rows
        fn(null, null);
      }
      set(_sid: string, _sess: session.SessionData, fn?: (err?: unknown) => void): void {
        if (fn) fn(null);
      }
      destroy(_sid: string, fn?: (err?: unknown) => void): void {
        if (fn) fn(null);
      }
    }

    const app = createApp({ customStore: new ExpiredSessionStore() });

    // 1. /me with expired session returns 401
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', 'khata_session=s%3Aexpired_sid.fake_signature');

    expect(meRes.status).toBe(401);
    expect(meRes.body.authenticated).toBe(false);

    // 2. Protected products API returns 401
    const prodRes = await request(app)
      .get('/api/v1/products')
      .set('Cookie', 'khata_session=s%3Aexpired_sid.fake_signature');

    expect(prodRes.status).toBe(401);
    expect(prodRes.body.authenticated).toBe(false);
  });

  it('7. Opportunistic session cleanup enforces 24-hour cooldown', async () => {
    let pruneCallCount = 0;
    const mockStore = {
      pruneSessions: vi.fn().mockImplementation((cb: (err?: Error) => void) => {
        pruneCallCount++;
        cb();
      }),
    } as unknown as session.Store;

    let simulatedTime = 1000000000;
    const getTime = () => simulatedTime;

    // Call 1: Prunes immediately
    await pruneExpiredSessionsOpportunistically(mockStore, { now: getTime });
    expect(pruneCallCount).toBe(1);

    // Call 2: Within 24 hours (1 hour later) -> cooldown skips cleanup
    simulatedTime += 60 * 60 * 1000;
    await pruneExpiredSessionsOpportunistically(mockStore, { now: getTime });
    expect(pruneCallCount).toBe(1);

    // Call 3: After 24 hours (25 hours later) -> runs cleanup
    simulatedTime += 25 * 60 * 60 * 1000;
    await pruneExpiredSessionsOpportunistically(mockStore, { now: getTime });
    expect(pruneCallCount).toBe(2);
  });

  it('8. Opportunistic session cleanup is single-flight: concurrent executions share one promise', async () => {
    let activePrunes = 0;
    let maxConcurrent = 0;

    const mockStore = {
      pruneSessions: vi.fn().mockImplementation((cb: (err?: Error) => void) => {
        activePrunes++;
        maxConcurrent = Math.max(maxConcurrent, activePrunes);
        setTimeout(() => {
          activePrunes--;
          cb();
        }, 50);
      }),
    } as unknown as session.Store;

    // Launch 5 concurrent prune requests
    const promises = [
      pruneExpiredSessionsOpportunistically(mockStore),
      pruneExpiredSessionsOpportunistically(mockStore),
      pruneExpiredSessionsOpportunistically(mockStore),
      pruneExpiredSessionsOpportunistically(mockStore),
      pruneExpiredSessionsOpportunistically(mockStore),
    ];

    await Promise.all(promises);

    expect(maxConcurrent).toBe(1);
    expect(mockStore.pruneSessions).toHaveBeenCalledTimes(1);
  });

  it('9. Opportunistic session cleanup handles store errors safely without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingStore = {
      pruneSessions: vi.fn().mockImplementation((cb: (err?: Error) => void) => {
        cb(new Error('PostgreSQL deadlock during prune'));
      }),
    } as unknown as session.Store;

    // Must resolve safely without throwing
    await expect(pruneExpiredSessionsOpportunistically(failingStore)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('10. Opportunistic session cleanup safely ignores custom stores lacking pruneSessions()', async () => {
    const memoryStore = new session.MemoryStore();
    // MemoryStore does not have pruneSessions method
    await expect(pruneExpiredSessionsOpportunistically(memoryStore)).resolves.toBeUndefined();
  });
});
