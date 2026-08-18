/**
 * Production guardrails in the startup configuration contract.
 *
 * This file exists because `EMAIL_PROVIDER` shipped without one. The console
 * provider is the *default*, so a production deploy that simply never set the
 * variable came up healthy, marked every booking confirmation and every
 * reminder SENT, and delivered nothing — the failure mode with no logs, no
 * alert and no retry, discovered only by a customer who never heard back. The
 * guardrail's whole job is to be impossible to reach in production, so the only
 * way to know it works is to boot the config layer and watch it refuse.
 *
 * `src/config/env.ts` validates at import and calls `process.exit(1)` on a bad
 * value, so each case here resets the module registry, rewrites `process.env`
 * and imports it afresh with `exit` stubbed to throw. The environment is
 * snapshotted and restored around every test: dotenv has already merged the
 * repository's real `.env` into `process.env` by the time this runs, and a leak
 * from one case into the next would be invisible and maddening.
 *
 * Every case starts from a configuration that is otherwise production-clean —
 * https origins, real secrets, seeding off — so a failure names exactly one
 * guardrail and nothing has to be untangled from the other four.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_MODULE = '../../src/config/env';

/** A production configuration that satisfies every *other* guardrail. */
const PRODUCTION_BASE: Record<string, string | undefined> = {
  // NODE_ENV stays `test`: it selects the test database and the deterministic
  // secrets, while APP_ENV is what the production guardrails key on.
  NODE_ENV: 'test',
  APP_ENV: 'production',
  JWT_ACCESS_SECRET: 'production_access_secret_0123456789abcdef',
  JWT_REFRESH_SECRET: 'production_refresh_secret_0123456789abcdef',
  CORS_ORIGINS: 'https://app.meetflow.test',
  SOCKET_ORIGIN: 'https://app.meetflow.test',
  SEED_ENABLED: 'false',
  RATE_LIMIT_ENABLED: 'true',
  LOG_PRETTY: 'false',
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.meetflow.test',
};

interface BootOutcome {
  /** Did the configuration layer load, or did it refuse to start? */
  started: boolean;
  /** Whatever it wrote to stderr on the way down. */
  report: string;
}

let snapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  snapshot = { ...process.env };
});

afterEach(() => {
  process.env = snapshot;
  vi.restoreAllMocks();
});

/**
 * Boots `src/config/env.ts` under `overrides` and reports what happened.
 *
 * `process.exit` is stubbed to throw so the import rejects instead of taking
 * the test runner down with it — which is exactly what a real bad config does
 * to the server process.
 */
async function boot(overrides: Record<string, string | undefined>): Promise<BootOutcome> {
  for (const [name, value] of Object.entries({ ...PRODUCTION_BASE, ...overrides })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  let report = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    report += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null): never => {
    throw new Error(`process.exit(${String(code)})`);
  });

  vi.resetModules();
  try {
    // Specifier held in a variable on purpose. Under `moduleResolution: node16`
    // TypeScript treats a literal dynamic import as ESM and demands the `.js`
    // extension (TS2835), which is the wrong answer for a CommonJS test file
    // that Vite resolves from source. Deferring it sidesteps the check without
    // pretending the emit is something it is not.
    await import(ENV_MODULE);
    return { started: true, report };
  } catch {
    return { started: false, report };
  }
}

describe('production guardrail: EMAIL_PROVIDER', () => {
  it('refuses to start when the console provider is explicitly configured', async () => {
    const outcome = await boot({ EMAIL_PROVIDER: 'console', SMTP_HOST: undefined });

    expect(outcome.started).toBe(false);
    expect(outcome.report).toContain('EMAIL_PROVIDER');
    // The message has to say what to set — an operator reading a crash loop at
    // 2am should not have to open the source to find out.
    expect(outcome.report).toContain('EMAIL_PROVIDER=smtp');
  });

  it('refuses to start when EMAIL_PROVIDER is simply left unset', async () => {
    // The regression assertion. `console` is the schema default, so this is the
    // deploy nobody had to misconfigure on purpose: copy the example file,
    // forget one line, and every notification is reported as delivered.
    const outcome = await boot({ EMAIL_PROVIDER: undefined, SMTP_HOST: undefined });

    expect(outcome.started).toBe(false);
    expect(outcome.report).toContain('EMAIL_PROVIDER');
  });

  it('starts on a real transport', async () => {
    const outcome = await boot({});

    expect(outcome.report).toBe('');
    expect(outcome.started).toBe(true);
  });

  it('still allows the console provider outside production', async () => {
    // The console provider is genuinely useful in development — it renders the
    // whole notification pipeline into the log without a mail server — so the
    // guardrail must be production-only or it costs every developer an SMTP
    // relay to run the suite.
    const outcome = await boot({
      APP_ENV: 'development',
      EMAIL_PROVIDER: 'console',
      SMTP_HOST: undefined,
    });

    expect(outcome.started).toBe(true);
  });

  it('reports the mail misconfiguration alongside its neighbours, not instead of them', async () => {
    // superRefine collects issues rather than short-circuiting, so an operator
    // fixing a bad deploy sees the whole list in one boot instead of peeling
    // guardrails off one restart at a time.
    const outcome = await boot({
      EMAIL_PROVIDER: 'console',
      SMTP_HOST: undefined,
      SEED_ENABLED: 'true',
      CORS_ORIGINS: 'http://app.meetflow.test',
    });

    expect(outcome.started).toBe(false);
    expect(outcome.report).toContain('EMAIL_PROVIDER');
    expect(outcome.report).toContain('SEED_ENABLED');
    expect(outcome.report).toContain('CORS_ORIGINS');
  });
});
