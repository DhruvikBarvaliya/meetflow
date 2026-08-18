# Redis Architecture

Redis provides caching, distributed rate limiting, advisory locks, the job
backbone and the Socket.IO adapter.

**It is never the system of record.** Every function that touches cached data
treats a Redis failure as a cache miss, so an outage makes MeetFlow slower — it
does not make it wrong, and it does not stop anyone booking.

## Key registry

Every key is written through `key()`, which applies `REDIS_KEY_PREFIX`, so
several environments can share one instance safely.

| Namespace                       | Purpose                                | TTL                              | Invalidation                   | Failure behaviour               |
| ------------------------------- | -------------------------------------- | -------------------------------- | ------------------------------ | ------------------------------- |
| `cache:link:{slug}`             | resolved public booking-link config    | `CACHE_BOOKING_LINK_TTL_SECONDS` | on link/service/staff mutation | miss → read PostgreSQL          |
| `cache:services:{linkId}`       | public service catalogue for a link    | same                             | on service mutation            | miss → read PostgreSQL          |
| `cache:tag:business:{id}`       | prefix used for bulk invalidation      | —                                | `cacheDeleteByPrefix`          | no-op                           |
| `rl:{bucket}`                   | rate-limiter counters                  | the window                       | natural expiry                 | in-memory insurance limiter     |
| `lock:slot:{biz}:{staff}:{iso}` | advisory lock around one slot          | ≤ 10s                            | released by owner token        | proceed unlocked                |
| `lock:resource:{id}`            | advisory lock around a shared resource | ≤ 10s                            | released by owner token        | proceed unlocked                |
| `lock:waitlist:{biz}:{svc}`     | serialises waitlist evaluation         | ≤ 15s                            | released by owner token        | proceed unlocked                |
| `idem:{scope}:{key}`            | short-lived idempotency fast path      | `IDEMPOTENCY_TTL_SECONDS`        | natural expiry                 | PostgreSQL row is authoritative |
| `rr:service:{id}`               | round-robin cursor cache               | 1h                               | recomputed from the database   | recompute                       |
| `bull:*`                        | BullMQ internals                       | managed by BullMQ                | —                              | jobs delayed, not lost          |

Values are JSON.

## Degradation

`isRedisReady()` gates every cache call. `cacheGet` returns `null`, `cacheSet`
and `cacheDelete` no-op, and each logs at `warn` once per outage rather than on
every request.

Concretely, with Redis down:

- **Booking still works.** The advisory lock is skipped; the exclusion
  constraints in PostgreSQL still make double-booking impossible.
- **Idempotency still works.** The durable `idempotency_keys` table is the
  authority; Redis is only ever a fast path.
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

Deletion by exact key where the key is known, and `SCAN`-based prefix deletion
for family invalidation. `KEYS` is never used — it blocks the server.

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

| Client                                        | Role                                     |
| --------------------------------------------- | ---------------------------------------- |
| `redis`                                       | cache, locks, idempotency, rate limiting |
| `bullmq-producer` / `bullmq-worker`           | queues                                   |
| `socket-pub` / `socket-sub`                   | Socket.IO Redis adapter                  |
| `realtime-bridge-pub` / `realtime-bridge-sub` | worker → API event bridge                |

All use bounded exponential backoff (capped at 5s) and reconnect on `READONLY`,
which is what a replica promotion looks like to a client.
