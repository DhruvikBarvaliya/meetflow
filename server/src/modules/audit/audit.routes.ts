/**
 * `/api/v1/audit-logs`
 *
 * A workspace's own view of the trail that every mutating service writes to.
 * Eighteen services record entries; until this router existed no tenant could
 * read one, and "the business sees its audit trail" was unreachable from the
 * product.
 *
 * Not a variant of `/api/v1/admin/audit-logs`, and the difference is the whole
 * design: that surface reads across tenants for a platform operator who holds no
 * membership, so a workspace id is ordinary input over there. Here the workspace
 * comes from the caller's membership and cannot be widened by any parameter this
 * router accepts.
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what each endpoint additionally requires. `requirePermission` runs before
 * `validate` so a caller who may not read the trail at all learns nothing from
 * the shape of the validation errors.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './audit.controller';
import {
  auditEntryIdParamsSchema,
  exportAuditEntriesQuerySchema,
  listAuditEntriesQuerySchema,
} from './audit.validation';

export const auditRouter = Router();

auditRouter.get(
  '/',
  requirePermission(PERMISSIONS.AUDIT_READ),
  validate({ query: listAuditEntriesQuerySchema }),
  controller.listAuditEntries,
);

/**
 * Declared before `/:id`, and the order is load-bearing: Express matches in
 * declaration order, so a `:id` route above this one would swallow
 * `export.csv` and answer 422 for a path that is not an identifier at all.
 *
 * A distinct literal path rather than a `:format` parameter, as on the report
 * export: the extension is what makes a browser save the response as a
 * spreadsheet instead of rendering it.
 *
 * The permissions are `audit:read` *and* `reports:export`, and
 * `requirePermission` demands every key listed. That is the same reading the
 * appointment export uses — an export is a read that leaves the building, so it
 * needs the permission to read and the separate permission to take a copy away.
 */
auditRouter.get(
  '/export.csv',
  requirePermission(PERMISSIONS.AUDIT_READ, PERMISSIONS.REPORTS_EXPORT),
  validate({ query: exportAuditEntriesQuerySchema }),
  controller.exportAuditEntries,
);

auditRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.AUDIT_READ),
  validate({ params: auditEntryIdParamsSchema }),
  controller.getAuditEntry,
);
