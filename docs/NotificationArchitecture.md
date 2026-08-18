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

Cancelling an appointment flips its pending `APPOINTMENT_REMINDER` and
`APPOINTMENT_FOLLOW_UP` rows to `CANCELLED`, so a reminder never goes out for an
appointment that is no longer happening.

## Idempotency

Every enqueue may carry a `dedupe_key`, backed by a unique index:

| Notification               | Key                                                   |
| -------------------------- | ----------------------------------------------------- |
| Booking confirmation       | `confirm:{appointmentId}:{customerId}`                |
| Reminder                   | `remind:{appointmentId}:{customerId}:{offsetMinutes}` |
| Reschedule                 | `reschedule:{appointmentId}:{newStartsAt}`            |
| Cancellation               | `cancel:{appointmentId}`                              |
| Staff assignment           | `staff-assigned:{appointmentId}:{userId}`             |
| Email verification / reset | `verify:{sha256(token)}` / `reset:{sha256(token)}`    |

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
BullMQ retry and the sweep can then pick it up, so a worker that dies mid-job
does not strand the message.

## States

```
PENDING ──claim──► PROCESSING ──ok──► SENT
   ▲                    │
   └────retry left──────┤
                        └──budget spent──► FAILED

PENDING ──appointment cancelled / no provider──► CANCELLED
```

## Templates

Built-in templates ship with the product, so notifications work the moment a
workspace is created. A workspace may override any of them with a row in
`notification_templates`; resolution is workspace override → system row →
built-in default.

Rendering is deliberately **not** a general template engine. Bodies are partly
author-controlled, and a real engine would turn "edit your confirmation email"
into arbitrary code execution. It is a `{{path}}` substitution with HTML
escaping on the HTML branch, and nothing else.

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
