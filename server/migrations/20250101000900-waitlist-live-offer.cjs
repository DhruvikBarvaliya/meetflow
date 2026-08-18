'use strict';

/**
 * One live offer per opening, enforced by the database.
 *
 * The matcher used to defend against a double offer with a `SELECT count(*)`
 * taken under a Redis advisory lock, and neither half of that holds. The count
 * and the write are two statements with a gap between them, and `acquireLock`
 * returns null — proceeding *unlocked* — whenever Redis is unreachable. So one
 * slot freed twice in the same moment could be promised to two different
 * customers, both of whom then race for the single appointment behind it, and
 * one of them is told to claim something that was never theirs.
 *
 * Booking answered the equivalent problem with an exclusion constraint as the
 * final authority and the lock as a fast path only. This index is the
 * waitlist's version of that: whatever the application believes, PostgreSQL
 * admits exactly one NOTIFIED row per (workspace, service, opening).
 *
 * The predicate deliberately says nothing about `hold_expires_at`. `now()` is
 * not immutable and cannot appear in an index predicate, so as far as this
 * index is concerned a *lapsed* hold still occupies its opening. Releasing it
 * is the application's job, and both places that need it do it: the matcher
 * releases lapsed holds on an opening inline before offering it, and the
 * maintenance sweep releases them workspace-wide on its own schedule.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    // A database that has already run the racy matcher may be holding exactly
    // the duplicates this index forbids, and CREATE UNIQUE INDEX would refuse
    // to build over them. Everyone but the earliest notified holder of each
    // opening goes back into the queue: they never had a claim the system could
    // honour, because only one appointment can exist behind one opening.
    // `notified_at` is always set alongside a hold, but coalescing to
    // `created_at` keeps the ordering total even for a row written by hand.
    await sql.query(`
      UPDATE waitlist_entries AS loser
         SET status = 'ACTIVE',
             hold_expires_at = NULL,
             held_slot_starts_at = NULL
       WHERE loser.status = 'NOTIFIED'
         AND loser.held_slot_starts_at IS NOT NULL
         AND EXISTS (
               SELECT 1
                 FROM waitlist_entries AS winner
                WHERE winner.status = 'NOTIFIED'
                  AND winner.business_id = loser.business_id
                  AND winner.service_id = loser.service_id
                  AND winner.held_slot_starts_at = loser.held_slot_starts_at
                  AND (COALESCE(winner.notified_at, winner.created_at), winner.id)
                    < (COALESCE(loser.notified_at, loser.created_at), loser.id)
             );
    `);

    // The constraint itself. Scoped to (business_id, service_id, opening) and
    // pointedly not to the provider: two customers told about the same clock
    // time for the same service is the failure worth forbidding, whichever
    // diary the opening came out of.
    await sql.query(`
      CREATE UNIQUE INDEX waitlist_live_offer_unique
        ON waitlist_entries (business_id, service_id, held_slot_starts_at)
        WHERE status = 'NOTIFIED' AND held_slot_starts_at IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    // Only the index is dropped. The entries released above stay released:
    // re-offering them would mean re-sending offers, and an email cannot be
    // unsent by a rollback.
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS waitlist_live_offer_unique;`);
  },
};
