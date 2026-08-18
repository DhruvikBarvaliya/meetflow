'use strict';

/**
 * Audit trail and outbound webhooks.
 *
 * `audit_logs` is append-only by convention and by API surface: nothing in the
 * application updates or deletes a row. Every entry names the actor, the tenant,
 * the action, the entity and the request id, so an operational investigation can
 * reconstruct exactly who changed what and in which HTTP call.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    await sql.query(`
      CREATE TABLE audit_logs (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- NULL for platform-level events that belong to no single tenant.
        business_id   uuid REFERENCES businesses (id) ON DELETE CASCADE,
        actor_type    text NOT NULL DEFAULT 'SYSTEM'
                        CHECK (actor_type IN ('USER', 'CUSTOMER', 'SYSTEM', 'PUBLIC', 'API')),
        actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        actor_customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
        -- Human-readable actor snapshot ("Priya Shah <priya@…>") kept even if
        -- the account is later deleted.
        actor_label   text,
        -- Dotted verb, e.g. 'appointment.cancelled', 'role.permissions_changed'.
        action        text NOT NULL,
        entity_type   text NOT NULL,
        entity_id     uuid,
        -- Correlates the audit entry with the HTTP request and its logs.
        request_id    text,
        ip_address    inet,
        user_agent    text,
        -- Safe, non-sensitive context only: never tokens, hashes or passwords.
        metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`
      CREATE INDEX audit_logs_business_created_idx ON audit_logs (business_id, created_at DESC);
    `);
    await sql.query(`CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);`);
    await sql.query(`CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);`);
    await sql.query(`
      CREATE INDEX audit_logs_actor_idx
        ON audit_logs (actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL;
    `);
    await sql.query(`
      CREATE INDEX audit_logs_request_idx ON audit_logs (request_id) WHERE request_id IS NOT NULL;
    `);

    await sql.query(`
      CREATE TABLE webhook_endpoints (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id    uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        url            text NOT NULL CHECK (url ~ '^https?://'),
        description    text,
        -- Event names this endpoint subscribes to; '*' subscribes to all.
        events         text[] NOT NULL DEFAULT ARRAY['*']::text[],
        -- Used to compute the HMAC-SHA256 signature header. Returned to the
        -- caller exactly once, at creation, and never echoed by any read API.
        signing_secret text NOT NULL,
        is_active      boolean NOT NULL DEFAULT true,
        -- Consecutive failures; the endpoint auto-disables past the threshold
        -- so a dead customer server cannot drain the worker pool forever.
        failure_count  integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        disabled_at    timestamptz,
        last_success_at timestamptz,
        last_failure_at timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        deleted_at     timestamptz
      );
    `);
    await sql.query(`
      CREATE INDEX webhook_endpoints_business_idx
        ON webhook_endpoints (business_id, is_active) WHERE deleted_at IS NULL;
    `);

    await sql.query(`
      CREATE TABLE webhook_deliveries (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
        business_id     uuid NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
        -- Stable per-event id, echoed in the payload so consumers can dedupe.
        event_id        uuid NOT NULL,
        event           text NOT NULL,
        payload         jsonb NOT NULL,
        status          text NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED')),
        attempt_count   integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts    integer NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
        response_status integer,
        -- Truncated by the worker; a verbose endpoint must not bloat the table.
        response_body   text,
        error           text,
        scheduled_for   timestamptz NOT NULL DEFAULT now(),
        delivered_at    timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
    `);
    // One delivery per event per endpoint, so a retried producer cannot
    // double-notify a subscriber.
    await sql.query(`
      CREATE UNIQUE INDEX webhook_deliveries_unique ON webhook_deliveries (endpoint_id, event_id);
    `);
    await sql.query(`
      CREATE INDEX webhook_deliveries_due_idx
        ON webhook_deliveries (scheduled_for) WHERE status = 'PENDING';
    `);
    await sql.query(`
      CREATE INDEX webhook_deliveries_endpoint_idx
        ON webhook_deliveries (endpoint_id, created_at DESC);
    `);
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    await sql.query('DROP TABLE IF EXISTS webhook_deliveries CASCADE;');
    await sql.query('DROP TABLE IF EXISTS webhook_endpoints CASCADE;');
    await sql.query('DROP TABLE IF EXISTS audit_logs CASCADE;');
  },
};
