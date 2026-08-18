/**
 * Services HTTP layer.
 *
 * Controllers stay thin: read validated input, take the tenant from the proven
 * membership, call the service, shape the response. All business rules live in
 * services.service.ts.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import * as serviceCatalogue from './services.service';
import {
  categoryIdParamsSchema,
  createCategorySchema,
  createServiceSchema,
  listCategoriesQuerySchema,
  listServicesQuerySchema,
  replaceServiceLocationsSchema,
  replaceServiceStaffSchema,
  serviceIdParamsSchema,
  updateCategorySchema,
  updateServiceSchema,
} from './services.validation';

function actorOf(req: Request): serviceCatalogue.ServiceActor {
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

export const listCategories = asyncHandler(async (req: Request, res: Response) => {
  const filters = query(req, listCategoriesQuerySchema);
  const { rows, totalItems } = await serviceCatalogue.listCategories(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const createCategory = asyncHandler(async (req: Request, res: Response) => {
  const category = await serviceCatalogue.createCategory(
    tenantOf(req).businessId,
    body(req, createCategorySchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, category);
});

export const updateCategory = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, categoryIdParamsSchema);
  const category = await serviceCatalogue.updateCategory(
    tenantOf(req).businessId,
    id,
    body(req, updateCategorySchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, category);
});

export const removeCategory = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, categoryIdParamsSchema);
  await serviceCatalogue.deleteCategory(
    tenantOf(req).businessId,
    id,
    actorOf(req),
    metadataOf(req),
  );
  sendNoContent(res);
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const filters = query(req, listServicesQuerySchema);
  const { rows, totalItems } = await serviceCatalogue.listServices(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const service = await serviceCatalogue.createService(
    tenantOf(req).businessId,
    body(req, createServiceSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, service);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, serviceIdParamsSchema);
  const service = await serviceCatalogue.getService(tenantOf(req).businessId, id);
  sendSuccess(res, service);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, serviceIdParamsSchema);
  const service = await serviceCatalogue.updateService(
    tenantOf(req).businessId,
    id,
    body(req, updateServiceSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, service);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, serviceIdParamsSchema);
  await serviceCatalogue.deleteService(tenantOf(req).businessId, id, actorOf(req), metadataOf(req));
  sendNoContent(res);
});

export const replaceStaff = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, serviceIdParamsSchema);
  const { staffProfileIds } = body(req, replaceServiceStaffSchema);
  const assignments = await serviceCatalogue.replaceServiceStaff(
    tenantOf(req).businessId,
    id,
    staffProfileIds,
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, assignments);
});

export const replaceLocations = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, serviceIdParamsSchema);
  const { locationIds } = body(req, replaceServiceLocationsSchema);
  const assignments = await serviceCatalogue.replaceServiceLocations(
    tenantOf(req).businessId,
    id,
    locationIds,
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, assignments);
});
