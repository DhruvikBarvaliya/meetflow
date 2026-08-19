#!/usr/bin/env node
/**
 * Prints the verification link that was emailed to an address.
 *
 * Local development only, and it exists because of a real friction:
 * `REQUIRE_EMAIL_VERIFICATION` is on by default, so an account registered
 * against a local stack can do nothing until its address is confirmed — and
 * with `EMAIL_PROVIDER=console` the link is only ever written to the worker's
 * log, which is a poor place to go fishing while you are trying to test
 * something else.
 *
 * This reads the same outbox row the delivery worker reads, so the link is the
 * genuine one and clicking it exercises the real endpoint. Nothing here
 * verifies anything by itself.
 *
 *   node scripts/verification-link.mjs someone@example.test
 *
 * Refuses to run against a production configuration. It is a convenience for a
 * machine where you already own the database; on a real deployment the same
 * query would hand somebody an account.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The repository's `.env`, so the port matches whatever compose published. */
function loadEnv() {
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = value.trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No `.env` is fine — the defaults below cover a stock compose stack.
  }
}

loadEnv();

if (process.env.APP_ENV === 'production') {
  console.error('Refusing to run against APP_ENV=production.');
  process.exit(1);
}

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/verification-link.mjs <email>');
  process.exit(1);
}

const client = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://meetflow:meetflow@localhost:5432/meetflow_dev',
});

await client.connect();
try {
  const { rows } = await client.query(
    `SELECT payload, created_at, status
       FROM notifications
      WHERE type = 'EMAIL_VERIFICATION'
        AND lower(recipient_address) = lower($1)
      ORDER BY created_at DESC
      LIMIT 1`,
    [email],
  );

  const row = rows[0];
  if (!row) {
    console.error(`No verification email has been queued for ${email}.`);
    console.error('Register the account first, or use "Send another link" on the sign-in screen.');
    process.exit(1);
  }

  const url = row.payload?.verificationUrl;
  if (!url) {
    console.error('That notification carried no verification URL.');
    process.exit(1);
  }

  console.log(url);
  // The status is worth seeing: a PENDING row means the worker has not drained
  // it yet, which is normal and does not stop the link working — the token is
  // live from the moment the row is written.
  console.error(`(queued ${row.created_at.toISOString()}, status ${row.status})`);
} finally {
  await client.end();
}
