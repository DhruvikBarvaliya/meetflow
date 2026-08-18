'use strict';

/**
 * Booking core: customers, public booking links, appointments and the
 * reservations that make double-booking impossible.
 *
 * ## How overlap is actually prevented
 *
 * Application-level conflict checks always lose a race eventually: two requests
 * can both read "free" before either writes. MeetFlow therefore pushes the
 * final word down to PostgreSQL using GiST exclusion constraints (enabled by
 * the btree_gist extension):
 *
 *   - `appointment_staff`    — one staff member cannot hold two overlapping
 *                              blocking reservations.
 *   - `appointment_resources`— one single-capacity resource cannot be held by
 *                              two overlapping appointments.
 *
 * These are real constraints on real range values, not advisory logic. Under
 * concurrency the loser receives a `23P01 exclusion_violation`, which the
 * booking service translates into a clean 409 SLOT_UNAVAILABLE.
 *
 * Reservations carry the *buffered* window (pre/post buffer included), so
 * back-to-back bookings respect preparation and cleanup time.
 *
 * Group services (capacity > 1) are modelled as ONE appointment with many
 * `appointment_participants`. That keeps every appointment exclusive on the
 * staff calendar while still allowing a yoga class of 20. Capacity itself is
 * enforced transactionally with a row lock — see the booking service.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    // -----------------------------------------------------------------------
    // Customers — tenant-scoped, optionally linked to a login for self-service.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE customers (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id              uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        -- Opaque handle used in customer-facing links; never expose the uuid.
        public_id                text NOT NULL,
        -- Set when the customer has a MeetFlow login. Public bookings may be
        -- made without one.
        user_id                  uuid REFERENCES users (id) ON DELETE SET NULL,
        first_name               text NOT NULL,
        last_name                text,
        email                    citext NOT NULL,
        phone                    text,
        timezone                 text NOT NULL DEFAULT 'UTC',
        locale                   text NOT NULL DEFAULT 'en-US',
        notes                    text,
        tags                     text[] NOT NULL DEFAULT ARRAY[]::text[],
        preferred_staff_profile_id uuid REFERENCES staff_profiles (id) ON DELETE SET NULL,
        preferred_location_id    uuid REFERENCES locations (id) ON DELETE SET NULL,
        -- { emailEnabled, smsEnabled, reminderOffsetsMinutes, marketingOptIn }
        communication_preferences jsonb NOT NULL DEFAULT
                                   '{"emailEnabled":true,"smsEnabled":false,"marketingOptIn":false}'::jsonb,
        status                   text NOT NULL DEFAULT 'ACTIVE'
                                   CHECK (status IN ('ACTIVE', 'BLOCKED', 'ARCHIVED')),
        -- Denormalised counters maintained by the lifecycle service. They are
        -- reporting accelerators; appointments remain the source of truth.
        total_bookings           integer NOT NULL DEFAULT 0 CHECK (total_bookings >= 0),
        completed_count          integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
        cancelled_count          integer NOT NULL DEFAULT 0 CHECK (cancelled_count >= 0),
        no_show_count            integer NOT NULL DEFAULT 0 CHECK (no_show_count >= 0),
        first_appointment_at     timestamptz,
        last_appointment_at      timestamptz,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now(),
        deleted_at               timestamptz
      );
    `);
    // One customer record per email per tenant. The same person booking with
    // two businesses is deliberately two records — tenants never share data.
    await sql.query(`
      CREATE UNIQUE INDEX customers_business_email_unique
        ON customers (business_id, email) WHERE deleted_at IS NULL;
    `);
    await sql.query(`CREATE UNIQUE INDEX customers_public_id_unique ON customers (public_id);`);
    await sql.query(`CREATE INDEX customers_business_idx ON customers (business_id, status);`);
    await sql.query(
      `CREATE INDEX customers_user_idx ON customers (user_id) WHERE user_id IS NOT NULL;`,
    );
    await sql.query(`CREATE INDEX customers_tags_idx ON customers USING gin (tags);`);
    // Supports "search customers by name/email" without a sequential scan.
    await sql.query(`
      CREATE INDEX customers_search_idx
        ON customers (business_id, lower(first_name), lower(coalesce(last_name, '')));
    `);

    // -----------------------------------------------------------------------
    // Public booking links.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE booking_links (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id       uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        -- Globally unique because it is the whole public URL path.
        slug              text NOT NULL,
        name              text NOT NULL,
        description       text,
        type              text NOT NULL DEFAULT 'CATALOG'
                            CHECK (type IN ('SINGLE_SERVICE', 'CATALOG', 'TEAM', 'STAFF')),
        service_id        uuid REFERENCES services (id) ON DELETE CASCADE,
        team_id           uuid REFERENCES teams (id) ON DELETE CASCADE,
        staff_profile_id  uuid REFERENCES staff_profiles (id) ON DELETE CASCADE,
        location_id       uuid REFERENCES locations (id) ON DELETE SET NULL,
        -- Lets the customer pick their provider; when false the engine assigns.
        allow_staff_selection boolean NOT NULL DEFAULT true,
        requires_approval boolean NOT NULL DEFAULT false,
        -- Extra questions rendered on the booking form:
        -- [{ key, label, type, required, options[] }]
        custom_questions  jsonb NOT NULL DEFAULT '[]'::jsonb,
        branding          jsonb NOT NULL DEFAULT '{}'::jsonb,
        -- Anti-abuse / campaign controls.
        max_bookings_total integer CHECK (max_bookings_total > 0),
        booking_count     integer NOT NULL DEFAULT 0 CHECK (booking_count >= 0),
        expires_at        timestamptz,
        is_active         boolean NOT NULL DEFAULT true,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        deleted_at        timestamptz,
        -- The link's type and its populated target must agree.
        CONSTRAINT booking_links_target_check CHECK (
          (type = 'SINGLE_SERVICE' AND service_id IS NOT NULL) OR
          (type = 'TEAM'           AND team_id IS NOT NULL) OR
          (type = 'STAFF'          AND staff_profile_id IS NOT NULL) OR
          (type = 'CATALOG')
        )
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX booking_links_slug_unique
        ON booking_links (slug) WHERE deleted_at IS NULL;
    `);
    await sql.query(
      `CREATE INDEX booking_links_business_idx ON booking_links (business_id, is_active);`,
    );

    await sql.query(`
      CREATE TABLE booking_link_services (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_link_id uuid NOT NULL REFERENCES booking_links (id) ON DELETE CASCADE,
        service_id      uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
        sort_order      integer NOT NULL DEFAULT 0,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX booking_link_services_unique
        ON booking_link_services (booking_link_id, service_id);
    `);

    // -----------------------------------------------------------------------
    // Appointments.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE appointments (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- Opaque, unguessable identifier used in every customer-facing URL.
        public_id           text NOT NULL,
        business_id         uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        service_id          uuid NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
        location_id         uuid REFERENCES locations (id) ON DELETE SET NULL,
        -- Primary provider. NULL only while an approval-required booking waits
        -- to be assigned.
        staff_profile_id    uuid REFERENCES staff_profiles (id) ON DELETE SET NULL,
        team_id             uuid REFERENCES teams (id) ON DELETE SET NULL,
        -- Primary customer; group bookings list everyone in participants.
        customer_id         uuid REFERENCES customers (id) ON DELETE SET NULL,
        booking_link_id     uuid REFERENCES booking_links (id) ON DELETE SET NULL,

        -- Lifecycle. PENDING/CONFIRMED/RESCHEDULED/IN_PROGRESS are "active":
        -- they occupy the calendar. RESCHEDULED means confirmed *and* moved at
        -- least once — the row keeps its identity so the customer's management
        -- link never breaks, while reschedule_history records every move.
        status              text NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED',
                                                'IN_PROGRESS', 'COMPLETED', 'CANCELLED',
                                                'NO_SHOW', 'REJECTED')),

        -- The appointment as the customer sees it.
        starts_at           timestamptz NOT NULL,
        ends_at             timestamptz NOT NULL,
        -- The calendar footprint including buffers. Reservations use this.
        buffer_start_at     timestamptz NOT NULL,
        buffer_end_at       timestamptz NOT NULL,
        duration_minutes    integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
        pre_buffer_minutes  integer NOT NULL DEFAULT 0 CHECK (pre_buffer_minutes >= 0),
        post_buffer_minutes integer NOT NULL DEFAULT 0 CHECK (post_buffer_minutes >= 0),
        -- Zone the customer booked in, so confirmations echo their own clock.
        timezone            text NOT NULL DEFAULT 'UTC',

        capacity            integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 1000),
        booked_count        integer NOT NULL DEFAULT 0 CHECK (booked_count >= 0),

        price_amount        integer NOT NULL DEFAULT 0 CHECK (price_amount >= 0),
        currency            char(3) NOT NULL DEFAULT 'USD',
        source              text NOT NULL DEFAULT 'PUBLIC'
                              CHECK (source IN ('PUBLIC', 'STAFF', 'OWNER', 'ADMIN', 'API', 'WAITLIST')),
        title               text,
        customer_notes      text,
        internal_notes      text,
        answers             jsonb NOT NULL DEFAULT '{}'::jsonb,
        requires_approval   boolean NOT NULL DEFAULT false,

        confirmed_at        timestamptz,
        checked_in_at       timestamptz,
        started_at          timestamptz,
        completed_at        timestamptz,
        cancelled_at        timestamptz,
        no_show_at          timestamptz,
        cancellation_reason text,
        cancelled_by_type   text CHECK (cancelled_by_type IN ('CUSTOMER', 'STAFF', 'OWNER', 'ADMIN', 'SYSTEM')),
        cancelled_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        -- True when the cancellation broke the configured deadline.
        late_cancellation   boolean NOT NULL DEFAULT false,

        rescheduled_from_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
        reschedule_count    integer NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),

        -- Present when the booking arrived through an idempotent public call.
        idempotency_key     text,
        created_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT appointments_time_check CHECK (ends_at > starts_at),
        CONSTRAINT appointments_buffer_check
          CHECK (buffer_start_at <= starts_at AND buffer_end_at >= ends_at),
        -- Named to avoid colliding with the auto-generated column-level check
        -- names PostgreSQL derives as <table>_<column>_check.
        CONSTRAINT appointments_capacity_limit_check CHECK (booked_count <= capacity)
      );
    `);
    await sql.query(
      `CREATE UNIQUE INDEX appointments_public_id_unique ON appointments (public_id);`,
    );
    // Idempotent replays are scoped per tenant.
    await sql.query(`
      CREATE UNIQUE INDEX appointments_idempotency_unique
        ON appointments (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
    // Hot paths from docs/Analytics.md and the calendar views.
    await sql.query(
      `CREATE INDEX appointments_business_start_idx ON appointments (business_id, starts_at);`,
    );
    await sql.query(`
      CREATE INDEX appointments_business_status_start_idx
        ON appointments (business_id, status, starts_at);
    `);
    await sql.query(`
      CREATE INDEX appointments_staff_start_idx
        ON appointments (staff_profile_id, starts_at) WHERE staff_profile_id IS NOT NULL;
    `);
    await sql.query(`
      CREATE INDEX appointments_customer_start_idx
        ON appointments (customer_id, starts_at DESC) WHERE customer_id IS NOT NULL;
    `);
    await sql.query(
      `CREATE INDEX appointments_service_status_idx ON appointments (service_id, status);`,
    );
    await sql.query(`
      CREATE INDEX appointments_location_start_idx
        ON appointments (location_id, starts_at) WHERE location_id IS NOT NULL;
    `);
    // Drives the reminder sweep and the "starting soon" dashboards.
    await sql.query(`
      CREATE INDEX appointments_upcoming_idx
        ON appointments (starts_at)
        WHERE status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED');
    `);
    await sql.query(
      `CREATE INDEX appointments_booking_link_idx ON appointments (booking_link_id);`,
    );

    // -----------------------------------------------------------------------
    // Staff reservations — the constraint that actually stops double booking.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE appointment_staff (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id   uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
        staff_profile_id uuid NOT NULL REFERENCES staff_profiles (id) ON DELETE CASCADE,
        role             text NOT NULL DEFAULT 'PRIMARY'
                           CHECK (role IN ('PRIMARY', 'ASSISTANT', 'OBSERVER')),
        -- Buffered window copied from the appointment. Denormalised on purpose:
        -- an exclusion constraint can only read columns of its own row.
        starts_at        timestamptz NOT NULL,
        ends_at          timestamptz NOT NULL,
        -- Cleared (not deleted) when an appointment is cancelled or completed,
        -- so the assignment stays auditable while the calendar frees up.
        is_blocking      boolean NOT NULL DEFAULT true,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT appointment_staff_range_check CHECK (ends_at > starts_at)
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX appointment_staff_unique
        ON appointment_staff (appointment_id, staff_profile_id);
    `);
    await sql.query(`
      ALTER TABLE appointment_staff
        ADD CONSTRAINT appointment_staff_no_overlap
        EXCLUDE USING gist (
          staff_profile_id WITH =,
          tstzrange(starts_at, ends_at, '[)') WITH &&
        ) WHERE (is_blocking);
    `);
    await sql.query(`
      CREATE INDEX appointment_staff_calendar_idx
        ON appointment_staff (staff_profile_id, starts_at) WHERE is_blocking;
    `);

    // -----------------------------------------------------------------------
    // Participants — one row per customer on an appointment (group services).
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE appointment_participants (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
        customer_id    uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
        -- Own opaque id: each attendee gets a personal manage link that must not
        -- let them act on anybody else's place in the class.
        public_id      text NOT NULL,
        role           text NOT NULL DEFAULT 'ATTENDEE'
                         CHECK (role IN ('ATTENDEE', 'ORGANIZER', 'GUEST')),
        status         text NOT NULL DEFAULT 'BOOKED'
                         CHECK (status IN ('BOOKED', 'CANCELLED', 'ATTENDED', 'NO_SHOW')),
        answers        jsonb NOT NULL DEFAULT '{}'::jsonb,
        joined_at      timestamptz NOT NULL DEFAULT now(),
        cancelled_at   timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX appointment_participants_public_id_unique
        ON appointment_participants (public_id);
    `);
    // A customer may re-join after cancelling, but cannot hold two live places.
    await sql.query(`
      CREATE UNIQUE INDEX appointment_participants_active_unique
        ON appointment_participants (appointment_id, customer_id)
        WHERE status <> 'CANCELLED';
    `);
    await sql.query(`
      CREATE INDEX appointment_participants_customer_idx
        ON appointment_participants (customer_id, status);
    `);

    // -----------------------------------------------------------------------
    // Resource reservations.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE appointment_resources (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
        resource_id    uuid NOT NULL REFERENCES resources (id) ON DELETE RESTRICT,
        quantity       integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
        starts_at      timestamptz NOT NULL,
        ends_at        timestamptz NOT NULL,
        -- Mirrors resources.capacity = 1 at reservation time. Only exclusive
        -- reservations participate in the overlap constraint; shared resources
        -- (capacity > 1) are counted transactionally under a row lock instead,
        -- because an exclusion constraint cannot express "at most N".
        is_exclusive   boolean NOT NULL DEFAULT true,
        is_active      boolean NOT NULL DEFAULT true,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT appointment_resources_range_check CHECK (ends_at > starts_at)
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX appointment_resources_unique
        ON appointment_resources (appointment_id, resource_id);
    `);
    await sql.query(`
      ALTER TABLE appointment_resources
        ADD CONSTRAINT appointment_resources_no_overlap
        EXCLUDE USING gist (
          resource_id WITH =,
          tstzrange(starts_at, ends_at, '[)') WITH &&
        ) WHERE (is_active AND is_exclusive);
    `);
    await sql.query(`
      CREATE INDEX appointment_resources_calendar_idx
        ON appointment_resources (resource_id, starts_at) WHERE is_active;
    `);

    // -----------------------------------------------------------------------
    // Immutable lifecycle history.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE appointment_status_history (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
        business_id    uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        from_status    text,
        to_status      text NOT NULL,
        actor_type     text NOT NULL DEFAULT 'SYSTEM'
                         CHECK (actor_type IN ('CUSTOMER', 'STAFF', 'OWNER', 'ADMIN', 'SYSTEM')),
        actor_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
        actor_label    text,
        reason         text,
        metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at     timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE INDEX appointment_status_history_appointment_idx
        ON appointment_status_history (appointment_id, created_at);
    `);
    await sql.query(`
      CREATE INDEX appointment_status_history_business_idx
        ON appointment_status_history (business_id, created_at DESC);
    `);

    await sql.query(`
      CREATE TABLE reschedule_history (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id          uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
        business_id             uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        previous_starts_at      timestamptz NOT NULL,
        previous_ends_at        timestamptz NOT NULL,
        new_starts_at           timestamptz NOT NULL,
        new_ends_at             timestamptz NOT NULL,
        previous_staff_profile_id uuid REFERENCES staff_profiles (id) ON DELETE SET NULL,
        new_staff_profile_id    uuid REFERENCES staff_profiles (id) ON DELETE SET NULL,
        previous_location_id    uuid REFERENCES locations (id) ON DELETE SET NULL,
        new_location_id         uuid REFERENCES locations (id) ON DELETE SET NULL,
        reason                  text,
        actor_type              text NOT NULL DEFAULT 'SYSTEM'
                                  CHECK (actor_type IN ('CUSTOMER', 'STAFF', 'OWNER', 'ADMIN', 'SYSTEM')),
        actor_user_id           uuid REFERENCES users (id) ON DELETE SET NULL,
        -- True when the move broke the configured reschedule deadline.
        late_reschedule         boolean NOT NULL DEFAULT false,
        created_at              timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE INDEX reschedule_history_appointment_idx
        ON reschedule_history (appointment_id, created_at);
    `);
    await sql.query(`
      CREATE INDEX reschedule_history_business_idx ON reschedule_history (business_id, created_at DESC);
    `);

    // -----------------------------------------------------------------------
    // Waitlist.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE waitlist_entries (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        public_id            text NOT NULL,
        business_id          uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        customer_id          uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
        service_id           uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
        -- NULL = no preference; a value narrows which openings qualify.
        staff_profile_id     uuid REFERENCES staff_profiles (id) ON DELETE SET NULL,
        location_id          uuid REFERENCES locations (id) ON DELETE SET NULL,
        -- Desired window, expressed in the customer's own timezone.
        earliest_date        date NOT NULL,
        latest_date          date NOT NULL,
        earliest_minute      integer NOT NULL DEFAULT 0 CHECK (earliest_minute BETWEEN 0 AND 1439),
        latest_minute        integer NOT NULL DEFAULT 1439 CHECK (latest_minute BETWEEN 1 AND 1440),
        -- Empty array = any weekday is acceptable.
        days_of_week         smallint[] NOT NULL DEFAULT ARRAY[]::smallint[],
        timezone             text NOT NULL DEFAULT 'UTC',
        status               text NOT NULL DEFAULT 'ACTIVE'
                               CHECK (status IN ('ACTIVE', 'NOTIFIED', 'CONVERTED', 'EXPIRED', 'CANCELLED')),
        -- Lower number = evaluated first, then by created_at (FIFO fairness).
        priority             integer NOT NULL DEFAULT 100,
        notify_channel       text NOT NULL DEFAULT 'EMAIL' CHECK (notify_channel IN ('EMAIL', 'SMS', 'NONE')),
        notified_at          timestamptz,
        notification_count   integer NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
        -- While set and in the future this customer holds an exclusive claim on
        -- the opening they were told about.
        hold_expires_at      timestamptz,
        held_slot_starts_at  timestamptz,
        converted_appointment_id uuid REFERENCES appointments (id) ON DELETE SET NULL,
        expires_at           timestamptz,
        note                 text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT waitlist_date_range_check CHECK (latest_date >= earliest_date),
        CONSTRAINT waitlist_minute_range_check CHECK (latest_minute > earliest_minute)
      );
    `);
    await sql.query(
      `CREATE UNIQUE INDEX waitlist_public_id_unique ON waitlist_entries (public_id);`,
    );
    // One live request per customer per service — re-asking should update, not
    // stack up duplicate notifications.
    await sql.query(`
      CREATE UNIQUE INDEX waitlist_active_unique
        ON waitlist_entries (business_id, customer_id, service_id)
        WHERE status IN ('ACTIVE', 'NOTIFIED');
    `);
    // The eligibility scan: service + status + date window, ordered by fairness.
    await sql.query(`
      CREATE INDEX waitlist_eligibility_idx
        ON waitlist_entries (service_id, status, earliest_date, latest_date, priority, created_at);
    `);
    await sql.query(`
      CREATE INDEX waitlist_business_status_idx ON waitlist_entries (business_id, status);
    `);
    await sql.query(`
      CREATE INDEX waitlist_hold_idx ON waitlist_entries (hold_expires_at)
        WHERE hold_expires_at IS NOT NULL;
    `);

    // -----------------------------------------------------------------------
    // Idempotency records.
    //
    // Durable in PostgreSQL rather than Redis-only: a replayed booking must
    // still be deduplicated after a cache flush or a Redis restart.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE idempotency_keys (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- Namespaces the key so the same value on different operations cannot
        -- collide, e.g. 'public.booking.create'.
        scope           text NOT NULL,
        key             text NOT NULL,
        business_id     uuid REFERENCES businesses (id) ON DELETE CASCADE,
        -- Digest of the canonical request body. A repeat with the same key but
        -- a different payload is a client bug and is rejected, not served.
        request_hash    text NOT NULL,
        status          text NOT NULL DEFAULT 'IN_PROGRESS'
                          CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
        response_status integer,
        response_body   jsonb,
        resource_type   text,
        resource_id     uuid,
        locked_at       timestamptz NOT NULL DEFAULT now(),
        completed_at    timestamptz,
        expires_at      timestamptz NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(
      `CREATE UNIQUE INDEX idempotency_keys_unique ON idempotency_keys (scope, key);`,
    );
    await sql.query(`CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);`);
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    for (const table of [
      'idempotency_keys',
      'waitlist_entries',
      'reschedule_history',
      'appointment_status_history',
      'appointment_resources',
      'appointment_participants',
      'appointment_staff',
      'appointments',
      'booking_link_services',
      'booking_links',
      'customers',
    ]) {
      await sql.query(`DROP TABLE IF EXISTS ${table} CASCADE;`);
    }
  },
};
