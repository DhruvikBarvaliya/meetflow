'use strict';

/**
 * Identity: platform users, refresh-token families, and the permission catalogue.
 *
 * `platform_role` is deliberately narrow (ADMIN | USER). Everything a person can
 * do *inside a business* comes from their membership role, never from a global
 * flag — see 20250101000200-create-business.cjs.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    await sql.query(`
      CREATE TABLE users (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- citext: casing must never create a duplicate account.
        email                       citext NOT NULL,
        password_hash               text NOT NULL,
        first_name                  text NOT NULL,
        last_name                   text NOT NULL,
        phone                       text,
        avatar_url                  text,
        platform_role               text NOT NULL DEFAULT 'USER'
                                      CHECK (platform_role IN ('ADMIN', 'USER')),
        status                      text NOT NULL DEFAULT 'ACTIVE'
                                      CHECK (status IN ('ACTIVE', 'INVITED', 'SUSPENDED', 'DEACTIVATED')),
        -- IANA identifier (e.g. Asia/Kolkata), never a fixed UTC offset.
        timezone                    text NOT NULL DEFAULT 'UTC',
        locale                      text NOT NULL DEFAULT 'en-US',
        email_verified_at           timestamptz,
        email_verification_token_hash text,
        email_verification_sent_at  timestamptz,
        password_reset_token_hash   text,
        password_reset_expires_at   timestamptz,
        last_login_at               timestamptz,
        -- Progressive lockout state for credential stuffing defence.
        failed_login_count          integer NOT NULL DEFAULT 0,
        locked_until                timestamptz,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        deleted_at                  timestamptz
      );
    `);

    // Soft-deleted accounts release their address so the person can re-register.
    await sql.query(`
      CREATE UNIQUE INDEX users_email_unique_active
        ON users (email) WHERE deleted_at IS NULL;
    `);
    await sql.query(`CREATE INDEX users_platform_role_idx ON users (platform_role);`);
    await sql.query(`CREATE INDEX users_status_idx ON users (status);`);
    await sql.query(`
      CREATE INDEX users_password_reset_token_idx
        ON users (password_reset_token_hash) WHERE password_reset_token_hash IS NOT NULL;
    `);
    await sql.query(`
      CREATE INDEX users_email_verification_token_idx
        ON users (email_verification_token_hash) WHERE email_verification_token_hash IS NOT NULL;
    `);

    await sql.query(`
      CREATE TABLE refresh_tokens (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        -- Only the SHA-256 digest is stored: a database leak must not yield
        -- usable tokens.
        token_hash           text NOT NULL,
        -- All tokens descended from one login share a family. Replaying a
        -- already-rotated token revokes the entire family (reuse detection).
        family_id            uuid NOT NULL,
        issued_at            timestamptz NOT NULL DEFAULT now(),
        expires_at           timestamptz NOT NULL,
        revoked_at           timestamptz,
        revoked_reason       text CHECK (revoked_reason IN
                               ('ROTATED', 'LOGOUT', 'LOGOUT_ALL', 'REUSE_DETECTED',
                                'PASSWORD_CHANGED', 'ADMIN_REVOKED', 'EXPIRED')),
        replaced_by_token_id uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL,
        user_agent           text,
        ip_address           inet,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(
      `CREATE UNIQUE INDEX refresh_tokens_hash_unique ON refresh_tokens (token_hash);`,
    );
    await sql.query(
      `CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id, revoked_at);`,
    );
    await sql.query(`CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);`);
    // Supports the periodic purge of dead tokens.
    await sql.query(`CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);`);

    await sql.query(`
      CREATE TABLE permissions (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- Stable machine key, e.g. 'appointments:cancel'.
        key         text NOT NULL UNIQUE,
        category    text NOT NULL,
        description text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sql.query(`CREATE INDEX permissions_category_idx ON permissions (category);`);
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    await sql.query('DROP TABLE IF EXISTS permissions CASCADE;');
    await sql.query('DROP TABLE IF EXISTS refresh_tokens CASCADE;');
    await sql.query('DROP TABLE IF EXISTS users CASCADE;');
  },
};
