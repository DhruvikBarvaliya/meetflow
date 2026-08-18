/**
 * Outbound webhooks, end to end against real PostgreSQL and a real HTTP
 * receiver.
 *
 * The subsystem shipped as a worker, a queue, two tables and an HMAC signer
 * with no way to register an endpoint and nothing calling the fan-out, so the
 * assertions here are deliberately about the whole chain rather than about any
 * one function: a booking that commits produces a delivery row for the right
 * endpoints, that row leaves the process as a signed request a receiver can
 * verify with the secret it was given, and a booking that never commits
 * produces nothing at all.
 *
 * Two things are checked the hard way rather than by trusting the code:
 *
 *  - **The signature.** It is recomputed here from `node:crypto` against the
 *    scheme in docs/SecurityThreatModel.md, not by calling `signPayload`. A
 *    test that used the implementation to check the implementation would keep
 *    passing if both drifted, and the whole value of a signature is that a
 *    receiver we do not control can reproduce it.
 *  - **The secret.** Asserted absent by searching the serialised response for
 *    the value itself, so an endpoint that leaked it under a different key name
 *    would still fail.
 *
 * The router is mounted onto `managementRouter` by this file because
 * `routes/index.ts` is owned elsewhere. Mounting it twice is harmless — the
 * first matching layer answers — so this keeps working unchanged once the
 * wiring lands.
 */
import crypto from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { sequelize } from '../../src/config/database';
import { Appointment, BusinessSettings } from '../../src/database/models';
import { WebhookDelivery, WebhookEndpoint } from '../../src/database/models';
import { deliverWebhook } from '../../src/jobs/processors/webhook.processor';
import { createBooking } from '../../src/modules/appointments/booking.service';
import {
  cancelAppointment,
  completeAppointment,
  markNoShow,
  rescheduleAppointment,
} from '../../src/modules/appointments/lifecycle.service';
import { login } from '../../src/modules/auth/auth.service';
import { publishAppointmentWebhook } from '../../src/modules/webhooks/webhooks.service';
import { WebhookEvents } from '../../src/modules/webhooks/webhooks.validation';
import { webhooksRouter } from '../../src/modules/webhooks/webhooks.routes';
import { managementRouter } from '../../src/routes';
import { SlotUnavailableError } from '../../src/utils/errors';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

managementRouter.use('/webhooks', webhooksRouter);
const app = createApp();

const metadata = { requestId: 'webhooks-test', ipAddress: null, userAgent: null };
const actor = { type: 'OWNER' as const, label: 'owner@meetflow.test' };

/** One workspace plus a signed-in owner for it. */
interface Session {
  fixture: WorkspaceFixture;
  token: string;
}

interface CapturedRequest {
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let owner: Session;
let receiver: Server;
let receiverOrigin: string;
/** Status the stand-in subscriber answers with, so a test can make it fail. */
let receiverStatus = 200;
let received: CapturedRequest[] = [];

async function signIn(fixture: WorkspaceFixture): Promise<Session> {
  const result = await login(fixture.user.email, TEST_PASSWORD, metadata);
  return { fixture, token: result.accessToken };
}

/** The worker reads only `job.data`; this is the smallest honest stand-in. */
function deliveryJob(deliveryId: string): Job<{ deliveryId: string }> {
  return { data: { deliveryId } } as unknown as Job<{ deliveryId: string }>;
}

function api(session: Session, path: string): request.Test {
  return request(app).get(path).set('Authorization', `Bearer ${session.token}`);
}

async function registerEndpoint(
  session: Session,
  body: Record<string, unknown>,
): Promise<{ id: string; signingSecret: string }> {
  const response = await request(app)
    .post('/api/v1/webhooks')
    .set('Authorization', `Bearer ${session.token}`)
    .set('X-Business-Id', session.fixture.business.id)
    .send(body)
    .expect(201);

  return {
    id: response.body.data.id as string,
    signingSecret: response.body.data.signingSecret as string,
  };
}

async function book(session: Session, startsAt: Date, email = 'hooked@meetflow.test') {
  return createBooking({
    businessId: session.fixture.business.id,
    serviceId: session.fixture.service.id,
    staffProfileId: session.fixture.staffProfile.id,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: { firstName: 'Web', lastName: 'Hook', email },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: email },
  });
}

async function deliveriesFor(businessId: string, event?: string): Promise<WebhookDelivery[]> {
  return WebhookDelivery.findAll({
    where: { businessId, ...(event ? { event } : {}) },
    order: [['createdAt', 'ASC']],
  });
}

