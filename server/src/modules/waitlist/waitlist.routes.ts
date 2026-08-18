/**
 * `/api/v1/waitlist`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to the waitlist: the permission each verb needs and the
 * schema each request must satisfy.
 *
 * `requirePermission` runs before `validate` so a caller who may not see the
 * waitlist at all learns nothing from the shape of the validation errors.
 *
 * `POST /:id/convert` creates an appointment but asks only for WAITLIST_MANAGE:
 * that is precisely what the permission catalogue defines it as ("Manage and
 * convert waitlist entries"), and every role that holds it also books.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './waitlist.controller';
import {
  convertWaitlistEntrySchema,
  createWaitlistEntrySchema,
  listWaitlistQuerySchema,
  notifyWaitlistEntrySchema,
  updateWaitlistEntrySchema,
  waitlistIdParamSchema,
} from './waitlist.validation';

export const waitlistRouter = Router();

waitlistRouter.get(
  '/',
  requirePermission(PERMISSIONS.WAITLIST_READ),
  validate({ query: listWaitlistQuerySchema }),
  controller.list,
);

waitlistRouter.post(
  '/',
  requirePermission(PERMISSIONS.WAITLIST_MANAGE),
  validate({ body: createWaitlistEntrySchema }),
  controller.create,
);

waitlistRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.WAITLIST_READ),
  validate({ params: waitlistIdParamSchema }),
  controller.get,
);

waitlistRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.WAITLIST_MANAGE),
  validate({ params: waitlistIdParamSchema, body: updateWaitlistEntrySchema }),
  controller.update,
);

waitlistRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.WAITLIST_MANAGE),
  validate({ params: waitlistIdParamSchema }),
  controller.remove,
);

waitlistRouter.post(
  '/:id/notify',
  requirePermission(PERMISSIONS.WAITLIST_MANAGE),
  validate({ params: waitlistIdParamSchema, body: notifyWaitlistEntrySchema }),
  controller.notify,
);

waitlistRouter.post(
  '/:id/convert',
  requirePermission(PERMISSIONS.WAITLIST_MANAGE),
  validate({ params: waitlistIdParamSchema, body: convertWaitlistEntrySchema }),
  controller.convert,
);
