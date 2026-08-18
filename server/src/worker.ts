/**
 * Background worker process.
 *
 * Runs as its own container in production so that job throughput and API
 * latency are isolated from each other: a burst of reminder emails cannot slow
 * down a customer trying to book.
 *
 * It can also be started inside the API process for local development
 * (`RUN_WORKER_IN_API=true`), which is why `startWorkers` is exported rather
 * than being executed unconditionally on import.
 */
import { Worker, type Job } from 'bullmq';
import { assertDatabaseConnection, closeDatabase } from './config/database';
import { env } from './config/env';
import { logger } from './config/logger';
import { closeRedis, createRedisConnection } from './config/redis';
import { JOB_NAMES, QUEUE_NAMES, closeQueues, registerRepeatableJobs } from './jobs/queues';
import { sendOwnerDailyDigests } from './jobs/processors/digest.processor';
import {
  advanceInProgress,
  expireWaitlistHolds,
  purgeExpiredTokens,
  purgeIdempotencyKeys,
} from './jobs/processors/maintenance.processor';
import { deliverNotification, sweepNotifications } from './jobs/processors/notification.processor';
import { deliverWebhook } from './jobs/processors/webhook.processor';
import { closeSocketServer } from './sockets';

const log = logger.child({ component: 'worker' });

let workers: Worker[] = [];

export interface StartWorkersOptions {
  /** True when this is a dedicated worker process rather than the API. */
  standalone: boolean;
}

export async function startWorkers(options: StartWorkersOptions): Promise<Worker[]> {
  const connection = createRedisConnection('bullmq-worker');

  const notificationWorker = new Worker(
    QUEUE_NAMES.notifications,
    async (job: Job) => {
      switch (job.name) {
        case JOB_NAMES.deliverNotification:
          return deliverNotification(job as Job<{ notificationId: string }>);
        case JOB_NAMES.sweepNotifications:
          return sweepNotifications();
        default:
          // An unknown job name means a producer and this worker disagree about
          // the contract. Log it rather than silently discarding work.
          log.warn({ jobName: job.name }, 'unhandled notification job');
          return undefined;
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY },
  );

  const webhookWorker = new Worker(
    QUEUE_NAMES.webhooks,
    async (job: Job) => {
      if (job.name === JOB_NAMES.deliverWebhook) {
        return deliverWebhook(job as Job<{ deliveryId: string }>);
      }
      log.warn({ jobName: job.name }, 'unhandled webhook job');
      return undefined;
    },
    { connection, concurrency: Math.max(2, Math.floor(env.WORKER_CONCURRENCY / 2)) },
  );

  const maintenanceWorker = new Worker(
    QUEUE_NAMES.maintenance,
    async (job: Job) => {
      switch (job.name) {
        case JOB_NAMES.expireWaitlistHolds:
          return expireWaitlistHolds();
        case JOB_NAMES.advanceInProgress:
          return advanceInProgress();
        case JOB_NAMES.purgeExpiredTokens:
          return purgeExpiredTokens();
        case JOB_NAMES.purgeIdempotencyKeys:
          return purgeIdempotencyKeys();
        case JOB_NAMES.sendOwnerDailyDigests:
          return sendOwnerDailyDigests();
        default:
          log.warn({ jobName: job.name }, 'unhandled maintenance job');
          return undefined;
      }
    },
    // Housekeeping is serialised: these tasks are cheap and running one at a
    // time keeps their database impact predictable.
    { connection, concurrency: 1 },
  );

  workers = [notificationWorker, webhookWorker, maintenanceWorker];

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      log.error(
        {
          err: error,
          queue: worker.name,
          jobId: job?.id,
          jobName: job?.name,
          attempts: job?.attemptsMade,
        },
        'job failed',
      );
    });
    worker.on('error', (error) => {
      log.error({ err: error, queue: worker.name }, 'worker error');
    });
  }

  await registerRepeatableJobs();

  log.info(
    { concurrency: env.WORKER_CONCURRENCY, standalone: options.standalone },
    'MeetFlow workers started',
  );
  return workers;
}

export async function stopWorkers(): Promise<void> {
  // close() waits for in-flight jobs to finish, so a deploy never kills a
  // half-sent email.
  await Promise.allSettled(workers.map((worker) => worker.close()));
  workers = [];
}

/** Entry point when this module is the process's main script. */
async function main(): Promise<void> {
  await assertDatabaseConnection();
  await startWorkers({ standalone: true });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'worker shutdown requested');
    try {
      await stopWorkers();
      await closeQueues();
      await closeSocketServer();
      await closeDatabase();
      await closeRedis();
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandled promise rejection in worker');
    void shutdown('unhandledRejection');
  });
}

// `require.main === module` is true only when node runs this file directly,
// so importing it from the API (RUN_WORKER_IN_API) does not start a second
// shutdown handler set.
if (require.main === module) {
  main().catch((error: unknown) => {
    log.fatal({ err: error }, 'failed to start MeetFlow worker');
    process.exit(1);
  });
}
