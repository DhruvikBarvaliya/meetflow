/**
 * Notification delivery.
 *
 * Claims a pending notification with a conditional UPDATE, delivers it through
 * the configured provider, and records the outcome. The claim is what makes
 * this safe to run on many workers at once: exactly one of them wins the
 * transition PENDING -> PROCESSING, and the others simply find nothing to do.
 *
 * A claim, though, is a promise the claiming process may not live to keep. This
 * file therefore also owns the other half: the sweep un-claims rows whose worker
 * died between the claim and its outcome, because nothing else in the system
 * ever will — not the delivery job, which finds `claimed === 0` and reports
 * success, and not BullMQ, which considers a job that returned successfully to
 * be done.
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
 * How long a claim may go unresolved before the sweep declares the claiming
 * worker dead and takes the row back.
 *
 * Every path out of PROCESSING — SENT, FAILED, CANCELLED, or back to PENDING —
 * is a single UPDATE at the end of one delivery attempt, so the wall-clock cost
 * of a *live* claim is bounded by the provider call: the SMTP transport gives
 * up after 10s to connect, 10s for the greeting and 20s on the socket, well
 * under a minute even when everything times out in sequence. Ten minutes is an
 * order of magnitude above that ceiling, which is what makes the reclaim safe:
 * a row past it is not slow, it is orphaned, and no in-flight delivery can be
 * overtaken by the requeue.
 *
 * Raising it costs stranded time; lowering it towards the provider timeouts
 * starts risking a duplicate send against a worker that was merely slow.
 */
const STALE_CLAIM_MS = 10 * 60_000;

/** Recorded on a reclaimed row so support can tell this apart from a bounce. */
const STALE_CLAIM_ERROR =
  'Delivery worker stopped responding after claiming this message; requeued by the recovery sweep.';

/**
 * Drops the delivery job left behind by a dead claim.
 *
 * Re-enqueueing on its own is not enough. Jobs are keyed `notification:<id>`,
 * and BullMQ treats an `add` for an id it already holds as a no-op — including
 * an id sitting in the completed set because its stalled-job retry ran, found
 * `claimed === 0` and returned successfully, or in the failed set where it is
 * kept for a week. Either would swallow the requeue and leave the row PENDING
 * but undeliverable. Removing the corpse first frees the key.
 *
 * `remove` reports 0 for a locked job rather than throwing, which is exactly
 * the behaviour wanted if a worker somehow is still alive on it: it keeps its
 * job, and the duplicate `add` is suppressed as usual.
 */
async function dropStaleDeliveryJob(notificationId: string): Promise<void> {
  try {
    await notificationQueue.remove(`notification:${notificationId}`);
  } catch (error) {
    // Redis being unavailable must not abort the database-side reclaim: the row
    // is the commitment, and the next sweep will try the queue again.
    log.warn({ err: error, notificationId }, 'could not drop the stale delivery job');
  }
}

/**
 * Returns orphaned claims to PENDING.
 *
 * The claim is the only writer of PROCESSING, so a worker killed between the
 * claim and its outcome leaves a row no one will ever look at again: the sweep
 * used to filter on PENDING, and BullMQ's stalled-job retry re-runs the job
 * only to find `claimed === 0` and report success. The message was silently
 * lost, and every counter said the system was healthy.
 *
 * `updated_at` is the claim timestamp. Nothing else writes to a row while it is
 * PROCESSING — every other transition also changes the status, and so ends the
 * window — which makes "PROCESSING and untouched since" a precise statement
 * about how long this claim has been outstanding.
 *
 * `attemptCount` is deliberately left alone. The attempt never completed, and
 * spending a retry on a SIGKILL from a deploy would shorten the budget for the
 * delivery failures it is actually meant to bound. The existing backoff still
 * bounds the row once a real attempt runs.
 */
async function reclaimStaleClaims(): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

  // Conditional UPDATE, mirroring the claim it undoes: a worker that resolves
  // its claim between this statement being planned and applied has already left
  // PROCESSING, so it matches nothing and cannot be trampled.
  const [reclaimed, rows] = await Notification.update(
    { status: 'PENDING', lastError: STALE_CLAIM_ERROR },
    {
      where: { status: 'PROCESSING', updatedAt: { [Op.lt]: staleBefore } },
      returning: true,
    },
  );

  if (reclaimed === 0) return 0;

  for (const row of rows) {
    await dropStaleDeliveryJob(row.id);
  }

  // Warn, not info: a healthy deployment strands nothing, so a steady trickle
  // here means workers are dying — or that one message keeps killing them,
  // which preserving `attemptCount` cannot bound on its own.
  log.warn(
    { count: reclaimed, staleAfterMs: STALE_CLAIM_MS },
    'reclaimed notifications stuck in PROCESSING — a delivery worker died mid-claim',
  );
  return reclaimed;
}

/**
 * Re-enqueues due notifications whose delivery job was never created, was lost
 * — for example because Redis was unavailable at the moment of booking — or
 * died along with the worker that had claimed it.
 *
 * This is what lets the outbox survive a queue outage: the database row is the
 * commitment, the job is only an optimisation.
 */
export async function sweepNotifications(): Promise<number> {
  // Reclaim first so rows rescued on this pass are picked up by the scan below
  // rather than waiting out another sweep interval.
  await reclaimStaleClaims();

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
