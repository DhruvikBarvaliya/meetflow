/**
 * Structured logging.
 *
 * One pino instance for the whole process. Redaction is configured centrally so
 * no call site can accidentally leak a credential — the compliance requirement
 * is that passwords, tokens and secrets never reach the log stream.
 */
import pino from 'pino';
import { env, isProduction } from './env';

/**
 * Paths scrubbed from every log record. `*` wildcards cover nested request and
 * response objects emitted by pino-http.
 */
const REDACT_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'refresh_token',
  'access_token',
  'tokenHash',
  'secret',
  'authorization',
  'cookie',
  'idempotencyKey',
  'signingSecret',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-idempotency-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
  '*.secret',
  '*.signingSecret',
];

const transport =
  env.LOG_PRETTY && !isProduction
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      }
    : undefined;

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'meetflow', env: env.APP_ENV },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(transport ? { transport } : {}),
});

/**
 * Child logger for a named subsystem, e.g. `createLogger('scheduling')`.
 * Keeps log filtering practical once queues, sockets and HTTP all emit.
 */
export function createLogger(component: string, bindings: Record<string, unknown> = {}) {
  return logger.child({ component, ...bindings });
}

export type Logger = pino.Logger;
