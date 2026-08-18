/**
 * Teams HTTP layer.
 *
 * Controllers stay thin: read validated input, resolve the tenant from the
 * request context, call the service, shape the response. Every rule about who
 * may see what lives in teams.service.ts.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import type { TeamActor } from './teams.service';
import * as teamService from './teams.service';
import {
  addTeamMemberSchema,
  createTeamSchema,
  listTeamsQuerySchema,
  teamIdParamsSchema,
  teamMemberParamsSchema,
  updateTeamMemberSchema,
  updateTeamSchema,
} from './teams.validation';

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

function actorOf(req: Request): TeamActor {
  if (!req.auth) throw new UnauthenticatedError();
  return { userId: req.auth.userId, email: req.auth.email };
}

export const listTeams = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const filters = query(req, listTeamsQuerySchema);
  const result = await teamService.listTeams(businessId, filters);
  sendPage(res, result.rows, {
    page: result.page,
    pageSize: result.pageSize,
    totalItems: result.totalItems,
  });
});

export const createTeam = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const team = await teamService.createTeam(
    businessId,
    body(req, createTeamSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, team);
});

export const getTeam = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, teamIdParamsSchema);
  const { team, members } = await teamService.getTeam(businessId, id);
  sendSuccess(res, { ...team.toJSON(), members });
});

export const updateTeam = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, teamIdParamsSchema);
  const team = await teamService.updateTeam(
    businessId,
    id,
    body(req, updateTeamSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, team);
});

export const deleteTeam = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, teamIdParamsSchema);
  await teamService.deleteTeam(businessId, id, actorOf(req), metadataOf(req));
  sendNoContent(res);
});

export const addTeamMember = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, teamIdParamsSchema);
  const member = await teamService.addTeamMember(
    businessId,
    id,
    body(req, addTeamMemberSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, member);
});

export const updateTeamMember = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id, memberId } = params(req, teamMemberParamsSchema);
  const member = await teamService.updateTeamMember(
    businessId,
    id,
    memberId,
    body(req, updateTeamMemberSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, member);
});

export const removeTeamMember = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id, memberId } = params(req, teamMemberParamsSchema);
  await teamService.removeTeamMember(businessId, id, memberId, actorOf(req), metadataOf(req));
  sendNoContent(res);
});
