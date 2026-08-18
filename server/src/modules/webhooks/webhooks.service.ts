/**
 * Outbound webhook subscriptions.
 *
 * Three invariants govern everything in this file:
 *
 *  1. `businessId` is always the first parameter and always comes from the
 *     caller's membership. An endpoint belonging to another workspace must be
 *     indistinguishable from one that does not exist, so every miss raises
 *     NotFoundError — never a 403, which would confirm the id is real. The same
 *     applies to deliveries, which are only ever reached through an endpoint
 *     already proven to belong to the tenant.
 *
 *  2. **The signing secret leaves the server exactly once.** It is generated
 *     here, returned by `createEndpoint` and by nothing else, ever. The rule is
 *     the one `auth/tokens.ts` applies to refresh tokens — the value is shown
 *     at issue and is afterwards only usable, never readable — and it is
 *     enforced in three places so that removing any one of them still fails
 *     safe: the model's defaultScope excludes the column from every query,
 *     `serialiseEndpoint` is an allow-list rather than a delete, and the audit
 *     sanitiser redacts the key name. A reviewer tempted to "fix" the reads by
 *     adding the secret back should note that a webhook's entire security model
 *     is that only the two ends know it: an endpoint that can be re-read can be
 *     forged by anyone who has ever held a read token for this workspace.
 *
 *  3. An event is written in the same transaction as the change it announces
 *     and queued only after that transaction commits — see
 *     `publishAppointmentWebhook` and `fanOutEvent`.
 */
