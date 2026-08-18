/**
 * Workspace HTTP layer.
 *
 * Note the split in business.routes.ts: creating a workspace is authenticated
 * but *not* tenant-scoped — you cannot already be a member of a workspace that
 * does not exist. Every other route here is tenant-scoped as usual.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendSuccess } from '../../utils/http';
import * as service from './business.service';
import type {
  CreateBusinessBody,
  UpdateBusinessBody,
  UpdateSettingsBody,
} from './business.validation';

function metadataOf(req: Request) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

function actorOf(req: Request): { userId: string; email: string } {
  if (!req.auth) throw new UnauthenticatedError();
  return { userId: req.auth.userId, email: req.auth.email };
}

export const create = asyncHandler(async (req: Request, res: Response) => {
  const actor = actorOf(req);
  const input = req.body as CreateBusinessBody;

  await service.assertNoDuplicateForOwner(actor.userId, input.name);
  const result = await service.createBusiness(actor.userId, input, metadataOf(req));

  sendCreated(res, {
    business: result.business,
    membership: {
      id: result.membership.id,
      roleId: result.membership.roleId,
      status: result.membership.status,
    },
    staffProfile: result.staffProfile
      ? { id: result.staffProfile.id, displayName: result.staffProfile.displayName }
      : null,
  });
});

export const show = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  sendSuccess(res, await service.getBusiness(tenant.businessId));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const updated = await service.updateBusiness(
    tenant.businessId,
    req.body as UpdateBusinessBody,
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, updated);
});

export const showSettings = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  sendSuccess(res, await service.getSettings(tenant.businessId));
});

export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const updated = await service.updateSettings(
    tenant.businessId,
    req.body as UpdateSettingsBody,
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, updated);
});

export const listMembers = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  sendSuccess(res, await service.listMembers(tenant.businessId));
});

export const listRoles = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  sendSuccess(res, await service.listRoles(tenant.businessId));
});

export const checkSlug = asyncHandler(async (req: Request, res: Response) => {
  const { slug } = req.query as { slug: string };
  // Reports availability only — never which workspace holds a taken slug.
  sendSuccess(res, { slug, available: await service.isSlugAvailable(slug) });
});
