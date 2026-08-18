/**
 * Outbound webhook delivery.
 *
 * Deliveries are signed with HMAC-SHA256 over `timestamp.body` so a receiver
 * can verify both authenticity and freshness (a captured payload cannot be
 * replayed later against a timestamp tolerance).
 *
 * Endpoints that keep failing are disabled automatically: one dead customer
 * server must not consume worker capacity indefinitely.
 */
import crypto from 'node:crypto';
import type { Job } from 'bullmq';
import { Op } from 'sequelize';
import { createLogger } from '../../config/logger';
import { WebhookDelivery, WebhookEndpoint } from '../../database/models';

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

  const delivery = await WebhookDelivery.findByPk(deliveryId, {
    include: [{ model: WebhookEndpoint, as: 'endpoint', required: true }],
  });
  if (!delivery) return;

  const endpoint = delivery.get('endpoint') as WebhookEndpoint;
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
 * Queues one delivery per subscribed, active endpoint.
 *
 * The unique index on (endpoint_id, event_id) means a producer that retries
 * cannot double-notify a subscriber.
 */
export async function fanOutEvent(
  businessId: string,
  event: string,
  payload: Record<string, unknown>,
  eventId: string,
): Promise<string[]> {
  const endpoints = await WebhookEndpoint.findAll({
    where: {
      businessId,
      isActive: true,
      deletedAt: { [Op.is]: null },
      [Op.or]: [{ events: { [Op.contains]: ['*'] } }, { events: { [Op.contains]: [event] } }],
    },
  });

  const created: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const delivery = await WebhookDelivery.create({
        endpointId: endpoint.id,
        businessId,
        eventId,
        event,
        payload,
        responseStatus: null,
        responseBody: null,
        error: null,
        deliveredAt: null,
      });
      created.push(delivery.id);
    } catch (error) {
      if (error instanceof Error && error.name === 'SequelizeUniqueConstraintError') continue;
      throw error;
    }
  }
  return created;
}
