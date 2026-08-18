'use strict';

/**
 * The tenant boundary.
 *
 * A `business` IS the tenant. Every tenant-owned table below carries a
 * `business_id`, and the API derives that id from the authenticated membership —
 * never from a client-supplied value. See docs/MultiTenancy.md.
 *
 * Roles are per-business (with `business_id IS NULL` reserved for the built-in
 * system role templates), so one workspace cannot see or edit another's roles.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    await sql.query(`
      CREATE TABLE businesses (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- Public workspace handle used in booking URLs. Globally unique.
        slug           text NOT NULL,
        name           text NOT NULL,
        legal_name     text,
        description    text,
        industry       text,
        -- Default timezone for business hours and reporting. IANA identifier.
        timezone       text NOT NULL DEFAULT 'UTC',
        currency       char(3) NOT NULL DEFAULT 'USD',
        locale         text NOT NULL DEFAULT 'en-US',
        logo_url       text,
        website_url    text,
        support_email  citext,
        support_phone  text,
        status         text NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
        owner_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        deleted_at     timestamptz
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX businesses_slug_unique_active
        ON businesses (slug) WHERE deleted_at IS NULL;
    `);
    await sql.query(`CREATE INDEX businesses_owner_idx ON businesses (owner_user_id);`);
    await sql.query(
      `CREATE INDEX businesses_status_idx ON businesses (status) WHERE deleted_at IS NULL;`,
    );

    // -----------------------------------------------------------------------
    // Booking policy defaults. Services may override individual values; the
    // resolver falls back to these, then to hard-coded engine defaults.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE business_settings (
        business_id                     uuid PRIMARY KEY
                                          REFERENCES businesses (id) ON DELETE CASCADE,
        -- Slot grid granularity, e.g. 15 => 09:00, 09:15, 09:30 …
        slot_interval_minutes           integer NOT NULL DEFAULT 15
                                          CHECK (slot_interval_minutes BETWEEN 1 AND 480),
        default_pre_buffer_minutes      integer NOT NULL DEFAULT 0
                                          CHECK (default_pre_buffer_minutes BETWEEN 0 AND 1440),
        default_post_buffer_minutes     integer NOT NULL DEFAULT 0
                                          CHECK (default_post_buffer_minutes BETWEEN 0 AND 1440),
        -- How soon before a start time a booking may still be made.
        min_notice_minutes              integer NOT NULL DEFAULT 60
                                          CHECK (min_notice_minutes BETWEEN 0 AND 525600),
        -- How far ahead the booking calendar is open.
        max_horizon_days                integer NOT NULL DEFAULT 60
                                          CHECK (max_horizon_days BETWEEN 1 AND 730),
        cancellation_deadline_minutes   integer NOT NULL DEFAULT 1440
                                          CHECK (cancellation_deadline_minutes >= 0),
        reschedule_deadline_minutes     integer NOT NULL DEFAULT 1440
                                          CHECK (reschedule_deadline_minutes >= 0),
        allow_customer_cancel           boolean NOT NULL DEFAULT true,
        allow_customer_reschedule       boolean NOT NULL DEFAULT true,
        max_reschedules_per_appointment integer NOT NULL DEFAULT 3 CHECK (max_reschedules_per_appointment >= 0),
        require_approval                boolean NOT NULL DEFAULT false,
        max_bookings_per_customer_per_day integer CHECK (max_bookings_per_customer_per_day > 0),
        max_bookings_per_staff_per_day  integer CHECK (max_bookings_per_staff_per_day > 0),
        -- Minutes after start_at before an appointment may be marked NO_SHOW.
        no_show_grace_minutes           integer NOT NULL DEFAULT 15 CHECK (no_show_grace_minutes >= 0),
        waitlist_enabled                boolean NOT NULL DEFAULT true,
        -- How long a notified waitlist customer keeps an exclusive claim.
        waitlist_hold_minutes           integer NOT NULL DEFAULT 60 CHECK (waitlist_hold_minutes > 0),
        waitlist_auto_book              boolean NOT NULL DEFAULT false,
        reminder_offsets_minutes        integer[] NOT NULL DEFAULT ARRAY[1440, 60],
        branding                        jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at                      timestamptz NOT NULL DEFAULT now(),
        updated_at                      timestamptz NOT NULL DEFAULT now()
      );
    `);

    // -----------------------------------------------------------------------
    // Roles & permissions. business_id NULL marks a built-in system template
    // that every workspace inherits at creation time.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE roles (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid REFERENCES businesses (id) ON DELETE CASCADE,
        key         text NOT NULL
                      CHECK (key ~ '^[A-Z][A-Z0-9_]*$'),
        name        text NOT NULL,
        description text,
        -- System roles cannot be renamed or deleted through the API.
        is_system   boolean NOT NULL DEFAULT false,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
    `);
    // One key per workspace…
    await sql.query(`
      CREATE UNIQUE INDEX roles_business_key_unique
        ON roles (business_id, key) WHERE business_id IS NOT NULL;
    `);
    // …and one global template per key.
    await sql.query(`
      CREATE UNIQUE INDEX roles_system_key_unique
        ON roles (key) WHERE business_id IS NULL;
    `);

    await sql.query(`
      CREATE TABLE role_permissions (
        role_id       uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
        permission_id uuid NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
        created_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (role_id, permission_id)
      );
    `);
    await sql.query(
      `CREATE INDEX role_permissions_permission_idx ON role_permissions (permission_id);`,
    );

    // -----------------------------------------------------------------------
    // Membership = the authenticated link between a user and a tenant.
    // This row is the ONLY source of tenant context for management APIs.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE memberships (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        business_id    uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        role_id        uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
        status         text NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED')),
        invited_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        invited_at     timestamptz,
        joined_at      timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        deleted_at     timestamptz
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX memberships_user_business_unique
        ON memberships (user_id, business_id) WHERE deleted_at IS NULL;
    `);
    await sql.query(`CREATE INDEX memberships_business_idx ON memberships (business_id, status);`);
    await sql.query(`CREATE INDEX memberships_user_idx ON memberships (user_id, status);`);

    // Per-member exceptions layered on top of the role. DENY always wins, which
    // makes "this staff member must not see revenue" expressible without
    // cloning an entire role.
    await sql.query(`
      CREATE TABLE membership_permissions (
        membership_id uuid NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
        permission_id uuid NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
        effect        text NOT NULL CHECK (effect IN ('GRANT', 'DENY')),
        created_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (membership_id, permission_id)
      );
    `);
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    await sql.query('DROP TABLE IF EXISTS membership_permissions CASCADE;');
    await sql.query('DROP TABLE IF EXISTS memberships CASCADE;');
    await sql.query('DROP TABLE IF EXISTS role_permissions CASCADE;');
    await sql.query('DROP TABLE IF EXISTS roles CASCADE;');
    await sql.query('DROP TABLE IF EXISTS business_settings CASCADE;');
    await sql.query('DROP TABLE IF EXISTS businesses CASCADE;');
  },
};
