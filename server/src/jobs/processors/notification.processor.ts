/**
 * Notification delivery.
 *
 * Claims a pending notification with a conditional UPDATE, delivers it through
 * the configured provider, and records the outcome. The claim is what makes
 * this safe to run on many workers at once: exactly one of them wins the
 * transition PENDING -> PROCESSING, and the others simply find nothing to do.
 */
import type { Job } from 'bullmq';
import { Op } from 'sequelize';
import { createLogger } from '../../config/logger';
import { Notification } from '../../database/models';
import { getEmailProvider } from '../../integrations/email/emailProvider';
import { buildHtmlBody } from '../../modules/notifications/notification.service';
import { JOB_NAMES, notificationQueue, safeEnqueue } from '../queues';

const log = createLogger('notification-worker');

/** How many overdue notifications one sweep will re-enqueue. */
const SWEEP_BATCH = 200;

export async function deliverNotification(job: Job<{ notificationId: string }>): Promise<void> {
  const { notificationId } = job.data;

  // Atomic claim. `status = 'PENDING'` in the WHERE clause means a second
  // worker (or a retry racing the sweep) updates zero rows and exits.
  const [claimed] = await Notification.update(
    { status: 'PROCESSING' },
    { where: { id: notificationId, status: 'PENDING' } },
  );

  if (claimed === 0) {
    log.debug({ notificationId }, 'notification already claimed or no longer pending');
    return;
  }

  const notification = await Notification.findByPk(notificationId);
  if (!notification) {
    log.warn({ notificationId }, 'claimed notification disappeared');
    return;
  }

  const attempt = notification.attemptCount + 1;

  try {
    if (notification.channel !== 'EMAIL') {
      // SMS and in-app channels have no provider configured yet. The row is
      // closed out honestly as CANCELLED rather than reported as delivered.
      await notification.update({
        status: 'CANCELLED',
        attemptCount: attempt,
        lastError: `No provider is configured for the ${notification.channel} channel.`,
      });
      return;
    }

    const result = await getEmailProvider().send({
      to: notification.recipientAddress,
      subject: notification.subject ?? 'MeetFlow',
      text: notification.body ?? '',
      html: buildHtmlBody(notification.body ?? '', notification.payload),
      referenceId: notification.id,
    });

    await notification.update({
      status: 'SENT',
      sentAt: new Date(),
      attemptCount: attempt,
      providerMessageId: result.messageId,
      lastError: null,
    });

    log.info(
      { notificationId, type: notification.type, provider: result.provider },
      'notification delivered',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown delivery error';
    const exhausted = attempt >= notification.maxAttempts;

    await notification.update({
      // Back to PENDING while retries remain, so both BullMQ's retry and the
      // sweep can pick it up again; FAILED once the budget is spent.
      status: exhausted ? 'FAILED' : 'PENDING',
      attemptCount: attempt,
      lastError: message.slice(0, 1000),
      failedAt: exhausted ? new Date() : null,
    });

    log.error({ err: error, notificationId, attempt, exhausted }, 'notification delivery failed');

    // Rethrow while retries remain so BullMQ applies its backoff schedule.
    if (!exhausted) throw error;
  }
}

/**
 * Re-enqueues due notifications whose delivery job was never created or was
 * lost — for example because Redis was unavailable at the moment of booking.
 *
 * This is what lets the outbox survive a queue outage: the database row is the
 * commitment, the job is only an optimisation.
 */
export async function sweepNotifications(): Promise<number> {
  const due = await Notification.findAll({
    where: { status: 'PENDING', scheduledFor: { [Op.lte]: new Date() } },
    order: [['scheduledFor', 'ASC']],
    limit: SWEEP_BATCH,
    attributes: ['id'],
  });

  for (const notification of due) {
    await safeEnqueue(
      notificationQueue,
      JOB_NAMES.deliverNotification,
      { notificationId: notification.id },
      { jobId: `notification:${notification.id}` },
    );
  }

  if (due.length > 0) {
    log.info({ count: due.length }, 'sweep re-enqueued due notifications');
  }
  // A full batch means there is very likely more waiting; the caller logs it so
  // a persistent backlog is visible rather than silently trickling.
  if (due.length === SWEEP_BATCH) {
    log.warn({ batch: SWEEP_BATCH }, 'notification sweep hit its batch limit — backlog present');
  }
  return due.length;
}
