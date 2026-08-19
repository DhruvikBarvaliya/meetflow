/**
 * Opening the verification email.
 *
 * `requireVerifiedEmail` now guards every authenticated surface, so an account
 * this suite registers is refused everything until its address is confirmed —
 * and the only way to confirm one is a link that arrives by email.
 *
 * There is no mail server in the stack (`EMAIL_PROVIDER: console`), so this
 * reads the link out of the outbox instead. That row is the same row the
 * delivery worker would hand to a provider, and its payload carries the same
 * URL the person would click, so the token is genuine and
 * `POST /auth/verify-email` is called exactly as the browser would call it.
 * Only the "check your inbox" step is short-circuited.
 *
 * Two things this deliberately does not do:
 *
 *  - **It does not set `email_verified_at` directly.** That would skip the
 *    endpoint, the token's single-use semantics and the audit row, which is
 *    most of what there is to get wrong.
 *  - **It does not read the token from `users`.** Only the SHA-256 of it is
 *    stored there, which is the point of storing it that way.
 *
 * This is the one place in the e2e suite that talks to PostgreSQL. It is
 * arrangement, never assertion: nothing here decides whether a test passes, and
 * every claim the suite makes still goes through the product.
 */
import { Client } from 'pg';
import { apiCall } from './api';

/**
 * Where the dev stack's database lives.
 *
 * The same default as `.env.example`, so a checkout that has not been
 * configured works, and overridable for anyone running Postgres somewhere else.
 */
const CONNECTION =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://meetflow:meetflow@localhost:5432/meetflow_dev';

interface VerificationRow {
  payload: { verificationUrl?: string };
}

/**
 * Confirms an address by using the link that was emailed to it.
 *
 * Retries briefly: registration queues the notification inside the request's
 * own transaction, so the row is there by the time the response is written —
 * but the outbox is written by the same commit, and a slow one under parallel
 * load can land a moment after the client has read its 201.
 */
export async function verifyEmailFor(email: string): Promise<void> {
  const client = new Client({ connectionString: CONNECTION });
  await client.connect();

  try {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const result = await client.query<VerificationRow>(
        `SELECT payload
           FROM notifications
          WHERE type = 'EMAIL_VERIFICATION'
            AND recipient_address = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [email],
      );

      const url = result.rows[0]?.payload?.verificationUrl;
      if (url) {
        const token = new URL(url).searchParams.get('token');
        if (!token) throw new Error(`The verification URL for ${email} carried no token.`);
        await apiCall('/api/v1/auth/verify-email', { method: 'POST', body: { token } });
        return;
      }

      if (Date.now() > deadline) {
        throw new Error(`No verification email was queued for ${email} within 5s.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await client.end();
  }
}
