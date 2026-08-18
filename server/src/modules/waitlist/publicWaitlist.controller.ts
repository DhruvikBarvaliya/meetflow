/**
 * Public waitlist HTTP layer.
 *
 * Controllers stay thin, exactly as publicBooking's do: read validated input,
 * resolve the slug or the handle, call the service, return the shaped result.
 * Every rule about what a slug may reach lives in publicWaitlist.service.ts.
 *
 * The one thing this layer owns is the tenant handshake on the join path.
 * `linkOf` is the single door through which a join acquires a workspace, and it
 * populates `req.publicBooking` so the context is visible to anything
 * downstream that inspects the request — the same handshake, through the same
 * resolver, that a booking through the same link performs.
 *
 * The claim and read paths have no handshake to do: they are addressed by the
 * entry's own opaque handle, and the workspace is read off the row it names.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { body, params } from '../../middleware/validate';
import { asyncHandler, sendCreated, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import {
  resolveBookingLink,
  toPublicBookingContext,
  type ResolvedBookingLink,
} from '../publicBooking/publicBooking.service';
import { bookingLinkSlugParamsSchema } from '../publicBooking/publicBooking.validation';
import * as service from './publicWaitlist.service';
import { joinWaitlistSchema, waitlistPublicIdParamsSchema } from './publicWaitlist.validation';

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

/**
 * Resolves the slug in the path to an open booking link, and records the
 * resulting context on the request.
 *
 * Deliberately the *same* resolver the booking surface uses rather than a
 * lookup of its own: an expired or exhausted link stops taking waitlist
 * requests at the moment it stops taking bookings, and a second implementation
 * is how those two dates start drifting apart.
 */
async function linkOf(req: Request): Promise<ResolvedBookingLink> {
  const { slug } = params(req, bookingLinkSlugParamsSchema);
  const resolved = await resolveBookingLink(slug);
  req.publicBooking = toPublicBookingContext(resolved);
  return resolved;
}

export const joinWaitlist = asyncHandler(async (req: Request, res: Response) => {
  const resolved = await linkOf(req);
  const entry = await service.joinWaitlistFromLink(
    resolved,
    body(req, joinWaitlistSchema),
    metadataOf(req),
  );
  // 201: the meaningful outcome of this call is a new standing request.
  sendCreated(res, entry);
});

export const showOffer = asyncHandler(async (req: Request, res: Response) => {
  const { publicId } = params(req, waitlistPublicIdParamsSchema);
  sendSuccess(res, await service.getPublicWaitlistEntry(publicId));
});

export const claimOffer = asyncHandler(async (req: Request, res: Response) => {
  const { publicId } = params(req, waitlistPublicIdParamsSchema);
  const claim = await service.claimWaitlistOffer(publicId, metadataOf(req));
  // 201: an appointment now exists that did not before.
  sendCreated(res, claim);
});
