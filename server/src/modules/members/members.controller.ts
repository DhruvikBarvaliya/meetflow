/**
 * Members HTTP layer.
 *
 * Controllers stay thin: read validated input, resolve the tenant from the
 * request context, call the service, shape the response. Every rule about who
 * may be invited, promoted, suspended or removed lives in members.service.ts —
 * including the guards that stop a workspace locking itself out, which must
 * hold for any caller of the service and not only for one that arrived by HTTP.
 *
 * The two invitation handlers at the bottom are the exception to the "resolve
 * the tenant" line, and deliberately so: an invitee has no active membership
 * yet, so there is no tenant to resolve. They read `req.auth` alone.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import type { MemberActor } from './members.service';
import * as memberService from './members.service';
import {
  acceptInvitationSchema,
  inviteMemberSchema,
  listMembersQuerySchema,
  memberIdParamsSchema,
  replaceMemberPermissionsSchema,
  updateMemberSchema,
} from './members.validation';

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

function actorOf(req: Request): MemberActor {
  if (!req.auth) throw new UnauthenticatedError();
  return { userId: req.auth.userId, email: req.auth.email };
}

export const listMembers = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const filters = query(req, listMembersQuerySchema);
  const result = await memberService.listMembers(businessId, filters);
  sendPage(res, result.rows, {
    page: result.page,
    pageSize: result.pageSize,
    totalItems: result.totalItems,
  });
});

export const inviteMember = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const member = await memberService.inviteMember(
    businessId,
    body(req, inviteMemberSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, member);
});

export const updateMember = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, memberIdParamsSchema);
  const member = await memberService.updateMember(
    businessId,
    id,
    body(req, updateMemberSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, member);
});

export const removeMember = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, memberIdParamsSchema);
  await memberService.removeMember(businessId, id, actorOf(req), metadataOf(req));
  sendNoContent(res);
});

export const getMemberPermissions = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, memberIdParamsSchema);
  sendSuccess(res, await memberService.getMemberPermissions(businessId, id));
});

export const replaceMemberPermissions = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, memberIdParamsSchema);
  const permissions = await memberService.replaceMemberPermissions(
    businessId,
    id,
    body(req, replaceMemberPermissionsSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, permissions);
});

export const listInvitations = asyncHandler(async (req: Request, res: Response) => {
  sendSuccess(res, await memberService.listInvitations(actorOf(req).userId));
});

export const acceptInvitation = asyncHandler(async (req: Request, res: Response) => {
  const { token } = body(req, acceptInvitationSchema);
  const membership = await memberService.acceptInvitation(
    actorOf(req).userId,
    token,
    metadataOf(req),
  );
  sendSuccess(res, membership);
});
