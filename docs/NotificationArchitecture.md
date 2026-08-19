# Notification Architecture

Email, reminders and (in future) SMS, built as a transactional outbox rather
than as sends fired from a request handler.

## Why an outbox

Sending inside the HTTP request has two failure modes that both hurt customers:

- the booking commits, the mail provider is slow or down, and the request fails —
  so the customer thinks they have no appointment when they do;
- the mail sends, the transaction then rolls back, and the customer has a
  confirmation for an appointment that does not exist.

MeetFlow writes a `notifications` row **inside the same transaction** as the
change that caused it. The row is the commitment; delivery is a separate,
retryable step.

```
BEGIN
  … create appointment, reservations, audit …
  INSERT INTO notifications (status = 'PENDING', scheduled_for = now())
COMMIT
  → enqueue a BullMQ delivery job (best effort)
```

If the enqueue fails — Redis down, network blip — nothing is lost: a periodic
sweep finds due `PENDING` rows and enqueues them again.

## Reminders are not a separate concept

A reminder is a notification with `scheduled_for` in the future. There is no
separate reminders table, no separate scheduler, and no second code path to keep
correct. Offsets come from `business_settings.reminder_offsets_minutes`
(default 24h and 1h before); offsets that would already be in the past at
booking time are skipped rather than sent immediately.

The follow-up is the same idea pointing the other way: queued at booking time,
scheduled for a day after the appointment ends. Queuing it up front is what
makes it withdrawable — a message that only exists once the visit is over can
never be called back if the visit does not happen.

Cancelling an appointment flips its pending `APPOINTMENT_REMINDER` and
`APPOINTMENT_FOLLOW_UP` rows to `CANCELLED`, so a reminder never goes out for an
appointment that is no longer happening, and nobody is thanked for a visit they
never made. Completion withdraws only the reminder: the follow-up is meant to
arrive afterwards. A reschedule withdraws both and re-queues both against the
new time.

## The one message with no change behind it

Every other notification is caused by something a person did, so it is written
in that change's transaction. The owner's daily digest has no such moment: it is
caused by a clock, and by a different clock in every workspace.

It is produced by an hourly job that asks PostgreSQL which workspaces are
currently inside their local digest hour (07:00), rather than by a timer per
workspace. Sending twice is prevented the same way everything else here prevents
it — a dedupe key of workspace plus **local** date — so a job that overlaps its
own hour, or a worker that restarts inside it, writes nothing the second time. A
workspace with an empty day gets no digest at all: "here is your day: 0
appointments" is how an owner learns to ignore the ones that matter.

## Idempotency

Every enqueue may carry a `dedupe_key`, backed by a unique index:

| Notification               | Key                                                      |
| -------------------------- | -------------------------------------------------------- |
| Booking confirmation       | `confirm:{appointmentId}:{customerId}`                   |
| Reminder                   | `remind:{appointmentId}:{customerId}:{offsetMinutes}`    |
| Follow-up                  | `follow-up:{appointmentId}:{customerId}`                 |
| Customer welcome           | `welcome:{customerId}`                                   |
| Reschedule                 | `reschedule:{appointmentId}:{newStartsAt}`               |
| Cancellation               | `cancel:{appointmentId}`                                 |
| No-show                    | `no-show:{appointmentId}:{customerId}`                   |
| Staff assignment           | `staff-assigned:{appointmentId}:{userId}`                |
| Staff schedule changed     | `schedule-changed:{appointmentId}:{staffProfileId}:r{n}` |
| Owner new booking          | `owner-new-booking:{appointmentId}:{customerId}`         |
| Owner daily digest         | `digest:{businessId}:{localDate}`                        |
| Email verification / reset | `verify:{sha256(token)}` / `reset:{sha256(token)}`       |

A reschedule appends `:r{n}` — the appointment's reschedule counter — to the
reminder and follow-up keys it re-queues. The booking-time key belongs to the
row the move just cancelled, and reusing it would be read as "already queued",
leaving the customer with no reminder at all.

A duplicate insert is caught and treated as success — the message is already
queued.

**Important implementation detail:** inside a caller's transaction that INSERT
runs in a `SAVEPOINT`. In PostgreSQL a failed statement aborts the whole
transaction, so catching a duplicate without a savepoint would silently discard
the caller's booking. This is not hypothetical — it happened during development
and is covered in `BookingConcurrency.md`.

## Delivery

The worker claims a row with a conditional update:

```sql
UPDATE notifications SET status = 'PROCESSING'
 WHERE id = $1 AND status = 'PENDING'
```

Exactly one worker wins; the rest find zero rows updated and exit. Then:

- **success** → `SENT`, `sent_at`, `provider_message_id`
- **failure, retries remain** → back to `PENDING`, error recorded, and the error
  is rethrown so BullMQ applies exponential backoff (5s base, 5 attempts)
- **failure, budget spent** → `FAILED`, `failed_at`, last error kept

Returning to `PENDING` rather than staying `PROCESSING` is deliberate: both the
BullMQ retry and the sweep can then pick it up.

