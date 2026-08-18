/**
 * Vitest global setup.
 *
 * Migrates the dedicated test database from empty before the suite runs. This
 * doubles as a continuous check that migrations apply cleanly from scratch —
 * the "fresh database migration works" release requirement is verified on every
 * test run rather than remembered at release time.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default async function globalSetup(): Promise<void> {
  const serverRoot = path.resolve(__dirname, '..');
  const env = { ...process.env, NODE_ENV: 'test' };

  const run = (args: string[]): void => {
    execFileSync('npx', ['sequelize-cli', ...args], {
      cwd: serverRoot,
      env,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  };

  try {
    // Undo first so a schema change in a migration cannot leave the test
    // database on a stale shape from a previous run.
    run(['db:migrate:undo:all']);
  } catch {
    // Nothing to undo on a brand-new database.
  }
  run(['db:migrate']);
}
