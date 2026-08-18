'use strict';

/**
 * The permission catalogue.
 *
 * Mirrors src/modules/auth/permissions.ts (PERMISSION_CATALOGUE) exactly: the
 * TypeScript file is the source of truth for the application, this file is the
 * source of truth for a freshly migrated database. The two are kept in step by
 * hand rather than by importing, because the CLI runs these files as plain
 * CommonJS with no TypeScript build step available.
 *
 * The insert is an upsert on `key`, not a plain insert, for two reasons:
 *  - `ensurePermissionsSeeded()` in businesses/business.service.ts may already
 *    have created rows (a workspace can be created on a migrated-but-unseeded
 *    database), and the two paths must never collide;
 *  - re-running the seeder after a wording change must update the description
 *    rather than fail on the unique index.
 *
 * Because of that, ids here are a *preference*, not a guarantee: a row that
 * already exists keeps the id it was born with. Everything downstream therefore
 * resolves permissions by `key`, never by hard-coded uuid.
 */

/** Values accepted as "yes" for SEED_ENABLED, matching sequelize-cli.config.cjs. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Seeding writes demo credentials and demo tenants. Requiring an explicit
 * opt-in makes it impossible to run this by reflex against a database that
 * holds real data.
 */
function assertSeedEnabled() {
  const flag = String(process.env.SEED_ENABLED ?? '')
    .trim()
    .toLowerCase();
  if (!TRUTHY.has(flag)) {
    throw new Error(
      'Refusing to seed: SEED_ENABLED is not set to a truthy value ' +
        "(one of '1', 'true', 'yes', 'on'). Set SEED_ENABLED=true to run the seeders.",
    );
  }
}

