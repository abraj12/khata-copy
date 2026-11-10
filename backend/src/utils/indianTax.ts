import { AppError } from './errors.js';

/**
 * Authoritative Indian GST State and Union Territory Codes (CBIC Canonical Mapping)
 */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/**
 * Normalizes and validates Indian GST State/UT Code.
 * Ensures 2-digit padding and official mapping membership.
 */
export function normalizeGstStateCode(
  value: string | number | null | undefined
): string {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new AppError(
      'Customer state code is required for GST calculation.',
      400,
      'STATE_CODE_REQUIRED'
    );
  }

  const normalized = String(value).trim().padStart(2, '0');

  if (!GST_STATE_CODES[normalized]) {
    throw new AppError(
      `Invalid Indian GST state code "${normalized}". Must be a recognized 2-digit Indian State/UT code.`,
      400,
      'INVALID_STATE_CODE'
    );
  }

  return normalized;
}

/**
 * Validates a GSTIN against the official 15-character format and checks that
 * the first 2 characters match the buyer's state code.
 */
export function validateGstinForState(
  gstin: string | null | undefined,
  stateCode: string
): void {
  if (!gstin || !gstin.trim()) return;

  const normalized = gstin.trim().toUpperCase();

  const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

  if (!gstinRegex.test(normalized)) {
    throw new AppError(
      'Invalid GSTIN format. Must be 15 alphanumeric characters matching Indian GSTIN specification.',
      400,
      'INVALID_GSTIN'
    );
  }

  const expectedCode = normalizeGstStateCode(stateCode);

  if (normalized.slice(0, 2) !== expectedCode) {
    throw new AppError(
      `GSTIN state code prefix (${normalized.slice(0, 2)}) does not match the customer state code (${expectedCode}).`,
      400,
      'GSTIN_STATE_MISMATCH'
    );
  }
}

/**
 * Retrieves the state name for a given 2-digit state code.
 */
export function getStateNameByCode(code: string | number | null | undefined): string | undefined {
  if (!code) return undefined;
  const normalized = String(code).trim().padStart(2, '0');
  return GST_STATE_CODES[normalized];
}
