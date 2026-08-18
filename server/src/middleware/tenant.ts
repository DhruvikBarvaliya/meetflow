/**
 * Tenant resolution and permission enforcement.
 *
 * The single rule this file exists to enforce: **the tenant a request operates
 * on is derived from an ACTIVE membership row, never from client input.**
 *
 * A client may *indicate* which of their own workspaces they are acting in (via
 * the `X-Business-Id` header), but that value is only ever used to select among
 * memberships the authenticated user already has. An id for a workspace they do
 * not belong to resolves to nothing and the request is refused — and refused
 * with 404, not 403, so the endpoint cannot be used to probe which workspace
 * ids exist.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  Business,
  Membership,
  MembershipPermission,
  Permission,
  Role,
  StaffProfile,
} from '../database/models';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../utils/errors';
import type { TenantContext } from '../modules/auth/context';
import {
  type PermissionKey,
  hasAllPermissions,
  hasAnyPermission,
  resolveEffectivePermissions,
} from '../modules/auth/permissions';

export const BUSINESS_HEADER = 'x-business-id';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads the membership, its role's permissions and any per-member overrides.
 * Not cached: a revoked role must take effect on the very next request, and one
 * indexed query with joins is cheap enough that staleness is not worth buying.
 */
async function loadTenantContext(
  userId: string,
  businessId: string | null,
): Promise<TenantContext | null> {
  const membership = await Membership.findOne({
    where: {
      userId,
      status: 'ACTIVE',
      ...(businessId ? { businessId } : {}),
    },
    include: [
      { model: Business, as: 'business', required: true, where: { status: 'ACTIVE' } },
      {
        model: Role,
        as: 'role',
        required: true,
        include: [{ model: Permission, as: 'permissions', through: { attributes: [] } }],
      },
      {
        // Most members have no overrides at all. Both this include AND its
        // nested one must stay optional: a `required: true` child promotes its
        // parent join to INNER in Sequelize, which would silently exclude every
        // member without an override row — i.e. almost everyone.
        model: MembershipPermission,
        as: 'permissionOverrideRows',
        required: false,
        include: [{ model: Permission, as: 'permission', required: false }],
      },
    ],
    order: [['createdAt', 'ASC']],
  });

  if (!membership) return null;

  const business = membership.get('business') as Business;
  const role = membership.get('role') as Role & { permissions?: Permission[] };
  const rolePermissions = (role.get('permissions') as Permission[] | undefined) ?? [];
  const overrideRows =
    (membership.get('permissionOverrideRows') as
      Array<MembershipPermission & { permission?: Permission }> | undefined) ?? [];

  const overrides = overrideRows
    .map((row) => {
      const permission = row.get('permission') as Permission | undefined;
      return permission ? { permissionKey: permission.key, effect: row.effect } : null;
    })
    .filter(
      (value): value is { permissionKey: string; effect: 'GRANT' | 'DENY' } => value !== null,
    );

  const permissions = resolveEffectivePermissions(
    rolePermissions.map((permission) => permission.key),
    overrides,
  );

  // A member may also be a bookable provider. Scoped queries ("my
  // appointments") need this id, so it is resolved once per request.
  const staffProfile = await StaffProfile.findOne({
    where: { membershipId: membership.id },
    attributes: ['id'],
  });

  return {
    businessId: business.id,
    businessSlug: business.slug,
    businessTimezone: business.timezone,
    membershipId: membership.id,
    roleId: role.id,
    roleKey: role.key,
    permissions,
    staffProfileId: staffProfile?.id ?? null,
  };
}

/**
 * Requires an authenticated user with an active membership.
 *
 * Selection rules:
 *  - `X-Business-Id` present  -> that workspace, if the user belongs to it
 *  - header absent, one membership -> that workspace
 *  - header absent, several   -> 400-style error asking the client to choose
 */
