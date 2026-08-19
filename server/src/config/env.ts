/**
 * Startup configuration contract.
 *
 * Every environment variable MeetFlow reads is declared, coerced and validated
 * here exactly once. An invalid or missing required value aborts the boot with
 * an actionable message rather than surfacing later as a runtime surprise.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load the first .env found: server workspace, then repository root. Values
// already present in the real environment (containers, CI, platform secrets)
// always win — dotenv never overwrites them.
for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../.env'),
]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

/** Accepts the usual truthy spellings people put in .env files. */
const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const integer = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : value))
    .pipe(z.coerce.number().int().min(min).max(max));

/** Comma-separated origin list -> deduplicated array of exact origins. */
const originList = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : value))
    .transform((value) =>
      Array.from(
        new Set(
          value
            .split(',')
            .map((origin) => origin.trim().replace(/\/$/, ''))
            .filter(Boolean),
        ),
      ),
    );

/** `15m`, `30d`, `900s`, or a raw number of seconds. */
const duration = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === '' ? defaultValue : value.trim(),
    )
    .refine((value) => /^\d+([smhdw])?$/.test(value), {
      message: 'expected a duration like 15m, 24h, 30d (or a plain number of seconds)',
    });

const isTestRun = process.env.NODE_ENV === 'test';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    APP_ENV: z.enum(['development', 'production']).default('development'),
    PORT: integer(4000, 1, 65535),
    HOST: z.string().default('0.0.0.0'),
    TRUST_PROXY: booleanish(false),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanish(false),

    DATABASE_URL: z.string().min(1).optional(),
    DB_HOST: z.string().default('localhost'),
    DB_PORT: integer(5432, 1, 65535),
    DB_NAME: z.string().default('meetflow_dev'),
    DB_USER: z.string().default('meetflow'),
    DB_PASSWORD: z.string().default('meetflow'),
    DB_SSL: booleanish(false),
    DB_POOL_MIN: integer(2, 0, 100),
    DB_POOL_MAX: integer(10, 1, 200),
    DB_LOGGING: booleanish(false),

    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    REDIS_KEY_PREFIX: z.string().min(1).default('meetflow:dev'),

    // Secrets are the one place with no usable default: a weak signing key is a
    // silent authentication bypass, so refuse to start without a real value.
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_EXPIRES_IN: duration('15m'),
    JWT_REFRESH_EXPIRES_IN: duration('30d'),
    JWT_ISSUER: z.string().default('meetflow'),
    JWT_AUDIENCE: z.string().default('meetflow-api'),

    CORS_ORIGINS: originList('http://localhost:5173'),
    SOCKET_ORIGIN: originList('http://localhost:5173'),
    PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
    API_BASE_URL: z.string().url().default('http://localhost:4000'),

    EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
    EMAIL_FROM: z.string().default('MeetFlow <no-reply@meetflow.local>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: integer(587, 1, 65535),
    SMTP_SECURE: booleanish(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),

    WORKER_CONCURRENCY: integer(5, 1, 100),
    REMINDER_SWEEP_INTERVAL_SECONDS: integer(60, 10, 3600),
    RUN_WORKER_IN_API: booleanish(false),

    RATE_LIMIT_ENABLED: booleanish(true),
    RATE_LIMIT_API_POINTS: integer(300, 1, 100_000),
    RATE_LIMIT_API_WINDOW_SECONDS: integer(60, 1, 86_400),
    RATE_LIMIT_PUBLIC_POINTS: integer(60, 1, 100_000),
    RATE_LIMIT_PUBLIC_WINDOW_SECONDS: integer(60, 1, 86_400),
    RATE_LIMIT_AUTH_POINTS: integer(10, 1, 100_000),
    RATE_LIMIT_AUTH_WINDOW_SECONDS: integer(300, 1, 86_400),

    AVAILABILITY_MAX_RANGE_DAYS: integer(62, 1, 366),
    AVAILABILITY_MAX_SLOTS: integer(750, 1, 20_000),
    CACHE_BOOKING_LINK_TTL_SECONDS: integer(120, 0, 86_400),
    IDEMPOTENCY_TTL_SECONDS: integer(86_400, 60, 2_592_000),

    SEED_DEFAULT_PASSWORD: z.string().min(8).default('MeetFlow!Demo123'),
    SEED_ENABLED: booleanish(false),

    /**
     * Lets webhook deliveries reach private and loopback addresses.
     *
     * Off by default and rejected outright in production, because the guard it
     * disables is the one stopping a tenant pointing MeetFlow's own server at
     * `169.254.169.254` and reading the instance credentials out of the
     * delivery log. It exists for exactly two situations, both local: a
     * developer testing against a receiver on their own machine, and the
     * integration suite, which starts a real HTTP server on 127.0.0.1 because
     * asserting delivery against a mock would assert nothing about delivery.
     */
    WEBHOOK_ALLOW_PRIVATE_TARGETS: booleanish(false),

    /**
     * Encrypts webhook signing secrets at rest.
     *
     * Required in production and optional elsewhere, so a local checkout needs
     * no configuration and a deployment cannot forget. Any length: the key is
     * derived by SHA-256 over whatever is configured, so a passphrase and a hex
     * string both work and neither is silently truncated.
     *
     * Leaving it unset stores the secrets in plaintext, which is what a leaked
     * backup then hands somebody: the ability to forge deliveries a tenant's
     * server accepts as genuine, which is the whole purpose of signing them.
     */
    WEBHOOK_SECRET_ENCRYPTION_KEY: z.string().min(16).optional(),

    TEST_DATABASE_URL: z.string().optional(),
    TEST_DB_NAME: z.string().default('meetflow_test'),
  })
  .superRefine((value, ctx) => {
    if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET — sharing one key lets a ' +
          'stolen refresh token be replayed as an access token.',
      });
    }
    if (value.DB_POOL_MIN > value.DB_POOL_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DB_POOL_MIN'],
        message: 'DB_POOL_MIN cannot exceed DB_POOL_MAX',
      });
    }
    if (value.EMAIL_PROVIDER === 'smtp' && !value.SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when EMAIL_PROVIDER=smtp',
      });
    }

    // Production-only guardrails: these are the settings that quietly turn a
    // hardened deployment into an open one.
    if (value.APP_ENV === 'production') {
      if (value.SEED_ENABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SEED_ENABLED'],
          message: 'SEED_ENABLED must be false in production — seeders are development-only',
        });
      }
      if (!value.WEBHOOK_SECRET_ENCRYPTION_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_SECRET_ENCRYPTION_KEY'],
          message:
            'WEBHOOK_SECRET_ENCRYPTION_KEY is required in production — without it webhook ' +
            'signing secrets are stored in plaintext, and a leaked backup is enough to forge ' +
            'deliveries a tenant accepts as genuine',
        });
      }
      if (value.WEBHOOK_ALLOW_PRIVATE_TARGETS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_ALLOW_PRIVATE_TARGETS'],
          message:
            'WEBHOOK_ALLOW_PRIVATE_TARGETS cannot be enabled in production — it disables the ' +
            'SSRF guard on tenant-supplied delivery URLs',
        });
      }
      if (!value.RATE_LIMIT_ENABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RATE_LIMIT_ENABLED'],
          message: 'RATE_LIMIT_ENABLED cannot be disabled in production',
        });
      }
      if (value.LOG_PRETTY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LOG_PRETTY'],
          message: 'LOG_PRETTY must be false in production so logs stay machine-parseable',
        });
      }
      // The console provider is the default, which makes this the one production
      // misconfiguration nobody has to make on purpose. It is also worse than
      // having no transport at all: a transport that throws puts the
      // notification row back to PENDING for the retry budget and the sweep to
      // pick up, whereas the console provider *reports success*. Every
      // confirmation and every reminder is then marked SENT while nothing
      // leaves the building, and the first person to notice is a customer who
      // never got their booking confirmation. Refuse to start instead.
      if (value.EMAIL_PROVIDER === 'console') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_PROVIDER'],
          message:
            'EMAIL_PROVIDER must be smtp in production — the console provider writes mail to ' +
            'the log and reports it as sent, so notifications are marked SENT and never ' +
            'delivered. Set EMAIL_PROVIDER=smtp and supply SMTP_HOST.',
        });
      }
      for (const [key, secret] of [
        ['JWT_ACCESS_SECRET', value.JWT_ACCESS_SECRET],
        ['JWT_REFRESH_SECRET', value.JWT_REFRESH_SECRET],
      ] as const) {
        if (/dev_only|change_me|REPLACE/i.test(secret)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} still contains a placeholder value — supply a real generated secret`,
          });
        }
      }
      const insecureOrigin = [...value.CORS_ORIGINS, ...value.SOCKET_ORIGIN].find(
        (origin) => origin === '*' || origin.startsWith('http://'),
      );
      if (insecureOrigin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message: `production origins must be explicit https URLs (received "${insecureOrigin}")`,
        });
      }
    }
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  // Tests get deterministic secrets so a developer can run the suite without a
  // populated .env; every other path must supply real configuration.
  const source: NodeJS.ProcessEnv = isTestRun
    ? {
        JWT_ACCESS_SECRET: 'test_access_secret_test_access_secret_0123456789',
        JWT_REFRESH_SECRET: 'test_refresh_secret_test_refresh_secret_0123456789',
        ...process.env,
      }
    : process.env;

  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Written straight to stderr: the logger itself depends on this config.
    process.stderr.write(
      `\n[MeetFlow] Invalid environment configuration — refusing to start.\n${details}\n\n` +
        `Copy .env.example to .env and fill in the required values.\n\n`,
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = load();

export const isProduction = env.APP_ENV === 'production';
export const isDevelopment = env.APP_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

/**
 * Resolved PostgreSQL connection settings shared by the runtime and the
 * migration CLI wrapper.
 */
export const databaseConfig = {
  url:
    isTest && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : isTest ? undefined : env.DATABASE_URL,
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: isTest ? env.TEST_DB_NAME : env.DB_NAME,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  ssl: env.DB_SSL,
  poolMin: env.DB_POOL_MIN,
  poolMax: env.DB_POOL_MAX,
  logging: env.DB_LOGGING,
} as const;
