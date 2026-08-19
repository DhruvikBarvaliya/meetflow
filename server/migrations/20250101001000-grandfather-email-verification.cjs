'use strict';

/**
 * Treats every account that existed before enforcement as verified.
 *
 * `requireVerifiedEmail` now guards the management API, the customer portal,
 * workspace creation and the platform surface. Without this migration, turning
 * that on locks out every account already in the database — none of which has
 * `email_verified_at` set, because until now nothing required it — and the
 * remedy would be a verification link whose token was issued at registration
 * and, for anyone who registered more than a moment ago, is long gone.
 *
 * That is a strictly worse failure than the one enforcement prevents. The gate
 * exists so a *new* account cannot claim a workspace with an address it does
 * not control; it was never meant to retroactively invalidate accounts that
 * have been operating for months. So the existing population is grandfathered
 * and the guarantee starts from here.
 *
 * `created_at` rather than `now()`: the column means "when was this address
 * confirmed", and stamping today would assert that everyone confirmed on the
 * day of this deploy, which is false and would make the audit trail lie. The
 * registration date is not the truth either, but it is the honest bound — the
 * account has existed and been usable since then — and it keeps the column
 * ordered consistently with the rest of the row.
 *
 * Only NULL rows are touched, so the seeded demo accounts (which already stamp
 * `email_verified_at`) and anyone who genuinely verified keep their own moment.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE users
         SET email_verified_at = created_at,
             updated_at        = now()
       WHERE email_verified_at IS NULL;
    `);
  },

  /**
   * Deliberately not reversible.
   *
   * There is no record of which rows this migration filled, so an honest
   * `down` would have to clear `email_verified_at` for everybody — including
   * accounts that verified properly, before or after this ran. That would lock
   * out real users to undo a migration whose only effect was to stop locking
   * out real users. Rolling back the *enforcement* is a one-line environment
   * change (`REQUIRE_EMAIL_VERIFICATION=false`) and does not need the data
   * changed back.
   */
  async down() {
    // Intentionally empty. See above.
  },
};
