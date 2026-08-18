'use strict';

/**
 * PostgreSQL extensions MeetFlow depends on.
 *
 * - pgcrypto   : `gen_random_uuid()` for server-side primary keys.
 * - btree_gist : lets a GiST exclusion constraint combine an equality operator
 *                on a scalar column (staff_profile_id) with an overlap operator
 *                on a range (tstzrange). This is what makes genuine
 *                database-level double-booking prevention possible — without it
 *                overlap protection would only ever be advisory application
 *                logic. See docs/BookingConcurrency.md.
 * - citext     : case-insensitive email columns, so `Ada@x.com` and `ada@x.com`
 *                cannot become two accounts.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS "btree_gist";');
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS "citext";');
  },

  async down(queryInterface) {
    // Extensions are intentionally NOT dropped: other schemas in the same
    // database may rely on them, and dropping citext would cascade to columns.
    await queryInterface.sequelize.query('SELECT 1;');
  },
};
