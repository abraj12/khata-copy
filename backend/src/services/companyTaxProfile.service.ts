import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { appPool } from '../config/database.js';
import { AppError } from '../utils/errors.js';
import { resolveValidatedState, validateGstinForState } from '../utils/indianTax.js';

export type DbQueryable = Pick<Pool | PoolClient, 'query'>;

export interface CompanyTaxProfile {
  companyName: string;
  logoUrl: string | null;
  cin: string | null;
  gstin: string | null;
  address: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  state: string;
  stateCode: string;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankBranch: string | null;
  standardValidityDays: number;
  standardPaymentTerms: string | null;
  standardDeliveryTerms: string | null;
  standardWarrantyTerms: string | null;
  standardDeclaration: string | null;
  signatoryTitle: string;
}

interface QuotationSettingsRow extends QueryResultRow {
  id: number;
  company_name: string;
  logo_url: string | null;
  cin: string | null;
  gstin: string | null;
  address: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  state: string | null;
  state_code: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_branch: string | null;
  standard_validity_days: number;
  standard_payment_terms: string | null;
  standard_delivery_terms: string | null;
  standard_warranty_terms: string | null;
  standard_declaration: string | null;
  signatory_title: string;
}

/**
 * Loads the single authoritative company tax profile from quotation_settings (id = 1).
 * Never invents or defaults seller state when configuration is missing or invalid.
 */
export async function getCompanyTaxProfile(db: DbQueryable = appPool): Promise<CompanyTaxProfile> {
  const result: QueryResult<QuotationSettingsRow> = await db.query(
    `SELECT * FROM quotation_settings WHERE id = 1`
  );

  const row = result.rows[0];
  if (!row) {
    throw new AppError(
      'Company tax profile is not configured in quotation_settings.',
      500,
      'COMPANY_TAX_PROFILE_MISSING'
    );
  }

  const resolved = resolveValidatedState({
    state: row.state,
    stateCode: row.state_code,
    required: true,
    fieldLabel: 'Company',
  });

  if (!resolved.state || !resolved.stateCode) {
    throw new AppError(
      'Company tax profile state configuration is invalid.',
      500,
      'COMPANY_TAX_PROFILE_INVALID'
    );
  }

  let validatedGstin = row.gstin ? row.gstin.trim().toUpperCase() : null;
  if (validatedGstin) {
    validatedGstin = validateGstinForState(validatedGstin, resolved.stateCode);
  }

  return {
    companyName: row.company_name,
    logoUrl: row.logo_url ?? null,
    cin: row.cin ?? null,
    gstin: validatedGstin,
    address: row.address,
    email: row.email ?? null,
    phone: row.phone ?? null,
    website: row.website ?? null,
    state: resolved.state,
    stateCode: resolved.stateCode,
    bankName: row.bank_name ?? null,
    bankAccountNumber: row.bank_account_number ?? null,
    bankIfsc: row.bank_ifsc ?? null,
    bankBranch: row.bank_branch ?? null,
    standardValidityDays: Number(row.standard_validity_days || 30),
    standardPaymentTerms: row.standard_payment_terms ?? null,
    standardDeliveryTerms: row.standard_delivery_terms ?? null,
    standardWarrantyTerms: row.standard_warranty_terms ?? null,
    standardDeclaration: row.standard_declaration ?? null,
    signatoryTitle: row.signatory_title,
  };
}
