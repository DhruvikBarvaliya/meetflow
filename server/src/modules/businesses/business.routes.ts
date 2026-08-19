/**
 * Workspace routes.
 *
 * Split into two routers on purpose:
 *
 *   `workspaceCreationRouter` is authenticated but NOT tenant-scoped —
 *   requiring an existing membership to create your first workspace would make
 *   onboarding impossible.
 *
 *   `businessesRouter` mounts on the tenant-scoped management router like every
 *   other module.
 */
import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { apiRateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './business.controller';
import {
  createBusinessSchema,
  slugAvailabilitySchema,
  updateBusinessSchema,
  updateSettingsSchema,
} from './business.validation';

/** Mounted directly on /api/v1 — authenticated, no workspace required. */
export const workspaceCreationRouter = Router();

// `requireVerifiedEmail` on creation but not on the slug check below. Claiming
// a workspace is the act this gate exists for: an unconfirmed address is a typo
// or somebody else's, and either way the business correspondence a workspace
// generates would go to a stranger. Checking whether a slug is free reveals
// nothing and changes nothing, so gating it would only make the form fail
// halfway through for no benefit.
workspaceCreationRouter.post(
  '/workspaces',
  authenticate,
  apiRateLimit,
  requireVerifiedEmail,
  validate({ body: createBusinessSchema }),
  controller.create,
);

workspaceCreationRouter.get(
  '/workspaces/slug-available',
  authenticate,
  apiRateLimit,
  validate({ query: slugAvailabilitySchema }),
  controller.checkSlug,
);

/** Mounted on the tenant-scoped management router. */
export const businessesRouter = Router();

businessesRouter.get('/', requirePermission(PERMISSIONS.WORKSPACE_READ), controller.show);

businessesRouter.patch(
  '/',
  requirePermission(PERMISSIONS.WORKSPACE_UPDATE),
  validate({ body: updateBusinessSchema }),
  controller.update,
);

businessesRouter.get(
  '/settings',
  requirePermission(PERMISSIONS.WORKSPACE_READ),
  controller.showSettings,
);

businessesRouter.patch(
  '/settings',
  requirePermission(PERMISSIONS.WORKSPACE_SETTINGS_MANAGE),
  validate({ body: updateSettingsSchema }),
  controller.updateSettings,
);

businessesRouter.get(
  '/members',
  requirePermission(PERMISSIONS.MEMBERS_READ),
  controller.listMembers,
);

businessesRouter.get('/roles', requirePermission(PERMISSIONS.ROLES_READ), controller.listRoles);
