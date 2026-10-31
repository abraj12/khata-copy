import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env, loadAndValidateEnv } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import { loginAttemptStore } from '../src/modules/auth/loginAttemptStore.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { neonRealtimeService } from '../src/modules/realtime/realtime.service.js';

// Configure test credentials
const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH = '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

// Set up env for tests
env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false; // Allow supertest over HTTP in test runner

const app = createApp({ useMemoryStoreInTest: true });

describe('Khata Owner Authentication & Application Security Test Suite', () => {
  beforeEach(() => {
    loginAttemptStore.resetInMemory();
    vi.spyOn(appPool, 'query').mockImplementation(async () => {
      return { rows: [], rowCount: 0 } as any;
    });
  });

  // TEST CASE 1: Correct phone + correct password succeeds
  it('1. Correct phone + correct password succeeds and returns minimal owner state', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.owner).toEqual({ role: 'OWNER' });
    // Must NOT leak sensitive details
    expect(res.body.password).toBeUndefined();
    expect(res.body.hash).toBeUndefined();
    expect(res.body.sessionId).toBeUndefined();

    // Verify session cookie was set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies[0]).toContain('khata_session');
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('SameSite=Lax');
    expect(cookies[0]).toContain('Path=/');
    expect(cookies[0]).not.toContain('Domain='); // Host-only cookie
  });

  // TEST CASE 2: Wrong password fails with generic error
  it('2. Wrong password fails with generic error and does not disclose reason', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .send({ phone: TEST_PHONE, password: 'WrongPassword123!' });

    expect(res.status).toBe(401);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.message).toBe('Invalid mobile number or password.');
  });

  // TEST CASE 3: Unknown phone fails with exactly the same generic error
  it('3. Unknown phone fails with exactly the same generic error (preventing account enumeration)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .send({ phone: '9999999999', password: 'SomeRandomPassword!' });

    expect(res.status).toBe(401);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.message).toBe('Invalid mobile number or password.');
  });

  // TEST CASE 4: SQL injection in password field treated strictly as string
  it('4. SQL injection payloads in password field are treated as password strings and rejected safely', async () => {
    const payloads = [
      '1=1',
      "' OR '1'='1",
      "' OR 1=1 --",
      "admin' --",
      "'; DROP TABLE products; --",
    ];

    for (const sqlPayload of payloads) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Origin', 'https://khata.algions.in')
        .send({ phone: TEST_PHONE, password: sqlPayload });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid mobile number or password.');
    }
  }, 15000);

  // TEST CASE 5: SQL injection in phone field rejected safely by strict schema
  it('5. SQL injection payloads in phone field are rejected safely by schema validation', async () => {
    const badPhones = [
      "' OR 1=1 --",
      "admin'--",
      "9876543210' UNION SELECT * FROM session --",
    ];

    for (const badPhone of badPhones) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Origin', 'https://khata.algions.in')
        .send({ phone: badPhone, password: TEST_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
  });

  // TEST CASE 6: XSS payload in input rendered inertly
  it('6. <script>alert(1)</script> in phone or password does not execute or corrupt responses', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .send({ phone: '<script>alert(1)</script>', password: '<script>alert(1)</script>' });

    expect(res.status).toBe(400);
    expect(res.text).not.toContain('<script>alert(1)</script>');
  });

  // TEST CASE 7: Missing/invalid session cannot access protected APIs
  it('7. Missing or invalid session cannot access protected APIs (fails closed with 401)', async () => {
    const resProducts = await request(app).get('/api/v1/products');
    expect(resProducts.status).toBe(401);
    expect(resProducts.body.message).toContain('Authentication required');

    const resLedger = await request(app).get('/api/v1/ledger');
    expect(resLedger.status).toBe(401);

    const resMe = await request(app).get('/api/v1/auth/me');
    expect(resMe.status).toBe(401);
  });

  // TEST CASE 8: Valid session can access protected APIs
  it('8. Valid session can access protected APIs (Products reference & Ledger)', async () => {
    // 1. Log in
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    const sessionCookie = loginRes.headers['set-cookie'];

    // 2. Access /me
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', sessionCookie);
    expect(meRes.status).toBe(200);
    expect(meRes.body.authenticated).toBe(true);
    expect(meRes.body.owner.role).toBe('OWNER');

    // 3. Access protected products
    const prodRes = await request(app)
      .get('/api/v1/products')
      .set('Cookie', sessionCookie);
    expect(prodRes.status).toBe(200);
    expect(prodRes.body.success).toBe(true);
    expect(Array.isArray(prodRes.body.data)).toBe(true);

    // 4. Access protected ledger
    const ledgerRes = await request(app)
      .get('/api/v1/ledger')
      .set('Cookie', sessionCookie);
    expect(ledgerRes.status).toBe(200);
    expect(ledgerRes.body.success).toBe(true);
  });

  // TEST CASE 9: Logout invalidates session; replaying old cookie fails
  it('9. Logout invalidates session in server store; replaying old cookie fails with 401', async () => {
    // Log in
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    const sessionCookie = loginRes.headers['set-cookie'];

    // Fetch CSRF token
    const csrfRes = await request(app)
      .get('/api/v1/auth/csrf-token')
      .set('Cookie', sessionCookie);
    const csrfToken = csrfRes.body.csrfToken;

    // Log out
    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://khata.algions.in')
      .set('Cookie', sessionCookie)
      .set('X-CSRF-Token', csrfToken);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.authenticated).toBe(false);

    // Replay old cookie
    const replayRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', sessionCookie);

    expect(replayRes.status).toBe(401);
  });

  // TEST CASE 10: Session ID changes after login (session fixation defense)
  it('10. Session ID changes after login to prevent session fixation', async () => {
    // Get initial session cookie by hitting csrf-token
    const initialRes = await request(app).get('/api/v1/auth/csrf-token');
    const initialCookie = initialRes.headers['set-cookie'][0];
    const initialSid = initialCookie.split(';')[0];

    // Log in with the initial session
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .set('Cookie', initialCookie)
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    const postLoginCookie = loginRes.headers['set-cookie'][0];
    const postLoginSid = postLoginCookie.split(';')[0];

    expect(postLoginSid).not.toBe(initialSid);
  });

  // TEST CASE 11: Cookie flags (HttpOnly, SameSite=Lax, Path=/, host-only)
  it('11. Session cookie has HttpOnly, SameSite=Lax, Path=/, and no Domain attribute', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    const cookie = res.headers['set-cookie'][0];
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
    expect(cookie.toLowerCase()).toContain('path=/');
    expect(cookie.toLowerCase()).not.toContain('domain=');
  });

  // TEST CASE 12: Phone format normalization (+91, spaces, 10 digits)
  it('12. Accepts +91 prefix and normalizes correctly', async () => {
    const formats = ['+91 9876543210', '+91-9876543210', '+919876543210'];
    for (const raw of formats) {
      const normalized = authService.normalizePhone(raw);
      expect(normalized).toBe('9876543210');
    }
  });

  // TEST CASE 14: CSRF token and Origin checks reject forged requests
  it('14. CSRF rejects state-changing requests when Origin is unauthorized or CSRF token is missing', async () => {
    // 1. Log in
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });
    const sessionCookie = loginRes.headers['set-cookie'];

    // 2. Try POST with evil origin
    const evilRes = await request(app)
      .post('/api/v1/ledger/entry')
      .set('Origin', 'https://evil-attacker-site.com')
      .set('Cookie', sessionCookie)
      .send({ customer_id: 1, type: 'UDHAR_GIVEN', amount: 500 });
    expect(evilRes.status).toBe(403);
    expect(evilRes.body.message.toLowerCase()).toContain('origin');

    // 3. Try POST with valid origin but missing CSRF token
    const missingCsrfRes = await request(app)
      .post('/api/v1/ledger/entry')
      .set('Origin', 'https://khata.algions.in')
      .set('Cookie', sessionCookie)
      .send({ customer_id: 1, type: 'UDHAR_GIVEN', amount: 500 });
    expect(missingCsrfRes.status).toBe(403);
    expect(missingCsrfRes.body.message).toContain('CSRF');
  });

  // TEST CASE 15: CORS reject unapproved origin
  it('15. CORS rejects unapproved origins and never permits credentials with wildcard', async () => {
    const res = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'https://malicious-domain.com');

    // CORS preflight or rejection
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    expect(res.headers['access-control-allow-origin']).not.toBe('https://malicious-domain.com');
  });

  // TEST CASE 16: Persistent login abuse protection (5 failures -> 429)
  it('16. Five failed attempts trigger temporary lockout (HTTP 429)', async () => {
    const clientIp = '192.168.1.100';

    // Submit 5 failed attempts
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Origin', 'https://khata.algions.in')
        .set('X-Forwarded-For', clientIp)
        .send({ phone: TEST_PHONE, password: 'WrongPassword!' });
      expect(res.status).toBe(401);
    }

    // 6th attempt should be blocked with 429
    const blockedRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .set('X-Forwarded-For', clientIp)
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.isLocked).toBe(true);
    expect(blockedRes.body.message).toContain('Too many failed login attempts');
  }, 15000);

  // TEST CASE 18: Oversized and malformed JSON payloads rejected
  it('18. Malformed JSON returns 400 Bad Request', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .set('Content-Type', 'application/json')
      .send('{"phone": "9876543210", "password": '); // Incomplete JSON

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Malformed request payload');
  });

  // TEST CASE 19: Environment validation fails if insecure settings in production
  it('19. Production startup validation fails closed if SESSION_COOKIE_SECURE is false', () => {
    expect(() => {
      loadAndValidateEnv({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: 'false',
        SESSION_SECRET: 'dummy_secret_32_characters_long_min_length',
      });
    }).toThrow(/SESSION_COOKIE_SECURE must be true/);
  });

  // TEST CASE 21: Android Capacitor WebView Origin Support
  it('21. Android Capacitor WebView origins (capacitor://localhost, https://localhost) are permitted and authenticated', async () => {
    // 1. Android Capacitor login
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'capacitor://localhost')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.authenticated).toBe(true);

    const cookie = loginRes.headers['set-cookie'];

    // 2. Android Capacitor accessing protected route
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Origin', 'capacitor://localhost')
      .set('Cookie', cookie);

    expect(meRes.status).toBe(200);
    expect(meRes.body.authenticated).toBe(true);
  });

  // TEST CASE 25: Secret Leak Defense - Secrets never returned in JSON or headers
  it('25. NEON_REALTIME_SECRET, SESSION_SECRET, and database credentials are never leaked in responses', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    const bodyString = JSON.stringify(res.body);
    const headersString = JSON.stringify(res.headers);

    expect(bodyString).not.toContain(env.SESSION_SECRET);
    expect(bodyString).not.toContain(env.OWNER_PASSWORD_HASH);
    if (env.NEON_REALTIME_SECRET) {
      expect(bodyString).not.toContain(env.NEON_REALTIME_SECRET);
    }
    expect(headersString).not.toContain(env.SESSION_SECRET);
  });

  // TEST CASE 26: Phone canonicalization before lockout hashing
  it('26. Phone formats with "+91", spaces, and dashes map to the same account lockout bucket', async () => {
    const clientIp = '192.168.1.200';

    // Submit 4 failures with "+91 9876543210"
    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Origin', 'https://khata.algions.in')
        .set('X-Forwarded-For', clientIp)
        .send({ phone: '+91 9876543210', password: 'WrongPassword!' });
      expect(res.status).toBe(401);
    }

    // 5th failure with "9876543210" (no country code)
    const fifthRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .set('X-Forwarded-For', clientIp)
      .send({ phone: '9876543210', password: 'WrongPassword!' });
    expect(fifthRes.status).toBe(401);

    // 6th attempt with "+91-9876543210" must now be locked out with HTTP 429
    const blockedRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://khata.algions.in')
      .set('X-Forwarded-For', clientIp)
      .send({ phone: '+91-9876543210', password: TEST_PASSWORD });

    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.isLocked).toBe(true);
  });

  // TEST CASE 27: Production origin restrictions reject localhost
  it('27. Production origin validator rejects http://localhost and dev origins', async () => {
    const originalEnv = env.NODE_ENV;
    try {
      (env as any).NODE_ENV = 'production';
      const { isAllowedOrigin } = await import('../src/middleware/csrf.js');
      expect(isAllowedOrigin('http://localhost:5173')).toBe(false);
      expect(isAllowedOrigin('http://localhost:3000')).toBe(false);
      expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(false);
      expect(isAllowedOrigin('https://khata.algions.in')).toBe(true);
      expect(isAllowedOrigin('capacitor://localhost')).toBe(true);
    } finally {
      (env as any).NODE_ENV = originalEnv;
    }
  });

  // TEST CASE 28: Production environment fails closed on placeholder secrets
  it('28. Production environment startup fails closed on default placeholder SESSION_SECRET', () => {
    expect(() => {
      loadAndValidateEnv({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: 'true',
        SESSION_SECRET: 'super_secret_session_key_at_least_32_characters_long_khata',
      });
    }).toThrow(/SESSION_SECRET must be an explicitly configured/);
  });
});
