/**
 * Express application assembly.
 *
 * Middleware order matters and is deliberate:
 *   security headers -> CORS -> request id -> logging -> body parsing
 *   -> routes -> 404 -> error handler
 *
 * The error handler is last so every thrown error, from any layer, is
 * translated in exactly one place.
 */
import express, { type Express } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import { env, isProduction } from './config/env';
import { createLogger } from './config/logger';
import { docsRouter } from './docs/swagger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { httpLogger, requestId } from './middleware/requestContext';
import { healthRouter } from './modules/health/health.routes';
import { apiRouter } from './routes';
import { ForbiddenError } from './utils/errors';

const log = createLogger('http');

export function createApp(): Express {
  const app = express();

  // Behind a load balancer, req.ip must reflect the real client or every
  // per-IP rate limit collapses onto the proxy's address. Enabled only when
  // the proxy is actually trusted.
  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(
    helmet({
      // The API serves JSON, not documents; a restrictive CSP here protects the
      // Swagger UI page, which is the only HTML this service returns.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      // Same-origin and non-browser callers (curl, server-to-server, health
      // probes) send no Origin header and are allowed through.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (env.CORS_ORIGINS.includes(origin.replace(/\/$/, ''))) {
        callback(null, true);
        return;
      }
      log.warn({ origin }, 'blocked cross-origin request');
      callback(new ForbiddenError('This origin is not allowed to call the MeetFlow API.'));
    },
    // Refresh tokens travel as an httpOnly cookie.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Business-Id',
      'X-Request-Id',
      'X-Idempotency-Key',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    maxAge: 600,
  };
  app.use(cors(corsOptions));

  app.use(requestId);
  app.use(httpLogger);

  // 256kb is generous for scheduling payloads and small enough that a hostile
  // client cannot buffer megabytes per connection.
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());
  app.use(compression());

  // Probes live outside /api/v1 so they never sit behind versioning or auth.
  app.use(healthRouter);

  // Interactive API reference. Deliberately not mounted in production: it is
  // unauthenticated and enumerates the entire management surface, which the
  // 401-on-unknown-path behaviour otherwise keeps private. Generate the
  // contract for production consumers with `npm run contracts:export` instead.
  if (!isProduction) {
    app.use('/api/docs', docsRouter);
  }

  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
