# Socket.IO Events

Real-time updates for dashboards and calendars.

## Authorisation model

**Clients never ask to join a room.**

There is no `join` event to abuse. At connection time the server verifies the
access token, re-reads the caller's ACTIVE memberships from the database, and
joins them to exactly the rooms those memberships entitle them to. Room
membership is therefore derived, not requested, and "socket room abuse" is
prevented by construction rather than by a check that could be forgotten.

Memberships are re-read on every connection, so a member removed from a
workspace cannot rejoin its room with a token issued before the removal.

Handshake:

```ts
io(SOCKET_URL, { auth: { token: accessToken } });
```

A missing, invalid, expired or suspended-account token is refused with
`unauthorised` before any room is joined.

## Rooms

| Room                          | Joined by                                      |
| ----------------------------- | ---------------------------------------------- |
| `workspace:{businessId}`      | every ACTIVE member of that workspace          |
| `staff:{staffProfileId}`      | the staff member that profile belongs to       |
| `appointment:{appointmentId}` | targeted emits only — nobody auto-joins        |
| `customer:{customerId}`       | reserved for the authenticated customer portal |

Appointment events are emitted to the workspace room _and_ the assigned
provider's personal room, so a staff member watching only their own feed still
sees their diary change.

## Events

All server → client. Payloads carry ids and the fields a dashboard needs to
update in place; they are never a substitute for fetching the full record.

| Event                       | Emitted when                                          | Payload                                                                                          |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `connection.ready`          | immediately after a successful handshake              | `{ userId, workspaces[], staffProfiles[] }`                                                      |
| `appointment.created`       | a booking commits                                     | `{ appointmentId, publicId, status, startsAt, endsAt, serviceId, staffProfileId, customerName }` |
| `appointment.updated`       | notes, check-in, approval, reassignment               | `{ appointmentId, publicId, status, ... }`                                                       |
| `appointment.rescheduled`   | a move commits                                        | `{ appointmentId, publicId, previousStartsAt, startsAt, endsAt, staffProfileId }`                |
| `appointment.cancelled`     | a cancellation commits                                | `{ appointmentId, publicId, startsAt, fullyCancelled }`                                          |
| `appointment.completed`     | marked completed                                      | `{ appointmentId, publicId, status }`                                                            |
| `appointment.no_show`       | marked no-show                                        | `{ appointmentId, publicId, status }`                                                            |
| `availability.updated`      | hours, overrides, holidays or blackouts change        | `{ scope, staffProfileId?, date? }`                                                              |
| `staff.assigned`            | a booking assigns a provider, or a move reassigns one | `{ appointmentId, publicId, staffProfileId, previousStaffProfileId?, startsAt, endsAt }`         |
| `waitlist.slot_available`   | a waitlist entry is offered a slot                    | `{ waitlistEntryId, serviceId, startsAt, holdExpiresAt }`                                        |
| `dashboard.metrics_updated` | any change that invalidates dashboard figures         | `{ reason }`                                                                                     |
| `notification.created`      | an outbox row addressed to a member commits           | `{ notificationId, type }`                                                                       |

`dashboard.metrics_updated` deliberately carries only a reason. Recomputing
analytics server-side for every connected socket would be wasteful; the client
refetches the figures it is actually displaying.

`staff.assigned` fires alongside `appointment.created` on a booking and
alongside `appointment.rescheduled` on a reassignment, because both are ways a
provider acquires an appointment. It does **not** fire when someone joins an
existing group session: an attendee arriving does not reassign the class.
`previousStaffProfileId` is present only on a reassignment, and the provider who
lost the appointment is told separately, by `appointment.updated` carrying
`reassignedTo`.

`notification.created` follows the recipient, not the workspace. It is emitted
only for rows addressed to a **user** — never for a customer's confirmation,
which goes to an inbox and to no socket, and never for account email such as a
password reset, which belongs to no workspace. The room is the recipient's own
`staff:{staffProfileId}` when they have a staff profile; a member without one (a
receptionist, an owner who takes no appointments) is only ever in
`workspace:{businessId}`, so that is where theirs is announced. The payload is
an id and a type — never the subject, the body or the address — so the second
case tells a colleague that a message exists without telling them whose it is or
what it says.

## Ordering guarantee

Events are emitted **after** the database transaction commits, never inside it.
A client that receives `appointment.created` and immediately refetches is
guaranteed to see the appointment.

## Cross-process delivery

API instances share a Redis adapter, so a broadcast on one instance reaches
sockets connected to any of them.

The worker process has no Socket.IO server. It publishes onto a Redis bridge
channel (`{prefix}:realtime`) instead, and each API instance re-emits that
payload **locally only** (`io.local.to(room)`). Every instance does the same, so
each socket receives the event exactly once — using a normal broadcast there
would duplicate it once per instance.

`emitRealtime()` picks the right path automatically and never throws: the
business change it describes has already been persisted, so a failed
notification must not turn into a failed request.

## Client guidance

- Treat every event as a **hint to refetch**, not as the source of truth.
- Events can arrive more than once during a reconnect; handlers must be
  idempotent.
- Reconnect with a fresh access token after a refresh — the connection is
  authenticated once, at handshake.
- `maxHttpBufferSize` is 100 KB: a socket is not a way around the HTTP body limit.
