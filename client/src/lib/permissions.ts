import type { SystemRoleKey } from '@/types/api';

/**
 * A mirror of the server's permission catalogue and built-in role templates.
 *
 * Why this file exists, honestly stated:
 *
 * `GET /api/v1/auth/me` is mounted on the unauthenticated `/auth` router, which
 * runs `authenticate` but not `requireTenant`. Its `activeWorkspace` field is
 * therefore always `null` in practice, even when the request carries a valid
 * `X-Business-Id` — verified against the running API. The only endpoint that
 * exposes real permission keys is `GET /workspace/roles`, which itself requires
 * `roles:read` and so is unavailable to exactly the roles that need the
 * narrowest UI.
 *
 * So `can()` resolves permissions in this order (see AuthContext):
 *   1. `activeWorkspace.permissions` when the API does return it,
 *   2. the template below for the four seeded system roles,
 *   3. `GET /workspace/roles` for a custom role, if the caller may read it.
 *
 * Two consequences worth being explicit about:
 *   - This is a *display* concern only. The server authorises every request
 *     independently; nothing here can grant access, only hide or show controls.
 *   - Per-member GRANT/DENY overrides are invisible to step 2. A member with an
 *     override may see a control they cannot use (the API answers 403, which the
 *     UI surfaces) or miss one they could. Step 1 fixes this the moment the API
 *     populates `activeWorkspace`.
 *
 * Kept byte-identical to `server/src/modules/auth/permissions.ts`.
 */

