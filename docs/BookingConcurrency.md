# Booking Concurrency

How MeetFlow guarantees that two customers cannot book the same time.

## The problem

Availability checks always lose a race eventually. Two requests can both read
"this slot is free" before either one writes, and both then insert. Retrying,
double-checking, or checking "one more time just before the insert" only makes
the window smaller — it never closes it, because there is no point at which a
read and a subsequent write are atomic.

The only reliable fix is to make the _database_ refuse the second write.

## The five layers

Ordered from cheapest to most authoritative. Every layer above the last is an
optimisation; the last one is the guarantee.

### 1. Idempotency

Public booking accepts an idempotency key. A durable row in `idempotency_keys`,
unique on `(scope, key)`, is claimed before any work happens:

- **key unseen** → claim it, proceed
- **key seen, same request hash, COMPLETED** → replay the stored response
- **key seen, same hash, IN_PROGRESS** → `409 IDEMPOTENCY_IN_PROGRESS`
- **key seen, different hash** → `409 IDEMPOTENCY_KEY_REUSED`

The last case matters: silently returning the first booking would hide a second,
different booking the caller believes they made.

Records are durable in PostgreSQL rather than Redis-only, so a cache flush
cannot resurrect a duplicate.

### 2. Advisory lock

A short Redis lock on `lock:slot:{businessId}:{staffId}:{startsAt}` removes most
contention before it reaches PostgreSQL, so the common case never generates a
constraint violation at all.

It is explicitly **not** an integrity mechanism. `acquireLock` returns `null`
when Redis is unavailable and booking proceeds anyway, because correctness does
not depend on it.

### 3. Re-validation

The client's chosen slot came from an availability response that may be seconds
or minutes old. Before writing, `verifySlot()` recomputes eligibility from live
data: working hours, overrides, holidays, blackouts, existing reservations,
minimum notice.

### 4. Database exclusion constraints — the guarantee

`btree_gist` lets a GiST exclusion constraint combine equality on a scalar
column with overlap on a range:

```sql
ALTER TABLE appointment_staff
  ADD CONSTRAINT appointment_staff_no_overlap
  EXCLUDE USING gist (
    staff_profile_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (is_blocking);
```

Two transactions that both believe the slot is free cannot both commit. The
loser receives SQLSTATE `23P01`, which the booking service translates into
`409 SLOT_UNAVAILABLE`.

Three details are deliberate:

- **`'[)'` — half-open ranges.** An appointment ending at 10:30 and one starting
  at 10:30 do not overlap, so back-to-back bookings are allowed.
- **The stored range is the _buffered_ window**, not the appointment window, so
  pre/post buffers are enforced by the same constraint.
- **`WHERE (is_blocking)`** — cancelling sets `is_blocking = false` rather than
  deleting the row, which frees the slot while keeping the assignment
  auditable.

`appointment_resources` carries the equivalent constraint on `resource_id`,
predicated on `is_active AND is_exclusive`.

### 5. Row locks for capacity

An exclusion constraint expresses "no overlap". It cannot express "at most N
overlapping", so it cannot enforce group capacity or shared resources.

Those use `SELECT … FOR UPDATE`:

- **Group services** — the appointment row is locked before `booked_count` is
  read, so two customers claiming the last place are serialised. A
  `booked_count <= capacity` CHECK constraint backs it up.
- **Shared resources** (`capacity > 1`) — candidate resource rows are locked
  before overlapping reservations are counted.

## Group services: create-or-join

A group service is **one appointment with many participants**, not many
appointments. That keeps every appointment exclusive on the staff calendar
while still allowing a class of twenty.

Booking is therefore create-or-join:

1. Look for an active session for this service, provider and start time.
2. **Found** → skip slot verification (the session already holds the staff
   reservation; re-verifying would find it and refuse), lock the row, check
   capacity and duplicate attendance, add a participant.
3. **Not found** → verify the slot and create the session.

Step 3 can race: two customers both find nothing and both try to create. The
exclusion constraint rejects one, and the booking service **retries once**,
which takes the join path. Single-capacity services never retry — for them a
lost race genuinely means the slot is gone.

## SAVEPOINTs: a trap worth naming

In PostgreSQL, a failed statement aborts the entire transaction. Every
subsequent statement fails, and the eventual `COMMIT` silently becomes a
`ROLLBACK`.

This makes the obvious "try the insert, catch the duplicate, carry on" pattern
actively dangerous inside a transaction: the catch succeeds, the code continues,
and the whole booking is discarded with no error raised anywhere.

MeetFlow hit exactly this during development — group joins appeared to succeed
while nothing persisted. Anywhere a constraint violation is caught and execution
continues, the statement runs inside a SAVEPOINT (`sequelize.transaction({
transaction: parent }, …)`):

- notification outbox writes with a `dedupe_key`
- per-resource reservation attempts that fall through to the next candidate

## Ordering

Nothing is announced before it is durable:

```
BEGIN
  validate → lock rows → insert appointment
  → insert staff reservation      (exclusion constraint decides the winner)
  → reserve resources             (savepoint per candidate)
  → participant, status history, counters
  → audit record
  → notification outbox rows
COMMIT
  → Socket.IO event
  → webhook fan-out
```

A rolled-back booking cannot emit a confirmation, and a committed one cannot
lose its reminders, because the outbox row is part of the same transaction.

## What is verified

`server/tests/integration/booking.concurrency.test.ts`, against real PostgreSQL:

| Test                                 | Guarantee                           |
| ------------------------------------ | ----------------------------------- |
| 10 simultaneous bookings of one slot | exactly 1 appointment, 9 clean 409s |
| adjacent slots booked simultaneously | both succeed                        |
| overlapping booking after the fact   | rejected                            |
| buffered service, next slot          | rejected until the buffer clears    |
| repeated idempotency key             | replays, does not duplicate         |
| 5 concurrent retries of one key      | 1 appointment, all failures < 500   |
| same key, different payload          | `IDEMPOTENCY_KEY_REUSED`            |
| group capacity 3, 3 bookings         | 1 appointment, 3 participants       |
| group capacity 2, 6-way race         | `booked_count` never exceeds 2      |
| same customer twice in a session     | `ALREADY_EXISTS`                    |
| cross-tenant service / staff id      | 404                                 |