import { Op, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { createLogger } from '../../config/logger';
import type { Appointment } from '../../database/models';
import { WebhookDelivery, WebhookEndpoint } from '../../database/models';
import type { WebhookDeliveryStatus } from '../../database/models/WebhookDelivery';
import { WEBHOOK_WILDCARD_EVENT } from '../../database/models/WebhookEndpoint';
import { fanOutEvent, scheduleDeliveries } from '../../jobs/processors/webhook.processor';
import { ConflictError, ErrorCode, NotFoundError } from '../../utils/errors';
import { newUuid, newWebhookSecret } from '../../utils/ids';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import { WebhookEvents, type WebhookEvent } from './webhooks.validation';

const log = createLogger('webhooks');

/**
 * Every fan-out writes one row per endpoint inside the booking transaction, so
 * a workspace's endpoint count is a multiplier on the latency of the most
 * safety-critical path in the product. Twenty is far beyond any real
 * integration and cheap enough to be invisible.
 */
const MAX_ENDPOINTS_PER_BUSINESS = 20;

/** Enough recent deliveries to see whether an endpoint is healthy. */
const RECENT_DELIVERY_LIMIT = 10;

export interface WebhookActor {
  userId: string;
  email: string;
}

/**
 * The endpoint as the API describes it.
 *
 * An explicit allow-list, not `toJSON()` minus a field: a column added to the
 * model later is invisible here until somebody decides it is safe to publish,
 * which is the opposite of the default a `delete row.signingSecret` would set.
 */
export interface SerialisedWebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  failureCount: number;
  disabledAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SerialisedWebhookDelivery {
  id: string;
  endpointId: string;
  event: string;
  /** Stable across every endpoint notified of one occurrence. */
  eventId: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  scheduledFor: Date;
  deliveredAt: Date | null;
  createdAt: Date;
  payload: Record<string, unknown>;
}

/**
 * The creation response, and the only shape in the product that carries a
 * signing secret. Named so that a reviewer sees the exception rather than
 * discovering it.
 */
export interface CreatedWebhookEndpoint extends SerialisedWebhookEndpoint {
  signingSecret: string;
}

export interface WebhookEndpointDetail extends SerialisedWebhookEndpoint {
  recentDeliveries: SerialisedWebhookDelivery[];
}

export interface ListEndpointsOptions {
  page: number;
  pageSize: number;
  isActive?: boolean;
  event?: string;
}

export interface EndpointPage {
  rows: SerialisedWebhookEndpoint[];
  page: number;
  pageSize: number;
  totalItems: number;
}

export interface ListDeliveriesOptions {
  page: number;
  pageSize: number;
  status?: WebhookDeliveryStatus;
  event?: string;
}

export interface DeliveryPage {
  rows: SerialisedWebhookDelivery[];
  page: number;
  pageSize: number;
  totalItems: number;
}

export interface CreateEndpointInput {
  url: string;
  description?: string | null;
  events?: string[];
  isActive?: boolean;
}

export interface UpdateEndpointInput {
  url?: string;
  description?: string | null;
  events?: string[];
  isActive?: boolean;
}

export function serialiseEndpoint(endpoint: WebhookEndpoint): SerialisedWebhookEndpoint {
  return {
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    events: endpoint.events,
    isActive: endpoint.isActive,
    failureCount: endpoint.failureCount,
    disabledAt: endpoint.disabledAt,
    lastSuccessAt: endpoint.lastSuccessAt,
    lastFailureAt: endpoint.lastFailureAt,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

export function serialiseDelivery(delivery: WebhookDelivery): SerialisedWebhookDelivery {
  return {
    id: delivery.id,
    endpointId: delivery.endpointId,
    event: delivery.event,
    eventId: delivery.eventId,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    maxAttempts: delivery.maxAttempts,
    responseStatus: delivery.responseStatus,
    // Already truncated by the worker; a verbose subscriber cannot bloat this.
    responseBody: delivery.responseBody,
    error: delivery.error,
    scheduledFor: delivery.scheduledFor,
    deliveredAt: delivery.deliveredAt,
    createdAt: delivery.createdAt,
    payload: delivery.payload,
  };
}

/**
 * The only way an endpoint is ever loaded. Scoping on businessId here is what
 * makes every delivery query below tenant-safe: a delivery is addressed through
 * its endpoint, never by its own id.
 *
 * Loaded through the default scope, so the secret is absent even from the
 * in-memory instance the mutating paths work with.
 */
async function findEndpointOrFail(
  businessId: string,
  endpointId: string,
  transaction?: Transaction,
): Promise<WebhookEndpoint> {
  const endpoint = await WebhookEndpoint.findOne({
    where: { id: endpointId, businessId },
    transaction,
  });
  if (!endpoint) throw new NotFoundError('Webhook endpoint');
  return endpoint;
}

export async function listEndpoints(
  businessId: string,
  options: ListEndpointsOptions,
): Promise<EndpointPage> {
  const { rows, count } = await WebhookEndpoint.findAndCountAll({
    where: {
      businessId,
      ...(options.isActive !== undefined ? { isActive: options.isActive } : {}),
      // Wildcard subscribers are included, and must be: the question an
      // operator asks by filtering — "who hears this event?" — is the one the
      // fan-out answers, and a filter that disagreed with the matcher would be
      // a debugging trap rather than a tool.
      ...(options.event
        ? {
            [Op.or]: [
              { events: { [Op.contains]: [WEBHOOK_WILDCARD_EVENT] } },
              { events: { [Op.contains]: [options.event] } },
            ],
          }
        : {}),
    },
    order: [['createdAt', 'DESC']],
    limit: options.pageSize,
    offset: (options.page - 1) * options.pageSize,
  });

  return {
    rows: rows.map(serialiseEndpoint),
    page: options.page,
    pageSize: options.pageSize,
    totalItems: count,
  };
}

export async function getEndpoint(
  businessId: string,
  endpointId: string,
): Promise<WebhookEndpointDetail> {
  const endpoint = await findEndpointOrFail(businessId, endpointId);

  const deliveries = await WebhookDelivery.findAll({
    where: { endpointId: endpoint.id, businessId },
    order: [['createdAt', 'DESC']],
    limit: RECENT_DELIVERY_LIMIT,
  });

  return { ...serialiseEndpoint(endpoint), recentDeliveries: deliveries.map(serialiseDelivery) };
}

export async function createEndpoint(
  businessId: string,
  input: CreateEndpointInput,
  actor: WebhookActor,
  metadata: RequestMetadata,
): Promise<CreatedWebhookEndpoint> {
  // Generated here rather than read back from the row: the plaintext exists in
  // exactly one variable, in one function, and the response is built from that
  // variable. Nothing downstream has to remember to fetch it, and nothing
  // downstream is able to.
  const signingSecret = newWebhookSecret();

  const endpoint = await sequelize.transaction(async (transaction) => {
    const existing = await WebhookEndpoint.count({ where: { businessId }, transaction });
    if (existing >= MAX_ENDPOINTS_PER_BUSINESS) {
      throw new ConflictError(
        `A workspace can have at most ${MAX_ENDPOINTS_PER_BUSINESS} webhook endpoints. ` +
          'Delete one you no longer need, or subscribe an existing endpoint to more events.',
        ErrorCode.CONFLICT,
        { limit: MAX_ENDPOINTS_PER_BUSINESS },
      );
    }

    const created = await WebhookEndpoint.create(
      {
        businessId,
        url: input.url,
        description: input.description ?? null,
        signingSecret,
        // Events and activity fall through to the column defaults when the
        // caller did not choose, so the default lives in one place.
        ...(input.events ? { events: input.events } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        disabledAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        deletedAt: null,
      },
      { transaction },
    );

    // The audit row and the change it describes are committed together, so a
    // new delivery target can never exist without its trail. `signingSecret` is
    // not in the metadata, and `sanitiseMetadata` would redact the key even if
    // a later edit put it there.
    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.WEBHOOK_ENDPOINT_CREATED,
        entityType: 'webhook_endpoint',
        entityId: created.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { url: created.url, events: created.events, isActive: created.isActive },
      },
      { transaction },
    );

    return created;
  });

  log.info({ businessId, endpointId: endpoint.id }, 'webhook endpoint created');

  return { ...serialiseEndpoint(endpoint), signingSecret };
}

export async function updateEndpoint(
  businessId: string,
  endpointId: string,
  input: UpdateEndpointInput,
  actor: WebhookActor,
  metadata: RequestMetadata,
): Promise<SerialisedWebhookEndpoint> {
  const endpoint = await sequelize.transaction(async (transaction) => {
    const target = await findEndpointOrFail(businessId, endpointId, transaction);

    const before = {
      url: target.url,
      events: target.events,
      isActive: target.isActive,
    };

    // Re-enabling is a fresh start, not a resumption: the failure counter is
    // what auto-disables an endpoint, so leaving it at the threshold would let
    // the very next failure switch the endpoint straight back off.
    const reactivating = input.isActive === true && !target.isActive;
    // Only a real transition stamps `disabledAt`; re-sending `isActive: false`
    // for an endpoint that is already off would otherwise rewrite the moment it
    // stopped working, which is the one thing that column is there to record.
    const deactivating = input.isActive === false && target.isActive;

    await target.update(
      {
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(reactivating ? { failureCount: 0, disabledAt: null } : {}),
        ...(deactivating ? { disabledAt: new Date() } : {}),
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.WEBHOOK_ENDPOINT_UPDATED,
        entityType: 'webhook_endpoint',
        entityId: target.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          before,
          after: { url: target.url, events: target.events, isActive: target.isActive },
        },
      },
      { transaction },
    );

    return target;
  });

  return serialiseEndpoint(endpoint);
}

export async function deleteEndpoint(
  businessId: string,
  endpointId: string,
  actor: WebhookActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const endpoint = await findEndpointOrFail(businessId, endpointId, transaction);

    // Paranoid model: the row is soft-deleted so the delivery history stays
    // readable and keeps pointing at a real endpoint. Deliveries still queued
    // for it are not chased down here — the worker refuses to send to a
    // withdrawn endpoint and marks them CANCELLED, which records what happened
    // instead of hiding it.
    await endpoint.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.WEBHOOK_ENDPOINT_DELETED,
        entityType: 'webhook_endpoint',
        entityId: endpoint.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { url: endpoint.url, events: endpoint.events },
      },
      { transaction },
    );

    log.info({ businessId, endpointId: endpoint.id }, 'webhook endpoint deleted');
  });
}

