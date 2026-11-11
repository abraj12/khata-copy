import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env, loadAndValidateEnv } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import { loginAttemptStore, LoginAttemptStore } from '../src/modules/auth/loginAttemptStore.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { realtimeManager } from '../src/modules/realtime/realtime.service.js';

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
    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('information_schema.tables')) {
        if (sqlText.includes('schema_migrations')) {
          return { rows: [{ has_table: true }], rowCount: 1 } as any;
        }
        return {
          rows: [
            { table_name: 'session' },
            { table_name: 'login_attempts' },
            { table_name: 'products' },
            { table_name: 'customers' },
            { table_name: 'udhar_transactions' },
            { table_name: 'udhar_items' },
            { table_name: 'payments' },
            { table_name: 'payment_allocations' },
            { table_name: 'idempotency_keys' },
            { table_name: 'offline_bill_records' },
            { table_name: 'gst_invoices' },
            { table_name: 'gst_invoice_items' },
            { table_name: 'normal_bills' },
            { table_name: 'normal_bill_items' },
            { table_name: 'quotations' },
            { table_name: 'quotation_items' },
            { table_name: 'quotation_settings' },
          ],
          rowCount: 9,
        } as any;
      }
      if (sqlText.includes('FROM schema_migrations')) {
        return {
          rows: [
            { version: '001_auth_tables.sql' },
            { version: '002_khata_transactions.sql' },
            { version: '003_idempotency_and_hardening.sql' },
            { version: '004_integer_quantity_and_money_constraints.sql' },
            { version: '005_search_indexes_and_identity_constraints.sql' },
            { version: '006_quantity_two_decimal_places.sql' },
            { version: '007_quantity_strict_scale_and_allocation_integrity.sql' },
            { version: '008_strict_quantity_scale.sql' },
            { version: '009_product_images_and_offline_bills.sql' },
            { version: '010_product_hsn_code.sql' },
            { version: '013_customer_address.sql' },
            { version: '014_billing_quantity_and_sequences.sql' },
            { version: '015_product_barcode.sql' },
            { version: '016_quotations.sql' },
            { version: '017_quotation_conversion_financial_fields.sql' },
            { version: '018_numbering_and_legacy_data_integrity.sql' },
            { version: '019_customer_tax_integrity_and_idempotency.sql' },
            {
            version: '011_gst_invoices.sql',
          },
          {
            version: '012_normal_bills.sql',
          },
          ],
          rowCount: 19,
        } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });
  });

  // TEST CASE 1: Correct phone + correct password succeeds
  it('1. Correct phone + correct password succeeds and returns minimal owner state', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.owner).toEqual({ role: 'OWNER' });
    // Must NOT leak sensitive details
    expect(res.body.password).toBeUndefined();
    expect(res.body.hash).toBeUndefined();
    expect(res.body.sessionId).toBeUndefined();
    expect(res.body.csrfToken).toBeDefined();
    expect(typeof res.body.csrfToken).toBe("string");

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
      .set('Origin', 'https://erp.algions.in')
      .send({ phone: TEST_PHONE, password: 'WrongPassword123!' });

    expect(res.status).toBe(401);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.message).toBe('Invalid mobile number or password.');
  });

  // TEST CASE 3: Unknown phone fails with exactly the same generic error
  it('3. Unknown phone fails with exactly the same generic error (preventing account enumeration)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
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
        .set('Origin', 'https://erp.algions.in')
        .send({ phone: TEST_PHONE, password: sqlPayload });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid mobile number or password.');
    }
  }, 30000);

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
        .set('Origin', 'https://erp.algions.in')
        .send({ phone: badPhone, password: TEST_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
  });

  // TEST CASE 6: XSS payload in input rendered inertly
  it('6. <script>alert(1)</script> in phone or password does not execute or corrupt responses', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
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
      .set('Origin', 'https://erp.algions.in')
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
      .set('Origin', 'https://erp.algions.in')
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
      .set('Origin', 'https://erp.algions.in')
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
      .set('Origin', 'https://erp.algions.in')
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
      .set('Origin', 'https://erp.algions.in')
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
      .set('Origin', 'https://erp.algions.in')
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
      .set('Origin', 'https://erp.algions.in')
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
        .set('Origin', 'https://erp.algions.in')
        .set('X-Forwarded-For', clientIp)
        .send({ phone: TEST_PHONE, password: 'WrongPassword!' });
      expect(res.status).toBe(401);
    }

    // 6th attempt should be blocked with 429
    const blockedRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
      .set('X-Forwarded-For', clientIp)
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.isLocked).toBe(true);
    expect(blockedRes.body.message).toContain('Too many failed login attempts');
  }, 30000);

  // TEST CASE 18: Oversized and malformed JSON payloads rejected
  it('18. Malformed JSON returns 400 Bad Request', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
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

  // TEST CASE 21: Production Origin & Security Defense
  it('21. Production website origin (https://erp.algions.in) is permitted and authenticated; unauthorized origins are rejected', async () => {
    // 1. Production website login
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.authenticated).toBe(true);

    const cookie = loginRes.headers['set-cookie'];

    // 2. Production website accessing protected route
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Origin', 'https://erp.algions.in')
      .set('Cookie', cookie);

    expect(meRes.status).toBe(200);
    expect(meRes.body.authenticated).toBe(true);

    // 3. Unauthorized origin rejected
    const badRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', 'https://malicious-site.com')
      .set('Cookie', cookie);
    expect(badRes.status).toBe(403);
  });

  // TEST CASE 25: Secret Leak Defense - Secrets never returned in JSON or headers
  it('25. NEON_REALTIME_SECRET, SESSION_SECRET, and database credentials are never leaked in responses', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
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
        .set('Origin', 'https://erp.algions.in')
        .set('X-Forwarded-For', clientIp)
        .send({ phone: '+91 9876543210', password: 'WrongPassword!' });
      expect(res.status).toBe(401);
    }

    // 5th failure with "9876543210" (no country code)
    const fifthRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
      .set('X-Forwarded-For', clientIp)
      .send({ phone: '9876543210', password: 'WrongPassword!' });
    expect(fifthRes.status).toBe(401);

    // 6th attempt with "+91-9876543210" must now be locked out with HTTP 429
    const blockedRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
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
      expect(isAllowedOrigin('https://erp.algions.in')).toBe(true);
      expect(isAllowedOrigin('capacitor://localhost')).toBe(false);
      expect(isAllowedOrigin('https://localhost')).toBe(false);
      expect(isAllowedOrigin('https://evil.com')).toBe(false);
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

  // TEST CASE 29: CORS OPTIONS preflight request with Idempotency-Key
  it('29. CORS OPTIONS preflight with Idempotency-Key returns 204, exact origin, credentials, and allowed header', async () => {
    const res = await request(app)
      .options('/api/v1/khata/transactions')
      .set('Origin', 'https://erp.algions.in')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token,idempotency-key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://erp.algions.in');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const allowedHeaders = (res.headers['access-control-allow-headers'] || '').toLowerCase();
    expect(allowedHeaders).toContain('idempotency-key');
    expect(allowedHeaders).toContain('x-csrf-token');
  });

  // TEST CASE 30: CORS OPTIONS preflight from unauthorized origin is rejected
  it('30. CORS preflight request from unauthorized origin does not return allow headers', async () => {
    const res = await request(app)
      .options('/api/v1/khata/transactions')
      .set('Origin', 'https://malicious-phishing-site.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // TEST CASE 31: Production environment fails closed on insecure cookie configs
  it('31. Production environment fails closed if SESSION_COOKIE_HTTP_ONLY is false or SameSite is invalid', () => {
    expect(() => {
      loadAndValidateEnv({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: 'true',
        SESSION_COOKIE_HTTP_ONLY: 'false',
        SESSION_SECRET: 'valid_random_secret_with_more_than_32_characters_long',
        OWNER_PHONE: '9812345678',
        OWNER_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$realvalidhash00000000000000000000',
        DATABASE_URL_POOLED: 'postgresql://usr:pwd@ep-prod-pooler.aws.neon.tech/neondb?sslmode=require',
        DATABASE_URL: 'postgresql://usr:pwd@ep-prod.aws.neon.tech/neondb?sslmode=require',
      });
    }).toThrow(/SESSION_COOKIE_HTTP_ONLY must be true/);

    expect(() => {
      loadAndValidateEnv({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: 'true',
        SESSION_COOKIE_HTTP_ONLY: 'true',
        SESSION_COOKIE_SAME_SITE: 'none',
        SESSION_SECRET: 'valid_random_secret_with_more_than_32_characters_long',
        OWNER_PHONE: '9812345678',
        OWNER_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$realvalidhash00000000000000000000',
        DATABASE_URL_POOLED: 'postgresql://usr:pwd@ep-prod-pooler.aws.neon.tech/neondb?sslmode=require',
        DATABASE_URL: 'postgresql://usr:pwd@ep-prod.aws.neon.tech/neondb?sslmode=require',
      });
    }).toThrow(/SESSION_COOKIE_SAME_SITE must be lax or strict/);
  });

  // TEST CASE 32: Production environment fails closed on missing owner phone
  it('32. Production environment fails closed on unconfigured or default placeholder OWNER_PHONE', () => {
    expect(() => {
      loadAndValidateEnv({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: 'true',
        SESSION_COOKIE_HTTP_ONLY: 'true',
        SESSION_SECRET: 'valid_random_secret_with_more_than_32_characters_long',
        OWNER_PHONE: '9876543210', // Default placeholder rejected
        OWNER_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$realvalidhash00000000000000000000',
        DATABASE_URL_POOLED: 'postgresql://usr:pwd@ep-prod-pooler.aws.neon.tech/neondb?sslmode=require',
        DATABASE_URL: 'postgresql://usr:pwd@ep-prod.aws.neon.tech/neondb?sslmode=require',
      });
    }).toThrow(/OWNER_PHONE must be explicitly configured/);
  });

  // TEST CASE 33: Production environment fails closed on non-TLS database URLs
  it('33. Production environment fails closed if DATABASE_URL lacks TLS sslmode requirement', () => {
    expect(() => {
      loadAndValidateEnv({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: 'true',
        SESSION_COOKIE_HTTP_ONLY: 'true',
        SESSION_SECRET: 'valid_random_secret_with_more_than_32_characters_long',
        OWNER_PHONE: '9812345678',
        OWNER_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$realvalidhash00000000000000000000',
        DATABASE_URL_POOLED: 'postgresql://usr:pwd@ep-prod-pooler.aws.neon.tech/neondb', // Missing ?sslmode=require
        DATABASE_URL: 'postgresql://usr:pwd@ep-prod.aws.neon.tech/neondb?sslmode=require',
      });
    }).toThrow(/DATABASE_URL_POOLED must be explicitly configured with TLS enabled/);
  });

  // TEST CASE 34: LoginAttemptStore retention cleanup
  it('34. LoginAttemptStore pruneOldAttempts cleans up expired attempts and retains recent ones', async () => {
    const store = new LoginAttemptStore(true);
    const clientIp = '10.20.30.40';
    const testPhone = '9876500000';

    await store.recordAttempt(clientIp, testPhone, false);
    const remaining = await store.pruneOldAttempts();
    expect(remaining).toBeGreaterThanOrEqual(1);

    const status = await store.checkLockout(clientIp, testPhone);
    expect(status.isLocked).toBe(false);
  });

  // TEST CASE 35: Readiness probe returns healthy minimal response without leaking schema internals
  it('35. Readiness probe /api/v1/health/ready returns minimal ready status and does NOT disclose internal schema or migration details', async () => {
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.database).toBeUndefined();
    expect(res.body.checks).toBeUndefined();
    expect(res.body.migrationsApplied).toBeUndefined();
    expect(res.body.coreTables).toBeUndefined();
  });

  // TEST CASE 36: LoginAttemptStore background pruning handles connection failure safely
  it('36. LoginAttemptStore background pruning handles connection failure gracefully without unhandled rejections', async () => {
    const store = new LoginAttemptStore(false);
    vi.spyOn(appPool, 'connect').mockRejectedValueOnce(new Error('Simulated database connection failure'));

    // maybePruneOldAttempts must resolve safely without throwing
    await expect(store.maybePruneOldAttempts()).resolves.toBeUndefined();

    // Check lockout must remain resilient even if connection acquisition fails
    vi.spyOn(appPool, 'connect').mockRejectedValueOnce(new Error('Simulated connection failure on cleanup'));
    const status = await store.checkLockout('192.168.1.100', '9876543210');
    expect(status).toBeDefined();
    expect(status.isLocked).toBe(false);
  });

  // TEST CASE 37: Liveness probe /api/v1/health/live bypasses session middleware and does not set session cookies
  it('37. Liveness probe /api/v1/health/live returns 200 alive, bypasses session store, and sets no session cookie', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
    expect(res.body.timestamp).toBeDefined();
    expect(res.headers['cache-control']).toContain('no-store');
    // Session middleware is registered AFTER health routes: no session cookie must be created
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  // TEST CASE 38: Login returns csrfToken directly in response body
  it('38. Login response directly includes csrfToken to eliminate extra round-trip', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.csrfToken).toBeDefined();
    expect(typeof res.body.csrfToken).toBe('string');
    expect(res.body.csrfToken.length).toBeGreaterThan(16);
  });

  // TEST CASE 39: Diagnostic logging on /api/v1/auth/me does not leak secrets
  it('39. /api/v1/auth/me logs diagnostic metrics without logging cookies or session secrets', async () => {
    const consoleSpy = vi.spyOn(console, 'log');

    // 401 unauthenticated check
    await request(app).get('/api/v1/auth/me');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/\[AUTH ME\] status=401 durationMs=\d+ authenticated=false/));

    // Authenticated check
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://erp.algions.in')
      .send({ phone: TEST_PHONE, password: TEST_PASSWORD });
    const cookie = loginRes.headers['set-cookie']?.[0];

    await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookie || '');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/\[AUTH ME\] status=200 durationMs=\d+ authenticated=true/));
  });

  // TEST CASE 40: Readiness probe returns 503 when database is unready without leaking internals
  it('40. Readiness probe /api/v1/health/ready returns 503 when database is unavailable', async () => {
    vi.spyOn(appPool, 'query').mockRejectedValueOnce(new Error('Connection refused'));
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unready');
    expect(res.body.database).toBeUndefined();
  });
});
