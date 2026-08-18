/**
 * `/api/v1/resources`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to resources: the permission each verb needs and the
 * schema each request must satisfy.
 *
 * `requirePermission` runs before `validate` so a caller who may not see
 * resources at all learns nothing from the shape of the validation errors.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './resources.controller';
import {
  createResourceSchema,
  listResourcesQuerySchema,
  replaceServiceRequirementsSchema,
  resourceIdParamsSchema,
  serviceIdParamsSchema,
  updateResourceSchema,
} from './resources.validation';

export const resourcesRouter = Router();

resourcesRouter.get(
  '/',
  requirePermission(PERMISSIONS.RESOURCES_READ),
  validate({ query: listResourcesQuerySchema }),
  controller.list,
);

resourcesRouter.post(
  '/',
  requirePermission(PERMISSIONS.RESOURCES_MANAGE),
  validate({ body: createResourceSchema }),
  controller.create,
);

resourcesRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.RESOURCES_READ),
  validate({ params: resourceIdParamsSchema }),
  controller.get,
);

resourcesRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.RESOURCES_MANAGE),
  validate({ params: resourceIdParamsSchema, body: updateResourceSchema }),
  controller.update,
);

resourcesRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.RESOURCES_MANAGE),
  validate({ params: resourceIdParamsSchema }),
  controller.remove,
);

// A service's resource needs live here rather than under /services because they
// are edited from the resource-planning screen and gated on RESOURCES_*: a
// manager who may not touch the catalogue can still say which room a service
// needs.
resourcesRouter.get(
  '/requirements/service/:serviceId',
  requirePermission(PERMISSIONS.RESOURCES_READ),
  validate({ params: serviceIdParamsSchema }),
  controller.listRequirements,
);

// PUT, not PATCH: the body is the complete set the caller wants to end up with.
resourcesRouter.put(
  '/requirements/service/:serviceId',
  requirePermission(PERMISSIONS.RESOURCES_MANAGE),
  validate({ params: serviceIdParamsSchema, body: replaceServiceRequirementsSchema }),
  controller.replaceRequirements,
);