export const PERMISSIONS = {
  WORKSPACE_READ: 'workspace:read',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_SETTINGS_MANAGE: 'workspace:settings:manage',

  MEMBERS_READ: 'members:read',
  MEMBERS_INVITE: 'members:invite',
  MEMBERS_UPDATE: 'members:update',
  MEMBERS_REMOVE: 'members:remove',
  ROLES_READ: 'roles:read',
  ROLES_MANAGE: 'roles:manage',

  LOCATIONS_READ: 'locations:read',
  LOCATIONS_MANAGE: 'locations:manage',
  TEAMS_READ: 'teams:read',
  TEAMS_MANAGE: 'teams:manage',
  STAFF_READ: 'staff:read',
  STAFF_MANAGE: 'staff:manage',

  SERVICES_READ: 'services:read',
  SERVICES_MANAGE: 'services:manage',
  RESOURCES_READ: 'resources:read',
  RESOURCES_MANAGE: 'resources:manage',

  AVAILABILITY_READ: 'availability:read',
  AVAILABILITY_MANAGE: 'availability:manage',
  AVAILABILITY_MANAGE_OWN: 'availability:manage:own',
  HOLIDAYS_MANAGE: 'holidays:manage',
  BLACKOUTS_MANAGE: 'blackouts:manage',

  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_MANAGE: 'customers:manage',
  CUSTOMERS_NOTES_MANAGE: 'customers:notes:manage',
  CUSTOMERS_READ_ASSIGNED: 'customers:read:assigned',

  APPOINTMENTS_READ: 'appointments:read',
  APPOINTMENTS_READ_OWN: 'appointments:read:own',
  APPOINTMENTS_CREATE: 'appointments:create',
  APPOINTMENTS_UPDATE: 'appointments:update',
  APPOINTMENTS_RESCHEDULE: 'appointments:reschedule',
  APPOINTMENTS_CANCEL: 'appointments:cancel',
  APPOINTMENTS_COMPLETE: 'appointments:complete',
  APPOINTMENTS_NO_SHOW: 'appointments:no_show',
  APPOINTMENTS_APPROVE: 'appointments:approve',
  APPOINTMENTS_NOTES_MANAGE: 'appointments:notes:manage',

  BOOKING_LINKS_READ: 'booking_links:read',
  BOOKING_LINKS_MANAGE: 'booking_links:manage',

  WAITLIST_READ: 'waitlist:read',
  WAITLIST_MANAGE: 'waitlist:manage',

  NOTIFICATIONS_READ: 'notifications:read',
  NOTIFICATIONS_MANAGE: 'notifications:manage',
  TEMPLATES_MANAGE: 'templates:manage',
  AUTOMATIONS_READ: 'automations:read',
  AUTOMATIONS_MANAGE: 'automations:manage',

  ANALYTICS_READ: 'analytics:read',
  REPORTS_READ: 'reports:read',
  REPORTS_EXPORT: 'reports:export',
  AUDIT_READ: 'audit:read',

  WEBHOOKS_READ: 'webhooks:read',
  WEBHOOKS_MANAGE: 'webhooks:manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSIONS);

const MANAGER_PERMISSIONS: PermissionKey[] = [
  PERMISSIONS.WORKSPACE_READ,
  PERMISSIONS.WORKSPACE_UPDATE,
  PERMISSIONS.WORKSPACE_SETTINGS_MANAGE,
  PERMISSIONS.MEMBERS_READ,
  PERMISSIONS.MEMBERS_INVITE,
  PERMISSIONS.MEMBERS_UPDATE,
  PERMISSIONS.ROLES_READ,
  PERMISSIONS.LOCATIONS_READ,
  PERMISSIONS.LOCATIONS_MANAGE,
  PERMISSIONS.TEAMS_READ,
  PERMISSIONS.TEAMS_MANAGE,
  PERMISSIONS.STAFF_READ,
  PERMISSIONS.STAFF_MANAGE,
  PERMISSIONS.SERVICES_READ,
  PERMISSIONS.SERVICES_MANAGE,
  PERMISSIONS.RESOURCES_READ,
  PERMISSIONS.RESOURCES_MANAGE,
  PERMISSIONS.AVAILABILITY_READ,
  PERMISSIONS.AVAILABILITY_MANAGE,
  PERMISSIONS.AVAILABILITY_MANAGE_OWN,
  PERMISSIONS.HOLIDAYS_MANAGE,
  PERMISSIONS.BLACKOUTS_MANAGE,
  PERMISSIONS.CUSTOMERS_READ,
  PERMISSIONS.CUSTOMERS_MANAGE,
  PERMISSIONS.CUSTOMERS_NOTES_MANAGE,
  PERMISSIONS.APPOINTMENTS_READ,
  PERMISSIONS.APPOINTMENTS_CREATE,
  PERMISSIONS.APPOINTMENTS_UPDATE,
  PERMISSIONS.APPOINTMENTS_RESCHEDULE,
  PERMISSIONS.APPOINTMENTS_CANCEL,
  PERMISSIONS.APPOINTMENTS_COMPLETE,
  PERMISSIONS.APPOINTMENTS_NO_SHOW,
  PERMISSIONS.APPOINTMENTS_APPROVE,
  PERMISSIONS.APPOINTMENTS_NOTES_MANAGE,
  PERMISSIONS.BOOKING_LINKS_READ,
  PERMISSIONS.BOOKING_LINKS_MANAGE,
  PERMISSIONS.WAITLIST_READ,
  PERMISSIONS.WAITLIST_MANAGE,
  PERMISSIONS.NOTIFICATIONS_READ,
  PERMISSIONS.NOTIFICATIONS_MANAGE,
  PERMISSIONS.TEMPLATES_MANAGE,
  PERMISSIONS.AUTOMATIONS_READ,
  PERMISSIONS.AUTOMATIONS_MANAGE,
  PERMISSIONS.ANALYTICS_READ,
  PERMISSIONS.REPORTS_READ,
  PERMISSIONS.REPORTS_EXPORT,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.WEBHOOKS_READ,
];

const RECEPTIONIST_PERMISSIONS: PermissionKey[] = [
  PERMISSIONS.WORKSPACE_READ,
  PERMISSIONS.LOCATIONS_READ,
  PERMISSIONS.TEAMS_READ,
  PERMISSIONS.STAFF_READ,
  PERMISSIONS.SERVICES_READ,
  PERMISSIONS.RESOURCES_READ,
  PERMISSIONS.AVAILABILITY_READ,
  PERMISSIONS.CUSTOMERS_READ,
  PERMISSIONS.CUSTOMERS_MANAGE,
  PERMISSIONS.CUSTOMERS_NOTES_MANAGE,
  PERMISSIONS.APPOINTMENTS_READ,
  PERMISSIONS.APPOINTMENTS_CREATE,
  PERMISSIONS.APPOINTMENTS_UPDATE,
  PERMISSIONS.APPOINTMENTS_RESCHEDULE,
  PERMISSIONS.APPOINTMENTS_CANCEL,
  PERMISSIONS.APPOINTMENTS_COMPLETE,
  PERMISSIONS.APPOINTMENTS_NO_SHOW,
  PERMISSIONS.APPOINTMENTS_NOTES_MANAGE,
  PERMISSIONS.BOOKING_LINKS_READ,
  PERMISSIONS.WAITLIST_READ,
  PERMISSIONS.WAITLIST_MANAGE,
  PERMISSIONS.NOTIFICATIONS_READ,
];

const STAFF_PERMISSIONS: PermissionKey[] = [
  PERMISSIONS.WORKSPACE_READ,
  PERMISSIONS.LOCATIONS_READ,
  PERMISSIONS.SERVICES_READ,
  PERMISSIONS.STAFF_READ,
  PERMISSIONS.AVAILABILITY_READ,
  PERMISSIONS.AVAILABILITY_MANAGE_OWN,
  PERMISSIONS.CUSTOMERS_READ_ASSIGNED,
  PERMISSIONS.APPOINTMENTS_READ_OWN,
  PERMISSIONS.APPOINTMENTS_RESCHEDULE,
  PERMISSIONS.APPOINTMENTS_CANCEL,
  PERMISSIONS.APPOINTMENTS_COMPLETE,
  PERMISSIONS.APPOINTMENTS_NO_SHOW,
  PERMISSIONS.APPOINTMENTS_NOTES_MANAGE,
];

export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, PermissionKey[]> = {
  BUSINESS_OWNER: ALL_PERMISSIONS,
  MANAGER: MANAGER_PERMISSIONS,
  RECEPTIONIST: RECEPTIONIST_PERMISSIONS,
  STAFF: STAFF_PERMISSIONS,
};

export const SYSTEM_ROLE_LABELS: Record<SystemRoleKey, string> = {
  BUSINESS_OWNER: 'Business Owner',
  MANAGER: 'Manager',
  RECEPTIONIST: 'Receptionist',
  STAFF: 'Staff',
};

export function isSystemRoleKey(key: string): key is SystemRoleKey {
  return key in SYSTEM_ROLE_PERMISSIONS;
}

/**
 * Whether a member sees the whole diary or only their own rows.
 * Mirrors `appointmentVisibility` on the server so both agree on what a page
 * should even try to request.
 */
export function appointmentVisibility(granted: ReadonlySet<string>): 'ALL' | 'OWN' | 'NONE' {
  if (granted.has(PERMISSIONS.APPOINTMENTS_READ)) return 'ALL';
  if (granted.has(PERMISSIONS.APPOINTMENTS_READ_OWN)) return 'OWN';
  return 'NONE';
}

export function customerVisibility(granted: ReadonlySet<string>): 'ALL' | 'ASSIGNED' | 'NONE' {
  if (granted.has(PERMISSIONS.CUSTOMERS_READ)) return 'ALL';
  if (granted.has(PERMISSIONS.CUSTOMERS_READ_ASSIGNED)) return 'ASSIGNED';
  return 'NONE';
}