beforeAll(async () => {
  receiver = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(receiverStatus, { 'Content-Type': 'text/plain' });
      res.end(receiverStatus === 200 ? 'ok' : 'nope');
    });
  });

  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address() as AddressInfo;
  receiverOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await closeDatabaseConnection();
});

beforeEach(async () => {
  // webhook_endpoints and webhook_deliveries both carry a foreign key to
  // businesses, so the fixture's TRUNCATE ... CASCADE clears them with it.
  await resetDatabase();
  owner = await signIn(await createWorkspace());
  received = [];
  receiverStatus = 200;
});

afterEach(() => {
  receiverStatus = 200;
});

describe('registering an endpoint', () => {
  it('returns the signing secret once and never again', async () => {
    const created = await registerEndpoint(owner, {
      url: `${receiverOrigin}/hooks/crm`,
      description: 'CRM sync',
      events: ['appointment.created'],
    });

    expect(created.signingSecret).toMatch(/^whsec_/);

    // The secret is stored — the delivery worker has to be able to sign with
    // it — but it is not readable through any API the tenant can reach.
    const stored = await WebhookEndpoint.scope('withSecret').findByPk(created.id);
    expect(stored?.signingSecret).toBe(created.signingSecret);

    const detail = await api(owner, `/api/v1/webhooks/${created.id}`).expect(200);
    const list = await api(owner, '/api/v1/webhooks').expect(200);

    // Searched for by value rather than by key: an endpoint that echoed the
    // secret under some other name would still be caught.
    expect(JSON.stringify(detail.body)).not.toContain(created.signingSecret);
    expect(JSON.stringify(list.body)).not.toContain(created.signingSecret);
    expect(detail.body.data).not.toHaveProperty('signingSecret');
    expect(detail.body.data.url).toBe(`${receiverOrigin}/hooks/crm`);
    expect(list.body.meta.totalItems).toBe(1);
  });

  it('refuses a workspace id in the body', async () => {
    // The tenant comes from the membership; accepting one here would be an
    // authorisation hole with a validation schema in front of it.
    await request(app)
      .post('/api/v1/webhooks')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Business-Id', owner.fixture.business.id)
      .send({ url: `${receiverOrigin}/hooks`, businessId: owner.fixture.business.id })
      .expect(422);
  });

  it('refuses credentials in the delivery URL', async () => {
    await request(app)
      .post('/api/v1/webhooks')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Business-Id', owner.fixture.business.id)
      .send({ url: 'https://user:secret@example.test/hooks' })
      .expect(422);
  });

  it('updates the subscription list and re-arms a disabled endpoint', async () => {
    const created = await registerEndpoint(owner, { url: `${receiverOrigin}/hooks` });

    // An endpoint the worker gave up on: disabled with failures against it.
    await WebhookEndpoint.update(
      { isActive: false, failureCount: 20, disabledAt: new Date() },
      { where: { id: created.id } },
    );

    const response = await request(app)
      .patch(`/api/v1/webhooks/${created.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('X-Business-Id', owner.fixture.business.id)
      .send({ isActive: true, events: ['appointment.cancelled'] })
      .expect(200);

    expect(response.body.data.events).toEqual(['appointment.cancelled']);
    expect(response.body.data.isActive).toBe(true);
    // Re-enabling without clearing the counter would let the next single
    // failure switch the endpoint straight back off.
    expect(response.body.data.failureCount).toBe(0);
    expect(response.body.data.disabledAt).toBeNull();
  });
});

describe('cross-tenant isolation', () => {
  it("answers 404 — not 403 — for another workspace's endpoint", async () => {
    const created = await registerEndpoint(owner, { url: `${receiverOrigin}/hooks` });
    const rival = await signIn(await createWorkspace());

    // A 403 would confirm the id exists, turning every route below into an
    // existence oracle for another tenant's integrations.
    await api(rival, `/api/v1/webhooks/${created.id}`).expect(404);
    await api(rival, `/api/v1/webhooks/${created.id}/deliveries`).expect(404);
    await request(app)
      .patch(`/api/v1/webhooks/${created.id}`)
      .set('Authorization', `Bearer ${rival.token}`)
      .send({ isActive: false })
      .expect(404);
    await request(app)
      .post(`/api/v1/webhooks/${created.id}/test`)
      .set('Authorization', `Bearer ${rival.token}`)
      .expect(404);
    await request(app)
      .delete(`/api/v1/webhooks/${created.id}`)
      .set('Authorization', `Bearer ${rival.token}`)
      .expect(404);

    // And the endpoint is untouched by any of it.
    expect(await WebhookEndpoint.findByPk(created.id)).not.toBeNull();
  });

  it("never fans an event out to another workspace's endpoints", async () => {
    const rival = await signIn(await createWorkspace());
    await registerEndpoint(rival, { url: `${receiverOrigin}/rival` });

    await book(owner, nextWeekdayAt(10));

    expect(await deliveriesFor(rival.fixture.business.id)).toHaveLength(0);
  });
});

describe('fan-out from the booking lifecycle', () => {
  it('writes a delivery for a subscribed endpoint and nothing for the others', async () => {
    const subscribed = await registerEndpoint(owner, {
      url: `${receiverOrigin}/subscribed`,
      events: ['appointment.created'],
    });
    const wildcard = await registerEndpoint(owner, {
      url: `${receiverOrigin}/wildcard`,
      events: ['*'],
    });
    const unsubscribed = await registerEndpoint(owner, {
      url: `${receiverOrigin}/unsubscribed`,
      events: ['appointment.cancelled'],
    });
    const inactive = await registerEndpoint(owner, {
      url: `${receiverOrigin}/inactive`,
      events: ['*'],
      isActive: false,
    });

    const { appointment } = await book(owner, nextWeekdayAt(10));

    const deliveries = await deliveriesFor(owner.fixture.business.id);
    const notified = deliveries.map((row) => row.endpointId).sort();
    expect(notified).toEqual([subscribed.id, wildcard.id].sort());
    expect(notified).not.toContain(unsubscribed.id);
    expect(notified).not.toContain(inactive.id);

    // One occurrence, one event id, however many subscribers hear about it —
    // which is what lets a consumer dedupe across endpoints.
    expect(new Set(deliveries.map((row) => row.eventId)).size).toBe(1);

    const payload = deliveries[0]!.payload as { appointmentId?: string; publicId?: string };
    expect(deliveries[0]!.event).toBe('appointment.created');
    expect(deliveries[0]!.status).toBe('PENDING');
    expect(payload.appointmentId).toBe(appointment.id);
    expect(payload.publicId).toBe(appointment.publicId);
    // Contact details are deliberately not in the body: a mis-typed URL should
    // leak opaque identifiers rather than a customer's identity.
    expect(JSON.stringify(deliveries[0]!.payload)).not.toContain('hooked@meetflow.test');
  });

  it('announces the rest of the lifecycle', async () => {
    await registerEndpoint(owner, { url: `${receiverOrigin}/all`, events: ['*'] });

    const first = await book(owner, nextWeekdayAt(10));
    await rescheduleAppointment({
      businessId: owner.fixture.business.id,
      appointmentId: first.appointment.id,
      newStartsAt: nextWeekdayAt(11),
      actor,
    });
    await cancelAppointment({
      businessId: owner.fixture.business.id,
      appointmentId: first.appointment.id,
      reason: 'Customer request',
      actor,
    });

    const second = await book(owner, nextWeekdayAt(13), 'second@meetflow.test');
    await completeAppointment({
      businessId: owner.fixture.business.id,
      appointmentId: second.appointment.id,
      actor,
    });

    const third = await book(owner, nextWeekdayAt(15), 'third@meetflow.test');
    // Wind the appointment into the past so the grace period has elapsed. The
    // buffer columns move with it: `appointments_buffer_check` requires them to
    // bracket the appointment window.
    const past = new Date(Date.now() - 60 * 60_000);
    const pastEnd = new Date(past.getTime() + 30 * 60_000);
    await Appointment.update(
      { startsAt: past, endsAt: pastEnd, bufferStartAt: past, bufferEndAt: pastEnd },
      { where: { id: third.appointment.id } },
    );
    await BusinessSettings.update(
      { noShowGraceMinutes: 0 },
      { where: { businessId: owner.fixture.business.id } },
    );
    await markNoShow({
      businessId: owner.fixture.business.id,
      appointmentId: third.appointment.id,
      actor,
    });

    const events = (await deliveriesFor(owner.fixture.business.id)).map((row) => row.event);
    expect(events).toEqual([
      'appointment.created',
      'appointment.rescheduled',
      'appointment.cancelled',
      'appointment.created',
      'appointment.completed',
      'appointment.created',
      'appointment.no_show',
    ]);

    const [moved] = await deliveriesFor(owner.fixture.business.id, 'appointment.rescheduled');
    const payload = moved!.payload as { previousStartsAt?: string; startsAt?: string };
    // A subscriber's own calendar needs to know which entry to replace.
    expect(payload.previousStartsAt).toBe(nextWeekdayAt(10).toISOString());
    expect(payload.startsAt).toBe(nextWeekdayAt(11).toISOString());
  });

  it('fires nothing for a booking that never commits', async () => {
    await registerEndpoint(owner, { url: `${receiverOrigin}/all`, events: ['*'] });

    const slot = nextWeekdayAt(10);
    await book(owner, slot);
    expect(await deliveriesFor(owner.fixture.business.id)).toHaveLength(1);

    // The same slot again: the exclusion constraint refuses it and the whole
    // transaction is discarded.
    await expect(book(owner, slot, 'loser@meetflow.test')).rejects.toThrow();

    expect(await deliveriesFor(owner.fixture.business.id)).toHaveLength(1);
  });

  it('discards the delivery rows when the transaction that wrote them rolls back', async () => {
    await registerEndpoint(owner, { url: `${receiverOrigin}/all`, events: ['*'] });
    const { appointment } = await book(owner, nextWeekdayAt(10));
    await WebhookDelivery.destroy({ where: { businessId: owner.fixture.business.id } });

    // The rollback is injected rather than provoked because the only statements
    // left in the booking transaction after the fan-out are idempotency
    // bookkeeping — provoking a failure there would mean mocking Sequelize
    // instead of exercising the rule. What is under test is the rule itself:
    // the rows exist inside the transaction and do not survive it.
    await expect(
      sequelize.transaction(async (transaction) => {
        await publishAppointmentWebhook(WebhookEvents.APPOINTMENT_CREATED, appointment, {
          transaction,
        });

        const insideCount = await WebhookDelivery.count({
          where: { businessId: owner.fixture.business.id },
          transaction,
        });
        expect(insideCount).toBe(1);

        throw new SlotUnavailableError('the slot went while we were writing');
      }),
    ).rejects.toThrow();

    expect(await deliveriesFor(owner.fixture.business.id)).toHaveLength(0);
  });
});

describe('signed delivery', () => {
  it('signs the body so a receiver can verify it with the secret it was given', async () => {
    const endpoint = await registerEndpoint(owner, {
      url: `${receiverOrigin}/hooks/verified`,
      events: ['appointment.created'],
    });
    const { appointment } = await book(owner, nextWeekdayAt(10));

    const [delivery] = await deliveriesFor(owner.fixture.business.id);
    await deliverWebhook(deliveryJob(delivery!.id));

    expect(received).toHaveLength(1);
    const call = received[0]!;
    expect(call.url).toBe('/hooks/verified');
    expect(call.headers['x-meetflow-event']).toBe('appointment.created');
    expect(call.headers['x-meetflow-delivery']).toBe(delivery!.eventId);

    // The documented scheme, recomputed from first principles rather than by
    // calling the signer: HMAC-SHA256 over `${timestamp}.${body}`, hex, with a
    // `v1=` prefix. A receiver that reads only the docs must be able to do this.
    const timestamp = call.headers['x-meetflow-timestamp'] as string;
    const expected = crypto
      .createHmac('sha256', endpoint.signingSecret)
      .update(`${timestamp}.${call.body}`)
      .digest('hex');
    expect(call.headers['x-meetflow-signature']).toBe(`v1=${expected}`);

    // The timestamp is inside the signed material, so a captured payload cannot
    // be replayed later against a receiver's freshness window.
    expect(Number(timestamp)).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);

    const body = JSON.parse(call.body) as {
      id: string;
      event: string;
      data: { appointmentId: string };
    };
    expect(body.id).toBe(delivery!.eventId);
    expect(body.event).toBe('appointment.created');
    expect(body.data.appointmentId).toBe(appointment.id);

    const settled = await WebhookDelivery.findByPk(delivery!.id);
    expect(settled?.status).toBe('DELIVERED');
    expect(settled?.responseStatus).toBe(200);
    expect(settled?.attemptCount).toBe(1);
    expect(settled?.deliveredAt).not.toBeNull();

    const healthy = await WebhookEndpoint.findByPk(endpoint.id);
    expect(healthy?.failureCount).toBe(0);
    expect(healthy?.lastSuccessAt).not.toBeNull();
  });

  it('records a refusal and leaves the delivery due for another attempt', async () => {
    const endpoint = await registerEndpoint(owner, {
      url: `${receiverOrigin}/hooks/broken`,
      events: ['*'],
    });
    await book(owner, nextWeekdayAt(10));

    receiverStatus = 500;
    const [delivery] = await deliveriesFor(owner.fixture.business.id);

    // The job is rethrown so BullMQ retries it with backoff; the row it
    // describes must be left in a state that expects that retry.
    await expect(deliverWebhook(deliveryJob(delivery!.id))).rejects.toThrow();

    const attempted = await WebhookDelivery.findByPk(delivery!.id);
    expect(attempted?.status).toBe('PENDING');
    expect(attempted?.attemptCount).toBe(1);
    expect(attempted?.error).toContain('500');
    expect(attempted?.deliveredAt).toBeNull();

    const failing = await WebhookEndpoint.findByPk(endpoint.id);
    expect(failing?.failureCount).toBe(1);
    expect(failing?.lastFailureAt).not.toBeNull();
  });

  it('sends nothing to an endpoint that was switched off after the event', async () => {
    const endpoint = await registerEndpoint(owner, {
      url: `${receiverOrigin}/hooks/late`,
      events: ['*'],
    });
    await book(owner, nextWeekdayAt(10));

    await request(app)
      .delete(`/api/v1/webhooks/${endpoint.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    const [delivery] = await deliveriesFor(owner.fixture.business.id);
    await deliverWebhook(deliveryJob(delivery!.id));

    expect(received).toHaveLength(0);
    // Cancelled rather than deleted: the history says what happened to it.
    const cancelled = await WebhookDelivery.findByPk(delivery!.id);
    expect(cancelled?.status).toBe('CANCELLED');
  });
});

describe('delivery history', () => {
  it('reports each attempt and its status, newest first', async () => {
    const endpoint = await registerEndpoint(owner, {
      url: `${receiverOrigin}/hooks/history`,
      events: ['*'],
    });

    await book(owner, nextWeekdayAt(10));
    const [created] = await deliveriesFor(owner.fixture.business.id);
    await deliverWebhook(deliveryJob(created!.id));

    const response = await api(owner, `/api/v1/webhooks/${endpoint.id}/deliveries`).expect(200);
    expect(response.body.meta.totalItems).toBe(1);
    expect(response.body.data[0].status).toBe('DELIVERED');
    expect(response.body.data[0].responseStatus).toBe(200);
    expect(response.body.data[0].event).toBe('appointment.created');

    const filtered = await api(
      owner,
      `/api/v1/webhooks/${endpoint.id}/deliveries?status=FAILED`,
    ).expect(200);
    expect(filtered.body.meta.totalItems).toBe(0);

    const detail = await api(owner, `/api/v1/webhooks/${endpoint.id}`).expect(200);
    expect(detail.body.data.recentDeliveries).toHaveLength(1);
  });

  it('sends a signed test event on request', async () => {
    const endpoint = await registerEndpoint(owner, {
      url: `${receiverOrigin}/hooks/test`,
      // Subscribed to nothing that has happened: a test is addressed to the
      // endpoint, not matched against its subscriptions.
      events: ['appointment.cancelled'],
    });

    const response = await request(app)
      .post(`/api/v1/webhooks/${endpoint.id}/test`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(201);

    expect(response.body.data.event).toBe('webhook.test');
    expect(response.body.data.status).toBe('PENDING');

    await deliverWebhook(deliveryJob(response.body.data.id as string));

    expect(received).toHaveLength(1);
    const call = received[0]!;
    const expected = crypto
      .createHmac('sha256', endpoint.signingSecret)
      .update(`${call.headers['x-meetflow-timestamp'] as string}.${call.body}`)
      .digest('hex');
    expect(call.headers['x-meetflow-signature']).toBe(`v1=${expected}`);
  });

  it('refuses to test a disabled endpoint rather than queueing a delivery nobody will make', async () => {
    const endpoint = await registerEndpoint(owner, {
      url: `${receiverOrigin}/hooks/off`,
      isActive: false,
    });

    await request(app)
      .post(`/api/v1/webhooks/${endpoint.id}/test`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(409);

    expect(await deliveriesFor(owner.fixture.business.id)).toHaveLength(0);
  });
});
