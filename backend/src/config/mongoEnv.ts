import { z } from 'zod';

/**
 * Explicit strict boolean parser for environment variables.
 * Never uses z.coerce.boolean() because Boolean("false") === true in JavaScript.
 */
export function parseStrictEnvBoolean(
  raw: unknown,
  defaultValue: boolean,
  varName: string
): boolean {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  throw new Error(
    `[ENV CONFIG ERROR] ${varName} must be an explicit boolean ('true' or 'false'), received '${String(raw)}'.`
  );
}

const mongoEnvSchema = z.object({
  MONGODB_ENABLED: z.unknown().transform((val) => parseStrictEnvBoolean(val, false, 'MONGODB_ENABLED')),
  MONGODB_URI: z.string().trim().optional(),
  MONGODB_DATABASE: z.string().trim().min(1).default('khata'),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  MONGODB_MIN_POOL_SIZE: z.coerce.number().int().min(0).max(10).default(1),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  MONGODB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  MONGODB_READ_STALE_THRESHOLD_MS: z.coerce.number().int().min(5000).max(3600000).default(300000),
  READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
});

export type MongoEnvConfig = z.infer<typeof mongoEnvSchema>;

export function validateAndParseMongoEnv(
  rawEnv: Record<string, string | undefined>,
  nodeEnv: string
): MongoEnvConfig {
  const parsed = mongoEnvSchema.safeParse({
    MONGODB_ENABLED: rawEnv.MONGODB_ENABLED,
    MONGODB_URI: rawEnv.MONGODB_URI,
    MONGODB_DATABASE: rawEnv.MONGODB_DATABASE,
    MONGODB_MAX_POOL_SIZE: rawEnv.MONGODB_MAX_POOL_SIZE,
    MONGODB_MIN_POOL_SIZE: rawEnv.MONGODB_MIN_POOL_SIZE,
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: rawEnv.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    MONGODB_CONNECT_TIMEOUT_MS: rawEnv.MONGODB_CONNECT_TIMEOUT_MS,
    MONGODB_READ_STALE_THRESHOLD_MS: rawEnv.MONGODB_READ_STALE_THRESHOLD_MS,
    READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS: rawEnv.READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS,
  });

  if (!parsed.success) {
    throw new Error(
      `[MONGODB CONFIG ERROR] Invalid MongoDB environment configuration: ${parsed.error.errors[0]?.message || 'validation failed'}`
    );
  }

  const cfg = parsed.data;

  if (nodeEnv === 'production' && !cfg.MONGODB_ENABLED) {
    throw new Error(
      '[MONGODB CONFIG ERROR] In production, MONGODB_ENABLED must be set to true so read models and analytics do not fall back silently.'
    );
  }

  if (cfg.MONGODB_ENABLED) {
    const uri = cfg.MONGODB_URI?.trim() || '';
    if (
      !uri ||
      (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) ||
      uri.includes('REPLACE_WITH') ||
      uri.includes('dummy_mongo')
    ) {
      throw new Error(
        '[MONGODB CONFIG ERROR] When MONGODB_ENABLED=true, MONGODB_URI must be configured with a valid mongodb:// or mongodb+srv:// URI.'
      );
    }
  }

  return cfg;
}
