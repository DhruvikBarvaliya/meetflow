/**
 * Staff HTTP layer.
 *
 * Controllers stay thin: read validated input, take the tenant from the proven
 * membership, call the service, shape the response. All business rules live in
 * staff.service.ts.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import * as staffService from './staff.service';
import {
  createStaffSchema,
  listStaffQuerySchema,
  replaceStaffServicesSchema,
  staffIdParamsSchema,
  updateStaffSchema,
} from './staff.validation';

function actorOf(req: Request): staffService.StaffActor {
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
  const filters = query(req, listStaffQuerySchema);
  const { rows, totalItems } = await staffService.listStaff(tenantOf(req).businessId, filters);
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const staff = await staffService.createStaffProfile(
    tenantOf(req).businessId,
    body(req, createStaffSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, staff);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, staffIdParamsSchema);
  const staff = await staffService.getStaff(tenantOf(req).businessId, id);
  sendSuccess(res, staff);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, staffIdParamsSchema);
  const staff = await staffService.updateStaffProfile(
    tenantOf(req).businessId,
    id,
    body(req, updateStaffSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, staff);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, staffIdParamsSchema);
  await staffService.deleteStaffProfile(
    tenantOf(req).businessId,
    id,
    actorOf(req),
    metadataOf(req),
  );
  sendNoContent(res);
});

export const listServices = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, staffIdParamsSchema);
  const assignments = await staffService.listStaffServices(tenantOf(req).businessId, id);
  sendSuccess(res, assignments);
});

export const replaceServices = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, staffIdParamsSchema);
  const assignments = await staffService.replaceStaffServices(
    tenantOf(req).businessId,
    id,
    body(req, replaceStaffServicesSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, assignments);
});
