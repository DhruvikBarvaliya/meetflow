/**
 * Platform-administration request schemas.
 *
 * These are the contract for `/api/v1/admin`: the runtime validation, the
 * generated OpenAPI document and the frontend's types all derive from them, so
 * the three cannot drift apart.
 *
 * One property here is unlike every other module in MeetFlow. Tenant-scoped
 * schemas deliberately refuse a `businessId` — the tenant is proven from the
 * caller's membership, so accepting one would be an authorisation hole with a
 * validation schema in front of it. A platform admin has no membership in the
 * workspaces they administer, so on this surface a workspace id is ordinary
 * input: it appears as a path parameter and as an audit-log filter. The
 * authorisation that a membership would otherwise carry is done in exactly one
 * place instead, `requirePlatformAdmin` at the router mount.
 *
 * Every enum is sourced from its model so a schema cannot drift from the CHECK
 * constraint the database enforces a moment later.
 */
import { z } from 'zod';
import { BUSINESS_STATUSES } from '../../database/models/Business';
import { PLATFORM_ROLES, USER_STATUSES } from '../../database/models/User';
import { isIsoDate } from '../../utils/time';

const uuidSchema = z.string().uuid();

/**
 * Shared by every list endpoint on this surface. `pageSize` is capped at 100:
 * these endpoints already return counts rather than contents, and an uncapped
 * page would still turn the workspace directory into a bulk export.
 */
const pageSchema = z.coerce.number().int().min(1).default(1);
const pageSizeSchema = z.coerce.number().int().min(1).max(100).default(20);

const searchSchema = z.string().trim().min(1).max(120);

/**
 * Filters compared against `created_at` as whole UTC days, so the client sends
 * a calendar date and never has to guess an instant. `to` is inclusive; the
 * service turns it into a half-open upper bound.
 */
const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, 'Use a calendar date formatted YYYY-MM-DD.');

/*
 * Note for whoever adds the first boolean filter here: `z.coerce.boolean()`
 * maps the string "false" to `true`, so `?flag=false` would return exactly the
 * rows it excludes. Spell the two literals out the way teams.validation.ts
 * does — `z.enum(['true', 'false']).transform((v) => v === 'true')`.
 */

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const listWorkspacesQuerySchema = z
  .object({
    page: pageSchema,
    pageSize: pageSizeSchema,
    /** Matched against name and slug, case-insensitively. */
    search: searchSchema.optional(),
    status: z.enum(BUSINESS_STATUSES).optional(),
    sort: z.enum(['newest', 'oldest', 'name', 'appointments']).default('newest'),
  })
  .strict();

export const workspaceIdParamsSchema = z.object({ id: uuidSchema }).strict();

export const updateWorkspaceStatusSchema = z
  .object({
    status: z.enum(BUSINESS_STATUSES),
    /**
     * Optional, and stored only in the audit row. Suspending a paying customer's
     * workspace is the kind of action that gets asked about weeks later, and the
     * trail is worth much more when it says why.
     */
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const listUsersQuerySchema = z
  .object({
    page: pageSchema,
    pageSize: pageSizeSchema,
    /** Matched against email, first name and last name, case-insensitively. */
    search: searchSchema.optional(),
    status: z.enum(USER_STATUSES).optional(),
    platformRole: z.enum(PLATFORM_ROLES).optional(),
    sort: z.enum(['newest', 'oldest', 'name', 'lastLogin']).default('newest'),
  })
  .strict();

export const userIdParamsSchema = z.object({ id: uuidSchema }).strict();

/**
 * Narrower than USER_STATUSES on purpose: INVITED is missing.
 *
 * INVITED is a state the invitation flow puts an account into and that
 * accepting an invitation takes it out of. An operator setting it by hand would
 * produce an account that has never been invited but is waiting for an
 * invitation it will never receive, and nothing in the product would resolve
 * that. The three values here are the ones an operator can meaningfully choose.
 */
export const updateUserStatusSchema = z
  .object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']) })
  .strict();

export const updatePlatformRoleSchema = z.object({ platformRole: z.enum(PLATFORM_ROLES) }).strict();

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

export const listAuditLogsQuerySchema = z
  .object({
    page: pageSchema,
    pageSize: pageSizeSchema,
    /** Not a tenant selector on this surface — see the file header. */
    businessId: uuidSchema.optional(),
    /** Exact match on the dotted verb, e.g. `appointment.cancelled`. */
    action: z.string().trim().min(1).max(120).optional(),
    actorUserId: uuidSchema.optional(),
    entityType: z.string().trim().min(1).max(120).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .strict()
  // ISO dates sort lexicographically, so no parsing is needed to order them.
  .refine((query) => query.from === undefined || query.to === undefined || query.to >= query.from, {
    path: ['to'],
    message: 'The end of the range cannot precede its start.',
  });

export type ListWorkspacesQuery = z.infer<typeof listWorkspacesQuerySchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
export type UpdateWorkspaceStatusBody = z.infer<typeof updateWorkspaceStatusSchema>;
export type UpdateUserStatusBody = z.infer<typeof updateUserStatusSchema>;
export type UpdatePlatformRoleBody = z.infer<typeof updatePlatformRoleSchema>;
export type WorkspaceIdParams = z.infer<typeof workspaceIdParamsSchema>;
export type UserIdParams = z.infer<typeof userIdParamsSchema>;