export const requireTenant: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.auth) {
      throw new UnauthenticatedError();
    }

    const header = req.header(BUSINESS_HEADER)?.trim();
    if (header && !UUID_PATTERN.test(header)) {
      throw new NotFoundError('Workspace');
    }

    const tenant = await loadTenantContext(req.auth.userId, header ?? null);
    if (!tenant) {
      // Covers "no membership at all" and "membership in a different workspace"
      // with one indistinguishable answer.
      throw new NotFoundError('Workspace');
    }

    if (!header) {
      const count = await Membership.count({
        where: { userId: req.auth.userId, status: 'ACTIVE' },
      });
      if (count > 1) {
        throw new ForbiddenError(
          `You belong to several workspaces. Send the ${BUSINESS_HEADER} header to choose one.`,
        );
      }
    }

    req.tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Resolves tenant context when the caller has one, and continues without when
 * they do not. The optional counterpart to `requireTenant`, in the same way
 * `optionalAuthenticate` is the optional counterpart to `authenticate`.
 *
 * It exists for endpoints that must answer *both* kinds of caller. `/auth/me`
 * is the case that motivated it: a member needs their effective permissions
 * back, and a user with no membership at all — a customer, an invitee who has
 * not accepted yet — still needs a valid answer rather than the 404
 * `requireTenant` gives them.
 *
 * Every way of not resolving a workspace is silent here, and each is a case
 * `requireTenant` deliberately treats as an error:
 *
 *  - a malformed `X-Business-Id`, which over there must not become an oracle
 *    for which workspace ids exist and so answers 404;
 *  - a workspace the caller does not belong to, for the same reason;
 *  - no header from someone who belongs to several, which over there is a
 *    request to choose. This endpoint is precisely where they *discover* the
 *    list to choose from, so demanding the choice first would be circular.
 *
 * What is not swallowed is a database failure: `loadTenantContext` raising is
 * passed to `next` like anywhere else, because "the query broke" and "you have
 * no membership" must never look the same.
 */
export const optionalTenant: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.auth) {
      next();
      return;
    }

    const header = req.header(BUSINESS_HEADER)?.trim();
    if (header && !UUID_PATTERN.test(header)) {
      next();
      return;
    }

    const tenant = await loadTenantContext(req.auth.userId, header ?? null);
    if (!tenant) {
      next();
      return;
    }

    // Same auto-selection rule as `requireTenant`, and the same query behind
    // it: one membership and no header means that workspace, several means the
    // caller has not chosen and nothing is assumed on their behalf.
    if (!header) {
      const count = await Membership.count({
        where: { userId: req.auth.userId, status: 'ACTIVE' },
      });
      if (count > 1) {
        next();
        return;
      }
    }

    req.tenant = tenant;
    next();
  } catch (error) {
    next(error);
  }
};

/** Requires every listed permission. */
export function requirePermission(...required: PermissionKey[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.tenant) {
      next(new UnauthenticatedError('Workspace context is required for this endpoint.'));
      return;
    }
    if (!hasAllPermissions(req.tenant.permissions, required)) {
      next(new ForbiddenError('Your role does not allow this action.', undefined, { required }));
      return;
    }
    next();
  };
}

/** Requires at least one of the listed permissions (e.g. read-all OR read-own). */
export function requireAnyPermission(...required: PermissionKey[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.tenant) {
      next(new UnauthenticatedError('Workspace context is required for this endpoint.'));
      return;
    }
    if (!hasAnyPermission(req.tenant.permissions, required)) {
      next(new ForbiddenError('Your role does not allow this action.', undefined, { required }));
      return;
    }
    next();
  };
}

/**
 * The tenant context, or a hard failure.
 *
 * Service and controller code calls this instead of reading `req.tenant`
 * directly, so a route that forgot `requireTenant` fails loudly at the first
 * call rather than silently querying with `businessId: undefined` — which in
 * Sequelize would drop the tenant filter entirely.
 */
export function tenantOf(req: Request): TenantContext {
  if (!req.tenant) {
    throw new UnauthenticatedError('Workspace context is required for this endpoint.');
  }
  return req.tenant;
}
