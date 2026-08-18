/**
 * Waitlist HTTP layer.
 *
 * Controllers stay thin: read validated input, take the tenant from the proven
 * membership, call the service, shape the response. All business rules live in
 * waitlist.service.ts and waitlist.matcher.ts.
 *
 * One thing is settled at this boundary and only here: **who is acting**. A
 * conversion writes a real appointment, and "the owner took them off the
 * waitlist" is a materially different fact from "the front desk did", so the
 * caller's role is resolved once and handed down.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import type { SystemRoleKey } from '../auth/permissions';
import * as waitlistService from './waitlist.service';
import {
  convertWaitlistEntrySchema,
  createWaitlistEntrySchema,
  listWaitlistQuerySchema,
  updateWaitlistEntrySchema,
  waitlistIdParamSchema,
} from './waitlist.validation';

/** Tied to the role catalogue so a renamed key breaks the build, not the audit. */
const OWNER_ROLE_KEY: SystemRoleKey = 'BUSINESS_OWNER';

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

function actorOf(req: Request): waitlistService.WaitlistActor {
  if (!req.auth) throw new UnauthenticatedError();
  return {
    userId: req.auth.userId,
    email: req.auth.email,
    type: tenantOf(req).roleKey === OWNER_ROLE_KEY ? 'OWNER' : 'STAFF',
  };
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const filters = query(req, listWaitlistQuerySchema);
  const { rows, totalItems } = await waitlistService.listWaitlistEntries(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const entry = await waitlistService.createWaitlistEntry(
    tenantOf(req).businessId,
    body(req, createWaitlistEntrySchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, entry);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, waitlistIdParamSchema);
  sendSuccess(res, await waitlistService.getWaitlistEntry(tenantOf(req).businessId, id));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, waitlistIdParamSchema);
  const entry = await waitlistService.updateWaitlistEntry(
    tenantOf(req).businessId,
    id,
    body(req, updateWaitlistEntrySchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, entry);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, waitlistIdParamSchema);
  await waitlistService.cancelWaitlistEntry(
    tenantOf(req).businessId,
    id,
    actorOf(req),
    metadataOf(req),
  );
  sendNoContent(res);
});

export const notify = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, waitlistIdParamSchema);
  const entry = await waitlistService.notifyWaitlistEntry(
    tenantOf(req).businessId,
    id,
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, entry);
});

export const convert = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, waitlistIdParamSchema);
  const { startsAt } = body(req, convertWaitlistEntrySchema);

  const result = await waitlistService.convertWaitlistEntry(
    tenantOf(req).businessId,
    id,
    startsAt,
    actorOf(req),
    metadataOf(req),
  );

  // 201: the meaningful outcome of this call is a new appointment.
  sendCreated(res, { entry: result.entry, appointment: result.appointment });
});