/** [id, key, category, description] — same order as PERMISSION_CATALOGUE. */
const PERMISSIONS = [
  [
    'c0000000-0000-4000-8000-000000000001',
    'workspace:read',
    'workspace',
    'View workspace profile and configuration',
  ],
  [
    'c0000000-0000-4000-8000-000000000002',
    'workspace:update',
    'workspace',
    'Edit workspace profile',
  ],
  [
    'c0000000-0000-4000-8000-000000000003',
    'workspace:delete',
    'workspace',
    'Archive or delete the workspace',
  ],
  [
    'c0000000-0000-4000-8000-000000000004',
    'workspace:settings:manage',
    'workspace',
    'Change booking policies and defaults',
  ],

  ['c0000000-0000-4000-8000-000000000005', 'members:read', 'people', 'View workspace members'],
  ['c0000000-0000-4000-8000-000000000006', 'members:invite', 'people', 'Invite new members'],
  [
    'c0000000-0000-4000-8000-000000000007',
    'members:update',
    'people',
    'Change a member’s role or status',
  ],
  [
    'c0000000-0000-4000-8000-000000000008',
    'members:remove',
    'people',
    'Remove a member from the workspace',
  ],
  [
    'c0000000-0000-4000-8000-000000000009',
    'roles:read',
    'people',
    'View roles and their permissions',
  ],
  [
    'c0000000-0000-4000-8000-000000000010',
    'roles:manage',
    'people',
    'Create and edit roles and permissions',
  ],

  ['c0000000-0000-4000-8000-000000000011', 'locations:read', 'structure', 'View locations'],
  [
    'c0000000-0000-4000-8000-000000000012',
    'locations:manage',
    'structure',
    'Create and edit locations',
  ],
  ['c0000000-0000-4000-8000-000000000013', 'teams:read', 'structure', 'View teams'],
  ['c0000000-0000-4000-8000-000000000014', 'teams:manage', 'structure', 'Create and edit teams'],
  ['c0000000-0000-4000-8000-000000000015', 'staff:read', 'structure', 'View staff profiles'],
  [
    'c0000000-0000-4000-8000-000000000016',
    'staff:manage',
    'structure',
    'Create and edit staff profiles',
  ],

  [
    'c0000000-0000-4000-8000-000000000017',
    'services:read',
    'catalogue',
    'View the service catalogue',
  ],
  [
    'c0000000-0000-4000-8000-000000000018',
    'services:manage',
    'catalogue',
    'Create and edit services',
  ],
  [
    'c0000000-0000-4000-8000-000000000019',
    'resources:read',
    'catalogue',
    'View bookable resources',
  ],
  [
    'c0000000-0000-4000-8000-000000000020',
    'resources:manage',
    'catalogue',
    'Create and edit resources',
  ],

  [
    'c0000000-0000-4000-8000-000000000021',
    'availability:read',
    'availability',
    'View availability for anyone',
  ],
  [
    'c0000000-0000-4000-8000-000000000022',
    'availability:manage',
    'availability',
    'Edit availability for anyone',
  ],
  [
    'c0000000-0000-4000-8000-000000000023',
    'availability:manage:own',
    'availability',
    'Edit your own availability and leave',
  ],
  [
    'c0000000-0000-4000-8000-000000000024',
    'holidays:manage',
    'availability',
    'Manage the holiday calendar',
  ],
  [
    'c0000000-0000-4000-8000-000000000025',
    'blackouts:manage',
    'availability',
    'Manage blackout periods',
  ],

  [
    'c0000000-0000-4000-8000-000000000026',
    'customers:read',
    'customers',
    'View all customer records',
  ],
  [
    'c0000000-0000-4000-8000-000000000027',
    'customers:read:assigned',
    'customers',
    'View customers booked with you',
  ],
  [
    'c0000000-0000-4000-8000-000000000028',
    'customers:manage',
    'customers',
    'Create and edit customer records',
  ],
  [
    'c0000000-0000-4000-8000-000000000029',
    'customers:notes:manage',
    'customers',
    'Write internal customer notes',
  ],

  [
    'c0000000-0000-4000-8000-000000000030',
    'appointments:read',
    'appointments',
    'View all appointments',
  ],
  [
    'c0000000-0000-4000-8000-000000000031',
    'appointments:read:own',
    'appointments',
    'View appointments assigned to you',
  ],
  [
    'c0000000-0000-4000-8000-000000000032',
    'appointments:create',
    'appointments',
    'Book appointments on behalf of customers',
  ],
  [
    'c0000000-0000-4000-8000-000000000033',
    'appointments:update',
    'appointments',
    'Edit appointment details',
  ],
  [
    'c0000000-0000-4000-8000-000000000034',
    'appointments:reschedule',
    'appointments',
    'Move an appointment to a new time',
  ],
  [
    'c0000000-0000-4000-8000-000000000035',
    'appointments:cancel',
    'appointments',
    'Cancel an appointment',
  ],
  [
    'c0000000-0000-4000-8000-000000000036',
    'appointments:complete',
    'appointments',
    'Mark an appointment completed',
  ],
  [
    'c0000000-0000-4000-8000-000000000037',
    'appointments:no_show',
    'appointments',
    'Mark an appointment as a no-show',
  ],
  [
    'c0000000-0000-4000-8000-000000000038',
    'appointments:approve',
    'appointments',
    'Approve or reject pending bookings',
  ],
  [
    'c0000000-0000-4000-8000-000000000039',
    'appointments:notes:manage',
    'appointments',
    'Write internal appointment notes',
  ],

  [
    'c0000000-0000-4000-8000-000000000040',
    'booking_links:read',
    'booking',
    'View public booking links',
  ],
  [
    'c0000000-0000-4000-8000-000000000041',
    'booking_links:manage',
    'booking',
    'Create and edit public booking links',
  ],
  ['c0000000-0000-4000-8000-000000000042', 'waitlist:read', 'booking', 'View waitlist entries'],
  [
    'c0000000-0000-4000-8000-000000000043',
    'waitlist:manage',
    'booking',
    'Manage and convert waitlist entries',
  ],

  [
    'c0000000-0000-4000-8000-000000000044',
    'notifications:read',
    'communication',
    'View notification history',
  ],
  [
    'c0000000-0000-4000-8000-000000000045',
    'notifications:manage',
    'communication',
    'Resend or cancel notifications',
  ],
  [
    'c0000000-0000-4000-8000-000000000046',
    'templates:manage',
    'communication',
    'Edit notification templates',
  ],
  [
    'c0000000-0000-4000-8000-000000000047',
    'automations:read',
    'communication',
    'View automation rules',
  ],
  [
    'c0000000-0000-4000-8000-000000000048',
    'automations:manage',
    'communication',
    'Create and edit automation rules',
  ],

  [
    'c0000000-0000-4000-8000-000000000049',
    'analytics:read',
    'insight',
    'View analytics dashboards',
  ],
  ['c0000000-0000-4000-8000-000000000050', 'reports:read', 'insight', 'View operational reports'],
  ['c0000000-0000-4000-8000-000000000051', 'reports:export', 'insight', 'Export reports as CSV'],
  ['c0000000-0000-4000-8000-000000000052', 'audit:read', 'insight', 'Read the workspace audit log'],

  [
    'c0000000-0000-4000-8000-000000000053',
    'webhooks:read',
    'integration',
    'View webhook endpoints',
  ],
  [
    'c0000000-0000-4000-8000-000000000054',
    'webhooks:manage',
    'integration',
    'Create and edit webhook endpoints',
  ],
];

module.exports = {
  async up(queryInterface) {
    assertSeedEnabled();
    const sql = queryInterface.sequelize;

    const binds = [];
    const tuples = PERMISSIONS.map((row) => {
      const slots = row.map((value) => {
        binds.push(value);
        return `$${binds.length}`;
      });
      return `(${slots.join(', ')})`;
    });

    await sql.query(
      `INSERT INTO permissions (id, key, category, description)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (key) DO UPDATE
         SET category = EXCLUDED.category,
             description = EXCLUDED.description,
             updated_at = now()`,
      { bind: binds },
    );
  },

  async down(queryInterface) {
    assertSeedEnabled();
    const sql = queryInterface.sequelize;

    const keys = PERMISSIONS.map((row) => row[1]);
    const slots = keys.map((_, index) => `$${index + 1}`).join(', ');
    // role_permissions and membership_permissions cascade from here, which is
    // what we want: a permission that no longer exists cannot stay granted.
    await sql.query(`DELETE FROM permissions WHERE key IN (${slots})`, { bind: keys });
  },
};
