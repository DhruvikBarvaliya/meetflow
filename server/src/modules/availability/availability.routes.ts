/**
 * `/api/v1/availability`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to availability: the permission each verb needs and the
 * schema each request must satisfy.
 *
 * The permission check runs before `validate` so a caller who may not see the
 * rota at all learns nothing from the shape of the validation errors.
 *
 * Rules and overrides use `requireAnyPermission`: a member holding only
 * `availability:manage:own` gets past the router, and the service then refuses
 * anything that is not their own row. The router cannot make that call itself —
 * whose availability is being edited is a property of the request body and the
 * stored row, not of the route.
 */
import { Router } from 'express';
import { requireAnyPermission, requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './availability.controller';
import {
  createBlackoutSchema,
  createHolidaySchema,
  createOverrideSchema,
  idParamsSchema,
  listBlackoutsQuerySchema,
  listBusinessHoursQuerySchema,
  listHolidaysQuerySchema,
  listOverridesQuerySchema,
  listStaffRulesQuerySchema,
  replaceBusinessHoursSchema,
  replaceStaffRulesSchema,
  staffProfileIdParamsSchema,
} from './availability.validation';

export const availabilityRouter = Router();

availabilityRouter.get(
  '/business-hours',
  requirePermission(PERMISSIONS.AVAILABILITY_READ),
  validate({ query: listBusinessHoursQuerySchema }),
  controller.listBusinessHours,
);

// PUT, not PATCH: the body is the complete week the caller wants to end up with.
availabilityRouter.put(
  '/business-hours',
  requirePermission(PERMISSIONS.AVAILABILITY_MANAGE),
  validate({ body: replaceBusinessHoursSchema }),
  controller.replaceBusinessHours,
);

availabilityRouter.get(
  '/staff/:staffProfileId/rules',
  requirePermission(PERMISSIONS.AVAILABILITY_READ),
  validate({ params: staffProfileIdParamsSchema, query: listStaffRulesQuerySchema }),
  controller.listStaffRules,
);

availabilityRouter.put(
  '/staff/:staffProfileId/rules',
  requireAnyPermission(PERMISSIONS.AVAILABILITY_MANAGE, PERMISSIONS.AVAILABILITY_MANAGE_OWN),
  validate({ params: staffProfileIdParamsSchema, body: replaceStaffRulesSchema }),
  controller.replaceStaffRules,
);

availabilityRouter.get(
  '/overrides',
  requirePermission(PERMISSIONS.AVAILABILITY_READ),
  validate({ query: listOverridesQuerySchema }),
  controller.listOverrides,
);

availabilityRouter.post(
  '/overrides',
  requireAnyPermission(PERMISSIONS.AVAILABILITY_MANAGE, PERMISSIONS.AVAILABILITY_MANAGE_OWN),
  validate({ body: createOverrideSchema }),
  controller.createOverride,
);

availabilityRouter.delete(
  '/overrides/:id',
  requireAnyPermission(PERMISSIONS.AVAILABILITY_MANAGE, PERMISSIONS.AVAILABILITY_MANAGE_OWN),
  validate({ params: idParamsSchema }),
  controller.removeOverride,
);

availabilityRouter.get(
  '/holidays',
  requirePermission(PERMISSIONS.AVAILABILITY_READ),
  validate({ query: listHolidaysQuerySchema }),
  controller.listHolidays,
);

availabilityRouter.post(
  '/holidays',
  requirePermission(PERMISSIONS.AVAILABILITY_MANAGE),
  validate({ body: createHolidaySchema }),
  controller.createHoliday,
);

availabilityRouter.delete(
  '/holidays/:id',
  requirePermission(PERMISSIONS.AVAILABILITY_MANAGE),
  validate({ params: idParamsSchema }),
  controller.removeHoliday,
);

availabilityRouter.get(
  '/blackouts',
  requirePermission(PERMISSIONS.AVAILABILITY_READ),
  validate({ query: listBlackoutsQuerySchema }),
  controller.listBlackouts,
);

availabilityRouter.post(
  '/blackouts',
  requirePermission(PERMISSIONS.AVAILABILITY_MANAGE),
  validate({ body: createBlackoutSchema }),
  controller.createBlackout,
);

availabilityRouter.delete(
  '/blackouts/:id',
  requirePermission(PERMISSIONS.AVAILABILITY_MANAGE),
  validate({ params: idParamsSchema }),
  controller.removeBlackout,
);
