'use strict';

/**
 * Notifications and workflow automation.
 *
 * `notifications` is a durable transactional outbox. A row is written inside
 * the same transaction as the business change that caused it, and the BullMQ
 * worker later picks it up and delivers it. That ordering is what makes the
 * system safe: an email is never sent for a booking that rolled back, and a
 * committed booking never loses its confirmation because Redis was down.
 *
 * Reminders are not a separate concept — a reminder is a notification with
 * `scheduled_for` in the future.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    await sql.query(`
      CREATE TABLE notification_templates (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- NULL = built-in default shipped with MeetFlow; a workspace row of the
        -- same key overrides it.
        business_id uuid REFERENCES businesses (id) ON DELETE CASCADE,
        key         text NOT NULL CHECK (key IN (
                      'BOOKING_CONFIRMATION', 'BOOKING_PENDING_APPROVAL', 'BOOKING_APPROVED',
                      'BOOKING_REJECTED', 'BOOKING_CANCELLED', 'BOOKING_RESCHEDULED',
                      'APPOINTMENT_REMINDER', 'APPOINTMENT_FOLLOW_UP', 'APPOINTMENT_NO_SHOW',
                      'WAITLIST_SLOT_AVAILABLE', 'WAITLIST_CONFIRMED',
                      'STAFF_ASSIGNED', 'STAFF_SCHEDULE_CHANGED', 'OWNER_DAILY_DIGEST',
                      'OWNER_NEW_BOOKING', 'CUSTOMER_WELCOME')),
        channel     text NOT NULL CHECK (channel IN ('EMAIL', 'SMS', 'IN_APP')),
        locale      text NOT NULL DEFAULT 'en-US',
        subject     text,
        -- Handlebars-style {{placeholders}} resolved from the notification payload.
        body_text   text NOT NULL,
        body_html   text,
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX notification_templates_business_unique
        ON notification_templates (business_id, key, channel, locale)
        WHERE business_id IS NOT NULL;
    `);
    await sql.query(`
      CREATE UNIQUE INDEX notification_templates_system_unique
        ON notification_templates (key, channel, locale) WHERE business_id IS NULL;
    `);

    await sql.query(`
      CREATE TABLE notifications (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id         uuid REFERENCES businesses (id) ON DELETE CASCADE,
        type                text NOT NULL,
        channel             text NOT NULL CHECK (channel IN ('EMAIL', 'SMS', 'IN_APP')),
        recipient_type      text NOT NULL
                              CHECK (recipient_type IN ('CUSTOMER', 'STAFF', 'OWNER', 'ADMIN')),
        recipient_customer_id uuid REFERENCES customers (id) ON DELETE CASCADE,
        recipient_user_id   uuid REFERENCES users (id) ON DELETE CASCADE,
        -- Snapshot of the destination at enqueue time: if the customer later
        -- changes their address, an in-flight message still goes where it was
        -- addressed, and the audit trail stays truthful.
        recipient_address   text NOT NULL,
        appointment_id      uuid REFERENCES appointments (id) ON DELETE CASCADE,
        waitlist_entry_id   uuid REFERENCES waitlist_entries (id) ON DELETE CASCADE,
        subject             text,
        body                text,
        payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
        status              text NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED')),
        -- A reminder is simply a notification scheduled in the future.
        scheduled_for       timestamptz NOT NULL DEFAULT now(),
        sent_at             timestamptz,
        failed_at           timestamptz,
        attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts        integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        last_error          text,
        provider_message_id text,
        -- Idempotency for the job layer: a retried job with the same dedupe key
        -- cannot produce a second email.
        dedupe_key          text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT notifications_recipient_check CHECK (
          recipient_customer_id IS NOT NULL OR recipient_user_id IS NOT NULL
        )
      );
    `);
    await sql.query(`
      CREATE UNIQUE INDEX notifications_dedupe_unique
        ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;
    `);
    // The worker's claim query: due, pending, oldest first.
    await sql.query(`
      CREATE INDEX notifications_due_idx
        ON notifications (scheduled_for) WHERE status = 'PENDING';
    `);
    await sql.query(
      `CREATE INDEX notifications_status_idx ON notifications (status, scheduled_for);`,
    );
    await sql.query(`
      CREATE INDEX notifications_appointment_idx
        ON notifications (appointment_id) WHERE appointment_id IS NOT NULL;
    `);
    await sql.query(`
      CREATE INDEX notifications_business_created_idx
        ON notifications (business_id, created_at DESC);
    `);
    await sql.query(`
      CREATE INDEX notifications_recipient_customer_idx
        ON notifications (recipient_customer_id) WHERE recipient_customer_id IS NOT NULL;
    `);

    // -----------------------------------------------------------------------
    // Automation: declarative "when X happens, do Y" rules per workspace.
    // -----------------------------------------------------------------------
    await sql.query(`
      CREATE TABLE automation_rules (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id   uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        name          text NOT NULL,
        description   text,
        trigger_event text NOT NULL CHECK (trigger_event IN (
                        'appointment.created', 'appointment.confirmed', 'appointment.cancelled',
                        'appointment.rescheduled', 'appointment.completed', 'appointment.no_show',
                        'appointment.approaching', 'waitlist.slot_available', 'customer.created')),
        -- [{ field, operator, value }] — all must match (AND).
        conditions    jsonb NOT NULL DEFAULT '[]'::jsonb,
        -- [{ type: 'SEND_NOTIFICATION' | 'CREATE_TASK' | 'EMIT_WEBHOOK' |
        --    'TAG_CUSTOMER' | 'EVALUATE_WAITLIST', ...params }]
        actions       jsonb NOT NULL DEFAULT '[]'::jsonb,
        -- Delay between the trigger firing and the actions running (0 = now).
        delay_minutes integer NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0),
        is_active     boolean NOT NULL DEFAULT true,
        run_count     integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
        last_run_at   timestamptz,
        created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        deleted_at    timestamptz
      );
    `);
    await sql.query(`
      CREATE INDEX automation_rules_trigger_idx
        ON automation_rules (business_id, trigger_event, is_active) WHERE deleted_at IS NULL;
    `);

    await sql.query(`
      CREATE TABLE automation_executions (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id       uuid NOT NULL REFERENCES automation_rules (id) ON DELETE CASCADE,
        business_id   uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        trigger_event text NOT NULL,
        entity_type   text NOT NULL,
        entity_id     uuid,
        status        text NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
        -- Which actions ran and what they produced — the "why did my automation
        -- do that?" answer for support.
        result        jsonb NOT NULL DEFAULT '{}'::jsonb,
        error         text,
        started_at    timestamptz,
        finished_at   timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE INDEX automation_executions_rule_idx ON automation_executions (rule_id, created_at DESC);
    `);
    await sql.query(`
      CREATE INDEX automation_executions_business_idx
        ON automation_executions (business_id, created_at DESC);
    `);
    await sql.query(`
      CREATE INDEX automation_executions_entity_idx ON automation_executions (entity_type, entity_id);
    `);
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    for (const table of [
      'automation_executions',
      'automation_rules',
      'notifications',
      'notification_templates',
    ]) {
      await sql.query(`DROP TABLE IF EXISTS ${table} CASCADE;`);
    }
  },
};
