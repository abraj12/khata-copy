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

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

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
 * Computes the official 15th check digit of an Indian GSTIN using Luhn mod-36.
 */
export function computeGstinCheckDigit(first14: string): string {
  const normalized = first14.trim().toUpperCase();
  if (normalized.length !== 14) {
    throw new AppError(
      'Invalid GSTIN format. Must be 15 alphanumeric characters matching Indian GSTIN specification.',
      400,
      'INVALID_GSTIN'
    );
  }

  let factor = 1;
  let sum = 0;

  for (const ch of normalized) {
    const codePoint = GSTIN_CHARSET.indexOf(ch);
    if (codePoint < 0) {
      throw new AppError(
        'Invalid GSTIN format. Must be 15 alphanumeric characters matching Indian GSTIN specification.',
        400,
        'INVALID_GSTIN'
      );
    }
    const product = codePoint * factor;
    factor = factor === 1 ? 2 : 1;
    sum += Math.floor(product / 36) + (product % 36);
  }

  const checkCodePoint = (36 - (sum % 36)) % 36;
  return GSTIN_CHARSET[checkCodePoint];
}

/**
 * Validates a GSTIN structure, state code prefix membership, and Luhn mod-36 check digit.
 * Returns normalized uppercase GSTIN, or null when empty.
 */
export function validateGstin(gstin: string | null | undefined): string | null {
  if (!gstin || !gstin.trim()) return null;

  const normalized = gstin.trim().toUpperCase();

  if (!GSTIN_REGEX.test(normalized)) {
    throw new AppError(
      'Invalid GSTIN format. Must be 15 alphanumeric characters matching Indian GSTIN specification.',
      400,
      'INVALID_GSTIN'
    );
  }

  const prefixCode = normalized.slice(0, 2);
  if (!GST_STATE_CODES[prefixCode]) {
    throw new AppError(
      `Invalid GSTIN state code prefix "${prefixCode}". Must begin with a recognized Indian GST State/UT code.`,
      400,
      'INVALID_GSTIN'
    );
  }

  const expectedCheckDigit = computeGstinCheckDigit(normalized.slice(0, 14));
  if (normalized[14] !== expectedCheckDigit) {
    throw new AppError(
      'Invalid GSTIN checksum digit. Please verify the 15-character GSTIN.',
      400,
      'INVALID_GSTIN'
    );
  }

  return normalized;
}

/**
 * Validates a GSTIN against the official 15-character format, Luhn mod-36 checksum,
 * and checks that the first 2 characters match the buyer's state code.
 */
export function validateGstinForState(
  gstin: string | null | undefined,
  stateCode: string
): string | null {
  const normalized = validateGstin(gstin);
  if (!normalized) return null;

  const expectedCode = normalizeGstStateCode(stateCode);

  if (normalized.slice(0, 2) !== expectedCode) {
    throw new AppError(
      `GSTIN state code prefix (${normalized.slice(0, 2)}) does not match the customer state code (${expectedCode}).`,
      400,
      'GSTIN_STATE_MISMATCH'
    );
  }

  return normalized;
}

/**
 * Retrieves the state name for a given 2-digit state code.
 */
export function getStateNameByCode(code: string | number | null | undefined): string | undefined {
  if (code === null || code === undefined || String(code).trim() === '') return undefined;
  const normalized = String(code).trim().padStart(2, '0');
  return GST_STATE_CODES[normalized];
}

function normalizeStateNameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STATE_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(GST_STATE_CODES).map(([code, stateName]) => [normalizeStateNameKey(stateName), code])
);

/**
 * Resolves a 2-digit state code from a canonical Indian state/UT name.
 */
export function getStateCodeByName(name: string | null | undefined): string | undefined {
  if (!name || !name.trim()) return undefined;
  return STATE_NAME_TO_CODE[normalizeStateNameKey(name)];
}

export interface StateValidationInput {
  state?: string | null;
  stateCode?: string | number | null;
  required?: boolean;
  fieldLabel?: string;
}

export interface ResolvedStateResult {
  state: string | null;
  stateCode: string | null;
}

/**
 * Normalizes and cross-validates state name and 2-digit Indian GST state code.
 * Never defaults to Bihar or any other fallback when values are omitted or mismatched.
 */
export function resolveValidatedState(input: StateValidationInput): ResolvedStateResult {
  const rawState = typeof input.state === 'string' ? input.state.trim() : '';
  const rawCode =
    input.stateCode === null || input.stateCode === undefined
      ? ''
      : String(input.stateCode).trim();
  const fieldLabel = input.fieldLabel || 'Customer';

  if (!rawState && !rawCode) {
    if (input.required) {
      throw new AppError(
        `${fieldLabel} state code is required for GST calculation.`,
        400,
        'STATE_CODE_REQUIRED'
      );
    }
    return { state: null, stateCode: null };
  }

  if (rawCode) {
    const normalizedCode = normalizeGstStateCode(rawCode);
    const canonicalName = GST_STATE_CODES[normalizedCode];

    if (rawState) {
      const matchedCodeForName = getStateCodeByName(rawState);
      if (!matchedCodeForName || matchedCodeForName !== normalizedCode) {
        throw new AppError(
          `State name "${rawState}" does not match state code "${normalizedCode}" (${canonicalName}).`,
          400,
          'STATE_CODE_NAME_MISMATCH'
        );
      }
    }

    return {
      state: canonicalName,
      stateCode: normalizedCode,
    };
  }

  const resolvedCode = getStateCodeByName(rawState);
  if (!resolvedCode) {
    throw new AppError(
      `Invalid Indian GST state name "${rawState}". Please select a recognized state or supply its 2-digit state code.`,
      400,
      'INVALID_STATE_CODE'
    );
  }

  return {
    state: GST_STATE_CODES[resolvedCode],
    stateCode: resolvedCode,
  };
}
