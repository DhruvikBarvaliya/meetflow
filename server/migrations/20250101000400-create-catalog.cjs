'use strict';

/**
 * Service catalogue and schedulable resources.
 *
 * A service defines *what* is booked and every scheduling rule specific to it.
 * NULL on an override column means "inherit from business_settings", so a
 * workspace can change one default and have it apply everywhere it was not
 * deliberately overridden.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    await sql.query(`
      CREATE TABLE service_categories (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        name        text NOT NULL,
        slug        text NOT NULL,
        description text,
        color       text CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
        sort_order  integer NOT NULL DEFAULT 0,
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        deleted_at  timestamptz
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX service_categories_business_slug_unique
        ON service_categories (business_id, slug) WHERE deleted_at IS NULL;
    `);

    await sql.query(`
      CREATE TABLE services (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id           uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        category_id           uuid REFERENCES service_categories (id) ON DELETE SET NULL,
        name                  text NOT NULL,
        slug                  text NOT NULL,
        description           text,
        duration_minutes      integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
        -- Preparation/cleanup time reserved on the staff calendar around the
        -- appointment. Buffers block the calendar but are not shown as the
        -- appointment's own duration to the customer.
        pre_buffer_minutes    integer CHECK (pre_buffer_minutes BETWEEN 0 AND 1440),
        post_buffer_minutes   integer CHECK (post_buffer_minutes BETWEEN 0 AND 1440),
        -- Price in the smallest currency unit (paise/cents) — never a float.
        price_amount          integer NOT NULL DEFAULT 0 CHECK (price_amount >= 0),
        currency              char(3) NOT NULL DEFAULT 'USD',
        -- >1 turns this into a group service: one appointment, many
        -- participants, capacity enforced transactionally on booking.
        capacity              integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 1000),
        -- NULL on the next four = inherit from business_settings.
        min_notice_minutes    integer CHECK (min_notice_minutes >= 0),
        max_horizon_days      integer CHECK (max_horizon_days BETWEEN 1 AND 730),
        slot_interval_minutes integer CHECK (slot_interval_minutes BETWEEN 1 AND 480),
        max_per_customer_per_day integer CHECK (max_per_customer_per_day > 0),
        requires_approval     boolean NOT NULL DEFAULT false,
        assignment_strategy   text NOT NULL DEFAULT 'SMART_MATCH'
                                CHECK (assignment_strategy IN
                                  ('ROUND_ROBIN', 'COLLECTIVE', 'POOLED', 'SMART_MATCH')),
        color                 text CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
        -- Visible on public booking pages (private services are internal-only).
        is_public             boolean NOT NULL DEFAULT true,
        is_active             boolean NOT NULL DEFAULT true,
        sort_order            integer NOT NULL DEFAULT 0,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        deleted_at            timestamptz
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX services_business_slug_unique
        ON services (business_id, slug) WHERE deleted_at IS NULL;
    `);
    // Hot path: "list the bookable services for this workspace".
    await sql.query(`
      CREATE INDEX services_business_active_idx
        ON services (business_id, is_active, is_public) WHERE deleted_at IS NULL;
    `);
    await sql.query(`CREATE INDEX services_category_idx ON services (category_id);`);

    // Which staff may deliver which service, with per-pairing overrides.
    await sql.query(`
      CREATE TABLE service_staff (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        service_id                uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
        staff_profile_id          uuid NOT NULL REFERENCES staff_profiles (id) ON DELETE CASCADE,
        -- A senior stylist may need longer/charge more for the same service.
        duration_minutes_override integer CHECK (duration_minutes_override BETWEEN 1 AND 1440),
        price_amount_override     integer CHECK (price_amount_override >= 0),
        priority                  integer NOT NULL DEFAULT 0,
        weight                    integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 100),
        is_active                 boolean NOT NULL DEFAULT true,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX service_staff_unique ON service_staff (service_id, staff_profile_id);
    `);
    await sql.query(
      `CREATE INDEX service_staff_staff_idx ON service_staff (staff_profile_id, is_active);`,
    );

    // Where a service is offered. No rows = offered at every active location.
    await sql.query(`
      CREATE TABLE service_locations (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        service_id  uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
        location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX service_locations_unique ON service_locations (service_id, location_id);
    `);
    await sql.query(
      `CREATE INDEX service_locations_location_idx ON service_locations (location_id);`,
    );

    await sql.query(`
      CREATE TABLE resources (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        -- NULL = the resource is mobile / not tied to one site.
        location_id uuid REFERENCES locations (id) ON DELETE SET NULL,
        name        text NOT NULL,
        slug        text NOT NULL,
        type        text NOT NULL DEFAULT 'ROOM'
                      CHECK (type IN ('ROOM', 'EQUIPMENT', 'VEHICLE', 'DESK', 'FACILITY', 'OTHER')),
        description text,
        -- How many appointments may hold this resource at the same instant.
        capacity    integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 1000),
        color       text CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        deleted_at  timestamptz
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX resources_business_slug_unique
        ON resources (business_id, slug) WHERE deleted_at IS NULL;
    `);
    await sql.query(`
      CREATE INDEX resources_business_active_idx ON resources (business_id, is_active, type);
    `);
    await sql.query(`CREATE INDEX resources_location_idx ON resources (location_id);`);

    // A service's resource needs, expressed either as a specific resource or as
    // "any N resources of this type" (a pool). Exactly one form per row.
    await sql.query(`
      CREATE TABLE service_resource_requirements (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        service_id    uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
        resource_id   uuid REFERENCES resources (id) ON DELETE CASCADE,
        resource_type text CHECK (resource_type IN
                        ('ROOM', 'EQUIPMENT', 'VEHICLE', 'DESK', 'FACILITY', 'OTHER')),
        quantity      integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
        -- A non-required requirement is reserved when possible and skipped when
        -- not, so an optional nicety never blocks a booking.
        is_required   boolean NOT NULL DEFAULT true,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT service_resource_requirements_target_check CHECK (
          (resource_id IS NOT NULL AND resource_type IS NULL) OR
          (resource_id IS NULL AND resource_type IS NOT NULL)
        )
      );
    `);
    await sql.query(`
      CREATE INDEX service_resource_requirements_service_idx
        ON service_resource_requirements (service_id);
    `);
    await sql.query(`
      CREATE INDEX service_resource_requirements_resource_idx
        ON service_resource_requirements (resource_id) WHERE resource_id IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    await sql.query('DROP TABLE IF EXISTS service_resource_requirements CASCADE;');
    await sql.query('DROP TABLE IF EXISTS resources CASCADE;');
    await sql.query('DROP TABLE IF EXISTS service_locations CASCADE;');
    await sql.query('DROP TABLE IF EXISTS service_staff CASCADE;');
    await sql.query('DROP TABLE IF EXISTS services CASCADE;');
    await sql.query('DROP TABLE IF EXISTS service_categories CASCADE;');
  },
};
