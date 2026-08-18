/**
 * `/api/v1/booking-links`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to booking links: the permission each verb needs and
 * the schema each request must satisfy.
 *
 * `requirePermission` runs before `validate` so a caller who may not see
 * booking links at all learns nothing from the shape of the validation errors.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './bookingLinks.controller';
import {
  bookingLinkIdParamsSchema,
  createBookingLinkSchema,
  listBookingLinksQuerySchema,
  replaceBookingLinkServicesSchema,
  updateBookingLinkSchema,
} from './bookingLinks.validation';

export const bookingLinksRouter = Router();

bookingLinksRouter.get(
  '/',
  requirePermission(PERMISSIONS.BOOKING_LINKS_READ),
  validate({ query: listBookingLinksQuerySchema }),
  controller.list,
);

bookingLinksRouter.post(
  '/',
  requirePermission(PERMISSIONS.BOOKING_LINKS_MANAGE),
  validate({ body: createBookingLinkSchema }),
  controller.create,
);

bookingLinksRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.BOOKING_LINKS_READ),
  validate({ params: bookingLinkIdParamsSchema }),
  controller.get,
);

bookingLinksRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.BOOKING_LINKS_MANAGE),
  validate({ params: bookingLinkIdParamsSchema, body: updateBookingLinkSchema }),
  controller.update,
);

bookingLinksRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.BOOKING_LINKS_MANAGE),
  validate({ params: bookingLinkIdParamsSchema }),
  controller.remove,
);

// PUT, not PATCH: the body is the complete set the caller wants to end up with.
bookingLinksRouter.put(
  '/:id/services',
  requirePermission(PERMISSIONS.BOOKING_LINKS_MANAGE),
  validate({ params: bookingLinkIdParamsSchema, body: replaceBookingLinkServicesSchema }),
  controller.replaceServices,
);
