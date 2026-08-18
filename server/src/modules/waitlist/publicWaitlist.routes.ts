/**
 * `/api/v1/public` — the waitlist half.
 *
 * A second router on the public surface rather than a mount under a prefix of
 * its own, because one of its three paths belongs to a booking link and the
 * other two to an offer. Declaring full paths here keeps
 * `POST /booking-links/:slug/waitlist` sitting next to the bookings endpoint it
 * mirrors, which is where a customer's client would look for it.
 *
 * There is no `authenticate`, no `requireTenant` and no `requirePermission`
 * here, by design and for the same reason publicBooking has none: the tenant is
 * the workspace behind the slug or behind the offer handle, and the only
 * authorisation that exists is "this link publishes this thing" and "you were
 * sent this offer", both enforced in publicWaitlist.service.ts.
 *
 * That makes rate limiting the load-bearing defence, and it is layered exactly
 * as it is next door:
 *
 *   publicRateLimit  — applied by the parent router to every path here
 *   bookingRateLimit — the tight bucket, on both writes. Joining creates a
 *                      customer record from an anonymous request and claiming
 *                      creates an appointment; both deserve the bucket the
 *                      product's most abuse-sensitive write uses.
 *
 * The read is left on the parent bucket alone: it is one indexed lookup by an
 * unguessable handle, and a customer refreshing the page while they decide
 * whether to take a slot must not be throttled out of claiming it.
 *
 * `validate` runs before every handler, so a malformed slug or handle — and a
 * body carrying a `businessId` — is refused before a single query is issued.
 */
import { Router } from 'express';
import { bookingRateLimit } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { bookingLinkSlugParamsSchema } from '../publicBooking/publicBooking.validation';
import * as controller from './publicWaitlist.controller';
import {
  claimWaitlistOfferSchema,
  joinWaitlistSchema,
  waitlistPublicIdParamsSchema,
} from './publicWaitlist.validation';

export const publicWaitlistRouter = Router();

// --- Joining from a booking page -------------------------------------------

publicWaitlistRouter.post(
  '/booking-links/:slug/waitlist',
  bookingRateLimit,
  validate({ params: bookingLinkSlugParamsSchema, body: joinWaitlistSchema }),
  controller.joinWaitlist,
);

// --- One offer --------------------------------------------------------------
//
// Addressed by the opaque `wlt_…` handle from the offer email. It behaves like
// a bearer token, which is why these two routes never widen: they read, or
// accept, exactly the one offer named in the path.

publicWaitlistRouter.get(
  '/waitlist/:publicId',
  validate({ params: waitlistPublicIdParamsSchema }),
  controller.showOffer,
);

publicWaitlistRouter.post(
  '/waitlist/:publicId/claim',
  bookingRateLimit,
  validate({ params: waitlistPublicIdParamsSchema, body: claimWaitlistOfferSchema }),
  controller.claimOffer,
);
