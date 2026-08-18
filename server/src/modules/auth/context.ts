/**
 * Request-scoped security context.
 *
 * These are plain data shapes with no model imports, so every layer — HTTP,
 * services, sockets, jobs — can depend on the same definition of "who is asking
 * and what may they touch" without dragging Sequelize along.
 */
import type { PermissionKey } from './permissions';

/** Established by the authenticate middleware from a verified access token. */
export interface AuthContext {
  userId: string;
  email: string;
  platformRole: 'ADMIN' | 'USER';
  /** Refresh-token family; lets logout-all invalidate live access tokens. */
  sessionId: string;
  /** Convenience flag. Platform admins still never bypass tenant scoping. */
  isPlatformAdmin: boolean;
}

/**
 * Established by the tenant middleware from an ACTIVE membership.
 *
 * `businessId` here is the ONLY tenant identifier any query may use. It is
 * derived from the authenticated membership, never from client input.
 */
export interface TenantContext {
  businessId: string;
  businessSlug: string;
  businessTimezone: string;
  membershipId: string;
  roleId: string;
  roleKey: string;
  /** Effective permissions after role + per-member GRANT/DENY overrides. */
  permissions: ReadonlySet<string>;
  /** Present when this member is also a bookable staff member. */
  staffProfileId: string | null;
}

/**
 * Established on public booking routes after a link slug has been resolved and
 * found active. Carries a tenant id that the caller never supplied and cannot
 * influence beyond choosing which (public, active) link to open.
 */
export interface PublicBookingContext {
  businessId: string;
  businessTimezone: string;
  bookingLinkId: string;
  slug: string;
  requiresApproval: boolean;
}

export function can(tenant: TenantContext | undefined, permission: PermissionKey): boolean {
  return tenant?.permissions.has(permission) ?? false;
}
