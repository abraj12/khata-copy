import argon2 from 'argon2';
import crypto from 'crypto';
import { env } from '../../config/env.js';

// Pre-computed dummy Argon2id hash for constant-time dummy verification on unknown phones
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$2q1kM/B+pS5wYd7V$zYV5W8k7Q8s9T0u1V2w3X4y5Z6a7B8c9D0e1F2g3H4i';

export class AuthService {
  /**
   * Normalizes an Indian phone input to the canonical 10-digit format.
   * Accepts: "9876543210", "+91 9876543210", "+91-9876543210", "919876543210"
   */
  public normalizePhone(rawPhone: string): string | null {
    if (!rawPhone || typeof rawPhone !== 'string') return null;

    // Strip spaces, dashes, parentheses
    let cleaned = rawPhone.replace(/[\s\-()]/g, '');

    // Strip leading +91
    if (cleaned.startsWith('+91')) {
      cleaned = cleaned.slice(3);
    } else if (cleaned.startsWith('91') && cleaned.length === 12) {
      cleaned = cleaned.slice(2);
    } else if (cleaned.startsWith('0') && cleaned.length === 11) {
      cleaned = cleaned.slice(1);
    }

    // Must be exactly 10 digits starting with 6, 7, 8, or 9
    if (/^[6-9]\d{9}$/.test(cleaned)) {
      return cleaned;
    }

    return null;
  }

  /**
   * Constant-time comparison for phone strings to prevent timing enumeration.
   */
  private safePhoneCompare(phoneA: string, phoneB: string): boolean {
    if (phoneA.length !== phoneB.length) return false;
    return crypto.timingSafeEqual(Buffer.from(phoneA), Buffer.from(phoneB));
  }

  /**
   * Authenticates the single owner.
   * Performs dummy verification if phone doesn't match to prevent timing attacks.
   */
  public async verifyCredentials(
    rawPhone: string,
    rawPassword: string
  ): Promise<{ success: boolean; normalizedPhone: string | null }> {
    const normalized = this.normalizePhone(rawPhone);
    const configuredPhone = env.OWNER_PHONE;

    const isPhoneMatch = normalized ? this.safePhoneCompare(normalized, configuredPhone) : false;

    if (!isPhoneMatch) {
      // Run dummy argon2 verification to keep response time indistinguishable from real verification
      try {
        await argon2.verify(DUMMY_HASH, rawPassword);
      } catch {
        // Ignore dummy verify errors
      }
      return { success: false, normalizedPhone: normalized };
    }

    // Verify password against configured Argon2id hash
    try {
      const isPasswordValid = await argon2.verify(env.OWNER_PASSWORD_HASH, rawPassword);
      return { success: isPasswordValid, normalizedPhone: normalized };
    } catch (err) {
      console.error('[AUTH ERROR] Argon2 verification failure:', (err as Error).message);
      return { success: false, normalizedPhone: normalized };
    }
  }
}

export const authService = new AuthService();
