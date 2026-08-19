/**
 * `/api/v1/notification-templates`
 *
 * The way in to the messages a workspace sends in its own name. Until this
 * router existed, `resolveTemplate`'s first branch — the workspace override —
 * was reachable only by inserting a row by hand, and `templates:manage` was a
 * permission the built-in roles granted to owners and managers and no endpoint
 * consulted.
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file declares only what
 * each endpoint additionally requires.
 *
 * One permission, not two. Elsewhere reads and writes are split — webhooks do,
 * because delivery history exposes response bodies from a tenant's own servers.
 * Here the read is the same copy the write produces and the same copy every
 * customer of the workspace already receives by email, so a second permission
 * would draw a line with nothing on either side of it.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './templates.controller';
import {
  listTemplatesQuerySchema,
  previewTemplateSchema,
  templateParamsSchema,
  upsertTemplateSchema,
} from './templates.validation';

export const notificationTemplatesRouter = Router();

notificationTemplatesRouter.get(
  '/',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  validate({ query: listTemplatesQuerySchema }),
  controller.listTemplates,
);

notificationTemplatesRouter.get(
  '/:key/:channel',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  validate({ params: templateParamsSchema }),
  controller.getTemplate,
);

notificationTemplatesRouter.put(
  '/:key/:channel',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  validate({ params: templateParamsSchema, body: upsertTemplateSchema }),
  controller.upsertTemplate,
);

notificationTemplatesRouter.delete(
  '/:key/:channel',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  validate({ params: templateParamsSchema }),
  controller.resetTemplate,
);

notificationTemplatesRouter.post(
  '/:key/:channel/preview',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  validate({ params: templateParamsSchema, body: previewTemplateSchema }),
  controller.previewTemplate,
);
