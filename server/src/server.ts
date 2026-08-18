/**
 * API process entry point.
 *
 * Boots in a deliberate order — verify dependencies, then start listening — so
 * an instance never accepts traffic it cannot serve. Shutdown is graceful:
 * stop accepting connections, drain in-flight requests, then close the
 * database, Redis and queue handles.
 */
import http from 'node:http';
import { createApp } from './app';
import { assertDatabaseConnection, closeDatabase } from './config/database';
import { env } from './config/env';
import { logger } from './config/logger';
import { closeRedis } from './config/redis';
import { closeQueues } from './jobs/queues';
import { attachSocketServer, closeSocketServer } from './sockets';

/** How long in-flight requests get to finish before the process exits. */
const SHUTDOWN_GRACE_MS = 15_000;

async function main(): Promise<void> {
  await assertDatabaseConnection();

  const app = createApp();
  const server = http.createServer(app);

  attachSocketServer(server);

  // Slowloris protection: a client cannot hold a socket open by dribbling
  // headers indefinitely.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve) => {
    server.listen(env.PORT, env.HOST, resolve);
  });

  logger.info(
    { port: env.PORT, host: env.HOST, env: env.APP_ENV, pid: process.pid },
    'MeetFlow API listening',
  );

  if (env.RUN_WORKER_IN_API) {
    // Development convenience only; production runs the dedicated worker
    // container so API latency is never affected by job processing.
    const { startWorkers } = await import('./worker');
    await startWorkers({ standalone: false });
    logger.warn('background workers are running inside the API process (development only)');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested');

    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await closeSocketServer();
      await closeQueues();
      await closeDatabase();
      await closeRedis();
      logger.info('shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Log it with
  // full context and let the orchestrator restart a clean instance.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start MeetFlow API');
  process.exit(1);
});
