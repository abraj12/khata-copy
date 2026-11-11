import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import { authService } from '../src/modules/auth/auth.service.js';
import {
  computeGstinCheckDigit,
  validateGstin,
  validateGstinForState,
  resolveValidatedState,
} from '../src/utils/indianTax.js';
import { getCompanyTaxProfile } from '../src/services/companyTaxProfile.service.js';
import {
  hashIdempotencyPayload,
  checkIdempotencyRecord,
  cleanupExpiredIdempotencyKeys,
  updateIdempotencyResponse,
} from '../src/services/idempotency.service.js';
import { fetchSafeLogoBuffer, MAX_QUOTATION_LOGO_BYTES } from '../src/modules/quotations/logoFetch.js';
import { generateQuotationPdf } from '../src/modules/quotations/quotations.pdf.js';
import { quotationsService } from '../src/modules/quotations/quotations.service.js';
import { storageService } from '../src/services/storage.service.js';
import { Readable } from 'node:stream';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const VALID_PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const DEFAULT_SETTINGS_ROW = {
  id: 1,
  company_name: 'ALGIONS AI LABS PRIVATE LIMITED',
  logo_url: null,
  cin: 'U62011BR2026PTC088473',
  gstin: '10ABGCA8624E1Z3',
  address: 'House No. 145A, Haziyapur, Gopalganj, Bihar',
  email: 'contact@algions.in',
  phone: '9493840000',
  website: 'algions.in',
  state: 'Bihar',
  state_code: '10',
  bank_name: 'SBI',
  bank_account_number: '123456789012',
  bank_ifsc: 'SBIN0001234',
  bank_branch: 'Gopalganj',
  standard_validity_days: 30,
  standard_payment_terms: '100% advance',
  standard_delivery_terms: '7 days',
  standard_warranty_terms: '1 year',
  standard_declaration: 'Computer generated.',
  signatory_title: 'Director',
};

const app = createApp({ useMemoryStoreInTest: true });

