/**
 * The permission catalogue and the built-in role templates.
 *
 * This file is pure data plus pure functions — no database, no request context —
 * so the authorisation model can be reasoned about and unit-tested in one place.
 *
 * Two rules govern everything here:
 *
 *  1. A permission grants an ability *within one business*. Holding it says
 *     nothing about which tenant's rows you may touch; that is decided
 *     separately by tenant scoping (src/middleware/tenant.ts).
 *  2. `:own` variants are narrower, not additional. A staff member with
 *     `appointments:read:own` sees only appointments assigned to them; the
 *     unscoped `appointments:read` is what widens that to the whole workspace.
 */

export const PERMISSIONS = {
  // Workspace
  WORKSPACE_READ: 'workspace:read',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_SETTINGS_MANAGE: 'workspace:settings:manage',

  // People
  MEMBERS_READ: 'members:read',
  MEMBERS_INVITE: 'members:invite',
  MEMBERS_UPDATE: 'members:update',
  MEMBERS_REMOVE: 'members:remove',
  ROLES_READ: 'roles:read',
  ROLES_MANAGE: 'roles:manage',

  // Structure
  LOCATIONS_READ: 'locations:read',
  LOCATIONS_MANAGE: 'locations:manage',
  TEAMS_READ: 'teams:read',
  TEAMS_MANAGE: 'teams:manage',
  STAFF_READ: 'staff:read',
  STAFF_MANAGE: 'staff:manage',

  // Catalogue
  SERVICES_READ: 'services:read',
  SERVICES_MANAGE: 'services:manage',
  RESOURCES_READ: 'resources:read',
  RESOURCES_MANAGE: 'resources:manage',

  // Availability
  AVAILABILITY_READ: 'availability:read',
  AVAILABILITY_MANAGE: 'availability:manage',
  /** Edit only your own working hours, leave and overrides. */
  AVAILABILITY_MANAGE_OWN: 'availability:manage:own',
  HOLIDAYS_MANAGE: 'holidays:manage',
  BLACKOUTS_MANAGE: 'blackouts:manage',

  // Customers
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_MANAGE: 'customers:manage',
  CUSTOMERS_NOTES_MANAGE: 'customers:notes:manage',
  /** Read the contact details of customers booked with you, and no others. */
  CUSTOMERS_READ_ASSIGNED: 'customers:read:assigned',

  // Appointments
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

  // Booking links
  BOOKING_LINKS_READ: 'booking_links:read',
  BOOKING_LINKS_MANAGE: 'booking_links:manage',

  // Waitlist
  WAITLIST_READ: 'waitlist:read',
  WAITLIST_MANAGE: 'waitlist:manage',

  // Communication
  NOTIFICATIONS_READ: 'notifications:read',
  NOTIFICATIONS_MANAGE: 'notifications:manage',
  TEMPLATES_MANAGE: 'templates:manage',
  AUTOMATIONS_READ: 'automations:read',
  AUTOMATIONS_MANAGE: 'automations:manage',

  // Insight
  ANALYTICS_READ: 'analytics:read',
  REPORTS_READ: 'reports:read',
  REPORTS_EXPORT: 'reports:export',
  AUDIT_READ: 'audit:read',

  // Integration
  WEBHOOKS_READ: 'webhooks:read',
  WEBHOOKS_MANAGE: 'webhooks:manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSIONS);

/** Seed metadata: category + human description for each permission. */
export const PERMISSION_CATALOGUE: Array<{
  key: PermissionKey;
  category: string;
  description: string;
}> = [
  {
    key: PERMISSIONS.WORKSPACE_READ,
    category: 'workspace',
    description: 'View workspace profile and configuration',
  },
  {
    key: PERMISSIONS.WORKSPACE_UPDATE,
    category: 'workspace',
    description: 'Edit workspace profile',
  },
  {
    key: PERMISSIONS.WORKSPACE_DELETE,
    category: 'workspace',
    description: 'Archive or delete the workspace',
  },
  {
    key: PERMISSIONS.WORKSPACE_SETTINGS_MANAGE,
    category: 'workspace',
    description: 'Change booking policies and defaults',
  },

  { key: PERMISSIONS.MEMBERS_READ, category: 'people', description: 'View workspace members' },
  { key: PERMISSIONS.MEMBERS_INVITE, category: 'people', description: 'Invite new members' },
  {
    key: PERMISSIONS.MEMBERS_UPDATE,
    category: 'people',
    description: 'Change a member’s role or status',
  },
  {
    key: PERMISSIONS.MEMBERS_REMOVE,
    category: 'people',
    description: 'Remove a member from the workspace',
  },
  {
    key: PERMISSIONS.ROLES_READ,
    category: 'people',
    description: 'View roles and their permissions',
  },
  {
    key: PERMISSIONS.ROLES_MANAGE,
    category: 'people',
    description: 'Create and edit roles and permissions',
  },

  { key: PERMISSIONS.LOCATIONS_READ, category: 'structure', description: 'View locations' },
  {
    key: PERMISSIONS.LOCATIONS_MANAGE,
    category: 'structure',
    description: 'Create and edit locations',
  },
  { key: PERMISSIONS.TEAMS_READ, category: 'structure', description: 'View teams' },
  { key: PERMISSIONS.TEAMS_MANAGE, category: 'structure', description: 'Create and edit teams' },
  { key: PERMISSIONS.STAFF_READ, category: 'structure', description: 'View staff profiles' },
  {
    key: PERMISSIONS.STAFF_MANAGE,
    category: 'structure',
    description: 'Create and edit staff profiles',
  },

  {
    key: PERMISSIONS.SERVICES_READ,
    category: 'catalogue',
    description: 'View the service catalogue',
  },
  {
    key: PERMISSIONS.SERVICES_MANAGE,
    category: 'catalogue',
    description: 'Create and edit services',
  },
  {
    key: PERMISSIONS.RESOURCES_READ,
    category: 'catalogue',
    description: 'View bookable resources',
  },
  {
    key: PERMISSIONS.RESOURCES_MANAGE,
    category: 'catalogue',
    description: 'Create and edit resources',
  },

  {
    key: PERMISSIONS.AVAILABILITY_READ,
    category: 'availability',
    description: 'View availability for anyone',
  },
  {
    key: PERMISSIONS.AVAILABILITY_MANAGE,
    category: 'availability',
    description: 'Edit availability for anyone',
  },
  {
    key: PERMISSIONS.AVAILABILITY_MANAGE_OWN,
    category: 'availability',
    description: 'Edit your own availability and leave',
  },
  {
    key: PERMISSIONS.HOLIDAYS_MANAGE,
    category: 'availability',
    description: 'Manage the holiday calendar',
  },
  {
    key: PERMISSIONS.BLACKOUTS_MANAGE,
    category: 'availability',
    description: 'Manage blackout periods',
  },

  {
    key: PERMISSIONS.CUSTOMERS_READ,
    category: 'customers',
    description: 'View all customer records',
  },
  {
    key: PERMISSIONS.CUSTOMERS_READ_ASSIGNED,
    category: 'customers',
    description: 'View customers booked with you',
  },
  {
    key: PERMISSIONS.CUSTOMERS_MANAGE,
    category: 'customers',
    description: 'Create and edit customer records',
  },
  {
    key: PERMISSIONS.CUSTOMERS_NOTES_MANAGE,
    category: 'customers',
    description: 'Write internal customer notes',
  },

  {
    key: PERMISSIONS.APPOINTMENTS_READ,
    category: 'appointments',
    description: 'View all appointments',
  },
  {
    key: PERMISSIONS.APPOINTMENTS_READ_OWN,
    category: 'appointments',
    description: 'View appointments assigned to you',
  },
  {
    key: PERMISSIONS.APPOINTMENTS_CREATE,
    category: 'appointments',
    description: 'Book appointments on behalf of customers',
  },
  {
    key: PERMISSIONS.APPOINTMENTS_UPDATE,
    category: 'appointments',
    description: 'Edit appointment details',
  },
  {
    key: PERMISSIONS.APPOINTMENTS_RESCHEDULE,
    category: 'appointments',
    description: 'Move an appointment to a new time',
  },
  {
    key: PERMISSIONS.APPOINTMENTS_CANCEL,
    category: 'appointments',
    description: 'Cancel an appointment',
  },
  {
    key: PERMISSIONS.APPOINTMENTS_COMPLETE,
    category: 'appointments',
    description: 'Mark an appointment completed',
  },
  {
    key: PERMISSIONS.APPOINTMENTS_NO_SHOW,
    category: 'appointments',
    description: 'Mark an appointment as a no-show',
  },
  {
    key: PERMISSIONS.APPOINTMENTS_APPROVE,
    category: 'appointments',
    description: 'Approve or reject pending bookings',
  },
  {
    key: PERMISSIONS.APPOINTMENTS_NOTES_MANAGE,
    category: 'appointments',
    description: 'Write internal appointment notes',
  },

  {
    key: PERMISSIONS.BOOKING_LINKS_READ,
    category: 'booking',
    description: 'View public booking links',
  },
  {
    key: PERMISSIONS.BOOKING_LINKS_MANAGE,
    category: 'booking',
    description: 'Create and edit public booking links',
  },

  { key: PERMISSIONS.WAITLIST_READ, category: 'booking', description: 'View waitlist entries' },
  {
    key: PERMISSIONS.WAITLIST_MANAGE,
    category: 'booking',
    description: 'Manage and convert waitlist entries',
  },

  {
    key: PERMISSIONS.NOTIFICATIONS_READ,
    category: 'communication',
    description: 'View notification history',
  },
  {
    key: PERMISSIONS.NOTIFICATIONS_MANAGE,
    category: 'communication',
    description: 'Resend or cancel notifications',
  },
  {
    key: PERMISSIONS.TEMPLATES_MANAGE,
    category: 'communication',
    description: 'Edit notification templates',
  },
  {
    key: PERMISSIONS.AUTOMATIONS_READ,
    category: 'communication',
    description: 'View automation rules',
  },
  {
    key: PERMISSIONS.AUTOMATIONS_MANAGE,
    category: 'communication',
    description: 'Create and edit automation rules',
  },

  {
    key: PERMISSIONS.ANALYTICS_READ,
    category: 'insight',
    description: 'View analytics dashboards',
  },
  { key: PERMISSIONS.REPORTS_READ, category: 'insight', description: 'View operational reports' },
  { key: PERMISSIONS.REPORTS_EXPORT, category: 'insight', description: 'Export reports as CSV' },
  { key: PERMISSIONS.AUDIT_READ, category: 'insight', description: 'Read the workspace audit log' },

  {
    key: PERMISSIONS.WEBHOOKS_READ,
    category: 'integration',
    description: 'View webhook endpoints',
  },
  {
    key: PERMISSIONS.WEBHOOKS_MANAGE,
    category: 'integration',
    description: 'Create and edit webhook endpoints',
  },
];

// ---------------------------------------------------------------------------
// Built-in role templates
// ---------------------------------------------------------------------------

export const SYSTEM_ROLE_KEYS = ['BUSINESS_OWNER', 'MANAGER', 'RECEPTIONIST', 'STAFF'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

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

/** Front-desk: runs the diary and the customer list, changes no configuration. */
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

/**
 * Deliberately minimal. A staff member sees their own diary and the customers
 * booked with them — nothing workspace-wide, no configuration, no analytics.
 * Anything broader must be granted explicitly by an owner.
 */
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

export const SYSTEM_ROLE_TEMPLATES: Array<{
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: PermissionKey[];
}> = [
  {
    key: 'BUSINESS_OWNER',
    name: 'Business Owner',
    description: 'Full control of the workspace, its people and its configuration.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'MANAGER',
    name: 'Manager',
    description: 'Runs day-to-day operations. Cannot change roles or delete the workspace.',
    permissions: MANAGER_PERMISSIONS,
  },
  {
    key: 'RECEPTIONIST',
    name: 'Receptionist',
    description: 'Manages the diary and customers without changing configuration.',
    permissions: RECEPTIONIST_PERMISSIONS,
  },
  {
    key: 'STAFF',
    name: 'Staff',
    description: 'Sees and manages their own schedule and assigned appointments only.',
    permissions: STAFF_PERMISSIONS,
  },
];

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

/**
 * Effective permissions for a member.
 *
 * DENY overrides beat both the role and any GRANT override — the ability to
 * revoke one capability from one person without cloning a whole role is the
 * point of the override table.
 */
export function resolveEffectivePermissions(
  rolePermissions: readonly string[],
  overrides: ReadonlyArray<{ permissionKey: string; effect: 'GRANT' | 'DENY' }> = [],
): Set<string> {
  const effective = new Set<string>(rolePermissions);
  for (const override of overrides) {
    if (override.effect === 'GRANT') effective.add(override.permissionKey);
  }
  for (const override of overrides) {
    if (override.effect === 'DENY') effective.delete(override.permissionKey);
  }
  return effective;
}

export function hasPermission(granted: ReadonlySet<string>, required: PermissionKey): boolean {
  return granted.has(required);
}

export function hasAnyPermission(
  granted: ReadonlySet<string>,
  required: readonly PermissionKey[],
): boolean {
  return required.some((permission) => granted.has(permission));
}

export function hasAllPermissions(
  granted: ReadonlySet<string>,
  required: readonly PermissionKey[],
): boolean {
  return required.every((permission) => granted.has(permission));
}

/**
 * Whether a member may see the whole workspace diary or only their own rows.
 * Returns the staff filter the query layer must apply.
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
