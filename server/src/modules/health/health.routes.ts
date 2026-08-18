/**
 * Liveness and readiness.
 *
 * `/health` answers "is this process alive?" and must never touch a dependency —
 * a database blip should not cause the orchestrator to kill healthy pods.
 * `/ready` answers "should this process receive traffic?" and does check
 * dependencies, so an instance that has lost PostgreSQL is pulled from the load
 * balancer instead of serving errors.
 */
import { Router } from 'express';
import { databaseHealth } from '../../config/database';
import { env } from '../../config/env';
import { redisHealth } from '../../config/redis';
import { asyncHandler, sendSuccess } from '../../utils/http';

export const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'meetflow-api',
    env: env.APP_ENV,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const [database, redis] = await Promise.all([databaseHealth(), redisHealth()]);

    // PostgreSQL is required to serve any request. Redis is not: caching,
    // rate limiting and queues all degrade gracefully, so a Redis outage is
    // reported as `degraded` while the instance keeps taking traffic.
    const ready = database.ok;
    const status = !database.ok ? 'unavailable' : redis.ok ? 'ready' : 'degraded';

    res.status(ready ? 200 : 503).json({
      status,
      checks: {
        database: { ...database, required: true },
        redis: { ...redis, required: false },
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/** Build/version metadata, useful when several revisions run side by side. */
healthRouter.get('/version', (_req, res) => {
  sendSuccess(res, {
    service: 'meetflow-api',
    apiVersion: 'v1',
    environment: env.APP_ENV,
    node: process.version,
  });
});
