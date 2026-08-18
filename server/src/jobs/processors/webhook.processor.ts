/**
 * Outbound webhook delivery.
 *
 * Deliveries are signed with HMAC-SHA256 over `timestamp.body` so a receiver
 * can verify both authenticity and freshness (a captured payload cannot be
 * replayed later against a timestamp tolerance).
 *
 * Endpoints that keep failing are disabled automatically: one dead customer
 * server must not consume worker capacity indefinitely.
 *
 * Durability follows the notification outbox exactly: `fanOutEvent` writes its
 * `webhook_deliveries` rows inside the caller's transaction, so an event can
 * never outlive the change it announces, and the queue is only touched once
 * that transaction has committed. PostgreSQL is the record of what is owed; the
 * queue is only how it gets sent.
 */
import crypto from 'node:crypto';
import type { Job } from 'bullmq';
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import { WebhookDelivery, WebhookEndpoint } from '../../database/models';
import { WEBHOOK_WILDCARD_EVENT } from '../../database/models/WebhookEndpoint';
import { JOB_NAMES, safeEnqueue, webhookQueue } from '../queues';

const log = createLogger('webhook-worker');

/** Consecutive failures after which an endpoint is switched off. */
const FAILURE_THRESHOLD = 20;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CAPTURE = 2_000;

