import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import {
  StorageService,
  MAX_PRODUCT_IMAGE_BYTES,
  MAX_SUPPLIER_DOC_BYTES,
  MAX_OFFLINE_BILL_BYTES,
} from '../src/services/storage.service.js';
import { getCompanyTaxProfile } from '../src/services/companyTaxProfile.service.js';
import { generateQuotationPdf, QuotationPdfData } from '../src/modules/quotations/quotations.pdf.js';
import { generateTaxInvoicePdf, GstInvoicePdfData } from '../src/modules/gstInvoices/gstInvoices.pdf.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client: unknown, command: unknown) => {
    const input = (command as { input?: { Key?: string; ContentType?: string } })?.input;
    const key = input?.Key || 'mock-key';
    const ct = encodeURIComponent(input?.ContentType || '');
    return `https://fake-r2.cloudflarestorage.com/${key}?ct=${ct}`;
  },
}));

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

const app = createApp({ useMemoryStoreInTest: true });

interface ParsedPdf {
  numPages: number;
  pageTexts: string[];
  fullText: string;
}

async function parsePdfBuffer(buffer: Buffer): Promise<ParsedPdf> {
  expect(buffer.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdfDoc = await loadingTask.promise;
  try {
    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const text = (textContent.items as Array<{ str?: string }>)
        .map((item) => item.str || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pageTexts.push(text);
    }
    return {
      numPages: pdfDoc.numPages,
      pageTexts,
      fullText: pageTexts.join(' '),
    };
  } finally {
    await loadingTask.destroy();
  }
}

const DEFAULT_COMPANY_SETTINGS_ROW = {
  id: 1,
  company_name: 'ALGIONS AI LABS PRIVATE LIMITED',
  cin: 'U62011BR2026PTC088473',
  gstin: '09AAAAA0000A1Z0',
  address: 'House No. 145A, Haziyapur, Ward 26, Sector 5, Uttar Pradesh',
  email: 'billing@algions.in',
  phone: '94938 40000',
  website: 'algions.in',
  state: 'Uttar Pradesh',
  state_code: '09',
  bank_name: 'State Bank of India',
  bank_account_number: '123456789012',
  bank_ifsc: 'SBIN0001234',
  bank_branch: 'Main Branch',
  standard_validity_days: 30,
  standard_payment_terms: '50% advance with PO, balance before dispatch.',
  standard_delivery_terms: '7 business days ex-works.',
  standard_warranty_terms: '12 months standard manufacturing warranty.',
  standard_declaration: 'We declare that the quote details are accurate.',
  signatory_title: 'Authorised Signatory',
  jurisdiction: 'Lucknow Jurisdiction Only',
};

describe('Khata Release #026 Backend Remediation Suite', () => {
  let authCookie: string;
  let csrfToken: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    env.COMPANY_JURISDICTION = undefined;

    vi.spyOn(appPool, 'query').mockImplementation(async (sql: unknown) => {
      const sqlText = typeof sql === 'string' ? sql : (sql as { text?: string })?.text || '';
      if (sqlText.includes('FROM quotation_settings')) {
        return { rows: [{ ...DEFAULT_COMPANY_SETTINGS_ROW }], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    });

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      phone: TEST_PHONE,
      password: TEST_PASSWORD,
    });
    authCookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
    const csrfRes = await request(app).get('/api/v1/auth/csrf-token').set('Cookie', authCookie);
    csrfToken = csrfRes.body.csrfToken;
  });

  describe('1. Quotation PDF Pagination, Long Content & Unlimited Terms (Section 17.A)', () => {
    function buildBaseQuotationPdfData(overrides: Partial<QuotationPdfData> = {}): QuotationPdfData {
      return {
        quotationNumber: 'QT-2026-0099',
        quotationDate: '2026-11-10',
        validUntil: '2026-12-10',
        company: {
          companyName: 'ALGIONS AI LABS PRIVATE LIMITED',
          address: 'Sector 5 Industrial Area, Uttar Pradesh - 226010',
          gstin: '09AAAAA0000A1Z0',
          phone: '9493840000',
          state: 'Uttar Pradesh',
          stateCode: '09',
          bankName: 'SBI Bank',
          bankAccountNumber: '112233445566',
          bankIfsc: 'SBIN0000111',
          bankBranch: 'Industrial Branch',
          signatoryTitle: 'Authorised Signatory',
          jurisdiction: 'Lucknow Jurisdiction Only',
        },
        customer: {
          name: 'Apex Infrastructure Engineering Pvt. Ltd.',
          address: 'Plot 42, Phase II, Okhla Industrial Estate',
          phone: '9876543210',
          gstin: '09AABCS1429B1ZS',
          state: 'Uttar Pradesh',
          stateCode: '09',
        },
        projectTitle: 'Modular Acoustic Auditorium Supply & Installation Phase-II',
        subject: 'Techno-commercial offer for acoustically rated interior panels',
        items: [
          {
            itemIndex: 1,
            description: 'HDF Board 12mm High Density',
            hsnCode: '44119219',
            quantity: '10.00',
            unit: 'pcs',
            rate: '500.00',
            rateUnit: 'pcs',
            amount: '5000.00',
          },
        ],
        totals: {
          subtotal: '5000.00',
          discountType: null,
          discountValue: '0.00',
          discountAmount: '0.00',
          taxableAmount: '5000.00',
          gstEnabled: true,
          gstRate: '18.00',
          cgstAmount: '450.00',
          sgstAmount: '450.00',
          igstAmount: '0.00',
          taxAmount: '900.00',
          grandTotal: '5900.00',
        },
        amountInWords: 'Rupees Five Thousand Nine Hundred Only',
        termsAndConditions: '1. Standard delivery in 7 working days.',
        notes: 'Prices valid for 30 days.',
        ...overrides,
      };
    }

    it('renders 1-item quotation cleanly on a single page with Page 1 of 1', async () => {
      const buffer = await generateQuotationPdf(buildBaseQuotationPdfData());
      const parsed = await parsePdfBuffer(buffer);
      expect(parsed.numPages).toBe(1);
      expect(parsed.pageTexts[0]).toContain('Page 1 of 1');
      expect(parsed.fullText).toContain('HDF Board 12mm High Density');
      expect(parsed.fullText).toContain('Lucknow Jurisdiction Only');
      expect(parsed.fullText).not.toContain('Gopalganj Jurisdiction only');
    });

    it('paginates 20, 30+, and 35 items cleanly without clipping or blank trailing pages', async () => {
      for (const count of [20, 35]) {
        const items = Array.from({ length: count }, (_, idx) => ({
          itemIndex: idx + 1,
          description: `Acoustic Wall Baffle Model-QT-${String(idx + 1).padStart(2, '0')} with Flame Retardant Fabric`,
          hsnCode: '44119219',
          quantity: '2.00',
          unit: 'pcs',
          rate: '100.00',
          rateUnit: 'pcs',
          amount: '200.00',
        }));

        const buffer = await generateQuotationPdf(
          buildBaseQuotationPdfData({
            items,
            totals: {
              subtotal: (count * 200).toFixed(2),
              discountAmount: '0.00',
              taxableAmount: (count * 200).toFixed(2),
              gstEnabled: true,
              gstRate: '18.00',
              cgstAmount: (count * 18).toFixed(2),
              sgstAmount: (count * 18).toFixed(2),
              igstAmount: '0.00',
              taxAmount: (count * 36).toFixed(2),
              grandTotal: (count * 236).toFixed(2),
            },
          })
        );
        const parsed = await parsePdfBuffer(buffer);

        expect(parsed.numPages).toBeGreaterThan(1);
        for (let i = 0; i < parsed.numPages; i++) {
          expect(parsed.pageTexts[i].length).toBeGreaterThan(40);
          expect(parsed.pageTexts[i]).toContain(`Page ${i + 1} of ${parsed.numPages}`);
        }
        expect(parsed.fullText).toContain('Model-QT-01');
        expect(parsed.fullText).toContain(`Model-QT-${String(count).padStart(2, '0')}`);
      }
    });

    it('splits a huge 1,600+ char item description across pages without truncation', async () => {
      const longStart = 'SPEC-BEGIN-ACOUSTIC-CORE-SERIES';
      const longMiddle = ' Multi-layer high density mineral wool core bonded with anodized aluminum framing and micro-perforated timber veneer.';
      const longEnd = 'SPEC_END_WARRANTY_TAG_VERIFIED';
      const hugeDescription = `${longStart}${longMiddle.repeat(14)} ${longEnd}`;
      expect(hugeDescription.length).toBeGreaterThan(1600);

      const buffer = await generateQuotationPdf(
        buildBaseQuotationPdfData({
          items: [
            {
              itemIndex: 1,
              description: hugeDescription,
              hsnCode: '44119219',
              quantity: '1.00',
              unit: 'lot',
              rate: '50000.00',
              rateUnit: 'lot',
              amount: '50000.00',
            },
          ],
        })
      );

      const parsed = await parsePdfBuffer(buffer);
      expect(parsed.fullText).toContain(longStart);
      expect(parsed.fullText).toContain(longEnd);
      for (const pageText of parsed.pageTexts) {
        expect(pageText.length).toBeGreaterThan(30);
      }
    });

    it('renders all 18 terms & conditions lines (no slice(0, 6) cap) across multi-page continuation', async () => {
      const termsLines = Array.from(
        { length: 18 },
        (_, idx) => `Clause-${String(idx + 1).padStart(2, '0')}: Mandatory site inspection & written sign-off required prior to milestone #${idx + 1}.`
      ).join('\n');

      const buffer = await generateQuotationPdf(
        buildBaseQuotationPdfData({
          termsAndConditions: termsLines,
          notes: 'Additional site safety notes: ' + 'Certified scaffolding only. '.repeat(25),
        })
      );

      const parsed = await parsePdfBuffer(buffer);
      expect(parsed.numPages).toBeGreaterThan(1);
      for (let i = 1; i <= 18; i++) {
        expect(parsed.fullText).toContain(`Clause-${String(i).padStart(2, '0')}`);
      }
      expect(parsed.fullText).toContain('Terms & Conditions');
      for (let i = 0; i < parsed.numPages; i++) {
        expect(parsed.pageTexts[i].length).toBeGreaterThan(30);
        expect(parsed.pageTexts[i]).toContain(`Page ${i + 1} of ${parsed.numPages}`);
      }
    });

    it('POST /api/v1/quotations/preview-pdf generates valid multi-page binary PDF response', async () => {
      const items = Array.from({ length: 24 }, (_, idx) => ({
        description: `Preview Panel Unit #${idx + 1}`,
        hsnCode: '4411',
        quantity: 2,
        unit: 'pcs',
        rate: 250,
        rateUnit: 'pcs',
      }));

      const res = await request(app)
        .post('/api/v1/quotations/preview-pdf')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({
          quotationNumber: 'QT-PREV-24',
          quotationDate: '2026-11-10',
          validUntil: '2026-11-30',
          customerName: 'Preview Customer',
          customerState: 'Uttar Pradesh',
          customerStateCode: '09',
          gstEnabled: true,
          gstRate: 18,
          items,
          termsAndConditions: Array.from({ length: 10 }, (_, i) => `Preview Term ${i + 1}: Non-cancellable order.`).join('\n'),
        })
        .buffer(true)
        .parse((resObj, cb) => {
          const data: Buffer[] = [];
          resObj.on('data', (chunk: Buffer) => data.push(chunk));
          resObj.on('end', () => cb(null, Buffer.concat(data)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      const parsed = await parsePdfBuffer(res.body as Buffer);
      expect(parsed.numPages).toBeGreaterThan(1);
      expect(parsed.fullText).toContain('Preview Panel Unit #24');
      expect(parsed.fullText).toContain('Preview Term 10');
    });
  });

  describe('2. Quotation Cross-Field Date Validation (Section 17.D)', () => {
    it('rejects validUntil < quotationDate with HTTP 400 on POST /api/v1/quotations & /preview-pdf', async () => {
      const badPayload = {
        quotationDate: '2026-11-15',
        validUntil: '2026-11-10',
        customerName: 'Chrono Check Client',
        gstEnabled: false,
        items: [{ description: 'Item A', quantity: 1, rate: 100 }],
      };

      const createRes = await request(app)
        .post('/api/v1/quotations')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send(badPayload);

      expect(createRes.status).toBe(400);
      expect(createRes.body.code).toBe('VALIDATION_ERROR');
      expect(createRes.body.message).toMatch(/valid until/i);

      const previewRes = await request(app)
        .post('/api/v1/quotations/preview-pdf')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send(badPayload);

      expect(previewRes.status).toBe(400);
      expect(previewRes.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('3. Multi-Page GST Invoice & Normal Bill PDFs + Jurisdiction Config (Section 17.B & 12)', () => {
    function buildInvoicePdfData(overrides: Partial<GstInvoicePdfData> = {}): GstInvoicePdfData {
      return {
        invoiceNumber: 'INV-026-01',
        invoiceDate: '2026-11-11',
        state: 'Uttar Pradesh',
        stateCode: '09',
        placeOfSupply: 'Uttar Pradesh',
        company: {
          companyName: 'ALGIONS AI LABS PRIVATE LIMITED',
          address: 'Sector 5 Industrial Park, Uttar Pradesh',
          gstin: '09AAAAA0000A1Z0',
          phone: '9493840000',
          state: 'Uttar Pradesh',
          stateCode: '09',
          jurisdiction: null,
        },
        customer: {
          name: 'Metro Buildcon Pvt Ltd',
          address: '19 MG Road, Lucknow',
          gstin: '09AABCS1429B1ZS',
          phone: '9811111111',
          state: 'Uttar Pradesh',
          stateCode: '09',
        },
        items: [
          {
            name: 'Standard Item 01',
            hsn: '4411',
            quantity: '2.00',
            unit: 'pcs',
            rate: '500.00',
            rateUnit: 'pcs',
            amount: '1000.00',
          },
        ],
        totals: {
          subtotal: '1000.00',
          discountType: null,
          discountValue: '0.00',
          discountAmount: '0.00',
          taxableAmount: '1000.00',
          cgstRate: '9.00',
          cgstAmount: '90.00',
          sgstRate: '9.00',
          sgstAmount: '90.00',
          igstRate: '0.00',
          igstAmount: '0.00',
          taxAmount: '180.00',
          grandTotal: '1180.00',
        },
        amountInWords: 'Rupees One Thousand One Hundred Eighty Only',
        isNormalBill: false,
        ...overrides,
      };
    }

    it('renders 1, 15, 25, and 32 items across pages without single-page overflow error or blank pages', async () => {
      for (const count of [1, 15, 25, 32]) {
        const items = Array.from({ length: count }, (_, idx) => ({
          name: `Structural Grid Component ${String(idx + 1).padStart(2, '0')} Extruded Aluminum Section`,
          hsn: '7610',
          quantity: '3.00',
          unit: 'pcs',
          rate: '100.00',
          rateUnit: 'pcs',
          amount: '300.00',
        }));

        const subtotal = (count * 300).toFixed(2);
        const gst = (count * 54).toFixed(2);
        const cgst = (count * 27).toFixed(2);
        const grandTotal = (count * 354).toFixed(2);

        const buffer = await generateTaxInvoicePdf(
          buildInvoicePdfData({
            items,
            totals: {
              subtotal,
              discountAmount: '0.00',
              taxableAmount: subtotal,
              cgstRate: '9.00',
              cgstAmount: cgst,
              sgstRate: '9.00',
              sgstAmount: cgst,
              igstRate: '0.00',
              igstAmount: '0.00',
              taxAmount: gst,
              grandTotal,
            },
          })
        );

        const parsed = await parsePdfBuffer(buffer);
        if (count >= 25) {
          expect(parsed.numPages).toBeGreaterThan(1);
        }
        for (let i = 0; i < parsed.numPages; i++) {
          expect(parsed.pageTexts[i].length).toBeGreaterThan(40);
          expect(parsed.pageTexts[i]).toContain(`Page ${i + 1} of ${parsed.numPages}`);
        }
        expect(parsed.fullText).toContain('Structural Grid Component 01');
        expect(parsed.fullText).toContain(`Structural Grid Component ${String(count).padStart(2, '0')}`);
        expect(parsed.fullText).not.toContain('Gopalganj Jurisdiction only');
        expect(parsed.fullText).toContain('Subject to seller jurisdiction.');
      }
    });

    it('handles single GST item with 1,600+ char description without throw & preserves start/end text', async () => {
      const startMarker = 'GST-LONG-START';
      const endMarker = 'GST-LONG-END';
      const bigName = `${startMarker} ` + 'Precision CNC anodized rail specification '.repeat(39) + endMarker;
      expect(bigName.length).toBeGreaterThan(1600);

      const buffer = await generateTaxInvoicePdf(
        buildInvoicePdfData({
          items: [
            {
              name: bigName,
              hsn: '7610',
              quantity: '1.00',
              unit: 'lot',
              rate: '1000.00',
              rateUnit: 'lot',
              amount: '1000.00',
            },
          ],
        })
      );

      const parsed = await parsePdfBuffer(buffer);
      expect(parsed.fullText).toContain(startMarker);
      expect(parsed.fullText).toContain(endMarker);
    });

    it('renders discounted Normal Bill multi-page PDF and configurable jurisdiction override vs fallback', async () => {
      const normalItems = Array.from({ length: 26 }, (_, idx) => ({
        name: `Normal Hardware Item ${String(idx + 1).padStart(2, '0')}`,
        hsn: '7318',
        quantity: '1.00',
        unit: 'box',
        rate: '100.00',
        rateUnit: 'box',
        amount: '100.00',
      }));

      const bufferWithCustomJurisdiction = await generateTaxInvoicePdf(
        buildInvoicePdfData({
          invoiceNumber: 'NB-2026-077',
          isNormalBill: true,
          billTitle: 'CASH / CREDIT BILL',
          company: {
            companyName: 'ALGIONS AI LABS PRIVATE LIMITED',
            address: 'Patna Road, Bihar',
            gstin: null,
            phone: '9493840000',
            state: 'Bihar',
            stateCode: '10',
            jurisdiction: 'Patna High Court Jurisdiction Only',
          },
          items: normalItems,
          totals: {
            subtotal: '2600.00',
            discountType: 'fixed',
            discountValue: '531.00',
            discountAmount: '531.00',
            taxableAmount: '2069.00',
            taxAmount: '0.00',
            grandTotal: '2069.00',
          },
        })
      );

      const parsed = await parsePdfBuffer(bufferWithCustomJurisdiction);
      expect(parsed.numPages).toBeGreaterThan(1);
      expect(parsed.fullText).toContain('Patna High Court Jurisdiction Only');
      expect(parsed.fullText).not.toContain('Gopalganj Jurisdiction only');
      expect(parsed.fullText).toContain('531.00');
      expect(parsed.fullText).toContain('2,069.00');
      expect(parsed.fullText).toContain('Normal Hardware Item 26');

      env.COMPANY_JURISDICTION = 'Delhi Court Jurisdiction';
      vi.spyOn(appPool, 'query').mockResolvedValueOnce({
        rows: [{ ...DEFAULT_COMPANY_SETTINGS_ROW, jurisdiction: null }],
        rowCount: 1,
      } as never);
      const profileWithEnv = await getCompanyTaxProfile();
      expect(profileWithEnv.jurisdiction).toBe('Delhi Court Jurisdiction');
    });
  });

  describe('4. Post-Commit R2 Failure Integrity & Retry Recovery Endpoints (Section 17.E)', () => {
    it('keeps r2_object_key NULL on post-commit upload failure and heals via POST /gst-invoices/:id/retry-pdf', async () => {
      let persistedInvoiceRow: Record<string, unknown> = {
        id: 701,
        invoice_number: 'INV-R2-701',
        invoice_date: '2026-11-11',
        state: 'Uttar Pradesh',
        state_code: '09',
        transportation_mode: null,
        vehicle_number: null,
        date_of_supply: null,
        place_of_supply: 'Uttar Pradesh',
        customer_id: null,
        customer_name: 'R2 Resilience Trader',
        customer_address: 'Main Market',
        customer_gstin: '09AABCS1429B1ZS',
        customer_phone: null,
        customer_state: 'Uttar Pradesh',
        customer_state_code: '09',
        subtotal_amount: '1000.00',
        discount_type: null,
        discount_value: '0.00',
        discount_amount: '0.00',
        taxable_amount: '1000.00',
        cgst_rate: '9.00',
        cgst_amount: '90.00',
        sgst_rate: '9.00',
        sgst_amount: '90.00',
        igst_rate: '0.00',
        igst_amount: '0.00',
        tax_amount: '180.00',
        grand_total: '1180.00',
        amount_in_words: 'Rupees One Thousand One Hundred Eighty Only',
        pdf_status: 'local_only',
        r2_object_key: null,
        notes: null,
        items: [
          {
            id: 1,
            invoice_id: 701,
            item_index: 1,
            product_id: null,
            description: 'Steel Frame',
            hsn_code: '7308',
            quantity: '1.00',
            unit: 'pcs',
            rate: '1000.00',
            rate_unit: 'pcs',
            amount: '1000.00',
          },
        ],
      };

      const updateCalls: Array<{ sql: string; params: unknown[] }> = [];

      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: unknown, params?: unknown[]) => {
          const text = typeof sql === 'string' ? sql : (sql as { text?: string })?.text || '';
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
          if (text.includes('FROM quotation_settings')) {
            return { rows: [{ ...DEFAULT_COMPANY_SETTINGS_ROW }], rowCount: 1 };
          }
          if (text.includes('SELECT 1 FROM gst_invoices WHERE invoice_number')) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes('INSERT INTO gst_invoices')) {
            return { rows: [{ ...persistedInvoiceRow }], rowCount: 1 };
          }
          if (text.includes('INSERT INTO gst_invoice_items')) {
            return { rows: [((persistedInvoiceRow.items as unknown[]) || [])[0]], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };
      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as never);

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: unknown, params?: unknown[]) => {
        const text = typeof sql === 'string' ? sql : (sql as { text?: string })?.text || '';
        if (text.includes('FROM quotation_settings')) {
          return { rows: [{ ...DEFAULT_COMPANY_SETTINGS_ROW }], rowCount: 1 } as never;
        }
        if (text.includes('UPDATE gst_invoices SET pdf_status')) {
          updateCalls.push({ sql: text, params: params || [] });
          persistedInvoiceRow = {
            ...persistedInvoiceRow,
            pdf_status: params?.[0],
            r2_object_key: params?.[1] ?? null,
          };
          return { rows: [{ ...persistedInvoiceRow }], rowCount: 1 } as never;
        }
        if (text.includes('FROM gst_invoices WHERE id = $1')) {
          return { rows: [{ ...persistedInvoiceRow }], rowCount: 1 } as never;
        }
        if (text.includes('FROM gst_invoice_items WHERE invoice_id = $1')) {
          return { rows: persistedInvoiceRow.items as unknown[], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      });

      vi.spyOn(StorageService.prototype, 'isConfigured').mockReturnValue(true);
      vi.spyOn(StorageService.prototype, 'assertConfigured').mockImplementation(() => undefined);
      const uploadSpy = vi
        .spyOn(StorageService.prototype, 'uploadBufferToR2')
        .mockRejectedValueOnce(new Error('Simulated R2 network timeout'));

      const createRes = await request(app)
        .post('/api/v1/gst-invoices')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({
          invoiceNumber: 'INV-R2-701',
          invoiceDate: '2026-11-11',
          state: 'Uttar Pradesh',
          stateCode: '09',
          customerName: 'R2 Resilience Trader',
          customerState: 'Uttar Pradesh',
          customerStateCode: '09',
          gstRate: 18,
          items: [{ description: 'Steel Frame', hsnCode: '7308', quantity: 1, rate: 1000 }],
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.data.pdf_status).toBe('failed');
      expect(createRes.body.data.r2_object_key).toBeNull();
      expect(persistedInvoiceRow.r2_object_key).toBeNull();
      expect(updateCalls.some((c) => c.params[0] === 'failed' && c.params[1] === null)).toBe(true);

      uploadSpy.mockResolvedValueOnce({
        objectKey: 'gst-invoices/2026/11/701.pdf',
        contentLength: 4096,
      } as never);

      const retryRes = await request(app)
        .post('/api/v1/gst-invoices/701/retry-pdf')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken);

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.success).toBe(true);
      expect(retryRes.body.data.pdf_status).toBe('uploaded');
      expect(retryRes.body.data.r2_object_key).toBe('gst-invoices/2026/11/701.pdf');
    });

    it('keeps r2_object_key NULL on post-commit upload failure and heals via POST /normal-bills/:id/retry-pdf', async () => {
      let persistedBillRow: Record<string, unknown> = {
        id: 801,
        bill_number: 'NB-R2-801',
        bill_date: '2026-11-11',
        state: 'Uttar Pradesh',
        state_code: '09',
        transportation_mode: null,
        vehicle_number: null,
        date_of_supply: null,
        place_of_supply: 'Uttar Pradesh',
        customer_id: null,
        customer_name: 'Normal Retry Buyer',
        customer_address: null,
        customer_phone: null,
        customer_state: 'Uttar Pradesh',
        customer_state_code: '09',
        subtotal_amount: '500.00',
        discount_type: null,
        discount_value: '0.00',
        discount_amount: '0.00',
        total_amount: '500.00',
        amount_in_words: 'Rupees Five Hundred Only',
        pdf_status: 'local_only',
        r2_object_key: null,
        notes: null,
        items: [
          {
            id: 1,
            bill_id: 801,
            item_index: 1,
            product_id: null,
            description: 'Adhesive Drum',
            hsn_code: null,
            quantity: '1.00',
            unit: 'drum',
            rate: '500.00',
            rate_unit: 'drum',
            amount: '500.00',
          },
        ],
      };

      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: unknown) => {
          const text = typeof sql === 'string' ? sql : (sql as { text?: string })?.text || '';
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
          if (text.includes('FROM quotation_settings')) {
            return { rows: [{ ...DEFAULT_COMPANY_SETTINGS_ROW }], rowCount: 1 };
          }
          if (text.includes('SELECT 1 FROM normal_bills WHERE bill_number')) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes('INSERT INTO normal_bills')) {
            return { rows: [{ ...persistedBillRow }], rowCount: 1 };
          }
          if (text.includes('INSERT INTO normal_bill_items')) {
            return { rows: [((persistedBillRow.items as unknown[]) || [])[0]], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };
      vi.spyOn(appPool, 'connect').mockResolvedValue(mockClient as never);

      vi.spyOn(appPool, 'query').mockImplementation(async (sql: unknown, params?: unknown[]) => {
        const text = typeof sql === 'string' ? sql : (sql as { text?: string })?.text || '';
        if (text.includes('FROM quotation_settings')) {
          return { rows: [{ ...DEFAULT_COMPANY_SETTINGS_ROW }], rowCount: 1 } as never;
        }
        if (text.includes('UPDATE normal_bills SET pdf_status')) {
          persistedBillRow = {
            ...persistedBillRow,
            pdf_status: params?.[0],
            r2_object_key: params?.[1] ?? null,
          };
          return { rows: [{ ...persistedBillRow }], rowCount: 1 } as never;
        }
        if (text.includes('FROM normal_bills') && text.includes('WHERE b.id = $1')) {
          return { rows: [{ ...persistedBillRow }], rowCount: 1 } as never;
        }
        if (text.includes('FROM normal_bill_items WHERE bill_id = $1')) {
          return { rows: persistedBillRow.items as unknown[], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      });

      vi.spyOn(StorageService.prototype, 'isConfigured').mockReturnValue(true);
      vi.spyOn(StorageService.prototype, 'assertConfigured').mockImplementation(() => undefined);
      const uploadSpy = vi
        .spyOn(StorageService.prototype, 'uploadBufferToR2')
        .mockRejectedValueOnce(new Error('Temporary 503 from R2'));

      const createRes = await request(app)
        .post('/api/v1/normal-bills')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken)
        .send({
          billNumber: 'NB-R2-801',
          billDate: '2026-11-11',
          customerName: 'Normal Retry Buyer',
          items: [{ description: 'Adhesive Drum', quantity: 1, rate: 500 }],
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.bill.pdf_status).toBe('failed');
      expect(createRes.body.bill.r2_object_key).toBeNull();
      expect(persistedBillRow.r2_object_key).toBeNull();

      uploadSpy.mockResolvedValueOnce({
        objectKey: 'normal-bills/2026/11/801.pdf',
        contentLength: 3000,
      } as never);

      const retryRes = await request(app)
        .post('/api/v1/normal-bills/801/retry-pdf')
        .set('Cookie', authCookie)
        .set('X-CSRF-Token', csrfToken);

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.success).toBe(true);
      expect(retryRes.body.bill.pdf_status).toBe('uploaded');
      expect(retryRes.body.bill.r2_object_key).toBe('normal-bills/2026/11/801.pdf');
    });
  });

  describe('5. R2 StorageService Hardening (Section 17.G)', () => {
    let storage: StorageService;
    let mockS3: { send: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      env.R2_ACCOUNT_ID = 'acct-026';
      env.R2_ACCESS_KEY_ID = 'key-026';
      env.R2_SECRET_ACCESS_KEY = 'secret-026';
      env.R2_BUCKET_NAME = 'khata-026-bucket';
      storage = new StorageService();
      mockS3 = { send: vi.fn().mockResolvedValue({}) };
      storage.setClient(mockS3 as unknown as S3Client);
    });

    it('enforces folder-specific byte limits (5 MB products vs 10 MB supplier-bills / offline-bills)', async () => {
      const productIntentOk = await storage.getUploadIntent({
        folder: 'products',
        referenceId: 5,
        contentType: 'image/webp',
        sizeBytes: MAX_PRODUCT_IMAGE_BYTES,
      });
      expect(productIntentOk.objectKey).toMatch(/^products\/5\/.+\.webp$/);
      expect(productIntentOk.headers['Content-Type']).toBe('image/webp');
      expect(productIntentOk.uploadUrl).toContain('ct=image%2Fwebp');

      await expect(
        storage.getUploadIntent({
          folder: 'products',
          referenceId: 5,
          contentType: 'image/webp',
          sizeBytes: MAX_PRODUCT_IMAGE_BYTES + 1,
        })
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 400 });

      const supplierPdfOk = await storage.getUploadIntent({
        folder: 'supplier-bills',
        referenceId: 9,
        contentType: 'application/pdf',
        sizeBytes: MAX_SUPPLIER_DOC_BYTES - 1024,
      });
      expect(supplierPdfOk.objectKey).toMatch(/^supplier-bills\/9\/.+\.pdf$/);
      expect(supplierPdfOk.headers['Content-Type']).toBe('application/pdf');

      await expect(
        storage.getUploadIntent({
          folder: 'supplier-bills',
          referenceId: 9,
          contentType: 'application/pdf',
          sizeBytes: MAX_SUPPLIER_DOC_BYTES + 1,
        })
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 400 });

      await expect(
        storage.getUploadIntent({
          folder: 'offline-bills',
          referenceId: 'inv-1',
          contentType: 'image/jpeg',
          sizeBytes: MAX_OFFLINE_BILL_BYTES + 1,
        })
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 400 });
    });

    it('rejects traversal / cross-folder object keys BEFORE issuing HeadObject or DeleteObject', async () => {
      const badKeys = [
        'products/1/../2/evil.jpg',
        'offline-bills/1/photo.jpg',
        'products/2/other-product.jpg',
        'products/1/nested/extra.jpg',
        'products\\1\\win.jpg',
      ];

      for (const badKey of badKeys) {
        await expect(storage.verifyObject(badKey, 'products', 1)).rejects.toMatchObject({
          code: 'INVALID_OBJECT_KEY',
          status: 400,
        });
      }
      expect(mockS3.send).not.toHaveBeenCalled();

      await expect(
        storage.getUploadIntent({
          folder: 'products',
          referenceId: '../99',
          contentType: 'image/jpeg',
          sizeBytes: 1024,
        })
      ).rejects.toMatchObject({ code: 'INVALID_REFERENCE_ID', status: 400 });
    });

    it('deletes R2 object on every verifyObject failure (zero-byte, oversized, wrong MIME, missing Body, bad signature)', async () => {
      const failureCases: Array<{
        name: string;
        folder: 'products' | 'supplier-bills';
        key: string;
        head: { ContentLength?: number; ContentType?: string };
        getBody?: unknown;
        expectedCode: string;
      }> = [
        {
          name: 'zero-byte object',
          folder: 'products',
          key: 'products/10/empty.jpg',
          head: { ContentLength: 0, ContentType: 'image/jpeg' },
          expectedCode: 'INVALID_OBJECT_SIZE',
        },
        {
          name: 'oversized product object',
          folder: 'products',
          key: 'products/10/huge.jpg',
          head: { ContentLength: MAX_PRODUCT_IMAGE_BYTES + 50, ContentType: 'image/jpeg' },
          expectedCode: 'INVALID_OBJECT_SIZE',
        },
        {
          name: 'disallowed content-type',
          folder: 'products',
          key: 'products/10/script.svg',
          head: { ContentLength: 512, ContentType: 'image/svg+xml' },
          expectedCode: 'INVALID_CONTENT_TYPE',
        },
        {
          name: 'missing GetObject Body',
          folder: 'products',
          key: 'products/10/nobody.jpg',
          head: { ContentLength: 512, ContentType: 'image/jpeg' },
          getBody: undefined,
          expectedCode: 'STORAGE_VERIFICATION_FAILED',
        },
        {
          name: 'invalid PDF magic bytes in supplier-bills',
          folder: 'supplier-bills',
          key: 'supplier-bills/10/fake.pdf',
          head: { ContentLength: 512, ContentType: 'application/pdf' },
          getBody: { transformToByteArray: async () => new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]) },
          expectedCode: 'INVALID_IMAGE_SIGNATURE',
        },
      ];

      for (const tc of failureCases) {
        const deletedKeys: string[] = [];
        mockS3.send.mockImplementation(async (cmd: unknown) => {
          if (cmd instanceof HeadObjectCommand) return tc.head;
          if (cmd instanceof GetObjectCommand) return { Body: tc.getBody };
          if (cmd instanceof DeleteObjectCommand) {
            deletedKeys.push(cmd.input.Key || '');
            return {};
          }
          return {};
        });

        await expect(storage.verifyObject(tc.key, tc.folder, 10)).rejects.toMatchObject({
          code: tc.expectedCode,
        });
        expect(deletedKeys, `Expected R2 delete cleanup for case: ${tc.name}`).toEqual([tc.key]);
      }
    });

    it('binds ContentType in PutObjectCommand when creating presigned intent', async () => {
      await storage.getUploadIntent({
        folder: 'supplier-bills',
        referenceId: 'bill_42',
        contentType: 'application/pdf',
        sizeBytes: 256000,
      });
      // Presigned URL generator spy receives PutObjectCommand instance; assert uploadBufferToR2 also enforces ContentType
      const sentCommands: unknown[] = [];
      mockS3.send.mockImplementation(async (cmd: unknown) => {
        sentCommands.push(cmd);
        return {};
      });
      await storage.uploadBufferToR2({
        buffer: Buffer.from('%PDF-1.4\n'),
        objectKey: 'supplier-bills/bill_42/doc.pdf',
        contentType: 'application/pdf',
      });
      const putCmd = sentCommands.find((c) => c instanceof PutObjectCommand) as PutObjectCommand | undefined;
      expect(putCmd?.input.ContentType).toBe('application/pdf');
    });
  });
});
