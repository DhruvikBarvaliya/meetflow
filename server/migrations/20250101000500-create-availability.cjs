'use strict';

/**
 * Availability rules.
 *
 * Two distinct kinds of rule live here, and the difference matters:
 *
 *  - **Wall-clock rules** (`business_hours`, `staff_availability_rules`,
 *    `availability_overrides`) are stored as *minutes from local midnight* plus
 *    a weekday or calendar date. They are resolved to instants against an IANA
 *    zone at query time, which is what keeps "we open at 09:00" true on both
 *    sides of a DST transition.
 *
 *  - **Instant rules** (`blackout_periods`) are absolute `timestamptz` ranges,
 *    because "the clinic is shut from 14:00 UTC Friday to 08:00 UTC Monday" is a
 *    span of real time, not a repeating wall-clock pattern.
 *
 * `end_minute` may exceed 1440 to express hours that run past midnight
 * (22:00–02:00 is stored as 1320–1560).
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    // Opening hours for the workspace, optionally specialised per location.
    await sql.query(`
      CREATE TABLE business_hours (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id  uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        -- NULL = applies to the whole business; a row for a location overrides
        -- the business-wide rows for that location entirely.
        location_id  uuid REFERENCES locations (id) ON DELETE CASCADE,
        day_of_week  smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
        end_minute   integer NOT NULL CHECK (end_minute BETWEEN 1 AND 2880),
        is_active    boolean NOT NULL DEFAULT true,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT business_hours_window_check CHECK (end_minute > start_minute)
      );
    `);
    // Several rows per day are legitimate (a split shift with a lunch closure),
    // but the same window must not be entered twice.
    await sql.query(`
      CREATE UNIQUE INDEX business_hours_unique_window
        ON business_hours (business_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid), day_of_week, start_minute);
    `);
    await sql.query(`
      CREATE INDEX business_hours_lookup_idx ON business_hours (business_id, day_of_week, is_active);
    `);

    // Recurring weekly working hours per staff member, in the staff timezone.
    await sql.query(`
      CREATE TABLE staff_availability_rules (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id      uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        staff_profile_id uuid NOT NULL REFERENCES staff_profiles (id) ON DELETE CASCADE,
        -- NULL = the staff member works this window at any location.
        location_id      uuid REFERENCES locations (id) ON DELETE CASCADE,
        day_of_week      smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        start_minute     integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
        end_minute       integer NOT NULL CHECK (end_minute BETWEEN 1 AND 2880),
        -- Bounded validity lets a schedule change take effect on a future date
        -- without destroying the history of what it used to be.
        effective_from   date,
        effective_to     date,
        is_active        boolean NOT NULL DEFAULT true,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT staff_availability_window_check CHECK (end_minute > start_minute),
        CONSTRAINT staff_availability_effective_check
          CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
      );
    `);
    await sql.query(`
      CREATE INDEX staff_availability_lookup_idx
        ON staff_availability_rules (staff_profile_id, day_of_week, is_active);
    `);
    await sql.query(`
      CREATE INDEX staff_availability_business_idx ON staff_availability_rules (business_id);
    `);

    // Date-specific exceptions to the recurring rules above. Covers both
    // "working extra hours this Saturday" and "on leave all day Tuesday".
    await sql.query(`
      CREATE TABLE availability_overrides (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id      uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        scope            text NOT NULL CHECK (scope IN ('BUSINESS', 'LOCATION', 'STAFF', 'RESOURCE')),
        staff_profile_id uuid REFERENCES staff_profiles (id) ON DELETE CASCADE,
        location_id      uuid REFERENCES locations (id) ON DELETE CASCADE,
        resource_id      uuid REFERENCES resources (id) ON DELETE CASCADE,
        date             date NOT NULL,
        -- false = unavailable for the window (or the whole day when the window
        -- is NULL); true = available for the window *instead of* the usual rules.
        is_available     boolean NOT NULL,
        start_minute     integer CHECK (start_minute BETWEEN 0 AND 1439),
        end_minute       integer CHECK (end_minute BETWEEN 1 AND 2880),
        reason           text CHECK (reason IN
                           ('LEAVE', 'SICK', 'HOLIDAY', 'TRAINING', 'MAINTENANCE',
                            'EXTRA_HOURS', 'CUSTOM')),
        note             text,
        created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT availability_overrides_window_check
          CHECK ((start_minute IS NULL AND end_minute IS NULL) OR
                 (start_minute IS NOT NULL AND end_minute IS NOT NULL AND end_minute > start_minute)),
        -- The scope column and the populated foreign key must agree, so a row
        -- can never be silently applied to the wrong kind of entity.
        CONSTRAINT availability_overrides_scope_target_check CHECK (
          (scope = 'BUSINESS' AND staff_profile_id IS NULL AND location_id IS NULL AND resource_id IS NULL) OR
          (scope = 'LOCATION' AND location_id IS NOT NULL AND staff_profile_id IS NULL AND resource_id IS NULL) OR
          (scope = 'STAFF'    AND staff_profile_id IS NOT NULL AND resource_id IS NULL) OR
          (scope = 'RESOURCE' AND resource_id IS NOT NULL AND staff_profile_id IS NULL)
        )
      );
    `);
    await sql.query(`
      CREATE INDEX availability_overrides_staff_date_idx
        ON availability_overrides (staff_profile_id, date) WHERE staff_profile_id IS NOT NULL;
    `);
    await sql.query(`
      CREATE INDEX availability_overrides_business_date_idx
        ON availability_overrides (business_id, date);
    `);
    await sql.query(`
      CREATE INDEX availability_overrides_resource_date_idx
        ON availability_overrides (resource_id, date) WHERE resource_id IS NOT NULL;
    `);

    await sql.query(`
      CREATE TABLE holidays (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id           uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        -- NULL = observed by every location.
        location_id           uuid REFERENCES locations (id) ON DELETE CASCADE,
        name                  text NOT NULL,
        date                  date NOT NULL,
        -- Repeats on the same month/day every year (Christmas, Independence Day).
        is_recurring_annually boolean NOT NULL DEFAULT false,
        -- Some holidays close the business entirely, others only reduce hours;
        -- when false the day stays open and this is purely informational.
        closes_business       boolean NOT NULL DEFAULT true,
        is_active             boolean NOT NULL DEFAULT true,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX holidays_unique
        ON holidays (business_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid), date, name);
    `);
    await sql.query(`CREATE INDEX holidays_business_date_idx ON holidays (business_id, date);`);
    // Recurring holidays are matched on month/day, so index that projection.
    await sql.query(`
      CREATE INDEX holidays_recurring_idx
        ON holidays (business_id, (EXTRACT(MONTH FROM date)), (EXTRACT(DAY FROM date)))
        WHERE is_recurring_annually;
    `);

    // Absolute unavailable spans: maintenance windows, multi-day leave, offsite
    // events. Stored as instants because they do not repeat on a wall clock.
    await sql.query(`
      CREATE TABLE blackout_periods (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id      uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        scope            text NOT NULL CHECK (scope IN ('BUSINESS', 'LOCATION', 'STAFF', 'RESOURCE')),
        staff_profile_id uuid REFERENCES staff_profiles (id) ON DELETE CASCADE,
        location_id      uuid REFERENCES locations (id) ON DELETE CASCADE,
        resource_id      uuid REFERENCES resources (id) ON DELETE CASCADE,
        starts_at        timestamptz NOT NULL,
        ends_at          timestamptz NOT NULL,
        reason           text NOT NULL DEFAULT 'CUSTOM'
                           CHECK (reason IN ('LEAVE', 'SICK', 'MAINTENANCE', 'CLOSURE',
                                             'TRAINING', 'EVENT', 'CUSTOM')),
        note             text,
        created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT blackout_periods_range_check CHECK (ends_at > starts_at),
        CONSTRAINT blackout_periods_scope_target_check CHECK (
          (scope = 'BUSINESS' AND staff_profile_id IS NULL AND location_id IS NULL AND resource_id IS NULL) OR
          (scope = 'LOCATION' AND location_id IS NOT NULL AND staff_profile_id IS NULL AND resource_id IS NULL) OR
          (scope = 'STAFF'    AND staff_profile_id IS NOT NULL AND resource_id IS NULL) OR
          (scope = 'RESOURCE' AND resource_id IS NOT NULL AND staff_profile_id IS NULL)
        )
      );
    `);
    // GiST range index: the engine asks "which blackouts overlap this window?".
    await sql.query(`
      CREATE INDEX blackout_periods_range_idx
        ON blackout_periods USING gist (business_id, tstzrange(starts_at, ends_at));
    `);
    await sql.query(`
      CREATE INDEX blackout_periods_staff_idx
        ON blackout_periods (staff_profile_id, starts_at) WHERE staff_profile_id IS NOT NULL;
    `);
    await sql.query(`
      CREATE INDEX blackout_periods_resource_idx
        ON blackout_periods (resource_id, starts_at) WHERE resource_id IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    await sql.query('DROP TABLE IF EXISTS blackout_periods CASCADE;');
    await sql.query('DROP TABLE IF EXISTS holidays CASCADE;');
    await sql.query('DROP TABLE IF EXISTS availability_overrides CASCADE;');
    await sql.query('DROP TABLE IF EXISTS staff_availability_rules CASCADE;');
    await sql.query('DROP TABLE IF EXISTS business_hours CASCADE;');
  },
};
