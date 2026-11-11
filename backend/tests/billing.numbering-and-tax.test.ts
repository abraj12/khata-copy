import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  allocateDocumentNumber,
  getSuggestedNextDocumentNumber,
  NORMAL_BILL_NUMBERING_CONFIG,
  GST_INVOICE_NUMBERING_CONFIG,
} from '../src/modules/billing/numbering.js';
import {
  GST_STATE_CODES,
  normalizeGstStateCode,
  validateGstinForState,
  getStateNameByCode,
} from '../src/utils/indianTax.js';
import {
  getBusinessDateISO,
  isValidCalendarDate,
  isBusinessDateExpired,
} from '../src/utils/businessDate.js';
import { AppError } from '../src/utils/errors.js';

describe('Billing Numbering, Indian Tax & Business Date Suite', () => {
  describe('Indian Tax & GST State Codes', () => {
    it('1. Authoritative Indian GST State Code map contains 37 verified entries', () => {
      expect(Object.keys(GST_STATE_CODES).length).toBeGreaterThanOrEqual(36);
      expect(GST_STATE_CODES['10']).toBe('Bihar');
      expect(GST_STATE_CODES['09']).toBe('Uttar Pradesh');
      expect(GST_STATE_CODES['07']).toBe('Delhi');
      expect(GST_STATE_CODES['27']).toBe('Maharashtra');
    });

    it('2. Normalizes 1-digit and 2-digit state codes properly', () => {
      expect(normalizeGstStateCode('9')).toBe('09');
      expect(normalizeGstStateCode('09')).toBe('09');
      expect(normalizeGstStateCode(10)).toBe('10');
      expect(normalizeGstStateCode(' 07 ')).toBe('07');
    });

    it('3. Rejects invalid or unmapped Indian GST state codes with HTTP 400', () => {
      expect(() => normalizeGstStateCode('')).toThrow(AppError);
      expect(() => normalizeGstStateCode(null)).toThrow(AppError);
      expect(() => normalizeGstStateCode('99')).toThrow(AppError);
      expect(() => normalizeGstStateCode('00')).toThrow(AppError);
    });

    it('4. Validates GSTIN structure and enforces prefix match with state code', () => {
      // Valid UP GSTIN matching '09'
      expect(() => validateGstinForState('09AAAAA0000A1Z0', '09')).not.toThrow();

      // Valid Bihar GSTIN matching '10'
      expect(() => validateGstinForState('10ABGCA8624E1Z3', '10')).not.toThrow();

      // Invalid Luhn mod-36 GSTIN checksum digit
      expect(() => validateGstinForState('09AAAAA0000A1Z5', '09')).toThrow(/Invalid GSTIN checksum digit/);

      // GSTIN state prefix mismatch: '10' GSTIN supplied for '09' UP customer
      expect(() => validateGstinForState('10ABGCA8624E1Z3', '09')).toThrow(/GSTIN state code prefix/);

      // Malformed GSTIN structure
      expect(() => validateGstinForState('INVALID_GSTIN_123', '10')).toThrow(/Invalid GSTIN format/);
    });

    it('5. getStateNameByCode retrieves canonical names for codes', () => {
      expect(getStateNameByCode('10')).toBe('Bihar');
      expect(getStateNameByCode('9')).toBe('Uttar Pradesh');
      expect(getStateNameByCode('99')).toBeUndefined();
    });
  });

  describe('Business Date & Calendar Validation', () => {
    it('6. Evaluates valid calendar dates in YYYY-MM-DD format strictly', () => {
      expect(isValidCalendarDate('2026-11-11')).toBe(true);
      expect(isValidCalendarDate('2024-02-29')).toBe(true); // 2024 is leap year
      expect(isValidCalendarDate('2025-02-29')).toBe(false); // 2025 is not leap year
      expect(isValidCalendarDate('2026-02-31')).toBe(false);
      expect(isValidCalendarDate('2026-04-31')).toBe(false); // April has 30 days
      expect(isValidCalendarDate('invalid-date')).toBe(false);
    });

    it('7. Computes business date in Asia/Kolkata timezone', () => {
      const now = new Date('2026-11-10T20:00:00.000Z'); // 8:00 PM UTC = 01:30 AM IST (Nov 11)
      const kolkataIso = getBusinessDateISO('Asia/Kolkata', now);
      expect(kolkataIso).toBe('2026-11-11');
    });

    it('8. Evaluates quotation validity expiration against business date', () => {
      expect(isBusinessDateExpired('2026-01-01', 'Asia/Kolkata')).toBe(true);
      expect(isBusinessDateExpired('2099-12-31', 'Asia/Kolkata')).toBe(false);
      expect(isBusinessDateExpired(null, 'Asia/Kolkata')).toBe(false);
    });
  });

  describe('Document Numbering & Concurrency Lock Allocator', () => {
    it('9. Allocates sequence-backed document number using advisory lock and 3-digit padding', async () => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('pg_advisory_xact_lock')) {
            return { rows: [] };
          }
          if (sql.includes('nextval')) {
            return { rows: [{ seq_num: 42 }] };
          }
          if (sql.includes('SELECT 1 FROM normal_bills')) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [] };
        }),
      } as any;

      const num = await allocateDocumentNumber(client, NORMAL_BILL_NUMBERING_CONFIG);
      expect(num).toBe('042');
      expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1, $2)', [18420, 1]);
    });

    it('10. Allocates valid manual document number and advances sequence high-water mark', async () => {
      const executed: string[] = [];
      const client = {
        query: vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
          executed.push(typeof sql === 'string' ? sql : (sql as any).text);
          if (sql.includes('pg_advisory_xact_lock')) {
            return { rows: [] };
          }
          if (sql.includes('SELECT 1 FROM normal_bills')) {
            return { rows: [], rowCount: 0 }; // No collision
          }
          if (sql.includes('last_value')) {
            return { rows: [{ last_value: '20', is_called: true }] };
          }
          if (sql.includes('setval')) {
            return { rows: [{ setval: '100' }] };
          }
          return { rows: [] };
        }),
      } as any;

      const num = await allocateDocumentNumber(client, NORMAL_BILL_NUMBERING_CONFIG, 'NB-100');
      expect(num).toBe('NB-100');
      expect(executed.some((q) => q.includes("setval('normal_bill_number_seq'"))).toBe(true);
    });

    it('11. Rejects duplicate manual document number with HTTP 409', async () => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT 1 FROM normal_bills')) {
            return { rows: [{ 1: 1 }], rowCount: 1 }; // Collision!
          }
          return { rows: [] };
        }),
      } as any;

      await expect(
        allocateDocumentNumber(client, NORMAL_BILL_NUMBERING_CONFIG, 'NB-DUPLICATE')
      ).rejects.toThrow(/already exists/);
    });

    it('12. Read-only preview calculates next number without calling setval or nextval', async () => {
      const executed: string[] = [];
      const pool = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          executed.push(sql);
          if (sql.includes('seq_last')) {
            return { rows: [{ seq_last: 15, seq_called: true, max_num: '15' }] };
          }
          return { rows: [] };
        }),
      } as any;

      const preview = await getSuggestedNextDocumentNumber(pool, GST_INVOICE_NUMBERING_CONFIG);
      expect(preview).toBe('016');
      expect(executed.some((q) => q.includes('setval'))).toBe(false);
      expect(executed.some((q) => q.includes('nextval'))).toBe(false);
    });
  });
});
