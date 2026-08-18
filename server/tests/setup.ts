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
