/**
 * `/api/v1/staff`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to staff: the permission each verb needs and the schema
 * each request must satisfy.
 *
 * `requirePermission` runs before `validate` so a caller who may not see staff
 * at all learns nothing from the shape of the validation errors.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './staff.controller';
import {
  createStaffSchema,
  listStaffQuerySchema,
  replaceStaffServicesSchema,
  staffIdParamsSchema,
  updateStaffSchema,
} from './staff.validation';

export const staffRouter = Router();

staffRouter.get(
  '/',
  requirePermission(PERMISSIONS.STAFF_READ),
  validate({ query: listStaffQuerySchema }),
  controller.list,
);

staffRouter.post(
  '/',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ body: createStaffSchema }),
  controller.create,
);

staffRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.STAFF_READ),
  validate({ params: staffIdParamsSchema }),
  controller.get,
);

staffRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ params: staffIdParamsSchema, body: updateStaffSchema }),
  controller.update,
);

staffRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ params: staffIdParamsSchema }),
  controller.remove,
);

staffRouter.get(
  '/:id/services',
  requirePermission(PERMISSIONS.STAFF_READ),
  validate({ params: staffIdParamsSchema }),
  controller.listServices,
);

// PUT, not PATCH: the body is the complete set of services this staff member
// delivers, and anything absent from it is withdrawn.
staffRouter.put(
  '/:id/services',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ params: staffIdParamsSchema, body: replaceStaffServicesSchema }),
  controller.replaceServices,
);
