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
  private lastCleanupTime = 0;
  private static readonly CLEANUP_LOCK_ID = 987654322;
  private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  constructor(forceInMemory = false) {
    if (!env.SESSION_SECRET) {
      throw new Error('SESSION_SECRET is required for LoginAttemptStore hashing');
    }
    this.secretPepper = env.SESSION_SECRET;
    this.forceInMemory = forceInMemory;
  }

  /**
   * Hashes an identifier with SHA-256 and SESSION_SECRET as pepper to avoid storing raw IPs or phone numbers.
   */
  public hashIdentifier(identifier: string): string {
    return crypto
      .createHmac('sha256', this.secretPepper)
      .update(identifier.trim().toLowerCase())
      .digest('hex');
  }

  /**
   * Evaluates lockout status for an IP and/or phone identifier.
   * Checks combined bucket, IP bucket, and phone bucket.
   */
  public async checkLockout(clientIp: string, normalizedPhone?: string): Promise<LockoutStatus> {
    const ipHash = this.hashIdentifier(clientIp);
    const phoneHash = normalizedPhone ? this.hashIdentifier(normalizedPhone) : null;
    const combinedHash = normalizedPhone ? this.hashIdentifier(`${clientIp}_${normalizedPhone}`) : null;

    const now = Date.now();
    const shortWindowStart = new Date(now - env.LOGIN_FAILURE_WINDOW_MS);
    const extendedWindowStart = new Date(now - env.LOGIN_EXTENDED_WINDOW_MS);

    // Opportunistically trigger safe throttled maintenance cleanup without unhandled rejection
    void this.maybePruneOldAttempts().catch(() => {});

    if (this.forceInMemory || (env.NODE_ENV as string) === 'test') {
      return this.checkInMemoryLockout(ipHash, phoneHash, combinedHash, now);
    }

    try {
      // Query PostgreSQL persistent login_attempts table
      // Checks failures across IP, phone, and combined buckets
      const query = `
        SELECT
          COUNT(*) FILTER (WHERE created_at >= $1) AS short_window_failures,
          COUNT(*) FILTER (WHERE created_at >= $2) AS extended_failures,
          MAX(created_at) AS last_failure_at
        FROM login_attempts
        WHERE (ip_hash = $3 OR ($4::text IS NOT NULL AND phone_hash = $4) OR ($5::text IS NOT NULL AND combined_hash = $5))
          AND success = false
          AND created_at >= $2
      `;

      const result = await appPool.query(query, [
        shortWindowStart.toISOString(),
        extendedWindowStart.toISOString(),
        ipHash,
        phoneHash,
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
      if (env.NODE_ENV === 'production') {
        const serviceErr = new Error('Database unavailable for persistent abuse controls.');
        (serviceErr as unknown as { status: number }).status = 503;
        throw serviceErr;
      }
      return this.checkInMemoryLockout(ipHash, phoneHash, combinedHash, now);
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

    // Opportunistically trigger safe throttled maintenance cleanup
    void this.maybePruneOldAttempts();

    // Only keep in-memory sync for test runner / isolated testing
    if (this.forceInMemory || (env.NODE_ENV as string) === 'test') {
      this.inMemoryAttempts.push({
        ipHash,
        phoneHash,
        combinedHash,
        success,
        createdAt: now,
      });
      return;
    }

    try {
      await appPool.query(
        `INSERT INTO login_attempts (ip_hash, phone_hash, combined_hash, success, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [ipHash, phoneHash, combinedHash, success]
      );
    } catch (err) {
      if (env.NODE_ENV === 'production') {
        const serviceErr = new Error('Database unavailable for recording persistent login abuse controls.');
        (serviceErr as unknown as { status: number }).status = 503;
        throw serviceErr;
      }
      if ((env.NODE_ENV as string) !== 'test') {
        console.error('[LOCKOUT STORE ERROR] Failed to record login attempt to PostgreSQL:', (err as Error).message);
      }
    }
  }

  /**
   * Throttled background maintenance that invokes pruneOldAttempts safely without extra worker processes.
   */
  /**
   * Throttled background maintenance that invokes pruneOldAttempts safely without extra worker processes.
   * Guaranteed to catch all connection acquisition errors and never emit unhandled rejections.
   */
  public async maybePruneOldAttempts(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanupTime < LoginAttemptStore.CLEANUP_INTERVAL_MS) {
      return;
    }

    if (this.forceInMemory || (env.NODE_ENV as string) === 'test') {
      try {
        await this.pruneOldAttempts();
        this.lastCleanupTime = now;
      } catch (err) {
        console.warn('[LOCKOUT MAINTENANCE WARNING] In-memory pruning skipped:', (err as Error).message);
        this.lastCleanupTime = now - LoginAttemptStore.CLEANUP_INTERVAL_MS + 5 * 60 * 1000;
      }
      return;
    }

    let client: any = null;
    try {
      client = await appPool.connect();
      const lockRes = await client.query(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [LoginAttemptStore.CLEANUP_LOCK_ID]
      );
      if (lockRes.rows[0]?.acquired) {
        try {
          await this.pruneOldAttempts();
          this.lastCleanupTime = now;
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [LoginAttemptStore.CLEANUP_LOCK_ID]);
        }
      } else {
        // Lock currently held by another worker; mark as checked recently
        this.lastCleanupTime = now;
      }
    } catch (err) {
      console.warn('[LOCKOUT MAINTENANCE WARNING] Background login attempt pruning skipped:', (err as Error).message);
      // Safe retry cooldown: 5 minutes instead of 1 hour
      this.lastCleanupTime = now - LoginAttemptStore.CLEANUP_INTERVAL_MS + 5 * 60 * 1000;
    } finally {
      if (client) {
        try {
          client.release();
        } catch {
          // ignore release error
        }
      }
    }
  }

  /**
   * Safe retention cleanup for login attempt records older than LOGIN_LOG_RETENTION_DAYS.
   */
  public async pruneOldAttempts(): Promise<number> {
    const cutoffDate = new Date(Date.now() - env.LOGIN_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    this.inMemoryAttempts = this.inMemoryAttempts.filter((a) => a.createdAt >= cutoffDate.getTime());

    if (this.forceInMemory || (env.NODE_ENV as string) === 'test') {
      return this.inMemoryAttempts.length;
    }

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

  private checkInMemoryLockout(
    ipHash: string,
    phoneHash: string | null,
    combinedHash: string | null,
    now: number
  ): LockoutStatus {
    const failures = this.inMemoryAttempts.filter(
      (a) =>
        !a.success &&
        (a.ipHash === ipHash ||
          (phoneHash && a.phoneHash === phoneHash) ||
          (combinedHash && a.combinedHash === combinedHash))
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
