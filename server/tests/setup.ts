/**
 * Global test setup.
 *
 * Pins NODE_ENV before any module reads configuration, so `src/config/env.ts`
 * resolves the dedicated test database and its deterministic secrets rather
 * than whatever a developer happens to have in `.env`.
 */
process.env.NODE_ENV = 'test';
process.env.APP_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'silent';
process.env.LOG_PRETTY = 'false';
process.env.SEED_ENABLED ??= 'false';
process.env.RATE_LIMIT_ENABLED ??= 'false';
// `webhooks.test.ts` starts a real HTTP receiver on 127.0.0.1 and asserts a
// signed delivery actually lands on it, which the SSRF guard would otherwise —
// correctly — refuse. `env.ts` rejects this flag outright when
// `APP_ENV=production`, so allowing it here cannot leak into a deployment.
// `ssrf.test.ts` forces it back off, because that file tests the guard as
// production runs it.
process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS ??= 'true';
// Encryption on for the whole suite, so `webhooks.test.ts` signs with a secret
// that has actually been through the seal/open round trip and the receiver
// verifies the result. Leaving it unset would run every test against the
// plaintext path and prove nothing about the encrypted one — which is the
// coverage hole that looks like coverage.
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ??= 'test-webhook-secret-key-long-enough';
