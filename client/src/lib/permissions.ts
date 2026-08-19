import { SYSTEM_ROLE_KEYS, type SystemRoleKey } from '@/types/api';

/**
 * The permission *vocabulary* — the key strings the server and this client both
 * name — and nothing about who holds them.
 *
 * There used to be a role-to-permissions table here as well, and deleting it
 * was the point of this file's last change. `GET /auth/me` runs `optionalTenant`
 * and returns `activeWorkspace.permissions`: the role's grants with per-member
 * GRANT and DENY overrides already applied, resolved by the same code every
 * `requirePermission` check runs through. A second table on the client is a
 * second answer to a question that already has one, and it could not see
 * overrides at all — so it showed members controls the server would refuse and
 * hid ones it would allow.
 *
 * What remains is safe to duplicate because it is not an answer: `PERMISSIONS`
 * is a set of names, and a name that drifts fails loudly as a key nothing
 * matches rather than quietly as the wrong access decision.
 *
 * This is still a *display* concern only. Nothing here grants access; the
 * server authorises every request independently.
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

export const SYSTEM_ROLE_LABELS: Record<SystemRoleKey, string> = {
  BUSINESS_OWNER: 'Business Owner',
  MANAGER: 'Manager',
  RECEPTIONIST: 'Receptionist',
  STAFF: 'Staff',
};

/** Whether a workspace role is one of the four seeded templates or a custom one. */
export function isSystemRoleKey(key: string): key is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(key);
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