export function signPayload(secret: string, timestamp: number, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function deliverWebhook(job: Job<{ deliveryId: string }>): Promise<void> {
  const { deliveryId } = job.data;

  const [claimed] = await WebhookDelivery.update(
    { status: 'PROCESSING' },
    { where: { id: deliveryId, status: 'PENDING' } },
  );
  if (claimed === 0) return;

  const delivery = await WebhookDelivery.findByPk(deliveryId);
  if (!delivery) return;

  // Two queries rather than one `include`, and that is load-bearing: Sequelize
  // injects a model's defaultScope into an include, so a joined endpoint
  // arrives with `signingSecret` stripped and every delivery would then try to
  // sign with `undefined`. `withSecret` is the scope that restores the column
  // and this is the one caller entitled to ask for it. `paranoid: false` keeps
  // the soft-deleted case reachable, so its deliveries are cancelled rather
  // than retried for ever against a row nobody can see.
  const endpoint = await WebhookEndpoint.scope('withSecret').findByPk(delivery.endpointId, {
    paranoid: false,
  });
  if (!endpoint) {
    await delivery.update({ status: 'CANCELLED', error: 'Endpoint no longer exists.' });
    return;
  }
  if (!endpoint.isActive || endpoint.deletedAt !== null) {
    await delivery.update({ status: 'CANCELLED', error: 'Endpoint is disabled.' });
    return;
  }

  const attempt = delivery.attemptCount + 1;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: delivery.eventId,
    event: delivery.event,
    createdAt: delivery.createdAt,
    data: delivery.payload,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MeetFlow-Webhooks/1.0',
        'X-MeetFlow-Event': delivery.event,
        'X-MeetFlow-Delivery': delivery.eventId,
        'X-MeetFlow-Timestamp': String(timestamp),
        'X-MeetFlow-Signature': `v1=${signPayload(endpoint.signingSecret, timestamp, body)}`,
      },
      body,
      signal: controller.signal,
    });

    const text = (await response.text().catch(() => '')).slice(0, MAX_RESPONSE_CAPTURE);

    if (response.ok) {
      await delivery.update({
        status: 'DELIVERED',
        attemptCount: attempt,
        responseStatus: response.status,
        responseBody: text,
        deliveredAt: new Date(),
        error: null,
      });
      await endpoint.update({ failureCount: 0, lastSuccessAt: new Date() });
      log.info({ deliveryId, event: delivery.event, status: response.status }, 'webhook delivered');
      return;
    }

    throw new Error(`Endpoint responded ${response.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown delivery error';
    const exhausted = attempt >= delivery.maxAttempts;

    await delivery.update({
      status: exhausted ? 'FAILED' : 'PENDING',
      attemptCount: attempt,
      error: message.slice(0, 1000),
    });

    const failureCount = endpoint.failureCount + 1;
    const shouldDisable = failureCount >= FAILURE_THRESHOLD;
    await endpoint.update({
      failureCount,
      lastFailureAt: new Date(),
      isActive: shouldDisable ? false : endpoint.isActive,
      disabledAt: shouldDisable ? new Date() : endpoint.disabledAt,
    });

    if (shouldDisable) {
      log.warn(
        { endpointId: endpoint.id, failureCount },
        'webhook endpoint disabled after repeated failures',
      );
    }

    log.error({ err: error, deliveryId, attempt, exhausted }, 'webhook delivery failed');
    if (!exhausted) throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hands written deliveries to the queue.
 *
 * `safeEnqueue` never throws, and inside a transaction the hand-off waits for
 * the commit: a job that ran before its row was visible would find nothing and
 * report success, and a job enqueued for a transaction that later rolled back
 * would announce an event that never happened. Redis being down therefore
 * delays a delivery — it never loses one, and it never fails the booking that
 * produced it.
 */
export function scheduleDeliveries(deliveryIds: string[], transaction?: Transaction): void {
  if (deliveryIds.length === 0) return;

  const schedule = (): void => {
    for (const deliveryId of deliveryIds) {
      void safeEnqueue(
        webhookQueue,
        JOB_NAMES.deliverWebhook,
        { deliveryId },
        // jobId keyed on the row, so a second enqueue for the same delivery
        // collapses onto the first instead of sending twice.
        { jobId: `webhook:${deliveryId}` },
      );
    }
  };

  if (transaction) {
    transaction.afterCommit(schedule);
  } else {
    schedule();
  }
}

export interface FanOutOptions {
  /**
   * The transaction the source change is being made in. Passing it is what
   * makes the event atomic with the thing it announces.
   */
  transaction?: Transaction;
  /**
   * Shared by every endpoint for one occurrence, echoed to subscribers as `id`,
   * and half of the unique index that stops a retried producer double-notifying
   * anybody. Defaults to a fresh id per call.
   */
  eventId?: string;
}

/**
 * Writes one delivery per subscribed, active endpoint, and queues them.
 *
 * Cheap when nobody is listening — a single indexed lookup returning no rows —
 * which is what lets the booking path call it unconditionally.
 */
export async function fanOutEvent(
  businessId: string,
  event: string,
  payload: Record<string, unknown>,
  options: FanOutOptions = {},
): Promise<string[]> {
  const { transaction } = options;
  const eventId = options.eventId ?? crypto.randomUUID();

  const endpoints = await WebhookEndpoint.findAll({
    where: {
      businessId,
      isActive: true,
      deletedAt: { [Op.is]: null },
      [Op.or]: [
        { events: { [Op.contains]: [WEBHOOK_WILDCARD_EVENT] } },
        { events: { [Op.contains]: [event] } },
      ],
    },
    // Only the id is needed to address a delivery; the signing secret belongs
    // to the worker that signs, and the defaultScope excludes it in any case.
    attributes: ['id'],
    transaction,
  });

  const created: string[] = [];
  for (const endpoint of endpoints) {
    const values = {
      endpointId: endpoint.id,
      businessId,
      eventId,
      event,
      payload,
      responseStatus: null,
      responseBody: null,
      error: null,
      deliveredAt: null,
    };

    try {
      // The duplicate caught here is a producer replaying one event id, which
      // is a success from its point of view. Inside a caller's transaction the
      // INSERT must run in a SAVEPOINT: in PostgreSQL a failed statement aborts
      // the whole transaction, so catching the violation without one would turn
      // the caller's booking into a silent rollback.
      const delivery = transaction
        ? await sequelize.transaction({ transaction }, async (savepoint) =>
            WebhookDelivery.create(values, { transaction: savepoint }),
          )
        : await WebhookDelivery.create(values);
      created.push(delivery.id);
    } catch (error) {
      if (error instanceof Error && error.name === 'SequelizeUniqueConstraintError') continue;
      throw error;
    }
  }

  scheduleDeliveries(created, transaction);
  return created;
}