export async function listDeliveries(
  businessId: string,
  endpointId: string,
  options: ListDeliveriesOptions,
): Promise<DeliveryPage> {
  // Proves the endpoint belongs to the tenant before any delivery is read. The
  // deliveries carry their own businessId as well, and both are applied: the
  // denormalised column is an index, not an authorisation.
  const endpoint = await findEndpointOrFail(businessId, endpointId);

  const { rows, count } = await WebhookDelivery.findAndCountAll({
    where: {
      endpointId: endpoint.id,
      businessId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.event ? { event: options.event } : {}),
    },
    order: [['createdAt', 'DESC']],
    limit: options.pageSize,
    offset: (options.page - 1) * options.pageSize,
  });

  return {
    rows: rows.map(serialiseDelivery),
    page: options.page,
    pageSize: options.pageSize,
    totalItems: count,
  };
}

/**
 * Sends a signed test event to one endpoint.
 *
 * Deliberately not routed through `fanOutEvent`: a test is addressed to the
 * endpoint the operator asked about, whatever it is subscribed to. That is also
 * why `webhook.test` is not a subscribable name — nobody else should be woken
 * by somebody's connectivity check.
 */
export async function sendTestEvent(
  businessId: string,
  endpointId: string,
  actor: WebhookActor,
  metadata: RequestMetadata,
): Promise<SerialisedWebhookDelivery> {
  const delivery = await sequelize.transaction(async (transaction) => {
    const endpoint = await findEndpointOrFail(businessId, endpointId, transaction);

    // The worker cancels anything addressed to a disabled endpoint, so allowing
    // this would answer 201 and then quietly deliver nothing — the least useful
    // possible response to "is this endpoint working?".
    if (!endpoint.isActive) {
      throw new ConflictError(
        'This endpoint is disabled, so a test event would not be delivered. ' +
          'Re-activate it first.',
        ErrorCode.CONFLICT,
      );
    }

    const created = await WebhookDelivery.create(
      {
        endpointId: endpoint.id,
        businessId,
        eventId: newUuid(),
        event: WebhookEvents.WEBHOOK_TEST,
        payload: {
          message: 'This is a test event from MeetFlow.',
          endpointId: endpoint.id,
          requestedBy: actor.email,
          requestedAt: new Date().toISOString(),
        },
        responseStatus: null,
        responseBody: null,
        error: null,
        deliveredAt: null,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        // No dedicated action constant exists for a test send, and inventing
        // one would be a schema change for an event that is not a change to the
        // endpoint. The metadata says exactly what happened.
        action: AuditActions.WEBHOOK_ENDPOINT_UPDATED,
        entityType: 'webhook_endpoint',
        entityId: endpoint.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { change: 'test_event_sent', deliveryId: created.id, url: endpoint.url },
      },
      { transaction },
    );

    // Same contract as the fan-out: the row is committed before the queue hears
    // about it, and a queue outage delays the test rather than failing it.
    scheduleDeliveries([created.id], transaction);

    return created;
  });

  return serialiseDelivery(delivery);
}

