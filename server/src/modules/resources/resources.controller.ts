/**
 * Resources HTTP layer.
 *
 * Controllers stay thin: read validated input, take the tenant from the proven
 * membership, call the service, shape the response. All business rules live in
 * resources.service.ts.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import * as resourceService from './resources.service';
import {
  createResourceSchema,
  listResourcesQuerySchema,
  replaceServiceRequirementsSchema,
  resourceIdParamsSchema,
  serviceIdParamsSchema,
  updateResourceSchema,
} from './resources.validation';

function actorOf(req: Request): resourceService.ResourceActor {
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
  const filters = query(req, listResourcesQuerySchema);
  const { rows, totalItems } = await resourceService.listResources(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const resource = await resourceService.createResource(
    tenantOf(req).businessId,
    body(req, createResourceSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, resource);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, resourceIdParamsSchema);
  const resource = await resourceService.getResource(tenantOf(req).businessId, id);
  sendSuccess(res, resource);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, resourceIdParamsSchema);
  const resource = await resourceService.updateResource(
    tenantOf(req).businessId,
    id,
    body(req, updateResourceSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, resource);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, resourceIdParamsSchema);
  await resourceService.deleteResource(tenantOf(req).businessId, id, actorOf(req), metadataOf(req));
  sendNoContent(res);
});

export const listRequirements = asyncHandler(async (req: Request, res: Response) => {
  const { serviceId } = params(req, serviceIdParamsSchema);
  const rows = await resourceService.listServiceRequirements(tenantOf(req).businessId, serviceId);
  sendSuccess(res, rows);
});

export const replaceRequirements = asyncHandler(async (req: Request, res: Response) => {
  const { serviceId } = params(req, serviceIdParamsSchema);
  const { requirements } = body(req, replaceServiceRequirementsSchema);
  const rows = await resourceService.replaceServiceRequirements(
    tenantOf(req).businessId,
    serviceId,
    requirements,
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, rows);
});
