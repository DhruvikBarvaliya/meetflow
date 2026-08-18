/**
 * Booking links HTTP layer.
 *
 * Controllers stay thin: read validated input, take the tenant from the proven
 * membership, call the service, shape the response. All business rules live in
 * bookingLinks.service.ts.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import * as bookingLinkService from './bookingLinks.service';
import {
  bookingLinkIdParamsSchema,
  createBookingLinkSchema,
  listBookingLinksQuerySchema,
  replaceBookingLinkServicesSchema,
  updateBookingLinkSchema,
} from './bookingLinks.validation';

function actorOf(req: Request): bookingLinkService.BookingLinkActor {
  if (!req.auth) throw new UnauthenticatedError();
  return { userId: req.auth.userId, email: req.auth.email };
}

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const filters = query(req, listBookingLinksQuerySchema);
  const { rows, totalItems } = await bookingLinkService.listBookingLinks(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const link = await bookingLinkService.createBookingLink(
    tenantOf(req).businessId,
    body(req, createBookingLinkSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, link);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, bookingLinkIdParamsSchema);
  const link = await bookingLinkService.getBookingLink(tenantOf(req).businessId, id);
  sendSuccess(res, link);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, bookingLinkIdParamsSchema);
  const link = await bookingLinkService.updateBookingLink(
    tenantOf(req).businessId,
    id,
    body(req, updateBookingLinkSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, link);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, bookingLinkIdParamsSchema);
  await bookingLinkService.deleteBookingLink(
    tenantOf(req).businessId,
    id,
    actorOf(req),
    metadataOf(req),
  );
  sendNoContent(res);
});

export const replaceServices = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, bookingLinkIdParamsSchema);
  const { serviceIds } = body(req, replaceBookingLinkServicesSchema);
  const link = await bookingLinkService.replaceBookingLinkServices(
    tenantOf(req).businessId,
    id,
    serviceIds,
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, link);
});
