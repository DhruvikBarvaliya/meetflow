import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * MeetFlow end-to-end configuration.
 *
 * These specs drive the real stack: a real Postgres, a real Redis, the real API
 * and the real Vite client. Nothing is mocked, because the behaviours worth
 * testing here — slot races, tenant isolation, the booking policy — only exist
 * once all four are in play.
 *
 * Two addressing details are load-bearing and are not interchangeable:
 *
 *  - The **browser** reaches the app at `localhost:5173`. The client is
 *    same-origin with the API in development (Vite proxies `/api`), so the
 *    session cookie stays first-party and there is no CORS preflight.
 *  - **Node** reaches the API at `127.0.0.1:4000`, never `localhost`. Node
 *    resolves `localhost` to `::1` first while the API binds IPv4 only, so a
 *    fixture pointed at `localhost` fails to connect on a machine with anything
 *    listening on IPv6 :4000.
 */
/**
 * The repository's own `.env`, for the one fixture that needs the database.
 *
 * `fixtures/verification.ts` reads the verification link out of the outbox,
 * because there is no mail server in the stack and every account this suite
 * registers is refused everything until its address is confirmed. It therefore
 * needs the same connection string the server uses — and the port is genuinely
 * machine-specific: `docker-compose.yml` publishes Postgres on
 * `${POSTGRES_HOST_PORT:-5432}`, so a developer avoiding a clash with a local
 * install has it somewhere else entirely.
 *
 * Parsed rather than pulled in through `dotenv`, which the e2e workspace does
 * not depend on and does not otherwise need. Existing environment variables
 * win, so `E2E_DATABASE_URL=… npx playwright test` still overrides everything.
 */
function loadRepoEnv(): void {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    // No `.env` is a legitimate state — CI supplies the variables directly.
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = rawValue!.trim().replace(/^["']|["']$/g, '');
  }
}

loadRepoEnv();

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:4000';
const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',

  /*
   * Files run in parallel with each other, tests within a file run in order.
   *
   * Every spec builds its own workspace, so two files can never see each
   * other's data — but within a file the tests deliberately share one workspace
   * and consume slots from it, and reordering them would have a later test race
   * an earlier one for the same opening.
   */
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  forbidOnly: Boolean(process.env.CI),

  /*
   * One retry, so `trace: 'on-first-retry'` can actually produce a trace.
   * The public booking surface is IP rate limited (see the note on `workers`
   * below), and a retry is the cheapest way to survive a limiter window
   * without weakening an assertion.
   */
  retries: process.env.CI ? 2 : 1,

  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: APP_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    /*
     * Both pinned. The booking flow renders every time in the *visitor's* zone,
     * and the workspaces these specs create keep their diary in Asia/Kolkata —
     * pinning the browser to the same zone is what lets a spec compare what the
     * page shows against what the API returned without doing its own timezone
     * arithmetic.
     */
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'npm --workspace server run dev',
      url: `${API_URL}/health`,
      cwd: '..',
      // In development an engineer keeps their own stack up; CI gets a clean boot.
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm --workspace client run dev',
      url: APP_URL,
      cwd: '..',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
