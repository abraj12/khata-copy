import crypto from 'crypto';
import { appPool } from '../../config/database.js';
import { env } from '../../config/env.js';

export interface LockoutStatus {
  isLocked: boolean;
  remainingMs: number;
  message?: string;
}

interface InMemoryAttempt {
  ipHash: string;
  phoneHash: string;
  combinedHash: string;
  success: boolean;
  createdAt: number;
}

export class LoginAttemptStore {
  private secretPepper: string;
  private inMemoryAttempts: InMemoryAttempt[] = [];
  private forceInMemory: boolean;

  constructor(forceInMemory = false) {
    this.secretPepper = env.SESSION_SECRET || 'khata_lockout_pepper_salt_value_123';
    this.forceInMemory = forceInMemory;
  }

  /**
   * Hashes an identifier with SHA-256 and a secret pepper to avoid storing raw IPs or phone numbers.
   */
  public hashIdentifier(identifier: string): string {
    return crypto
      .createHmac('sha256', this.secretPepper)
      .update(identifier.trim().toLowerCase())
      .digest('hex');
  }

  /**
   * Evaluates lockout status for an IP and/or phone identifier.
   * Checks combined bucket and IP bucket to prevent remote distributed DoS against owner.
   */
  public async checkLockout(clientIp: string, normalizedPhone?: string): Promise<LockoutStatus> {
    const ipHash = this.hashIdentifier(clientIp);
    const phoneHash = normalizedPhone ? this.hashIdentifier(normalizedPhone) : null;
    const combinedHash = normalizedPhone ? this.hashIdentifier(`${clientIp}_${normalizedPhone}`) : null;

    const now = Date.now();
    const shortWindowStart = new Date(now - env.LOGIN_FAILURE_WINDOW_MS);
    const extendedWindowStart = new Date(now - env.LOGIN_EXTENDED_WINDOW_MS);

    if (this.forceInMemory || (env.NODE_ENV as string) === 'test') {
      return this.checkInMemoryLockout(ipHash, combinedHash, now);
    }

    try {
      // Query PostgreSQL persistent login_attempts table
      // We check failures for combined (IP+phone) first, then IP bucket
      const query = `
        SELECT
          COUNT(*) FILTER (WHERE created_at >= $1) AS short_window_failures,
          COUNT(*) FILTER (WHERE created_at >= $2) AS extended_failures,
          MAX(created_at) AS last_failure_at
        FROM login_attempts
        WHERE (ip_hash = $3 OR ($4::text IS NOT NULL AND combined_hash = $4))
          AND success = false
          AND created_at >= $2
      `;

      const result = await appPool.query(query, [
        shortWindowStart.toISOString(),
        extendedWindowStart.toISOString(),
        ipHash,
        combinedHash,
      ]);

      const row = result.rows[0];
      const shortFailures = parseInt(row?.short_window_failures || '0', 10);
      const extendedFailures = parseInt(row?.extended_failures || '0', 10);
      const lastFailureAt = row?.last_failure_at ? new Date(row.last_failure_at).getTime() : 0;

      // Tier 2: Extended lockout (10 failures in 24h -> 30 min lockout)
      if (extendedFailures >= env.LOGIN_EXTENDED_THRESHOLD) {
        const lockoutEnd = lastFailureAt + env.LOGIN_EXTENDED_LOCK_DURATION_MS;
        if (now < lockoutEnd) {
          return {
            isLocked: true,
            remainingMs: lockoutEnd - now,
            message: 'Too many failed login attempts. Account temporarily locked for 30 minutes for security.',
          };
        }
      }

      // Tier 1: Short lockout (5 failures in 15 mins -> 15 min lockout)
      if (shortFailures >= env.LOGIN_MAX_ATTEMPTS) {
        const lockoutEnd = lastFailureAt + env.LOGIN_LOCK_DURATION_MS;
        if (now < lockoutEnd) {
          return {
            isLocked: true,
            remainingMs: lockoutEnd - now,
            message: 'Too many failed login attempts. Please try again in 15 minutes.',
          };
        }
      }

      return { isLocked: false, remainingMs: 0 };
    } catch (err) {
      console.warn('[LOCKOUT STORE] DB error querying login_attempts, checking in-memory fallback:', (err as Error).message);
      return this.checkInMemoryLockout(ipHash, combinedHash, now);
    }
  }

