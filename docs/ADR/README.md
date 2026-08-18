# Architecture Decision Records

A lightweight decision log. Each record states the decision, why it was taken,
what was rejected and what it costs. Records are append-only; a reversal is a
new record that supersedes an old one.

---

## ADR-0001 — JWT strategy: short access token, rotating opaque refresh token

**Status:** accepted

**Decision.** Access tokens are 15-minute HS256 JWTs carrying identity only
(`sub`, `sid`, `jti`, `email`, platform role). Refresh tokens are opaque
128-bit random strings, stored only as SHA-256 digests, rotated on every use and
grouped into a family.

**Why.** Permissions deliberately do _not_ go in the token. If they did, a
revoked role would keep working until the token expired — a 15-minute window an
attacker will happily use. Re-reading permissions per request costs one indexed
query and makes revocation immediate.

Refresh tokens are opaque rather than JWTs because they must be revocable, and a
stateless revocable token is a contradiction. Storing only the digest means a
database leak yields nothing usable.

**Reuse detection.** Presenting an already-rotated token revokes the whole
family. This logs out the legitimate user too — accepted deliberately: losing a
session is far cheaper than letting a stolen token mint credentials indefinitely.

**Costs.** One extra query per authenticated request (permissions) and one to
confirm the session family is live. A client that fires parallel requests during
a refresh must queue them, which the frontend API client does.

---

## ADR-0002 — Double-booking prevented by PostgreSQL exclusion constraints

**Status:** accepted

**Decision.** `appointment_staff` and `appointment_resources` carry GiST
exclusion constraints over `tstzrange` (enabled by `btree_gist`). Application
checks exist, but the database has the final word.

**Why.** Every application-level check has a read-then-write window. Making it
smaller never closes it. An exclusion constraint is evaluated by the database at
commit time and cannot be raced.

**Rejected.** `SELECT … FOR UPDATE` on a synthetic "slot" row (invents rows for
times nobody booked, and does not compose with buffers); advisory locks alone
(lost on a Redis outage); serialisable isolation (retry storms under load).

**Costs.** PostgreSQL-specific — this design does not port to MySQL. Requires
denormalising the buffered window onto the reservation row, because a constraint
can only read columns of its own row. Group capacity needs a separate mechanism
(ADR-0003) because "at most N" is not "no overlap".

---

## ADR-0003 — Group services are one appointment with many participants

**Status:** accepted

**Decision.** A capacity-12 yoga class is one `appointments` row with up to 12
`appointment_participants`, not 12 appointments. Capacity is enforced with
`SELECT … FOR UPDATE` on the appointment row plus a
`booked_count <= capacity` CHECK.

**Why.** It keeps every appointment exclusive on the staff calendar, so the
exclusion constraint in ADR-0002 applies universally with no special cases. The
alternative — many overlapping appointments — would force the constraint to be
conditional and reintroduce the race it exists to prevent.

**Consequence.** Booking is create-or-join. Two customers can race to create the
first session; the loser is retried once and takes the join path. Single-capacity
services never retry, because for them a lost race genuinely means the slot is
gone.

---

## ADR-0004 — Wall-clock rules stored as minutes + IANA zone, never as offsets

**Status:** accepted

**Decision.** Recurring schedules are stored as minutes-from-local-midnight plus
a weekday/date and an IANA zone, resolved to instants through Luxon at query
time. Instants are `timestamptz`. Fixed UTC offsets are rejected at validation.

**Why.** An offset is a property of an instant in a zone, not of the zone.
Storing `+05:30` freezes a decision the calendar must make later, and every DST
transition then shifts every recurring rule by an hour.

**Consequence.** Two DST edge cases must be handled explicitly, not hoped away:
nonexistent local times (spring forward) are detected and dropped; ambiguous
ones (fall back) resolve deterministically to the earlier offset. Both are
tested. See `TimezoneAndDST.md`.

---

## ADR-0005 — Notifications use a transactional outbox, not inline sends

**Status:** accepted

**Decision.** A `notifications` row is written inside the transaction that
caused it. A BullMQ job delivers it; a periodic sweep re-enqueues anything the
queue lost.

**Why.** Sending inline can email a customer about a booking that rolled back,
or fail a request because a mail provider was slow. The outbox makes the
database commit the single source of truth for "this message is owed".

**Consequence.** Delivery is eventually consistent — a confirmation may arrive
seconds after the response. A reminder is simply a notification with a future
`scheduled_for`, so there is no second scheduler to keep correct.

---

## ADR-0006 — Redis is infrastructure, never the system of record

**Status:** accepted

**Decision.** Redis backs caching, rate limiting, advisory locks, queues and the
Socket.IO adapter. Every consumer degrades gracefully when it is unavailable.

**Why.** Scheduling correctness must survive a cache outage. Anything whose loss
would corrupt state lives in PostgreSQL — idempotency records included, which is
why they are a durable table with a Redis fast path rather than Redis-only.

**Consequence.** Rate limiting falls back to per-process in-memory counters, so
protection degrades rather than disappears. `/ready` reports `degraded` and
still serves traffic. Every key has a documented purpose, TTL and invalidation
strategy (`RedisArchitecture.md`).

---

## ADR-0007 — Socket rooms are derived from memberships, never requested

**Status:** accepted

**Decision.** There is no client-initiated `join` event. The server reads ACTIVE
memberships at handshake and joins the socket to exactly the entitled rooms.

