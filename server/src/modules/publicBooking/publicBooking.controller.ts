/**
 * Public booking HTTP layer.
 *
 * Controllers stay thin: read validated input, resolve the slug to a tenant,
 * call the service, return the shaped result. Every rule about what a slug may
 * reach lives in publicBooking.service.ts.
 *
 * The one thing this layer owns is the tenant handshake. `linkOf` is the single
 * door through which a public request acquires a workspace, and it populates
 * `req.publicBooking` so the context is visible to anything downstream that
 * inspects the request.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { body, params, query } from '../../middleware/validate';
import { asyncHandler, sendCreated, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import * as service from './publicBooking.service';
import {
  appointmentPublicIdParamsSchema,
  bookingLinkSlugParamsSchema,
  cancelPublicAppointmentSchema,
  createPublicBookingSchema,
  publicAvailabilityQuerySchema,
  reschedulePublicAppointmentSchema,
} from './publicBooking.validation';

/** Optional, and case-insensitive as all header lookups are. */
const IDEMPOTENCY_HEADER = 'x-idempotency-key';

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
 * Nothing else in this file may establish a tenant, and no handler reads one
 * from the body, the query or a header.
 */
async function linkOf(req: Request): Promise<service.ResolvedBookingLink> {
  const { slug } = params(req, bookingLinkSlugParamsSchema);
  const resolved = await service.resolveBookingLink(slug);
  req.publicBooking = service.toPublicBookingContext(resolved);
  return resolved;
}

export const showBookingLink = asyncHandler(async (req: Request, res: Response) => {
  const resolved = await linkOf(req);
  sendSuccess(res, await service.getPublicConfig(resolved));
});

export const showAvailability = asyncHandler(async (req: Request, res: Response) => {
  const resolved = await linkOf(req);
  const slots = await service.searchPublicAvailability(
    resolved,
    query(req, publicAvailabilityQuerySchema),
  );
  sendSuccess(res, slots);
});

export const createBooking = asyncHandler(async (req: Request, res: Response) => {
  const resolved = await linkOf(req);

  const confirmation = await service.createPublicBooking(
    resolved,
    body(req, createPublicBookingSchema),
    {
      idempotencyKey: service.readIdempotencyKey(req.header(IDEMPOTENCY_HEADER)),
      metadata: metadataOf(req),
    },
  );

  // A replay created nothing on this request, so it answers 200 with the
  // original booking rather than claiming a second 201.
  if (confirmation.replayed) {
    sendSuccess(res, confirmation);
    return;
  }
  sendCreated(res, confirmation);
});

export const showAppointment = asyncHandler(async (req: Request, res: Response) => {
  const { publicId } = params(req, appointmentPublicIdParamsSchema);
  sendSuccess(res, await service.getPublicAppointment(publicId));
});

export const rescheduleAppointment = asyncHandler(async (req: Request, res: Response) => {
  const { publicId } = params(req, appointmentPublicIdParamsSchema);
  const updated = await service.reschedulePublicAppointment(
    publicId,
    body(req, reschedulePublicAppointmentSchema),
    metadataOf(req),
  );
  sendSuccess(res, updated);
});

export const cancelAppointment = asyncHandler(async (req: Request, res: Response) => {
  const { publicId } = params(req, appointmentPublicIdParamsSchema);
  const cancelled = await service.cancelPublicAppointment(
    publicId,
    body(req, cancelPublicAppointmentSchema),
    metadataOf(req),
  );
  sendSuccess(res, cancelled);
});
