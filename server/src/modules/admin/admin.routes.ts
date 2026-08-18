/**
 * `/api/v1/admin`
 *
 * The platform-administration surface: a third router beside the public booking
 * routes and the authenticated management routes, and the only one that reads
 * across tenants.
 *
 * **The guard lives at the mount, not on these routes.** routes/index.ts mounts
 * this router behind `authenticate -> apiRateLimit -> requirePlatformAdmin`, so
 * every path below — including one added in a hurry six months from now — is
 * covered whether or not its author remembered to think about it. A per-route
 * `requirePlatformAdmin` would look more explicit and would be exactly one
 * forgotten line away from shipping a cross-tenant endpoint to every signed-in
 * user. Nothing in this file may weaken that: no route here declares its own
 * authorisation, and none should.
 *
 * **`requireTenant` is deliberately absent.** A platform admin has no membership
 * in the workspaces they administer, and tenant resolution refuses a request
 * without one — with a 404, so it cannot be used to probe which workspaces
 * exist. Mounting this surface on the management router would therefore 404
 * every single call. That is the whole reason it is a separate router, and the
 * reason a workspace id is an ordinary path parameter here.
 *
 * Validation runs after the mount's guard, so a caller who is not an operator
 * learns nothing from the shape of the validation errors.
 */
import { Router } from 'express';
import { validate } from '../../middleware/validate';
import * as controller from './admin.controller';
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

export const adminRouter = Router();

adminRouter.get('/overview', controller.getOverview);

adminRouter.get(
  '/workspaces',
  validate({ query: listWorkspacesQuerySchema }),
  controller.listWorkspaces,
);

adminRouter.get(
  '/workspaces/:id',
  validate({ params: workspaceIdParamsSchema }),
  controller.getWorkspace,
);

adminRouter.patch(
  '/workspaces/:id/status',
  validate({ params: workspaceIdParamsSchema, body: updateWorkspaceStatusSchema }),
  controller.updateWorkspaceStatus,
);

adminRouter.get('/users', validate({ query: listUsersQuerySchema }), controller.listUsers);

adminRouter.get('/users/:id', validate({ params: userIdParamsSchema }), controller.getUser);

adminRouter.patch(
  '/users/:id/status',
  validate({ params: userIdParamsSchema, body: updateUserStatusSchema }),
  controller.updateUserStatus,
);

// A separate endpoint from status rather than one PATCH taking both: promoting
// someone and suspending them are different decisions with different guards,
// and combining them would let one request trip over both.
adminRouter.patch(
  '/users/:id/platform-role',
  validate({ params: userIdParamsSchema, body: updatePlatformRoleSchema }),
  controller.updatePlatformRole,
);

adminRouter.get(
  '/audit-logs',
  validate({ query: listAuditLogsQuerySchema }),
  controller.listAuditLogs,
);

// Distinct from the unauthenticated `/health` and `/ready` probes, which answer
// "is this process alive?" for an orchestrator. This one reports on the
// platform's dependencies and its delivery backlog, which is operator-only
// information and stays behind the admin guard.
adminRouter.get('/health', controller.getSystemHealth);
