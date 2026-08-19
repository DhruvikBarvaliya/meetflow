/**
 * Invalidation for the cached public booking pages.
 *
 * `getPublicConfig` caches one assembled page per slug under
 * `cache:link:{slug}`. That payload is built from rows several modules own —
 * the link itself, the services it offers, and the sites and providers those
 * services reach — so the module that *fills* the cache is never the module
 * that makes it wrong. This is the other half: the write paths that change
 * those rows call in here, and the pages that quoted them are dropped.
 *
 * Without it the only thing standing between a renamed service and the page
 * still advertising the old name is `CACHE_BOOKING_LINK_TTL_SECONDS` — an
 * operator corrects a price, reloads the public page, and is told nothing
 * happened for as long as the clock takes.
 *
 * Two rules govern everything here:
 *
 *  1. **A failed invalidation must never fail the write.** Every path swallows
 *     its errors: a stale cache entry is a smaller problem than an edit the
 *     operator was refused, and every entry expires on its own regardless.
 *  2. **Nothing is dropped before the change is durable.** Invalidating inside
 *     the transaction would let a concurrent reader repopulate the cache from
 *     the pre-commit row and pin the stale page in place for a full TTL, so the
 *     deletion is deferred to `afterCommit` — and a transaction that rolls back
 *     never touches the cache at all.
 */
import type { Transaction } from 'sequelize';
import { createLogger } from '../../config/logger';
import { RedisKeys, cacheDelete } from '../../config/redis';
import { BookingLink } from '../../database/models';

const log = createLogger('public-booking-cache');

/**
 * Every cached page a workspace publishes, dropped by exact key.
 *
 * Whole-workspace rather than one slug because the entities that feed a page
 * are shared: one service appears on every CATALOG link that offers it, and
 * working out which pages quoted it costs more than dropping the handful this
 * workspace has. `paranoid: false` keeps a link that was just soft-deleted in
 * the result set — its page is precisely the one that must stop being served.
 *
 * A slug the workspace no longer holds (a link renamed to a new address) keeps
 * its entry until the TTL, and that is harmless: `resolveBookingLink` reads
 * PostgreSQL, so the old address stops resolving the moment it is renamed and
 * the orphaned entry is never read again.
 */
async function dropCachedPages(businessId: string): Promise<void> {
  try {
    const links = await BookingLink.findAll({
      where: { businessId },
      attributes: ['slug'],
      paranoid: false,
    });
    if (links.length === 0) return;

    await cacheDelete(...links.map((link) => RedisKeys.bookingLinkConfig(link.slug)));
  } catch (error) {
    log.warn(
      { err: error, businessId },
      'could not invalidate cached booking pages — they will expire on their own',
    );
  }
}

/**
 * Drops the workspace's cached booking pages once `transaction` commits, or
 * immediately when called outside one.
 *
 * Always awaitable, and both branches are meant to be awaited, but they are
 * awaiting different things:
 *
 *  - **With a transaction**, this resolves as soon as the hook is *registered*.
 *    The deletion itself runs later, after the commit the caller is already
 *    waiting on, and Sequelize awaits `afterCommit` hooks before
 *    `sequelize.transaction` resolves — so by the time the write path returns,
 *    the drop has happened.
 *  - **Without one**, there is no commit to hang anything on: the caller's
 *    statement is already durable, so this resolves only once the deletion has
 *    actually been attempted. Firing it and walking away would make the
 *    invalidation unobservable — nothing could await it, nothing could test it,
 *    and an unhandled rejection would be the only way to learn it had failed.
 *
 * `dropCachedPages` never throws either way, which is what keeps rule 1 above
 * true for both.
 */
export async function invalidateBookingPageCache(
  businessId: string,
  transaction?: Transaction,
): Promise<void> {
  if (!transaction) {
    await dropCachedPages(businessId);
    return;
  }
  transaction.afterCommit(() => dropCachedPages(businessId));
}
