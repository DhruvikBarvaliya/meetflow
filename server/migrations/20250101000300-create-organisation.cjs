'use strict';

/**
 * Organisational structure: locations, teams and staff.
 *
 * A `staff_profile` is the *bookable* identity. It is separate from `users`
 * because the same person can hold profiles in several businesses, and because
 * scheduling attributes (colour, load limits, bookability) belong to the
 * workspace, not to the global account.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    await sql.query(`
      CREATE TABLE locations (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id         uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        name                text NOT NULL,
        slug                text NOT NULL,
        type                text NOT NULL DEFAULT 'PHYSICAL'
                              CHECK (type IN ('PHYSICAL', 'VIRTUAL', 'PHONE', 'CUSTOMER_SITE')),
        description         text,
        address_line1       text,
        address_line2       text,
        city                text,
        state               text,
        postal_code         text,
        country_code        char(2),
        -- A location may sit in a different zone from its business (a chain
        -- with branches in several regions), so it carries its own.
        timezone            text NOT NULL DEFAULT 'UTC',
        phone               text,
        email               citext,
        -- For VIRTUAL locations: the static room URL, when not per-appointment.
        virtual_meeting_url text,
        -- Concurrent appointments the site can physically host (NULL = no cap).
        capacity            integer CHECK (capacity > 0),
        sort_order          integer NOT NULL DEFAULT 0,
        is_active           boolean NOT NULL DEFAULT true,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        deleted_at          timestamptz
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX locations_business_slug_unique
        ON locations (business_id, slug) WHERE deleted_at IS NULL;
    `);
    await sql.query(
      `CREATE INDEX locations_business_active_idx ON locations (business_id, is_active);`,
    );

    await sql.query(`
      CREATE TABLE teams (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id         uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        name                text NOT NULL,
        slug                text NOT NULL,
        description         text,
        -- How the engine picks a member when a booking targets the team:
        --  ROUND_ROBIN : rotate by least-recently-assigned, honouring weights
        --  COLLECTIVE  : every member must be free (panel interviews, surgery)
        --  POOLED      : any free member, first match wins
        --  SMART_MATCH : deterministic multi-factor ranking (see engine docs)
        assignment_strategy text NOT NULL DEFAULT 'ROUND_ROBIN'
                              CHECK (assignment_strategy IN
                                ('ROUND_ROBIN', 'COLLECTIVE', 'POOLED', 'SMART_MATCH')),
        is_active           boolean NOT NULL DEFAULT true,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        deleted_at          timestamptz
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX teams_business_slug_unique
        ON teams (business_id, slug) WHERE deleted_at IS NULL;
    `);

    await sql.query(`
      CREATE TABLE staff_profiles (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id            uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        user_id                uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        membership_id          uuid NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
        display_name           text NOT NULL,
        title                  text,
        bio                    text,
        avatar_url             text,
        -- Staff schedules are authored in the staff member's own timezone.
        timezone               text NOT NULL DEFAULT 'UTC',
        -- Calendar colour (hex) used by the dashboards.
        color                  text NOT NULL DEFAULT '#4F46E5'
                                 CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
        default_location_id    uuid REFERENCES locations (id) ON DELETE SET NULL,
        is_bookable            boolean NOT NULL DEFAULT true,
        -- Per-staff overrides of the business defaults. NULL = inherit.
        pre_buffer_minutes     integer CHECK (pre_buffer_minutes BETWEEN 0 AND 1440),
        post_buffer_minutes    integer CHECK (post_buffer_minutes BETWEEN 0 AND 1440),
        min_notice_minutes     integer CHECK (min_notice_minutes >= 0),
        max_daily_appointments integer CHECK (max_daily_appointments > 0),
        max_weekly_appointments integer CHECK (max_weekly_appointments > 0),
        -- Advisory cursor used by ROUND_ROBIN fairness; recomputed from
        -- appointments if it is ever lost.
        last_assigned_at       timestamptz,
        assignment_weight      integer NOT NULL DEFAULT 1 CHECK (assignment_weight BETWEEN 1 AND 100),
        sort_order             integer NOT NULL DEFAULT 0,
        is_active              boolean NOT NULL DEFAULT true,
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_at             timestamptz NOT NULL DEFAULT now(),
        deleted_at             timestamptz
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX staff_profiles_business_user_unique
        ON staff_profiles (business_id, user_id) WHERE deleted_at IS NULL;
    `);
    await sql.query(`
      CREATE INDEX staff_profiles_business_bookable_idx
        ON staff_profiles (business_id, is_active, is_bookable);
    `);
    await sql.query(
      `CREATE INDEX staff_profiles_membership_idx ON staff_profiles (membership_id);`,
    );

    await sql.query(`
      CREATE TABLE team_members (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id          uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
        staff_profile_id uuid NOT NULL REFERENCES staff_profiles (id) ON DELETE CASCADE,
        -- Higher weight => proportionally more round-robin assignments.
        weight           integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 100),
        -- Lower number wins ties in SMART_MATCH ranking.
        priority         integer NOT NULL DEFAULT 0,
        is_active        boolean NOT NULL DEFAULT true,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX team_members_unique ON team_members (team_id, staff_profile_id);
    `);
    await sql.query(`CREATE INDEX team_members_staff_idx ON team_members (staff_profile_id);`);
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    await sql.query('DROP TABLE IF EXISTS team_members CASCADE;');
    await sql.query('DROP TABLE IF EXISTS staff_profiles CASCADE;');
    await sql.query('DROP TABLE IF EXISTS teams CASCADE;');
    await sql.query('DROP TABLE IF EXISTS locations CASCADE;');
  },
};