  /**
   * Records a login attempt (success or failure).
   */
  public async recordAttempt(clientIp: string, normalizedPhone: string, success: boolean): Promise<void> {
    const ipHash = this.hashIdentifier(clientIp);
    const phoneHash = this.hashIdentifier(normalizedPhone);
    const combinedHash = this.hashIdentifier(`${clientIp}_${normalizedPhone}`);
    const now = Date.now();

    // Always keep in-memory sync for test/fallback
    this.inMemoryAttempts.push({
      ipHash,
      phoneHash,
      combinedHash,
      success,
      createdAt: now,
    });

    if (this.forceInMemory || (env.NODE_ENV as string) === 'test') return;

    try {
      await appPool.query(
        `INSERT INTO login_attempts (ip_hash, phone_hash, combined_hash, success, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [ipHash, phoneHash, combinedHash, success]
      );
    } catch (err) {
      // In tests or if DB is offline, continue safely
      if ((env.NODE_ENV as string) !== 'test') {
        console.error('[LOCKOUT STORE ERROR] Failed to record login attempt to PostgreSQL:', (err as Error).message);
      }
    }
  }

  /**
   * Safe retention cleanup for login attempt records older than LOGIN_LOG_RETENTION_DAYS.
   */
  public async pruneOldAttempts(): Promise<number> {
    const cutoffDate = new Date(Date.now() - env.LOGIN_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    this.inMemoryAttempts = this.inMemoryAttempts.filter((a) => a.createdAt >= cutoffDate.getTime());

    try {
      const res = await appPool.query(
        `DELETE FROM login_attempts WHERE created_at < $1`,
        [cutoffDate.toISOString()]
      );
      return res.rowCount || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Resets attempts (useful for tests or after successful login).
   */
  public resetInMemory(): void {
    this.inMemoryAttempts = [];
  }

  private checkInMemoryLockout(ipHash: string, combinedHash: string | null, now: number): LockoutStatus {
    const failures = this.inMemoryAttempts.filter(
      (a) => !a.success && (a.ipHash === ipHash || (combinedHash && a.combinedHash === combinedHash))
    );

    const shortFailures = failures.filter((a) => now - a.createdAt <= env.LOGIN_FAILURE_WINDOW_MS);
    const extendedFailures = failures.filter((a) => now - a.createdAt <= env.LOGIN_EXTENDED_WINDOW_MS);

    const lastFailureAt = failures.length > 0 ? failures[failures.length - 1].createdAt : 0;

    if (extendedFailures.length >= env.LOGIN_EXTENDED_THRESHOLD) {
      const lockoutEnd = lastFailureAt + env.LOGIN_EXTENDED_LOCK_DURATION_MS;
      if (now < lockoutEnd) {
        return {
          isLocked: true,
          remainingMs: lockoutEnd - now,
          message: 'Too many failed login attempts. Account temporarily locked for 30 minutes for security.',
        };
      }
    }

    if (shortFailures.length >= env.LOGIN_MAX_ATTEMPTS) {
      const lockoutEnd = lastFailureAt + env.LOGIN_LOCK_DURATION_MS;
      if (now < lockoutEnd) {
        return {
          isLocked: true,
          remainingMs: lockoutEnd - now,
          message: 'Too many failed login attempts. Please try again in 15 minutes.',
        };
      }
    }

    return { isLocked: false, remainingMs: 0 };
  }
}

export const loginAttemptStore = new LoginAttemptStore();
