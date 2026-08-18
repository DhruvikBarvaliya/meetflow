/**
 * Background job infrastructure (BullMQ on Redis).
 *
 * MeetFlow never does slow or failure-prone work inside an HTTP request.
 * Email delivery, webhook fan-out, automation evaluation and periodic
 * housekeeping all run here, where they can retry with backoff.
 *
 * Durability model: Redis holds the *queue*, PostgreSQL holds the *intent*.
 * Every notification and webhook has a row before a job exists, and periodic
 * sweeps re-enqueue anything whose job was lost. Losing Redis therefore delays
 * delivery; it never loses it.
 */
import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { createRedisConnection } from '../config/redis';

const log = createLogger('queues');

export const QUEUE_NAMES = {
  notifications: 'meetflow.notifications',
  webhooks: 'meetflow.webhooks',
  automations: 'meetflow.automations',
  maintenance: 'meetflow.maintenance',
} as const;

export const JOB_NAMES = {
  deliverNotification: 'notification.deliver',
  sweepNotifications: 'notification.sweep',
  deliverWebhook: 'webhook.deliver',
  expireWaitlistHolds: 'maintenance.expire_waitlist_holds',
  purgeExpiredTokens: 'maintenance.purge_expired_tokens',
  purgeIdempotencyKeys: 'maintenance.purge_idempotency_keys',
  advanceInProgress: 'maintenance.advance_in_progress',
  sendOwnerDailyDigests: 'maintenance.owner_daily_digest',
} as const;

/**
 * Retry policy shared by delivery jobs.
 *
 * Exponential backoff from 5s: a provider blip resolves on attempt two, while a
 * sustained outage backs off to minutes instead of hammering a dead endpoint.
 * Completed jobs are trimmed aggressively because PostgreSQL, not Redis, is the
 * record of what happened.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400 * 7 },
};

const connection = createRedisConnection('bullmq-producer');

function makeQueue(name: string): Queue {
  const queue = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  queue.on('error', (error) => log.error({ err: error, queue: name }, 'queue error'));
  return queue;
}

export const notificationQueue = makeQueue(QUEUE_NAMES.notifications);
export const webhookQueue = makeQueue(QUEUE_NAMES.webhooks);
export const maintenanceQueue = makeQueue(QUEUE_NAMES.maintenance);

export const allQueues = [notificationQueue, webhookQueue, maintenanceQueue];

/**
 * Enqueues without ever failing the caller.
 *
 * The database row is the source of truth and a periodic sweep will pick up
 * anything that failed to enqueue, so a Redis hiccup must not turn a successful
 * booking into an error for the customer.
 */
export async function safeEnqueue(
  queue: Queue,
  jobName: string,
  data: Record<string, unknown>,
  options: JobsOptions = {},
): Promise<boolean> {
  try {
    await queue.add(jobName, data, options);
    return true;
  } catch (error) {
    log.error(
      { err: error, queue: queue.name, jobName, data },
      'failed to enqueue job — the periodic sweep will retry',
    );
    return false;
  }
}

/**
 * Registers the repeatable jobs.
 *
 * `jobId` is fixed per schedule so restarting a worker replaces the existing
 * repeatable entry instead of accumulating duplicates.
 */
export async function registerRepeatableJobs(): Promise<void> {
  const every = env.REMINDER_SWEEP_INTERVAL_SECONDS * 1000;

  await notificationQueue.add(
    JOB_NAMES.sweepNotifications,
    {},
    { repeat: { every }, jobId: 'repeat:notification-sweep', removeOnComplete: true },
  );

  const maintenanceSchedules: Array<[string, number]> = [
    [JOB_NAMES.expireWaitlistHolds, 60_000],
    [JOB_NAMES.advanceInProgress, 60_000],
    [JOB_NAMES.purgeExpiredTokens, 3_600_000],
    [JOB_NAMES.purgeIdempotencyKeys, 3_600_000],
    // Hourly, not daily: "morning" is a local hour and every workspace keeps
    // its own, so the job wakes up each hour and asks which of them are in it.
    // BullMQ aligns an `every` repeat to the epoch, so this lands once per hour
    // and each workspace's digest hour is entered exactly once a day.
    [JOB_NAMES.sendOwnerDailyDigests, 3_600_000],
  ];

  for (const [jobName, interval] of maintenanceSchedules) {
    await maintenanceQueue.add(
      jobName,
      {},
      { repeat: { every: interval }, jobId: `repeat:${jobName}`, removeOnComplete: true },
    );
  }

  log.info('repeatable jobs registered');
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled(allQueues.map((queue) => queue.close()));
  await connection.quit().catch(() => connection.disconnect());
}