// ---------------------------------------------------------------------------
// Lifecycle bridge
// ---------------------------------------------------------------------------

/**
 * The event body for an appointment.
 *
 * Built from the appointment row alone, so wiring this into the booking path
 * costs no extra query on the hot path. Names, emails and phone numbers are
 * deliberately absent: a subscriber that needs them resolves them through the
 * API with credentials of its own, which means a mis-typed URL leaks opaque
 * identifiers rather than a customer's identity.
 */
function appointmentEventPayload(appointment: Appointment): Record<string, unknown> {
  return {
    appointmentId: appointment.id,
    publicId: appointment.publicId,
    businessId: appointment.businessId,
    status: appointment.status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    timezone: appointment.timezone,
    durationMinutes: appointment.durationMinutes,
    serviceId: appointment.serviceId,
    staffProfileId: appointment.staffProfileId,
    locationId: appointment.locationId,
    customerId: appointment.customerId,
    capacity: appointment.capacity,
    bookedCount: appointment.bookedCount,
    source: appointment.source,
  };
}

/**
 * Announces an appointment event to every subscribed endpoint.
 *
 * Called from inside the lifecycle transaction, and that placement is the whole
 * guarantee: the delivery rows commit with the booking or roll back with it, so
 * a subscriber can never be told about an appointment the database does not
 * have. Queueing happens after the commit, through `safeEnqueue`, so a Redis
 * outage delays the announcement instead of failing the booking that caused it.
 */
export async function publishAppointmentWebhook(
  event: WebhookEvent,
  appointment: Appointment,
  options: { transaction?: Transaction; extra?: Record<string, unknown> } = {},
): Promise<void> {
  const payload = { ...appointmentEventPayload(appointment), ...(options.extra ?? {}) };
  const deliveryIds = await fanOutEvent(appointment.businessId, event, payload, {
    transaction: options.transaction,
  });

  if (deliveryIds.length > 0) {
    log.debug(
      { businessId: appointment.businessId, event, deliveries: deliveryIds.length },
      'webhook event fanned out',
    );
  }
}