describe('Khata Release #019 Remediation Regression Suite', () => {
  let authCookie: string;
  let csrfToken: string;

  beforeEach(async () => {
    vi.restoreAllMocks();

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: any) => {
      const sqlText = typeof sql === 'string' ? sql : sql?.text || '';
      if (sqlText.includes('FROM quotation_settings')) {
        return { rows: [DEFAULT_SETTINGS_ROW], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      phone: TEST_PHONE,
      password: TEST_PASSWORD,
    });
    authCookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
    const csrfRes = await request(app).get('/api/v1/auth/csrf-token').set('Cookie', authCookie);
    csrfToken = csrfRes.body.csrfToken;
  });

  describe('1. GSTIN Luhn mod-36 Checksum & State Cross-Validation', () => {
    it('accepts valid verified GSTINs across states and rejects invalid checksum digits', () => {
      const validCases = [
        { gstin: '10ABGCA8624E1Z3', code: '10' },
        { gstin: '09AAAAA0000A1Z0', code: '09' },
        { gstin: '09AABCS1429B1ZS', code: '09' },
        { gstin: '09ABCDE1234F1ZY', code: '09' },
        { gstin: '09AAACT1234A1ZZ', code: '09' },
        { gstin: '03ABCDE1234F1ZA', code: '03' },
        { gstin: '27ABCDE1234F1Z0', code: '27' },
      ];

      for (const tc of validCases) {
        expect(validateGstinForState(tc.gstin, tc.code)).toBe(tc.gstin);
      }

      expect(computeGstinCheckDigit('10ABGCA8624E1Z')).toBe('3');
      expect(() => validateGstin('10ABGCA8624E1Z4')).toThrow(/checksum digit/);
      expect(() => validateGstin('09AAAAA0000A1Z5')).toThrow(/checksum digit/);
      expect(() => validateGstinForState('10ABGCA8624E1Z3', '09')).toThrow(/does not match/);
    });

    it('resolveValidatedState returns null when optional & omitted and rejects name/code mismatch', () => {
      expect(resolveValidatedState({ required: false })).toEqual({ state: null, stateCode: null });
      expect(() => resolveValidatedState({ required: true })).toThrow(/required for GST calculation/);
      expect(() =>
        resolveValidatedState({ state: 'Uttar Pradesh', stateCode: '10', required: true })
      ).toThrow(/does not match state code/);

      expect(resolveValidatedState({ stateCode: '9', required: true })).toEqual({
        state: 'Uttar Pradesh',
        stateCode: '09',
      });
      expect(
        resolveValidatedState({
          state: 'Dadra & Nagar Haveli and Daman & Diu',
          required: true,
        })
      ).toEqual({
        state: 'Dadra and Nagar Haveli and Daman and Diu',
        stateCode: '26',
      });
    });

    it('getCompanyTaxProfile fails closed when quotation_settings is missing or inconsistent', async () => {
      await expect(
        getCompanyTaxProfile({
          query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        })
      ).rejects.toMatchObject({ status: 500, code: 'COMPANY_TAX_PROFILE_MISSING' });

      await expect(
        getCompanyTaxProfile({
          query: vi.fn().mockResolvedValue({
            rows: [{ ...DEFAULT_SETTINGS_ROW, state: null, state_code: null }],
            rowCount: 1,
          }),
        })
      ).rejects.toMatchObject({ status: 400, code: 'STATE_CODE_REQUIRED' });

      await expect(
        getCompanyTaxProfile({
          query: vi.fn().mockResolvedValue({
            rows: [{ ...DEFAULT_SETTINGS_ROW, state: 'Delhi', state_code: '07', gstin: '10ABGCA8624E1Z3' }],
            rowCount: 1,
          }),
        })
      ).rejects.toMatchObject({ status: 400, code: 'GSTIN_STATE_MISMATCH' });

      const ok = await getCompanyTaxProfile({
        query: vi.fn().mockResolvedValue({ rows: [DEFAULT_SETTINGS_ROW], rowCount: 1 }),
      });
      expect(ok.state).toBe('Bihar');
      expect(ok.stateCode).toBe('10');
      expect(ok.gstin).toBe('10ABGCA8624E1Z3');
    });
  });

  describe('2. Customer State API & Null-Safe Clearing', () => {
    it('creates, updates, and clears customer state via /api/v1/khata/customers without Bihar fabrication', async () => {
      let customerRecord = {
        id: '15',
        name: 'Asha Builders',
        phone: '9876501234',
        normalized_phone: '+919876501234',
        address: 'Mumbai',
        state: null as string | null,
        state_code: null as string | null,
        total_udhar: '0.00',
        total_received: '0.00',
        outstanding: '0.00',
        last_activity: null,
      };

      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
          const s = sql.trim().toUpperCase();
          if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };
          if (s.includes('FROM CUSTOMERS WHERE NORMALIZED_PHONE')) return { rows: [], rowCount: 0 };
          if (s.startsWith('INSERT INTO CUSTOMERS')) {
            customerRecord = {
              ...customerRecord,
              state: (params[5] as string) || null,
              state_code: (params[6] as string) || null,
            };
            return { rows: [{ id: '15' }], rowCount: 1 };
          }
          if (s.includes('FROM CUSTOMERS WHERE ID = $1')) {
            return { rows: [customerRecord], rowCount: 1 };
          }
          if (s.startsWith('UPDATE CUSTOMERS SET')) {
            if (sql.includes('state =')) {
              const stateVal = params[0] === null || typeof params[0] === 'string' ? params[0] : customerRecord.state;
              const codeVal = params[1] === null || typeof params[1] === 'string' ? params[1] : customerRecord.state_code;
              customerRecord.state = stateVal;
              customerRecord.state_code = codeVal;
            }
            return { rows: [customerRecord], rowCount: 1 };
          }
          if (s.includes('WITH CUSTOMER_TX')) {
            return { rows: [customerRecord], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };

      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

      // Create without state -> remains null (no Bihar default)
      const createRes = await request(app)
        .post('/api/v1/khata/customers')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ name: 'Asha Builders', phone: '9876501234', address: 'Mumbai' });
      expect(createRes.status).toBe(201);
      expect(createRes.body.customer.state).toBeNull();
      expect(createRes.body.customer.state_code).toBeNull();

      // Invalid state rejected with 400
      const badPatch = await request(app)
        .patch('/api/v1/khata/customers/15')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ state: 'Maharashtra', stateCode: '10' });
      expect(badPatch.status).toBe(400);

      // Valid PATCH state
      const okPatch = await request(app)
        .patch('/api/v1/khata/customers/15')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ state: 'Maharashtra', stateCode: '27' });
      expect(okPatch.status).toBe(200);
      expect(okPatch.body.customer.state).toBe('Maharashtra');
      expect(okPatch.body.customer.state_code).toBe('27');

      // Explicit clear sets both state columns back to null
      const clearPatch = await request(app)
        .patch('/api/v1/khata/customers/15')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ state: null, stateCode: null });
      expect(clearPatch.status).toBe(200);
      expect(clearPatch.body.customer.state).toBeNull();
      expect(clearPatch.body.customer.state_code).toBeNull();
    });
  });

  describe('3. Buyer State & GST Tax Order in Invoices and Quotations', () => {
    it('rejects GST invoice creation & preview-pdf without customer state instead of defaulting to Bihar', async () => {
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
          if (sql.includes('FROM quotation_settings')) {
            return { rows: [DEFAULT_SETTINGS_ROW], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };
      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

      const createRes = await request(app)
        .post('/api/v1/gst-invoices')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({
          customerName: 'Unconfigured Buyer',
          gstRate: 18,
          items: [{ description: 'Item A', quantity: 1, rate: 100 }],
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.code).toBe('STATE_CODE_REQUIRED');

      const previewRes = await request(app)
        .post('/api/v1/gst-invoices/preview-pdf')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({
          customerName: 'Unconfigured Buyer',
          gstRate: 18,
          items: [{ description: 'Item A', quantity: 1, rate: 100 }],
        });
      expect(previewRes.status).toBe(400);
      expect(previewRes.body.code).toBe('STATE_CODE_REQUIRED');
    });

    it('rejects GST quotation without buyer state before totals calculation, allows non-GST without buyer state, and accepts manual QT-150', async () => {
      const queries: string[] = [];
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          queries.push(sql);
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
          if (sql.includes('FROM quotation_settings')) {
            return { rows: [DEFAULT_SETTINGS_ROW], rowCount: 1 };
          }
          if (sql.includes('SELECT 1 FROM quotations')) return { rows: [], rowCount: 0 };
          if (sql.includes('INSERT INTO quotations')) {
            return {
              rows: [
                {
                  id: 77,
                  quotation_number: 'QT-150',
                  quotation_date: '2026-11-11',
                  valid_until: '2026-12-11',
                  status: 'draft',
                  customer_name: 'Non-GST Buyer',
                  customer_state: null,
                  customer_state_code: null,
                  gst_enabled: false,
                  tax_amount: '0.00',
                  grand_total: '500.00',
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes('INSERT INTO quotation_items')) return { rows: [{ id: 1 }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };
      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as any);

      // GST-enabled quotation without state -> rejected before inserting quotation row
      const gstMissingState = await request(app)
        .post('/api/v1/quotations')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({
          customerName: 'Missing State Buyer',
          gstEnabled: true,
          gstRate: 18,
          items: [{ description: 'Compute Node', quantity: 1, rate: 1000 }],
        });
      expect(gstMissingState.status).toBe(400);
      expect(gstMissingState.body.code).toBe('STATE_CODE_REQUIRED');
      expect(queries.some((q) => q.includes('INSERT INTO quotations'))).toBe(false);

      // GSTIN mismatch with buyer state -> 400 GSTIN_STATE_MISMATCH
      await expect(
        quotationsService.createQuotation({
          customerName: 'Mismatch GSTIN Buyer',
          customerState: 'Bihar',
          customerStateCode: '10',
          customerGstin: '09AABCS1429B1ZS',
          gstEnabled: true,
          gstRate: 18,
          items: [{ description: 'Item', quantity: 1, rate: 100 }],
        })
      ).rejects.toMatchObject({ status: 400, code: 'GSTIN_STATE_MISMATCH' });

      // Non-GST quotation without buyer state + manual number QT-150 -> succeeds cleanly
      const nonGstRes = await request(app)
        .post('/api/v1/quotations')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({
          quotationNumber: 'QT-150',
          customerName: 'Non-GST Buyer',
          gstEnabled: false,
          items: [{ description: 'Consulting', quantity: 1, rate: 500 }],
        });
      expect(nonGstRes.status).toBe(201);
      expect(nonGstRes.body.data.quotation_number).toBe('QT-150');
      expect(nonGstRes.body.data.customer_state).toBeNull();
    });
  });

  describe('4. Idempotency Hash Completeness, Action Isolation, Expiry & Cleanup', () => {
    it('hashes full document payloads deterministically and catches metadata changes & action mismatches', async () => {
      const base = {
        customerName: 'Ramesh',
        customerState: 'Bihar',
        customerStateCode: '10',
        notes: 'Original note',
        items: [{ description: 'Board', quantity: '2', rate: '500.00' }],
      };
      const hashA = hashIdempotencyPayload(base);
      const hashReordered = hashIdempotencyPayload({
        items: [{ rate: '500.00', description: 'Board', quantity: '2' }],
        notes: 'Original note',
        customerStateCode: '10',
        customerState: 'Bihar',
        customerName: 'Ramesh',
      });
      const hashNotesChanged = hashIdempotencyPayload({ ...base, notes: 'Changed note' });

      expect(hashA).toBe(hashReordered);
      expect(hashA).not.toBe(hashNotesChanged);

      // Action mismatch rejected with 409 IDEMPOTENCY_CONFLICT
      const activeDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              key: 'k-1',
              action: 'CREATE_NORMAL_BILL',
              request_hash: hashA,
              response_status: 201,
              response_body: { id: 1 },
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              is_expired: false,
            },
          ],
          rowCount: 1,
        }),
      };

      await expect(
        checkIdempotencyRecord(activeDb, 'k-1', 'CREATE_GST_INVOICE', hashA)
      ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });

      await expect(
        checkIdempotencyRecord(activeDb, 'k-1', 'CREATE_NORMAL_BILL', hashNotesChanged)
      ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });

      // Expired key returns expired: true without throwing conflict
      const expiredDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              key: 'k-1',
              action: 'CREATE_NORMAL_BILL',
              request_hash: hashA,
              response_status: 201,
              response_body: { id: 1 },
              created_at: new Date(Date.now() - 90_000_000).toISOString(),
              expires_at: new Date(Date.now() - 1000).toISOString(),
              is_expired: true,
            },
          ],
          rowCount: 1,
        }),
      };
      const expiredRes = await checkIdempotencyRecord(expiredDb, 'k-1', 'CREATE_GST_INVOICE', hashNotesChanged);
      expect(expiredRes).toEqual({ found: true, expired: true });

      // Bounded cleanup skips when lock not acquired
      const skipDb = {
        query: vi.fn().mockResolvedValueOnce({ rows: [{ acquired: false }], rowCount: 1 }),
      };
      expect(await cleanupExpiredIdempotencyKeys(skipDb, 50)).toBe(0);
      expect(skipDb.query).toHaveBeenCalledTimes(1);

      // Post-commit response sync sends parameterized UPDATE
      const updateDb = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
      await updateIdempotencyResponse(updateDb, {
        key: 'k-1',
        action: 'CREATE_NORMAL_BILL',
        requestHash: hashA,
        responseStatus: 201,
        responseBody: { success: true, r2_object_key: 'bills/1.pdf' },
      });
      expect(updateDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE idempotency_keys'),
        ['k-1', 'CREATE_NORMAL_BILL', hashA, 201, JSON.stringify({ success: true, r2_object_key: 'bills/1.pdf' })]
      );
    });
  });

  describe('5. SSRF-Safe Quotation Logo Fetching & PDF Embedding', () => {
    it('blocks unsafe URLs, private DNS targets, redirects, and oversize payloads; embeds valid PNG cleanly', async () => {
      expect(await fetchSafeLogoBuffer('http://example.com/logo.png')).toBeNull();
      expect(await fetchSafeLogoBuffer('https://localhost/logo.png')).toBeNull();
      expect(await fetchSafeLogoBuffer('https://169.254.169.254/latest/meta-data')).toBeNull();
      expect(await fetchSafeLogoBuffer('https://untrusted.example.org/logo.png')).toBeNull();

      // Private DNS resolution blocked
      expect(
        await fetchSafeLogoBuffer('https://cdn.algions.in/logo.png', {
          allowedHosts: ['cdn.algions.in'],
          lookupFn: async () => [{ address: '10.0.0.5', family: 4 }],
        })
      ).toBeNull();

      // HTTP redirect blocked
      expect(
        await fetchSafeLogoBuffer('https://cdn.algions.in/logo.png', {
          allowedHosts: ['cdn.algions.in'],
          lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
          fetchFn: (async () =>
            new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } })) as any,
        })
      ).toBeNull();

      // Oversized payload blocked
      expect(
        await fetchSafeLogoBuffer('https://cdn.algions.in/big.png', {
          allowedHosts: ['cdn.algions.in'],
          lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
          fetchFn: (async () =>
            new Response(new Uint8Array(MAX_QUOTATION_LOGO_BYTES + 10), {
              status: 200,
              headers: {
                'content-type': 'image/png',
                'content-length': String(MAX_QUOTATION_LOGO_BYTES + 10),
              },
            })) as any,
        })
      ).toBeNull();

      // Valid trusted R2 object key renders into quotation PDF without crashing
      vi.spyOn(storageService, 'isConfigured').mockReturnValue(true);
      vi.spyOn(storageService, 'getObjectStream').mockResolvedValue({
        stream: Readable.from([VALID_PNG_1X1]),
        contentType: 'image/png',
        contentLength: VALID_PNG_1X1.length,
      });

      const pdfBuffer = await generateQuotationPdf({
        quotationNumber: 'QT-901',
        quotationDate: '2026-11-11',
        validUntil: '2026-12-11',
        company: {
          companyName: 'ALGIONS AI LABS PRIVATE LIMITED',
          logoUrl: 'branding/algions-logo.png',
          address: 'Gopalganj, Bihar',
          state: 'Bihar',
          stateCode: '10',
        },
        customer: {
          name: 'Valid Logo Client',
          state: 'Uttar Pradesh',
          stateCode: '09',
        },
        items: [{ description: 'Item', quantity: 1, rate: '100.00', amount: '100.00' }],
        totals: {
          subtotal: '100.00',
          taxableAmount: '100.00',
          gstEnabled: true,
          gstRate: '18',
          igstAmount: '18.00',
          taxAmount: '18.00',
          grandTotal: '118.00',
        },
        amountInWords: 'Rupees One Hundred Eighteen Only',
      });
      expect(pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdfBuffer.length).toBeGreaterThan(1500);
    });
  });

  describe('6. Auth Dummy Argon2id Verification Integrity', () => {
    it('executes real Argon2id verify without throwing on unknown phone login', async () => {
      const verifySpy = vi.spyOn(argon2, 'verify');
      const result = await authService.verifyCredentials('9999999999', 'WrongPassword@123');
      expect(result).toEqual({ success: false, normalizedPhone: '9999999999' });
      expect(verifySpy).toHaveBeenCalledTimes(1);
      await expect(verifySpy.mock.results[0].value).resolves.toBe(false);
    });
  });
});
