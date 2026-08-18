/**
 * `/api/v1/public`
 *
 * The unauthenticated booking surface. There is no `authenticate`, no
 * `requireTenant` and no `requirePermission` here by design: the tenant is the
 * workspace behind the slug in the path, and the only authorisation that exists
 * is "this link publishes this thing", enforced in publicBooking.service.ts.
 *
 * That makes rate limiting the load-bearing defence, and it is layered:
 *
 *   publicRateLimit      — applied by the parent router to every path here
 *   availabilityRateLimit — read-only but expensive; a wide date range fans out
 *                           into a slot search per provider
 *   bookingRateLimit      — the tight bucket, on every write. Confirming a
 *                           booking is the abuse-sensitive one the product cares
 *                           about most, but a reschedule and a cancel move a
 *                           real customer's real appointment, so they share it.
 *
 * `validate` runs before any handler, so a malformed slug or a body carrying a
 * `businessId` is refused before a single query is issued.
 */
import { Router } from 'express';
import { availabilityRateLimit, bookingRateLimit } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as controller from './publicBooking.controller';
import {
  appointmentPublicIdParamsSchema,
  bookingLinkSlugParamsSchema,
  cancelPublicAppointmentSchema,
  createPublicBookingSchema,
  publicAvailabilityQuerySchema,
  reschedulePublicAppointmentSchema,
} from './publicBooking.validation';

export const publicBookingRouter = Router();

// --- The booking page -------------------------------------------------------

publicBookingRouter.get(
  '/booking-links/:slug',
  validate({ params: bookingLinkSlugParamsSchema }),
  controller.showBookingLink,
);

publicBookingRouter.get(
  '/booking-links/:slug/availability',
  availabilityRateLimit,
  validate({ params: bookingLinkSlugParamsSchema, query: publicAvailabilityQuerySchema }),
  controller.showAvailability,
);

publicBookingRouter.post(
  '/booking-links/:slug/bookings',
  bookingRateLimit,
  validate({ params: bookingLinkSlugParamsSchema, body: createPublicBookingSchema }),
  controller.createBooking,
);

// --- Managing one booking ---------------------------------------------------
//
// Addressed by the opaque `apt_…` handle. It behaves like a bearer token, which
// is why these routes never widen: they read, move or cancel exactly the one
// appointment named in the path.

publicBookingRouter.get(
  '/appointments/:publicId',
  validate({ params: appointmentPublicIdParamsSchema }),
  controller.showAppointment,
);

publicBookingRouter.post(
  '/appointments/:publicId/reschedule',
  bookingRateLimit,
  validate({
    params: appointmentPublicIdParamsSchema,
    body: reschedulePublicAppointmentSchema,
  }),
  controller.rescheduleAppointment,
);

publicBookingRouter.post(
  '/appointments/:publicId/cancel',
  bookingRateLimit,
  validate({ params: appointmentPublicIdParamsSchema, body: cancelPublicAppointmentSchema }),
  controller.cancelAppointment,
);
