/**
 * Destructive Test Database Safeguard
 * Enforces strict safety rules to guarantee that integration tests with DROP TABLE
 * or destructive SQL can NEVER run against production databases or Neon endpoints.
 */

export interface TestDbGuardOptions {
  allowRemoteOverride?: boolean;
}

export function assertSafeTestDatabaseUrl(urlStr: string, options: TestDbGuardOptions = {}): void {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error('[TEST DB GUARD] TEST_DATABASE_URL is required and must be a valid string.');
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('[TEST DB GUARD] Failed to parse TEST_DATABASE_URL as a valid URL.');
  }

  // 1. Protocol validation
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `[TEST DB GUARD] Invalid protocol '${parsed.protocol}'. Expected postgres: or postgresql:.`
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // 2. Unconditional rejection of Neon and production cloud endpoints
  const dangerousHostPatterns = [
    'neon.tech',
    'aws.neon.tech',
    'render.com',
    'onrender.com',
    'supabase.co',
    'elephantsql.com',
    'rds.amazonaws.com',
  ];

  for (const pattern of dangerousHostPatterns) {
    if (hostname.includes(pattern)) {
      throw new Error(
        `[TEST DB GUARD] DESTRUCTIVE TESTS BLOCKED: Hostname '${hostname}' contains forbidden production/cloud domain '${pattern}'. Tests can NEVER run against cloud databases!`
      );
    }
  }

  // 3. Database name safety check (must end with _test or _integration_test)
  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (!dbName) {
    throw new Error('[TEST DB GUARD] No database name found in connection string.');
  }

  const hasSafeSuffix = dbName.endsWith('_test') || dbName.endsWith('_integration_test');
  if (!hasSafeSuffix) {
    throw new Error(
      `[TEST DB GUARD] DESTRUCTIVE TESTS BLOCKED: Database name '${dbName}' does not end with safe suffix '_test' or '_integration_test'.`
    );
  }

  // 4. Loopback host verification (or explicit override for disposable CI containers)
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0';

  const remoteAllowed =
    options.allowRemoteOverride === true || process.env.ALLOW_REMOTE_TEST_DB === 'true';

  if (!isLoopback && !remoteAllowed) {
    throw new Error(
      `[TEST DB GUARD] DESTRUCTIVE TESTS BLOCKED: Non-loopback test host '${hostname}' requires explicit ALLOW_REMOTE_TEST_DB=true override (disposable CI only).`
    );
  }

  // 5. Reject production role names even on loopback endpoints
  const decodedUsername = decodeURIComponent(parsed.username || '').toLowerCase();
  if (decodedUsername === 'neondb_owner') {
    throw new Error(
      `[TEST DB GUARD] DESTRUCTIVE TESTS BLOCKED: Production role 'neondb_owner' is forbidden in test database URLs.`
    );
  }
}

function normalizePgTarget(connectionString: string): string {
  const parsed = new URL(connectionString);
  const protocol = parsed.protocol === 'postgres:' ? 'postgresql:' : parsed.protocol;
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || '5432';
  const dbName = parsed.pathname.replace(/^\/+/, '');
  return `${protocol}//${host}:${port}/${dbName}`;
}

function isUnconfiguredDefaultNeonUrl(url: string | undefined): boolean {
  if (!url) return false;
  return (
    url.includes('neondb_owner:dummy@') &&
    url.includes('ep-shy-mud-94919289')
  );
}

/**
 * Ensures that in test mode with TEST_DATABASE_URL set, BOTH appPool and directPool
 * resolve to the exact same validated disposable test database.
 * Rejects mismatched DATABASE_URL or DATABASE_URL_POOLED overrides.
 */
export function resolveValidatedTestPoolUrls(
  rawEnv: Record<string, string | undefined> = process.env
): { isTestDbActive: boolean; testDbUrl: string | null } {
  const requireTestDb = rawEnv.REQUIRE_TEST_DATABASE_URL === 'true';
  if (rawEnv.NODE_ENV !== 'test') {
    if (requireTestDb) {
      throw new Error(
        '[TEST DB GUARD] REQUIRE_TEST_DATABASE_URL=true can only be used in NODE_ENV=test with a validated TEST_DATABASE_URL.'
      );
    }
    return { isTestDbActive: false, testDbUrl: null };
  }

  const testDbUrl = rawEnv.TEST_DATABASE_URL?.trim();
  if (!testDbUrl) {
    if (requireTestDb) {
      throw new Error(
        '[TEST DB GUARD] REQUIRE_TEST_DATABASE_URL=true requires TEST_DATABASE_URL to be configured with a validated disposable test database URL.'
      );
    }
    return { isTestDbActive: false, testDbUrl: null };
  }

  assertSafeTestDatabaseUrl(testDbUrl);
  const expectedTarget = normalizePgTarget(testDbUrl);

  for (const varName of ['DATABASE_URL', 'DATABASE_URL_POOLED'] as const) {
    const candidate = rawEnv[varName]?.trim();
    if (!candidate || isUnconfiguredDefaultNeonUrl(candidate)) {
      continue;
    }

    assertSafeTestDatabaseUrl(candidate);
    const candidateTarget = normalizePgTarget(candidate);
    if (candidateTarget !== expectedTarget) {
      throw new Error(
        `[TEST DB GUARD] Pool URL mismatch in test mode: ${varName} target '${candidateTarget}' must match TEST_DATABASE_URL target '${expectedTarget}'.`
      );
    }
  }

  return { isTestDbActive: true, testDbUrl };
}
