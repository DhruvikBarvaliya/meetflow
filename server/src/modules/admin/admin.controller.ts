/**
 * Platform administration HTTP layer.
 *
 * Controllers stay thin: read validated input, identify the operator, call the
 * service, send the envelope. Every rule about what an admin may see and what
 * they may change lives in admin.service.ts.
 *
 * Note what is missing compared with every other controller in the codebase:
 * there is no `tenantOf(req)`. A platform admin holds no membership in the
 * workspaces they administer, so there is no tenant to resolve and the workspace
 * id arrives as an ordinary path parameter instead. That absence is the reason
 * this surface is mounted on its own router rather than beside the tenant ones.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import type { AdminActor } from './admin.service';
import * as adminService from './admin.service';
import {
  listAuditLogsQuerySchema,
  listUsersQuerySchema,
  listWorkspacesQuerySchema,
  updatePlatformRoleSchema,
  updateUserStatusSchema,
  updateWorkspaceStatusSchema,
  userIdParamsSchema,
  workspaceIdParamsSchema,
} from './admin.validation';

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

/**
 * The operator behind the request. Read from `req.auth` rather than from the
 * body, so the self-protection rules in the service compare the acting account
 * with the target and cannot be talked out of it by a crafted payload.
 */
function actorOf(req: Request): AdminActor {
  if (!req.auth) throw new UnauthenticatedError();
  return { userId: req.auth.userId, email: req.auth.email };
}

export const getOverview = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, await adminService.getOverview());
});

export const listWorkspaces = asyncHandler(async (req: Request, res: Response) => {
  const result = await adminService.listWorkspaces(query(req, listWorkspacesQuerySchema));
  sendPage(res, result.rows, {
    page: result.page,
    pageSize: result.pageSize,
    totalItems: result.totalItems,
  });
});

export const getWorkspace = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, workspaceIdParamsSchema);
  sendSuccess(res, await adminService.getWorkspace(id));
});

export const updateWorkspaceStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, workspaceIdParamsSchema);
  const workspace = await adminService.updateWorkspaceStatus(
    id,
    body(req, updateWorkspaceStatusSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, workspace);
});

export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const result = await adminService.listUsers(query(req, listUsersQuerySchema));
  sendPage(res, result.rows, {
    page: result.page,
    pageSize: result.pageSize,
    totalItems: result.totalItems,
  });
});

export const getUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, userIdParamsSchema);
  sendSuccess(res, await adminService.getUser(id));
});

export const updateUserStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, userIdParamsSchema);
  const user = await adminService.updateUserStatus(
    id,
    body(req, updateUserStatusSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, user);
});

export const updatePlatformRole = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, userIdParamsSchema);
  const user = await adminService.updatePlatformRole(
    id,
    body(req, updatePlatformRoleSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, user);
});

export const listAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const result = await adminService.listAuditLogs(query(req, listAuditLogsQuerySchema));
  sendPage(res, result.rows, {
    page: result.page,
    pageSize: result.pageSize,
    totalItems: result.totalItems,
  });
});

export const getSystemHealth = asyncHandler(async (_req: Request, res: Response) => {
  // Always 200, even when a dependency is down. This endpoint reports on the
  // platform rather than on itself, and a 503 here would make the one page that
  // could explain an outage disappear during one.
  sendSuccess(res, await adminService.getSystemHealth());
});