**Why.** A `join` handler is an authorisation check that can be forgotten or
bypassed. Removing the capability removes the vulnerability class.

**Consequence.** A membership change takes effect on the next connection, not
instantly. Acceptable: the alternative is re-authorising every broadcast.

---

## ADR-0008 — Tenant context comes from membership; cross-tenant answers 404

**Status:** accepted

**Decision.** `X-Business-Id` selects among the caller's own memberships and is
never trusted as an identifier in its own right. Access to another tenant's data
returns 404.

**Why.** 403 confirms a record exists, turning any tenant-scoped endpoint into
an existence oracle for enumeration.

**Consequence.** A genuine permission failure _within_ your own tenant returns
403, while a cross-tenant attempt returns 404 — occasionally confusing when
debugging, which is the intended trade.

---

## ADR-0009 — Calendars are projections, not stored entities

**Status:** accepted

**Decision.** There is no `calendars` or `calendar_events` table. Staff, team,
resource, location and customer calendars are queries over `appointments`,
`blackout_periods` and availability rules.

**Why.** A stored calendar duplicates appointment state and immediately invites
divergence between "the appointment" and "the calendar entry". The indexes that
make these projections fast already exist for other reasons.

**Consequence.** External calendar sync (Google, Outlook) will need a
`calendar_connections` table when it is built. It is deliberately _not_ stubbed
now: an empty adapter that syncs nothing is worse than an honest absence. The
core booking engine is kept free of vendor coupling so the adapter can be added
without touching it.

---

## ADR-0010 — Smart Match is deterministic scoring, not AI

**Status:** accepted

**Decision.** Provider selection is a weighted sum over observable facts, and
every ranking returns its per-factor reasons.

**Why.** A business owner must be able to be told why one provider was offered
over another, and the same inputs must always produce the same order — two API
instances answering one availability query have to agree.

**Consequence.** If an AI-assisted strategy is added, it goes behind this same
interface and booking correctness must not depend on it.

---

## ADR-0011 — BullMQ as the queue, with PostgreSQL as the system of record

**Status:** accepted

**Decision.** Background work runs on BullMQ over the same Redis the cache and
rate limiter use. Queues: notifications, webhooks, maintenance. The worker is a
separate process in a separate container, and job payloads carry an identifier
and nothing else — every worker re-reads its row from PostgreSQL before acting.

**Why BullMQ.** It gives durable retries with exponential backoff, delayed jobs
(which is what a reminder is), stalled-job recovery and concurrency control,
without adding a broker to the deployment. The alternative worth taking
seriously was polling PostgreSQL directly with `SELECT … FOR UPDATE SKIP
LOCKED`, which removes a dependency entirely; it was rejected because delayed
jobs then need a scheduler of their own, and reminders are the majority of the
workload.

**Why the payload carries only an id.** A job that carried the message body
would deliver whatever was true when it was enqueued — a reminder for an
appointment that has since moved would still name the old time. Re-reading makes
the row the single truth and the queue merely a trigger.

**Why a separate process.** Delivery latency must never become API latency. In
development `RUN_WORKER_IN_API=true` runs both in one process for convenience,
and the guard that permits it is deliberately development-only.

**The cost, stated plainly.** Redis is now on the delivery path even though it is
not on the request path. A Redis outage stops delivery; it does not stop booking,
because the outbox row is already committed and the recovery sweep will pick it
up. That asymmetry is the whole reason the outbox exists — see ADR-0005.

**What this does not cover.** A job id is `notification:<id>`, and BullMQ treats
`add` for an existing id as a no-op — including one already in the completed
set. Anything that requeues a row must drop the old job key first, or the
requeue is silently discarded. This bit us once; it is now handled in the sweep
and noted here so the next person does not rediscover it.

---

## ADR-0012 — The scheduling engine is three layers, and the innermost has no I/O

**Status:** accepted

**Decision.** Availability is computed in three separate layers:

1. **Rule resolution** (`scheduling/availability.service.ts`) — reads business
   hours, staff rules, overrides, holidays, blackouts and existing appointments,
   and resolves them into concrete instants in the workspace timezone.
2. **Slot generation** (`scheduling/slotEngine.ts`) — a pure function. No
   database, no clock of its own: `now` is a parameter. Given windows, busy
   intervals and a policy, it returns slots.
3. **Verification at commit** (`booking.service.ts`) — re-runs the same policy
   against the same data inside the booking transaction.

**Why the middle layer is pure.** Slot generation is where the subtle bugs live —
buffers, intervals, capacity, DST boundaries — and it is the layer that most
needs exhaustive testing. Making it I/O-free means those tests are milliseconds
rather than seconds, need no fixtures, and can enumerate edge cases that would be
impractical to construct in a database. Passing `now` as a parameter rather than
calling the clock is what makes "a slot that is one minute inside the notice
window" a test rather than a race.

**Why verification is a separate third layer rather than trust in the first
two.** Search and commit are separated in time by however long a customer takes
to fill in a form. Anything can happen in between. The layer exists because the
answer must be recomputed, not remembered.

**The invariant that binds them.** A slot the search offers must never be refused
at commit, and a slot the search hides must never be bookable. Both directions
are failures: the first is a customer filling in a form for nothing, the second
is a policy that is decorative. The layers therefore resolve policy through one
shared path, and the tests assert the invariant directly by booking what the
search offered.

**The cost.** Rule resolution runs twice for a booking — once to offer, once to
confirm. That is deliberate and cheap next to being wrong.
