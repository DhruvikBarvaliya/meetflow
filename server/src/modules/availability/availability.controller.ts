/**
 * Availability HTTP layer.
 *
 * Controllers stay thin: read validated input, take the tenant from the proven
 * membership, call the service, shape the response. All business rules live in
 * availability.service.ts.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import { PERMISSIONS } from '../auth/permissions';
import * as availabilityService from './availability.service';
import {
  createBlackoutSchema,
  createHolidaySchema,
  createOverrideSchema,
  idParamsSchema,
  listBlackoutsQuerySchema,
  listBusinessHoursQuerySchema,
  listHolidaysQuerySchema,
  listOverridesQuerySchema,
  listStaffRulesQuerySchema,
  replaceBusinessHoursSchema,
  replaceStaffRulesSchema,
  staffProfileIdParamsSchema,
} from './availability.validation';

/**
 * Whether the caller may edit anyone's availability is resolved here, from the
 * same effective permission set `requireAnyPermission` used, because the router
 * cannot decide it: whether a request is "own" depends on the row it touches.
 */
function actorOf(req: Request): availabilityService.AvailabilityActor {
  if (!req.auth) throw new UnauthenticatedError();
  const tenant = tenantOf(req);
  return {
    userId: req.auth.userId,
    email: req.auth.email,
    staffProfileId: tenant.staffProfileId,
    canManageAll: tenant.permissions.has(PERMISSIONS.AVAILABILITY_MANAGE),
  };
}

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

export const listBusinessHours = asyncHandler(async (req: Request, res: Response) => {
  const filters = query(req, listBusinessHoursQuerySchema);
  const { rows, totalItems } = await availabilityService.listBusinessHours(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const replaceBusinessHours = asyncHandler(async (req: Request, res: Response) => {
  const hours = await availabilityService.replaceBusinessHours(
    tenantOf(req).businessId,
    body(req, replaceBusinessHoursSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, hours);
});

export const listStaffRules = asyncHandler(async (req: Request, res: Response) => {
  const { staffProfileId } = params(req, staffProfileIdParamsSchema);
  const filters = query(req, listStaffRulesQuerySchema);
  const { rows, totalItems } = await availabilityService.listStaffRules(
    tenantOf(req).businessId,
    staffProfileId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const replaceStaffRules = asyncHandler(async (req: Request, res: Response) => {
  const { staffProfileId } = params(req, staffProfileIdParamsSchema);
  const rules = await availabilityService.replaceStaffRules(
    tenantOf(req).businessId,
    staffProfileId,
    body(req, replaceStaffRulesSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, rules);
});

export const listOverrides = asyncHandler(async (req: Request, res: Response) => {
  const filters = query(req, listOverridesQuerySchema);
  const { rows, totalItems } = await availabilityService.listOverrides(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const createOverride = asyncHandler(async (req: Request, res: Response) => {
  const override = await availabilityService.createOverride(
    tenantOf(req).businessId,
    body(req, createOverrideSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, override);
});

export const removeOverride = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, idParamsSchema);
  await availabilityService.deleteOverride(
    tenantOf(req).businessId,
    id,
    actorOf(req),
    metadataOf(req),
  );
  sendNoContent(res);
});

export const listHolidays = asyncHandler(async (req: Request, res: Response) => {
  const filters = query(req, listHolidaysQuerySchema);
  const { rows, totalItems } = await availabilityService.listHolidays(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const createHoliday = asyncHandler(async (req: Request, res: Response) => {
  const holiday = await availabilityService.createHoliday(
    tenantOf(req).businessId,
    body(req, createHolidaySchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, holiday);
});

export const removeHoliday = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, idParamsSchema);
  await availabilityService.deleteHoliday(
    tenantOf(req).businessId,
    id,
    actorOf(req),
    metadataOf(req),
  );
  sendNoContent(res);
});

export const listBlackouts = asyncHandler(async (req: Request, res: Response) => {
  const filters = query(req, listBlackoutsQuerySchema);
  const { rows, totalItems } = await availabilityService.listBlackouts(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const createBlackout = asyncHandler(async (req: Request, res: Response) => {
  const blackout = await availabilityService.createBlackout(
    tenantOf(req).businessId,
    body(req, createBlackoutSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, blackout);
});

export const removeBlackout = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, idParamsSchema);
  await availabilityService.deleteBlackout(
    tenantOf(req).businessId,
    id,
    actorOf(req),
    metadataOf(req),
  );
  sendNoContent(res);
});
