/**
 * Locations HTTP layer.
 *
 * Controllers stay thin: read validated input, take the tenant from the proven
 * membership, call the service, shape the response. All business rules live in
 * locations.service.ts.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import * as locationService from './locations.service';
import {
  createLocationSchema,
  listLocationsQuerySchema,
  locationIdParamSchema,
  updateLocationSchema,
} from './locations.validation';

function actorOf(req: Request): locationService.LocationActor {
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
  const filters = query(req, listLocationsQuerySchema);
  const { rows, totalItems } = await locationService.listLocations(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const location = await locationService.createLocation(
    tenantOf(req).businessId,
    body(req, createLocationSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, location);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, locationIdParamSchema);
  const location = await locationService.getLocation(tenantOf(req).businessId, id);
  sendSuccess(res, location);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, locationIdParamSchema);
  const location = await locationService.updateLocation(
    tenantOf(req).businessId,
    id,
    body(req, updateLocationSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, location);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, locationIdParamSchema);
  await locationService.deleteLocation(tenantOf(req).businessId, id, actorOf(req), metadataOf(req));
  sendNoContent(res);
});
