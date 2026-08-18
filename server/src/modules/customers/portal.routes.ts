/**
 * `/api/v1/me`
 *
 * The customer's own surface, and the mirror image of `/api/v1/admin`.
 *
 * **`requireTenant` is deliberately absent, and that absence is the whole
 * point.** A customer holds no membership — they are a person who appears in
 * one or more workspaces' address books, linked by `Customer.userId` — and
 * tenant resolution refuses a request without a membership, with a 404 so it
 * cannot be used to probe which workspaces exist. Mounted on the management
 * router, every call here would 404 for exactly the people it is built for.
 * That is the bug this router exists to fix, and it is why this file must be
 * mounted behind `authenticate -> apiRateLimit` and nothing else. The platform
 * admin surface is arranged the same way for the same structural reason: an
 * identity that is real but has no membership.
 *
 * There is consequently no `requirePermission` here either. Permissions are
 * resolved from a role attached to a membership; a customer has neither. The
 * authorisation on this surface is the scope itself — every query in
 * portal.service.ts is filtered to the `Customer` rows pointing at the
 * authenticated user — which is why no route below declares a guard of its own
 * and none should. A guard here would suggest the scope were optional.
 *
 * `bookingRateLimit` sits on the two writes, matching the anonymous manage-link
 * routes: being signed in makes a cancellation attributable, not cheap, and
 * these two move a real appointment in a real business's calendar.
 *
 * `validate` runs before every handler, so a malformed handle — or a body
 * carrying a `businessId` — is refused before a single query is issued.
 */
import { Router } from 'express';
import { bookingRateLimit } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as controller from './portal.controller';
import {
  bookingPublicIdParamsSchema,
  cancelBookingSchema,
  listBookingsQuerySchema,
  rescheduleBookingSchema,
  updatePreferencesSchema,
} from './portal.validation';

export const customerPortalRouter = Router();

// --- Who am I, and which businesses know me? -------------------------------

customerPortalRouter.get('/profile', controller.getProfile);

// --- My bookings, across every workspace at once ----------------------------
//
// Addressed by the same opaque `apt_…` handle the confirmation email carries,
// never by an internal id — so nothing about the shape of these paths invites a
// client to start sending workspace or appointment uuids.

customerPortalRouter.get(
  '/bookings',
  validate({ query: listBookingsQuerySchema }),
  controller.listBookings,
);

customerPortalRouter.get(
  '/bookings/:publicId',
  validate({ params: bookingPublicIdParamsSchema }),
  controller.getBooking,
);

customerPortalRouter.post(
  '/bookings/:publicId/cancel',
  bookingRateLimit,
  validate({ params: bookingPublicIdParamsSchema, body: cancelBookingSchema }),
  controller.cancelBooking,
);

customerPortalRouter.post(
  '/bookings/:publicId/reschedule',
  bookingRateLimit,
  validate({ params: bookingPublicIdParamsSchema, body: rescheduleBookingSchema }),
  controller.rescheduleBooking,
);

// --- How I want to be contacted ---------------------------------------------

customerPortalRouter.get('/preferences', controller.getPreferences);

customerPortalRouter.patch(
  '/preferences',
  validate({ body: updatePreferencesSchema }),
  controller.updatePreferences,
);
