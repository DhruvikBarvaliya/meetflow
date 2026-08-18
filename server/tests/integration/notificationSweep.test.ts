/**
 * Recovery of notifications stranded mid-claim, against real PostgreSQL.
 *
 * The outbox promises that a committed booking always produces a message. The
 * claim is the one step where that promise depends on a process staying alive:
 * `status = 'PROCESSING'` is written by the worker and by nothing else, so a
 * worker killed before it records an outcome leaves a row that no query in the
 * system was looking for. The delivery job cannot rescue it — a retry finds
 * `claimed === 0` and reports success — which is why the sweep has to.
 *
 * These tests pin both halves of that: the sweep takes back a claim old enough
 * to be dead, and refuses to touch one that could still be in flight.
 */
import type { Job } from 'bullmq';
import { QueryTypes } from 'sequelize';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sequelize } from '../../src/config/database';
import { Notification } from '../../src/database/models';
import {
  deliverNotification,
  sweepNotifications,
} from '../../src/jobs/processors/notification.processor';
import { enqueueNotification } from '../../src/modules/notifications/notification.service';
import {
  closeDatabaseConnection,
  createWorkspace,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

let fixture: WorkspaceFixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

/** One real outbox row, written through the service the application uses. */
async function queueMessage(): Promise<Notification> {
  const row = await enqueueNotification({
    businessId: fixture.business.id,
    type: 'BOOKING_CONFIRMATION',
    recipientType: 'CUSTOMER',
    recipientCustomerId: fixture.customer.id,
    recipientAddress: fixture.customer.email,
    payload: { customerName: 'Ada', businessName: 'Clinic', serviceName: 'Consultation' },
  });
  if (!row) throw new Error('fixture expected a notification row');
  return row;
}

/**
 * Reproduces a worker killed between the claim and its outcome.
 *
 * The write is exactly the worker's own claim — `SET status = 'PROCESSING'` —
 * with the clock wound back, since the one thing a test cannot do is wait out
 * the staleness threshold. Raw SQL because Sequelize manages `updated_at` and
 * would helpfully reset it to now, which is the very value under test.
 */
async function simulateDeadClaim(
  notificationId: string,
  claimedMinutesAgo: number,
  attemptCount = 0,
): Promise<void> {
  await sequelize.query(
    `UPDATE notifications
        SET status = 'PROCESSING',
            attempt_count = :attemptCount,
            updated_at = now() - (:minutes * interval '1 minute')
      WHERE id = :id`,
    {
      replacements: { id: notificationId, minutes: claimedMinutesAgo, attemptCount },
      type: QueryTypes.UPDATE,
    },
  );
}

/** The worker reads only `job.data`; this is the smallest honest stand-in. */
function deliveryJob(notificationId: string): Job<{ notificationId: string }> {
  return { data: { notificationId } } as unknown as Job<{ notificationId: string }>;
}

describe('notification sweep — orphaned claims', () => {
  it('returns a long-dead claim to PENDING and re-enqueues it in the same pass', async () => {
    const queued = await queueMessage();
    // Twenty minutes: past any plausible provider call, so the claiming worker
    // is dead rather than slow. Two attempts already spent.
    await simulateDeadClaim(queued.id, 20, 2);

    const reEnqueued = await sweepNotifications();

    // The count is the point: the row was not merely reset, it went back
    // through the sweep's due scan and out to the queue without waiting for
    // another interval.
    expect(reEnqueued).toBe(1);

    const reclaimed = await Notification.findByPk(queued.id);
    expect(reclaimed?.status).toBe('PENDING');
    // The row is claimable again by the worker's own definition of claimable.
    expect(reclaimed?.isDue).toBe(true);
    // The retry budget is untouched: the attempt never ran, and a SIGKILL from
    // a deploy must not spend one of the five tries meant for delivery failures.
    expect(reclaimed?.attemptCount).toBe(2);
    expect(reclaimed?.canRetry).toBe(true);
    // Recorded honestly, so support can tell this apart from a provider bounce.
    expect(reclaimed?.lastError).toMatch(/recovery sweep/i);
    expect(reclaimed?.sentAt).toBeNull();
  });

  it('delivers the reclaimed message, closing the loop the crash opened', async () => {
    const queued = await queueMessage();
    await simulateDeadClaim(queued.id, 20, 2);

    await sweepNotifications();
    await deliverNotification(deliveryJob(queued.id));

    const delivered = await Notification.findByPk(queued.id);
    expect(delivered?.status).toBe('SENT');
    expect(delivered?.sentAt).not.toBeNull();
    // The preserved count continues where the crash left it rather than restarting.
    expect(delivered?.attemptCount).toBe(3);
    expect(delivered?.lastError).toBeNull();
  });

  it('leaves a recent claim alone — a slow delivery is not a dead one', async () => {
    const queued = await queueMessage();
    // A minute in is well inside the SMTP transport's own timeouts; this worker
    // is very probably mid-send, and reclaiming it would send twice.
    await simulateDeadClaim(queued.id, 1, 0);

    const reEnqueued = await sweepNotifications();

    expect(reEnqueued).toBe(0);
    const untouched = await Notification.findByPk(queued.id);
    expect(untouched?.status).toBe('PROCESSING');
    expect(untouched?.lastError).toBeNull();
  });

  it('reclaims every dead claim it finds, not just the first', async () => {
    const first = await queueMessage();
    const second = await queueMessage();
    const live = await queueMessage();
    await simulateDeadClaim(first.id, 20);
    await simulateDeadClaim(second.id, 45);
    await simulateDeadClaim(live.id, 2);

    const reEnqueued = await sweepNotifications();

    expect(reEnqueued).toBe(2);
    expect((await Notification.findByPk(first.id))?.status).toBe('PENDING');
    expect((await Notification.findByPk(second.id))?.status).toBe('PENDING');
    expect((await Notification.findByPk(live.id))?.status).toBe('PROCESSING');
  });
});
