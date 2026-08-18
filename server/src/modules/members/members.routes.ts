/**
 * `/api/v1/members`
 *
 * Split into two routers, and the split is load-bearing.
 *
 * `membersRouter` is the workspace's people-management surface. It mounts on
 * the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore only
 * declares what each endpoint additionally requires. The permission guard runs
 * before validation so a caller who may not touch members learns nothing about
 * the shape of the payload — which matters more here than anywhere else in the
 * product, because this is the surface that hands out authority.
 *
 * `memberInvitesRouter` is authenticated but deliberately NOT tenant-scoped,
 * for the same reason `workspaceCreationRouter` is not: `requireTenant`
 * resolves an *ACTIVE* membership, and someone who has been invited but has not
 * accepted has none. Mounted on the management router, every acceptance would
 * 404 and an invited member would be stranded — which is precisely the failure
 * this module exists to remove. It carries its own rate limit because it is
 * mounted outside that chain.
 *
 * Neither router names a permission for acceptance, and that is not an
 * oversight: the only rows either endpoint can reach are invitations addressed
 * to the caller's own account, so there is no authority to check beyond being
 * signed in.
 */
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { apiRateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './members.controller';
import {
  acceptInvitationSchema,
  inviteMemberSchema,
  listMembersQuerySchema,
  memberIdParamsSchema,
  replaceMemberPermissionsSchema,
  updateMemberSchema,
} from './members.validation';

/** Mounted on the tenant-scoped management router. */
export const membersRouter = Router();

membersRouter.get(
  '/',
  requirePermission(PERMISSIONS.MEMBERS_READ),
  validate({ query: listMembersQuerySchema }),
  controller.listMembers,
);

membersRouter.post(
  '/invite',
  requirePermission(PERMISSIONS.MEMBERS_INVITE),
  validate({ body: inviteMemberSchema }),
  controller.inviteMember,
);

membersRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.MEMBERS_UPDATE),
  validate({ params: memberIdParamsSchema, body: updateMemberSchema }),
  controller.updateMember,
);

membersRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.MEMBERS_REMOVE),
  validate({ params: memberIdParamsSchema }),
  controller.removeMember,
);

membersRouter.get(
  '/:id/permissions',
  requirePermission(PERMISSIONS.MEMBERS_READ),
  validate({ params: memberIdParamsSchema }),
  controller.getMemberPermissions,
);

// Editing one person's exceptions is editing the authorisation model, so it
// takes `roles:manage` rather than the weaker `members:update` that a Manager
// holds — a Manager may change who does which job, not what a job is allowed to
// do.
membersRouter.put(
  '/:id/permissions',
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  validate({ params: memberIdParamsSchema, body: replaceMemberPermissionsSchema }),
  controller.replaceMemberPermissions,
);

/**
 * Mounted directly on /api/v1 — authenticated, no workspace required.
 *
 * Mount order matters: this must be registered before the management router, so
 * `POST /api/v1/members/accept` is matched here rather than falling into
 * tenant resolution and 404ing for the very people it exists to serve.
 */
export const memberInvitesRouter = Router();

memberInvitesRouter.get(
  '/members/invitations',
  authenticate,
  apiRateLimit,
  controller.listInvitations,
);

memberInvitesRouter.post(
  '/members/accept',
  authenticate,
  apiRateLimit,
  validate({ body: acceptInvitationSchema }),
  controller.acceptInvitation,
);
