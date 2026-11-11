export interface IndianState {
  code: string;
  name: string;
}

export const INDIAN_STATES: IndianState[] = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
];

export function getStateByCode(code?: string | null): IndianState | undefined {
  if (!code) return undefined;
  const trimmed = String(code).trim();
  const padded = /^\d$/.test(trimmed) ? `0${trimmed}` : trimmed;
  return INDIAN_STATES.find((s) => s.code === padded);
}

export function getStateByName(name?: string | null): IndianState | undefined {
  if (!name) return undefined;
  const normalized = String(name).trim().toLowerCase();
  return INDIAN_STATES.find((s) => s.name.toLowerCase() === normalized);
}

/**
 * Resolves customer state and 2-digit GST state code strictly from the selected customer record.
 * Clears state to empty strings ('') when a customer has no stored state (never falls back to another state).
 */
export function resolveCustomerStateSelection(
  customer?: { state?: string | null; state_code?: string | null; stateCode?: string | null } | null
): { state: string; stateCode: string } {
  if (!customer) {
    return { state: '', stateCode: '' };
  }

  const rawCode = customer.state_code ?? customer.stateCode ?? null;
  const rawName = customer.state ?? null;

  const matchedByCode = getStateByCode(rawCode);
  if (matchedByCode) {
    return {
      state: rawName && rawName.trim() ? rawName.trim() : matchedByCode.name,
      stateCode: matchedByCode.code,
    };
  }

  const matchedByName = getStateByName(rawName);
  if (matchedByName) {
    return {
      state: matchedByName.name,
      stateCode: matchedByName.code,
    };
  }

  return {
    state: rawName ? rawName.trim() : '',
    stateCode: rawCode ? String(rawCode).trim() : '',
  };
}

export function extractStateCodeFromGstin(gstin?: string | null): string | null {
  if (!gstin) return null;
  const normalized = String(gstin).trim().toUpperCase();
  if (normalized.length < 2) return null;
  const prefix = normalized.slice(0, 2);
  return getStateByCode(prefix) ? prefix : null;
}
