import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Runtime connection as the least-privileged `hotel_app` role (RLS applies). */
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL: z.string().default('10h'),
  REDIS_URL: z.string().url().optional(),
  QUEUES_ENABLED: bool.default('true'),
  /** Shared secret for the HQ integration worker (sent as a bearer token). */
  WORKER_TOKEN: z.string().min(32, 'WORKER_TOKEN must be at least 32 characters'),
  WORKER_CLAIM_LEASE_SECONDS: z.coerce.number().int().min(30).default(300),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24 * 30),
  ENABLE_DEV_ENDPOINTS: bool.default('false'),
  CORS_ORIGINS: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
