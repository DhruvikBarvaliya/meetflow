/**
 * `/api/v1/webhooks`
 *
 * The registration surface for outbound events. Until this router existed the
 * delivery worker, the queue, the HMAC signing and both tables were reachable
 * only by inserting a row by hand — a shipped subsystem with no way in.
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what each endpoint additionally requires. The permission guard runs
 * before validation so a caller who may not touch webhooks learns nothing about
 * the shape of the payload.
 *
 * Reads and writes are split across two permissions on purpose. `webhooks:read`
 * exposes delivery history — URLs, response bodies and error text — which is
 * operational debugging data; `webhooks:manage` is what lets somebody point a
 * tenant's event stream at a server of their choosing, which is a materially
 * bigger act and is granted to owners alone by the built-in roles.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './webhooks.controller';
import {
  createWebhookSchema,
  listDeliveriesQuerySchema,
  listWebhooksQuerySchema,
  updateWebhookSchema,
  webhookIdParamsSchema,
} from './webhooks.validation';

export const webhooksRouter = Router();

webhooksRouter.get(
  '/',
  requirePermission(PERMISSIONS.WEBHOOKS_READ),
  validate({ query: listWebhooksQuerySchema }),
  controller.listWebhooks,
);

webhooksRouter.post(
  '/',
  requirePermission(PERMISSIONS.WEBHOOKS_MANAGE),
  validate({ body: createWebhookSchema }),
  controller.createWebhook,
);

webhooksRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.WEBHOOKS_READ),
  validate({ params: webhookIdParamsSchema }),
  controller.getWebhook,
);

webhooksRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.WEBHOOKS_MANAGE),
  validate({ params: webhookIdParamsSchema, body: updateWebhookSchema }),
  controller.updateWebhook,
);

webhooksRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.WEBHOOKS_MANAGE),
  validate({ params: webhookIdParamsSchema }),
  controller.deleteWebhook,
);

/**
 * Sending a test event is `webhooks:manage`, not `webhooks:read`: it makes the
 * server open an outbound connection to a customer-supplied URL, which is a
 * write to the outside world even though nothing about the endpoint changes.
 */
webhooksRouter.post(
  '/:id/test',
  requirePermission(PERMISSIONS.WEBHOOKS_MANAGE),
  validate({ params: webhookIdParamsSchema }),
  controller.sendWebhookTest,
);

webhooksRouter.get(
  '/:id/deliveries',
  requirePermission(PERMISSIONS.WEBHOOKS_READ),
  validate({ params: webhookIdParamsSchema, query: listDeliveriesQuerySchema }),
  controller.listWebhookDeliveries,
);
