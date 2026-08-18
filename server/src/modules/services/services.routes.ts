/**
 * `/api/v1/services`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to the catalogue: the permission each verb needs and the
 * schema each request must satisfy.
 *
 * `requirePermission` runs before `validate` so a caller who may not see the
 * catalogue at all learns nothing from the shape of the validation errors.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './services.controller';
import {
  categoryIdParamsSchema,
  createCategorySchema,
  createServiceSchema,
  listCategoriesQuerySchema,
  listServicesQuerySchema,
  replaceServiceLocationsSchema,
  replaceServiceStaffSchema,
  serviceIdParamsSchema,
  updateCategorySchema,
  updateServiceSchema,
} from './services.validation';

export const servicesRouter = Router();

// Declared before `/:id`: Express matches in order, so a later literal path
// would be swallowed by the uuid parameter route and rejected as a bad id.
servicesRouter.get(
  '/categories',
  requirePermission(PERMISSIONS.SERVICES_READ),
  validate({ query: listCategoriesQuerySchema }),
  controller.listCategories,
);

servicesRouter.post(
  '/categories',
  requirePermission(PERMISSIONS.SERVICES_MANAGE),
  validate({ body: createCategorySchema }),
  controller.createCategory,
);

servicesRouter.patch(
  '/categories/:id',
  requirePermission(PERMISSIONS.SERVICES_MANAGE),
  validate({ params: categoryIdParamsSchema, body: updateCategorySchema }),
  controller.updateCategory,
);

servicesRouter.delete(
  '/categories/:id',
  requirePermission(PERMISSIONS.SERVICES_MANAGE),
  validate({ params: categoryIdParamsSchema }),
  controller.removeCategory,
);

servicesRouter.get(
  '/',
  requirePermission(PERMISSIONS.SERVICES_READ),
  validate({ query: listServicesQuerySchema }),
  controller.list,
);

servicesRouter.post(
  '/',
  requirePermission(PERMISSIONS.SERVICES_MANAGE),
  validate({ body: createServiceSchema }),
  controller.create,
);

servicesRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.SERVICES_READ),
  validate({ params: serviceIdParamsSchema }),
  controller.get,
);

servicesRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.SERVICES_MANAGE),
  validate({ params: serviceIdParamsSchema, body: updateServiceSchema }),
  controller.update,
);

servicesRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.SERVICES_MANAGE),
  validate({ params: serviceIdParamsSchema }),
  controller.remove,
);

// PUT, not PATCH: the body is the complete set the caller wants to end up with.
servicesRouter.put(
  '/:id/staff',
  requirePermission(PERMISSIONS.SERVICES_MANAGE),
  validate({ params: serviceIdParamsSchema, body: replaceServiceStaffSchema }),
  controller.replaceStaff,
);

servicesRouter.put(
  '/:id/locations',
  requirePermission(PERMISSIONS.SERVICES_MANAGE),
  validate({ params: serviceIdParamsSchema, body: replaceServiceLocationsSchema }),
  controller.replaceLocations,
);
