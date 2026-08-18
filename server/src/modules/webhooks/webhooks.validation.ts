/**
 * Webhook request schemas and the event catalogue.
 *
 * The contract for `/api/v1/webhooks`: runtime validation, the generated
 * OpenAPI document and the frontend's types all derive from these, so the three
 * cannot drift apart.
 *
 * The event catalogue lives here rather than beside the delivery worker because
 * it is the part of the subsystem tenants actually contract with: a subscriber
 * writes these strings into `events`, the fan-out matches on them, and the
 * document publishes them. One list, one place to add the next event.
 *
 * `businessId` appears in none of these schemas, and never will: the tenant is
 * resolved from the caller's membership, so accepting one here would be an
 * authorisation hole with a validation schema in front of it.
 */
import { z } from 'zod';
import { WEBHOOK_DELIVERY_STATUSES } from '../../database/models/WebhookDelivery';
import { WEBHOOK_WILDCARD_EVENT } from '../../database/models/WebhookEndpoint';

/**
 * Every event MeetFlow emits to subscribers.
 *
 * The names deliberately match the Socket.IO vocabulary in `sockets/index.ts`
 * and the automation triggers on `automation_rules`: an integrator reading the
 * real-time stream and an integrator reading webhooks should not have to learn
 * two spellings of "the appointment was cancelled".
 */
export const WebhookEvents = {
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_RESCHEDULED: 'appointment.rescheduled',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  APPOINTMENT_COMPLETED: 'appointment.completed',
  APPOINTMENT_NO_SHOW: 'appointment.no_show',
  /**
   * Sent only by `POST /webhooks/{id}/test`, and deliberately absent from the
   * subscribable list below: a test is delivered because somebody asked for it
   * on that one endpoint, not because anybody subscribed to it. Leaving it out
   * also means a wildcard subscriber is never woken by another operator's
   * connectivity check.
   */
  WEBHOOK_TEST: 'webhook.test',
} as const;

export type WebhookEvent = (typeof WebhookEvents)[keyof typeof WebhookEvents];

/** The names an endpoint may subscribe to. */
export const SUBSCRIBABLE_WEBHOOK_EVENTS = [
  WebhookEvents.APPOINTMENT_CREATED,
  WebhookEvents.APPOINTMENT_RESCHEDULED,
  WebhookEvents.APPOINTMENT_CANCELLED,
  WebhookEvents.APPOINTMENT_COMPLETED,
  WebhookEvents.APPOINTMENT_NO_SHOW,
] as const;

const eventNameSchema = z.enum([WEBHOOK_WILDCARD_EVENT, ...SUBSCRIBABLE_WEBHOOK_EVENTS]);

/**
 * A subscription list.
 *
 * Duplicates are rejected rather than quietly de-duplicated: `.strict()` exists
 * on every other schema here for the same reason — a caller who sent something
 * the server did not use should be told, not humoured. The wildcard on its own
 * is the way to subscribe to everything, including events added later.
 */
export const webhookEventsSchema = z
  .array(eventNameSchema)
  .min(1, 'Subscribe to at least one event.')
  .max(SUBSCRIBABLE_WEBHOOK_EVENTS.length + 1)
  .refine((values) => new Set(values).size === values.length, {
    message: 'The same event is listed more than once.',
  })
  .refine((values) => !(values.includes(WEBHOOK_WILDCARD_EVENT) && values.length > 1), {
    message: 'The wildcard already covers every event, so list it on its own.',
  });

/**
 * Delivery targets.
 *
 * Matches the `url ~ '^https?://'` CHECK on `webhook_endpoints` — plain http is
 * accepted because integrators develop against it, and the signature is what
 * authenticates a delivery in either case. Credentials in the URL are refused:
 * they would be sent to the log pipeline and stored in an audit-readable
 * column, and they buy nothing the HMAC signature does not already provide.
 *
 * Private and link-local targets are NOT filtered here. That is a known,
 * documented limitation (docs/SecurityThreatModel.md — "Webhook abuse"), not an
 * oversight: closing it needs DNS resolution and a re-check at delivery time to
 * survive rebinding, which belongs with the worker that opens the connection.
 */
const webhookUrlSchema = z
  .string()
  .trim()
  .min(1, 'A delivery URL is required.')
  .max(2048)
  .url('Enter a complete URL, including the scheme.')
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'Use an http:// or https:// URL.',
  })
  .refine(
    (value) => {
      const parsed = new URL(value);
      return parsed.username === '' && parsed.password === '';
    },
    { message: 'Do not put credentials in the URL; the signing secret authenticates deliveries.' },
  );

const descriptionSchema = z.string().trim().max(500).nullable();

/**
 * `z.coerce.boolean()` maps the string "false" to `true`, which would make
 * `?isActive=false` return exactly the rows it excludes. Spell the two accepted
 * literals out instead.
 */
const booleanQueryParam = z.enum(['true', 'false']).transform((value) => value === 'true');

export const webhookIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const listWebhooksQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    isActive: booleanQueryParam.optional(),
    /** Narrows to endpoints subscribed to one event, wildcards included. */
    event: eventNameSchema.optional(),
  })
  .strict();

export const createWebhookSchema = z
  .object({
    url: webhookUrlSchema,
    description: descriptionSchema.optional(),
    // Omitted means the column default, `['*']` — subscribe to everything.
    events: webhookEventsSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/**
 * The signing secret is not updatable, and its absence here is the point: a
 * caller-supplied secret would be a caller-chosen one, and a rotation endpoint
 * is a separate operation with its own overlap window. Neither is smuggled into
 * a PATCH.
 */
export const updateWebhookSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    description: descriptionSchema.optional(),
    events: webhookEventsSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  // An empty PATCH would write an audit row describing no change at all.
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const listDeliveriesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    // Sourced from the model so the enum cannot drift from the CHECK constraint.
    status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
    event: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type WebhookIdParams = z.infer<typeof webhookIdParamsSchema>;
export type ListWebhooksQuery = z.infer<typeof listWebhooksQuerySchema>;
export type CreateWebhookBody = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookBody = z.infer<typeof updateWebhookSchema>;
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;
