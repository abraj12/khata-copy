import { describe, it, expect } from 'vitest';
import { assertSafeTestDatabaseUrl, resolveValidatedTestPoolUrls } from '../src/config/testDbGuard.js';
import { resolveDatabasePoolTargets } from '../src/config/database.js';

describe('Destructive Test Database Safeguard Suite', () => {
  it('1. Rejects empty or invalid URL strings', () => {
    expect(() => assertSafeTestDatabaseUrl('')).toThrow(
      'TEST_DATABASE_URL is required and must be a valid string.'
    );
    expect(() => assertSafeTestDatabaseUrl('not-a-valid-url')).toThrow(
      'Failed to parse TEST_DATABASE_URL as a valid URL.'
    );
  });

  it('2. Rejects non-postgresql protocols', () => {
    expect(() =>
      assertSafeTestDatabaseUrl('http://localhost:5432/khata_test')
    ).toThrow("Invalid protocol 'http:'. Expected postgres: or postgresql:.");
  });

  it('3. Unconditionally rejects Neon production URLs', () => {
    const neonUrls = [
      'postgresql://neondb_owner:secret@ep-aged-resonance-az771dby.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
      'postgres://user:pass@ep-cool-project-12345.neon.tech/neondb_test',
      'postgresql://neondb_owner:npg_123@ep-shy-mud-94919289.ap-southeast-1.aws.neon.tech/neondb_test',
    ];

    for (const url of neonUrls) {
      expect(() => assertSafeTestDatabaseUrl(url)).toThrow(
        /DESTRUCTIVE TESTS BLOCKED: Hostname '.*' contains forbidden production\/cloud domain/
      );
    }
  });

  it('4. Unconditionally rejects Render, Supabase, and AWS RDS URLs', () => {
    const cloudUrls = [
      'postgresql://user:pass@dpg-abc123xyz.singapore-postgres.render.com/khata_test',
      'postgresql://postgres:pass@db.projectref.supabase.co/khata_test',
      'postgres://admin:pass@khata-db.cxyz.ap-southeast-1.rds.amazonaws.com/khata_test',
    ];

    for (const url of cloudUrls) {
      expect(() => assertSafeTestDatabaseUrl(url)).toThrow(
        /DESTRUCTIVE TESTS BLOCKED: Hostname '.*' contains forbidden production\/cloud domain/
      );
    }
  });

  it('5. Rejects databases lacking safe _test or _integration_test suffix', () => {
    const nonTestDbs = [
      'postgresql://postgres:postgres@localhost:5432/khata',
      'postgresql://postgres:postgres@127.0.0.1:5432/neondb',
      'postgresql://postgres:postgres@localhost:5432/production',
    ];

    for (const url of nonTestDbs) {
      expect(() => assertSafeTestDatabaseUrl(url)).toThrow(
        /does not end with safe suffix '_test' or '_integration_test'/
      );
    }
  });

  it('6. Rejects remote non-loopback hosts unless explicit ALLOW_REMOTE_TEST_DB override is provided', () => {
    const remoteUrl = 'postgresql://postgres:postgres@192.168.1.50:5432/khata_test';

    // Without override -> blocked
    expect(() => assertSafeTestDatabaseUrl(remoteUrl)).toThrow(
      /Non-loopback test host '.*' requires explicit ALLOW_REMOTE_TEST_DB=true override/
    );

    // With explicit programmatic override -> allowed
    expect(() =>
      assertSafeTestDatabaseUrl(remoteUrl, { allowRemoteOverride: true })
    ).not.toThrow();
  });

  it('7. Accepts valid local loopback test databases', () => {
    const validUrls = [
      'postgresql://postgres:postgres@localhost:5432/khata_test',
      'postgresql://postgres:postgres@127.0.0.1:5432/khata_integration_test',
      'postgres://testuser:testpass@localhost:5432/my_app_test',
    ];

    for (const url of validUrls) {
      expect(() => assertSafeTestDatabaseUrl(url)).not.toThrow();
    }
  });

  it('8. Rejects production role neondb_owner even on loopback host', () => {
    expect(() =>
      assertSafeTestDatabaseUrl('postgresql://neondb_owner:pass@localhost:5432/khata_test')
    ).toThrow(/Production role 'neondb_owner' is forbidden/);
  });

  it('9. Forces both appPool and directPool to resolve to validated TEST_DATABASE_URL in test mode and blocks mismatched overrides', () => {
    const testUrl = 'postgresql://postgres:pass@127.0.0.1:55432/khata_test';
    const resolved = resolveDatabasePoolTargets(
      {
        NODE_ENV: 'test',
        TEST_DATABASE_URL: testUrl,
        DATABASE_URL: 'postgresql://neondb_owner:dummy@ep-shy-mud-94919289.us-east-2.aws.neon.tech/neondb?sslmode=require',
        DATABASE_URL_POOLED: 'postgresql://neondb_owner:dummy@ep-shy-mud-94919289-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
      },
      {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://neondb_owner:dummy@ep-shy-mud-94919289.us-east-2.aws.neon.tech/neondb?sslmode=require',
        DATABASE_URL_POOLED: 'postgresql://neondb_owner:dummy@ep-shy-mud-94919289-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
      }
    );

    expect(resolved.isTestDbActive).toBe(true);
    expect(resolved.pooledConnectionString).toBe(testUrl);
    expect(resolved.directConnectionString).toBe(testUrl);
    expect(resolved.ssl).toBe(false);

    // Conflicting explicit DATABASE_URL in test mode must fail loudly
    expect(() =>
      resolveValidatedTestPoolUrls({
        NODE_ENV: 'test',
        TEST_DATABASE_URL: testUrl,
        DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/other_test',
      })
    ).toThrow(/Pool URL mismatch in test mode/);
  });
});
