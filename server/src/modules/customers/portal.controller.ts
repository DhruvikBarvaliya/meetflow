/**
 * Customer-portal HTTP layer.
 *
 * Controllers stay thin: read validated input, resolve who is asking, call the
 * service, send the envelope. Every rule about what a customer may see or
 * change lives in portal.service.ts.
 *
 * The one thing this layer owns is the identity handshake, and it is the mirror
 * image of the management surface's. There, `tenantOf(req)` returns a workspace
 * proven by a membership. Here there is no membership and no workspace, so
 * `scopeOf(req)` returns the set of customer records proven by the access
 * token. Both are the single door through which a request acquires its scope,
 * and neither reads anything a client sent: no handler in this file touches a
 * header, a query parameter or a body field to decide whose data to return.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import * as portalService from './portal.service';
import type { PortalScope } from './portal.service';
import {
  bookingPublicIdParamsSchema,
  cancelBookingSchema,
  listBookingsQuerySchema,
  rescheduleBookingSchema,
  updatePreferencesSchema,
} from './portal.validation';

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

/**
 * The caller's customer records, or a hard failure.
 *
 * Called at the top of every handler rather than resolved once in middleware,
 * for the same reason `requireTenant` re-reads a membership on every request: a
 * record that has been unlinked, or a workspace that has been deleted, must
 * stop being readable on the very next call rather than when a cache expires.
 */
async function scopeOf(req: Request): Promise<PortalScope> {
  if (!req.auth) throw new UnauthenticatedError();
  return portalService.resolveScope(req.auth.userId);
}

export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const scope = await scopeOf(req);
  sendSuccess(res, await portalService.getProfile(scope));
});

export const listBookings = asyncHandler(async (req: Request, res: Response) => {
  const scope = await scopeOf(req);
  const filters = query(req, listBookingsQuerySchema);
  const result = await portalService.listBookings(scope, filters);
  sendPage(res, result.rows, {
    page: filters.page,
    pageSize: filters.pageSize,
    totalItems: result.totalItems,
  });
});

export const getBooking = asyncHandler(async (req: Request, res: Response) => {
  const scope = await scopeOf(req);
  const { publicId } = params(req, bookingPublicIdParamsSchema);
  sendSuccess(res, await portalService.getBooking(scope, publicId));
});

export const cancelBooking = asyncHandler(async (req: Request, res: Response) => {
  const scope = await scopeOf(req);
  const { publicId } = params(req, bookingPublicIdParamsSchema);
  const cancelled = await portalService.cancelBooking(
    scope,
    publicId,
    body(req, cancelBookingSchema),
    metadataOf(req),
  );
  sendSuccess(res, cancelled);
});

export const rescheduleBooking = asyncHandler(async (req: Request, res: Response) => {
  const scope = await scopeOf(req);
  const { publicId } = params(req, bookingPublicIdParamsSchema);
  const moved = await portalService.rescheduleBooking(
    scope,
    publicId,
    body(req, rescheduleBookingSchema),
    metadataOf(req),
  );
  sendSuccess(res, moved);
});

export const getPreferences = asyncHandler(async (req: Request, res: Response) => {
  const scope = await scopeOf(req);
  sendSuccess(res, portalService.getPreferences(scope));
});

export const updatePreferences = asyncHandler(async (req: Request, res: Response) => {
  const scope = await scopeOf(req);
  const updated = await portalService.updatePreferences(
    scope,
    body(req, updatePreferencesSchema),
    metadataOf(req),
  );
  sendSuccess(res, updated);
});