That covers a worker which _handles_ its failure. A worker killed outright —
SIGKILL, OOM, a pod evicted mid-delivery — never writes that transition at all,
and the row stays `PROCESSING` with nothing looking for it. Worse, BullMQ's own
stalled-job retry fires ~30s later, finds nothing left to claim, and completes
_successfully_, so the failure leaves no trace anywhere.

The sweep closes this. Any claim untouched for ten minutes is treated as dead
and returned to `PENDING` with its attempt count preserved, so the existing
retry budget still bounds it. Ten minutes is an order of magnitude above the
longest a live claim can take: every exit from `PROCESSING` is a single write at
the end of one attempt, and the SMTP transport gives up well inside a minute
even when every timeout fires in sequence.

Reclaiming the row is necessary but not sufficient. Delivery jobs are keyed
`notification:<id>`, and BullMQ treats `add` for an existing id as a no-op —
including an id sitting in the completed set _because_ the stalled retry ran and
returned successfully. The sweep therefore drops that job key before requeueing,
or the message would strand a second time in a different status.

## States

```
PENDING ──claim──► PROCESSING ──ok──► SENT
   ▲                    │
   ├────retry left──────┤
   │                    └──budget spent──► FAILED
   │                    │
   └──claim went stale──┘

PENDING ──appointment cancelled / no provider──► CANCELLED
```

## Templates

Built-in templates ship with the product, so notifications work the moment a
workspace is created. `resolveTemplate` looks for a workspace override, then a
system row, then falls back to the built-in default — workspace override →
system row → built-in default.

**The override branch is reachable through
`/api/v1/notification-templates`**, guarded by `templates:manage` — the
permission the built-in roles grant to owners and managers and which used to be
attached to nothing. Rewriting a confirmation email is operational work rather
than an act of workspace authority, which is why a manager holds it. A
workspace lists every message MeetFlow defines, replaces any of them, parks a
draft with `isActive: false`, previews one against sample data before saving,
and drops its version to go back to MeetFlow's.

Two choices in that surface are worth stating, because both are the opposite of
the obvious one:

- **Defaults are never copied into a workspace.** Seeding sixteen rows at
  workspace creation would freeze each message at the version that shipped that
  day, so improving the confirmation email would reach nobody who signed up
  before it. A workspace holds a row only where somebody deliberately wrote
  one, and `DELETE` removes that row rather than restoring a snapshot — which
  is why the screen says "MeetFlow's default" and not "the original".
- **An unknown placeholder is refused, not rendered.** `renderTemplate`
  substitutes a name it does not recognise with an empty string, so
  `{{cusotmerName}}` would ship an email opening "Hi ," to every customer with
  nothing logged and nothing to notice. Every write is checked against
  `modules/notifications/placeholders.ts`, which lists what each message can
  fill, and the 422 names the offender and the alternatives.

The system-row branch in the middle is still unused: nothing inserts a row with
a NULL `businessId`, because the built-in defaults in `templates.ts` already
serve that purpose and a database copy of them would be a second source of
truth. It is kept because the partial unique index and the resolution order
cost nothing and a platform-wide override is a plausible future need.

`placeholders.ts` is a promise, and `notificationPlaceholderDrift.test.ts` is
what keeps it one: it books, cancels, moves, rejects and no-shows real
appointments, joins a waitlist and frees a slot into it, then asserts that every
name the catalogue offers is genuinely present in the payload that reached the
outbox. A producer that drops a field fails a test rather than silently emptying
a placeholder in production.

Rendering is deliberately **not** a general template engine. Bodies are partly
author-controlled, and a real engine would turn "edit your confirmation email"
into arbitrary code execution. It is a `{{path}}` substitution and nothing else.

Escaping happens at one point, and the order matters. A notification's body is
substituted **raw** when the row is enqueued — that string is the plain-text
part of the message, and escaping there would show a customer "Ben &amp; Jerry".
The HTML part is built at delivery, from that already-substituted text, so
escaping only the placeholders would escape nothing: there are none left. The
whole body is therefore escaped _before_ any remaining substitution runs, which
is safe because `{{ path }}` contains no escapable character and survives the
pass intact.

Getting this backwards is not a cosmetic bug. A customer's own name, typed into
a public booking form, would reach the recipient's inbox as live markup.

## Providers

The application depends on the `EmailProvider` port, never on nodemailer:

- **`console`** (development default) renders the message into the structured
  log and reports success. This is an honest no-op — the row is still written,
  claimed, and transitioned to `SENT`, so the whole pipeline is exercised
  locally. It is not a stand-in for production, which is why `EMAIL_PROVIDER`
  must be `smtp` there.
- **`smtp`** delivers through a pooled, timeout-bounded nodemailer transport.

Channels other than `EMAIL` have no provider configured yet. Rather than
pretending, those rows are closed out as `CANCELLED` with an explicit reason —
they are never reported as delivered.

## Observability

- Every state change is persisted, so "was the customer told?" is answerable
  from the database alone.
- `attempt_count` and `last_error` are kept for support.
- The sweep logs a warning when it hits its batch limit, so a growing backlog is
  visible instead of quietly trickling.
- Recipient addresses are snapshotted at enqueue time: if a customer later
  changes their email, an in-flight message still shows where it was actually
  sent.
