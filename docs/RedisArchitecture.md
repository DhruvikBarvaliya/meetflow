# Redis Architecture

Redis provides caching, distributed rate limiting, advisory locks, the job
backbone and the Socket.IO adapter.

**It is never the system of record.** Every function that touches cached data
treats a Redis failure as a cache miss, so an outage makes MeetFlow slower — it
does not make it wrong, and it does not stop anyone booking.

## Key registry

Every key is written through `key()`, which applies `REDIS_KEY_PREFIX`, so
several environments can share one instance safely.

| Namespace                       | Purpose                             | TTL                              | Invalidation                          | Failure behaviour           |
| ------------------------------- | ----------------------------------- | -------------------------------- | ------------------------------------- | --------------------------- |
| `cache:link:{slug}`             | resolved public booking-link config | `CACHE_BOOKING_LINK_TTL_SECONDS` | deleted by key on the mutations below | miss → read PostgreSQL      |
| `rl:{bucket}`                   | rate-limiter counters               | the window                       | natural expiry                        | in-memory insurance limiter |
| `lock:slot:{biz}:{staff}:{iso}` | advisory lock around one slot       | ≤ 10s                            | released by owner token               | proceed unlocked            |
| `lock:waitlist:{biz}:{svc}`     | serialises waitlist evaluation      | ≤ 15s                            | released by owner token               | proceed unlocked            |
| `bull:*`                        | BullMQ internals                    | managed by BullMQ                | —                                     | jobs delayed, not lost      |

Values are JSON.

**This table lists what MeetFlow writes, not what it could.** Redis holds no
idempotency records: `idempotency_keys` in PostgreSQL is claimed by a unique
index and read back inside the booking transaction, and a Redis fast path in
front of it would be an advisory hint that is wrong during exactly the outage a
retry storm arrives in. Round-robin fairness is likewise a PostgreSQL column
(`staff_profiles.last_assigned_at`), not a cursor in Redis, and shared-resource
capacity is enforced by row locks — see `BookingConcurrency.md` — rather than by
an advisory lock per resource.

## Degradation

`isRedisReady()` gates every cache call, so a known-down Redis costs a branch
rather than a timeout: `cacheGet` returns `null`, `cacheSet` and `cacheDelete`
no-op, all three silently. A command that fails despite the gate — the
connection dropping mid-request — logs at `warn` and degrades the same way.

Concretely, with Redis down:

- **Booking still works.** The advisory lock is skipped; the exclusion
  constraints in PostgreSQL still make double-booking impossible.
- **Idempotency still works**, and not by falling back: it never used Redis in
  the first place. `idempotency_keys` in PostgreSQL is the whole mechanism.
- **Rate limiting still works, per instance.** `RateLimiterRedis` falls back to
  an in-memory `insuranceLimiter`. Protection degrades from cluster-wide to
  per-process instead of disappearing — the correct trade for endpoints that
  must never be left open.
- **Notifications are delayed, not lost.** The outbox row is committed with the
  booking; the periodic sweep re-enqueues anything whose job never arrived.
- **Real-time updates stop.** Dashboards fall back to their normal query
  refresh. Nothing is silently wrong, just less live.
- **`/ready` reports `degraded`** and still returns 200, because the instance can
  serve traffic correctly.

## Invalidation

One cached family, one strategy: **deletion by exact key, after the commit that
made the entry wrong.** `cache:link:{slug}` is the only thing MeetFlow caches,
and a workspace's slugs are one indexed query away, so there is no family to
sweep and no prefix deletion helper — a `SCAN` across a keyspace that is mostly
BullMQ and rate-limiter entries would be a slower way of finding a handful of
keys we can already name. (`KEYS` is never used either; it blocks the server.)

`invalidateBookingPageCache(businessId, transaction)` in
`modules/publicBooking/publicBooking.cache.ts` drops every page the workspace
publishes. It is called from the write paths that change what a page says:

| Mutation                                                                 | Why the page changed                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| service created, updated or deleted                                      | name, price, duration, capacity, approval flag, existence |
| service ↔ staff pairings replaced                                        | which providers the page offers                           |
| service ↔ location pairings replaced                                     | which sites the page offers                               |
| booking link created, updated, deleted, or its offered services replaced | the link's own half of the payload, and a recycled slug   |
| staff profile created, updated or deleted                                | who is offered, under what name, and whether at all       |
| location created, updated or deleted                                     | which sites are offered, and a virtual one's meeting URL  |
| the workspace record updated                                             | name, logo, timezone, currency, support details           |
| `business_settings` updated                                              | notice period, horizon, approval, cancel/reschedule rules |

Two properties are deliberate:

- **After the commit, never inside it.** The deletion is registered on the
  transaction's `afterCommit` hook. Deleting inside the transaction would let a
  concurrent reader repopulate the cache from the pre-commit row and pin the
  stale page for a full TTL, and a rolled-back edit would evict for nothing.
- **A failed invalidation cannot fail the write.** Every path swallows and logs.
  A stale page is a smaller problem than an operator being refused an edit, and
  the TTL still closes the window on its own.

Every entity quoted on a published page is on that list, so a page goes stale
only for as long as it takes the write that changed it to commit. The two
workspace-level paths run outside a transaction — `updateBusiness` and
`updateSettings` each commit their own statement before returning — so they call
`invalidateBookingPageCache(businessId)` with no transaction and the drop is
immediate rather than deferred.

`CACHE_BOOKING_LINK_TTL_SECONDS` is now a backstop rather than the mechanism:
it bounds how long an entry can survive a _failed_ deletion, which is the only
staleness left, and is the reason the value should still be measured in minutes.

Availability is deliberately not on the list. Working hours, time off and
existing bookings decide which openings a page offers, but openings are not
cached — `GET /public/booking-links/:slug/slots` runs the engine against
PostgreSQL on every request, because a cached opening is one that can be sold
twice.

## Locks

`SET key token PX ttl NX` to acquire; release runs a Lua script that deletes the
key **only if the token still matches**. Without that check, a lock that expired
mid-work would be deleted out from under whoever acquired it next.

Locks are always short (≤ 15s), always released in a `finally`, and never the
only integrity mechanism — see `BookingConcurrency.md`.

## Connections

Separate connections by role, because BullMQ requires
`maxRetriesPerRequest: null` for blocking reads and the Socket.IO adapter needs
dedicated pub/sub sockets:

| Client                                        | Role                        |
| --------------------------------------------- | --------------------------- |
| `redis`                                       | cache, locks, rate limiting |
| `bullmq-producer` / `bullmq-worker`           | queues                      |
| `socket-pub` / `socket-sub`                   | Socket.IO Redis adapter     |
| `realtime-bridge-pub` / `realtime-bridge-sub` | worker → API event bridge   |

All use bounded exponential backoff (capped at 5s) and reconnect on `READONLY`,
which is what a replica promotion looks like to a client.
