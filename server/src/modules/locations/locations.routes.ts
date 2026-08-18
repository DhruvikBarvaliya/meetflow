/**
 * `/api/v1/locations`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to locations: the permission each verb needs and the
 * schema each request must satisfy.
 *
 * `requirePermission` runs before `validate` so a caller who may not see
 * locations at all learns nothing from the shape of the validation errors.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './locations.controller';
import {
  createLocationSchema,
  listLocationsQuerySchema,
  locationIdParamSchema,
  updateLocationSchema,
} from './locations.validation';

export const locationsRouter = Router();

locationsRouter.get(
  '/',
  requirePermission(PERMISSIONS.LOCATIONS_READ),
  validate({ query: listLocationsQuerySchema }),
  controller.list,
);

locationsRouter.post(
  '/',
  requirePermission(PERMISSIONS.LOCATIONS_MANAGE),
  validate({ body: createLocationSchema }),
  controller.create,
);

locationsRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.LOCATIONS_READ),
  validate({ params: locationIdParamSchema }),
  controller.get,
);

locationsRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.LOCATIONS_MANAGE),
  validate({ params: locationIdParamSchema, body: updateLocationSchema }),
  controller.update,
);

locationsRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.LOCATIONS_MANAGE),
  validate({ params: locationIdParamSchema }),
  controller.remove,
);
