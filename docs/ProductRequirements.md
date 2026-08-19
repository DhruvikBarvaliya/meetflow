# Product Requirements

The authoritative statement of what MeetFlow is meant to be, kept in the
repository so that judging whether the code meets it never requires anything
outside the repository. Its absence was itself a finding: an audit had to
reconstruct these requirements from a chat transcript, which is not a record.

Every section states the requirement first and its current standing second.
Where the two disagree, the disagreement is written down rather than smoothed
over — an honest gap is a backlog item, a quietly overstated one is a lie that
compounds.

**Status vocabulary**

|               |                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Met**       | Built, and covered by a test that would fail if it regressed.                                                                                          |
| **Partial**   | Built, with a named limitation.                                                                                                                        |
| **Not built** | Absent, deliberately, and disclosed.                                                                                                                   |
| **Gap**       | Required, absent, and not yet addressed. None remain; the audit that found the last fifty-three is kept as a record in [GapAudit.html](GapAudit.html). |

---

## 1. Product vision

MeetFlow is **not** a calendar-link clone. It is a scheduling operating system
for service businesses and teams, combining public booking, personal and team
scheduling, staff and resource management, customer records, availability
intelligence, automation, notifications, analytics, auditability and real-time
collaboration into one product.

It must serve consultants, clinics, salons, coaching businesses, agencies,
education providers, professional services, repair businesses, internal
corporate teams and multi-location operators — so neither the data model nor the
UI may be hard-coded around a single industry.

**Standing: Met.** Nothing in the schema or the interface names an industry. The
vocabulary is deliberately generic — service, staff, resource, location,
customer — and the demo seed is one plausible tenant rather than a shape the
product assumes. The one place industry appears is a free-text `industry` column
on the workspace, which nothing branches on.

---

## 2. Differentiators

These are the reasons the product is not a thin booking link. They are the
requirements most worth protecting in review.

### A. Business operating layer

Multi-service catalogue, multi-staff, multi-location, multi-resource, with roles
and permissions inside a workspace.

**Standing: Met.** All five dimensions are modelled and enforced, and every one
of the four roles is now reachable: `POST /members/invite` creates the
membership, `GET /members/invitations` and `POST /members/accept` let the
invitee join, and `roles.spec.ts` exercises Staff, Receptionist and Manager
end to end. Accepting an invitation also confirms the address, because the
invitation was sent to it and no verification link is ever sent to an account
the invitation itself created.

### B. Advanced scheduling engine

Per-service duration, buffers, capacity, notice and horizon; per-staff weekly
rules, overrides, holidays and blackouts; DST-correct wall-clock semantics;
group services; resource requirements.

**Standing: Met.** The engine is the strongest part of the product — see
[SchedulingEngine.md](SchedulingEngine.md) and [TimezoneAndDST.md](TimezoneAndDST.md).
The three limitations recorded here previously are closed: `resourceEngine.ts`
makes room and equipment availability an input to the search rather than a
surprise at submit, holidays and overrides carry their `locationId` through it
so a closure at one branch no longer shuts the workspace, and a slot beyond a
per-customer cap is rejected as `LIMIT_REACHED` in the search instead of only at
commit.

### C. Intelligent scheduling

Assignment strategies across a team — round robin, pooled, least busy, smart
match — resolved deterministically.

**Standing: Met.** Scoring is deterministic and explainable, never a model. See
[ADR/README.md](ADR/README.md), ADR-0010.

### D. Customer relationship layer

Per-workspace customer records, history, preferences, notes, and a portal for
the customer's own bookings.

**Standing: Met.** Records, history and preferences exist and are correct, and
a customer is now an identity the system authenticates in its own right:
`/api/v1/me` is a surface of its own, mounted above the management router
precisely so somebody with no membership can use it. Verifying an address is
what links the bookings already made against it to the account.

### E. Workflow automation

Rules that react to appointment events.

**Standing: Not built.** `AutomationRule` and `AutomationExecution` are modelled
and a queue name is reserved; there is no producer, processor or API. Disclosed
in the README.

### F. Waitlist

Customers wait for a slot and are offered it when one frees.

**Standing: Met.** Entries, matching and offer notifications work, and all three
transitions that free a slot now reach the matcher through one `offerFreedSlot`
helper — cancellation, rejection and moving an appointment away from a time.
`publicWaitlistRouter` is mounted, so the claim link in the offer email leads
somewhere; before it was, every offer email ended at a 404.

### G. Resource scheduling

Rooms, equipment and vehicles reserved alongside the appointment, with capacity.

**Standing: Met.** Reservation at booking is correct and concurrency-safe, and
a reschedule now re-claims the reservation under the same `SELECT … FOR UPDATE`
capacity check rather than sliding the rows with a bare `UPDATE` — an exclusion
constraint cannot express "at most N", so the row lock is the only thing that
can.

### H. Booking policies

Approval, notice, horizon, cancellation and reschedule deadlines, per-customer
limits.

**Standing: Met.** Resolved per booking link, then service, then workspace —
`requiresApproval` on a link is consulted at both the public and the staff-side
booking paths, so a link that asks for approval gets it whatever the service and
workspace say.

### I. Real-time collaboration

Live diary updates across connected staff.

**Standing: Met.** Socket.IO with rooms derived from live memberships, never
from client request. See [SocketIOEvents.md](SocketIOEvents.md). Every declared
event has a producer; the two that did not now fire from the booking and
lifecycle services alongside their webhook counterparts.

### J. Analytics

Aggregations over real appointment rows, and exportable reports.

**Standing: Met.** Every figure is a live query; there is no rollup table, so a
number on the dashboard is the number in the table. The denominators are
documented figure by figure in [Analytics.md](Analytics.md) and match the SQL —
`noShowRate` divides by completed plus no-shows, which is the set of
appointments that should have been attended, rather than by every booking.

---

## 3. Roles

Four roles inside a workspace, plus a platform operator above them.

| Role               | Scope                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| **Business owner** | Everything within their workspace.                                                             |
| **Manager**        | Operations, staff and diary; not roles or deletion.                                            |
| **Receptionist**   | Booking and customers; not configuration.                                                      |
| **Staff**          | Their own schedule and assigned appointments.                                                  |
| **Customer**       | Their own bookings only.                                                                       |
| **Platform admin** | Workspaces, accounts, audit and dependency health across the deployment — never customer data. |

Permissions are resolved per request from the membership, its role and any
per-member overrides. A grant is never carried in a token, so revocation is
immediate.

**Standing: Met.** The four workspace roles are fully specified, enforced and
reachable — invitation, acceptance and role changes all have routes, and
`roles.spec.ts` drives each role through the browser. Customer is an identity in
its own right on `/api/v1/me`. The platform admin surface is complete and sits
on its own router, behind `requirePlatformAdmin` and never behind
`requireTenant`.

---

## 4. Multi-tenancy

The workspace is the tenant boundary. Every tenant-owned row carries its id, and
that id is derived from an authenticated membership — never from client input. A
request for another tenant's resource answers **404, not 403**, so the API cannot
be used to enumerate what exists.

**Standing: Met.** See [MultiTenancy.md](MultiTenancy.md). Enforced in one
middleware and verified by integration and end-to-end tests, reads and writes
alike: `tenancy.test.ts` runs cross-tenant PATCH, PUT and DELETE against every
entity, re-reads each row to prove it did not change, and includes a control
that performs the same calls as the legitimate owner — without which a mistyped
path would let the whole block pass having tested nothing.

---

## 5. Scheduling correctness

The requirements that make the product trustworthy rather than merely functional.

- **No double booking, ever**, including under concurrency.
- **Wall-clock rules stay wall-clock** across daylight-saving transitions.
- **A retried booking is not a second booking.**
- **Group services** fill to capacity and then refuse.

**Standing: Met.** This is the part of the product that is hardest to fake and
has been built accordingly: PostgreSQL exclusion constraints over `tstzrange` as
the final authority, advisory locks and re-validation in front of them, an
idempotency table with two unique indexes, and row locks for group capacity. Ten
simultaneous requests for one slot yield exactly one appointment; six for the
last two places in a class yield exactly two. See
[BookingConcurrency.md](BookingConcurrency.md).

---

## 6. Notifications

Confirmations and reminders must survive a queue outage, must never be sent for
a booking that rolled back, and must never claim delivery that did not happen.

**Standing: Met, with limitations.** A transactional outbox writes the
notification row inside the same transaction as the change, and a worker drains
it after commit with backoff and a recovery sweep. See
[NotificationArchitecture.md](NotificationArchitecture.md).

Limitations: SMS is modelled and not delivered — non-email rows are closed as
cancelled _with a reason_ rather than reported sent.

One of the sixteen templates has no producer: `OWNER_DAILY_DIGEST`, which needs
a scheduled job nothing runs. The other fifteen are queued by real flows, and
`notificationPlaceholderDrift.test.ts` proves it rather than asserting it — it
exercises each flow and fails if a message stops being produced, so this count
cannot go stale again without a red test. (This section previously said six of
sixteen had no producer; five gained one and the number was not revised.)

A workspace can rewrite any of the sixteen through
`/api/v1/notification-templates`, and a body naming a placeholder the message
cannot fill is refused rather than sent as empty text.

---

## 7. Definition of success

The specification defines success as one unbroken path, achievable **with no
manual database editing and no demo-only behaviour**:

```
register → create workspace → configure services → add staff →
configure availability → configure locations and resources →
publish booking link → customer books → appointment safely persisted →
staff receive a real-time update → confirmation and reminders processed →
customer reschedules or cancels → business sees analytics and audit trail
```

**Standing: every link closed.**

| Step                                                   | Standing                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Register → create workspace                            | Met                                                                                          |
| Configure services, availability, locations, resources | Met                                                                                          |
| Add staff                                              | Met — invite, accept, then a staff profile; `roles.spec.ts` walks it in a browser            |
| Publish booking link → customer books                  | Met                                                                                          |
| Appointment safely persisted                           | Met                                                                                          |
| Real-time update                                       | Met                                                                                          |
| Confirmation and reminders processed                   | Met                                                                                          |
| Customer reschedules or cancels                        | Met — as a guest through an opaque link, and as an authenticated customer on `/api/v1/me`    |
| Business sees analytics                                | Met                                                                                          |
| Business sees audit trail                              | Met — `/api/v1/audit-logs` is on the management router and the workspace reads its own trail |

The chain runs end to end, and `e2e/tests/` walks most of it through a browser
rather than asserting it here. What remains unbuilt is listed in section 8 and
in the README, and none of it sits on this path: the workflow automation engine,
SMS delivery, calendar sync and payments are all beside it rather than in it.

---

## 8. What is deliberately not built

Listed so that absence is never mistaken for oversight.

|                                | Why                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| SMS delivery                   | Channel modelled; no provider integrated. Rows close as cancelled with a reason rather than reporting success.                                   |
| Google Calendar / Outlook sync | Declined in ADR-0009: an empty adapter that syncs nothing is worse than an honest absence.                                                       |
| Payments and invoicing         | Out of scope for this revision.                                                                                                                  |
| Workflow automation engine     | Models and queue reserved; no producer or processor.                                                                                             |
| Response schemas in OpenAPI    | Now generated: `server/src/docs/responses.ts` names 97 response schemas and every operation references one, returns 204, or declares `text/csv`. |

---

## Related documents

[Architecture.md](../Architecture.md) ·
[SchedulingEngine.md](SchedulingEngine.md) ·
[TimezoneAndDST.md](TimezoneAndDST.md) ·
[BookingConcurrency.md](BookingConcurrency.md) ·
[MultiTenancy.md](MultiTenancy.md) ·
[NotificationArchitecture.md](NotificationArchitecture.md) ·
[RedisArchitecture.md](RedisArchitecture.md) ·
[SocketIOEvents.md](SocketIOEvents.md) ·
[SecurityThreatModel.md](SecurityThreatModel.md) ·
[Analytics.md](Analytics.md) ·
[admin-panel.md](admin-panel.md) ·
[ADR/README.md](ADR/README.md) ·
[GapAudit.html](GapAudit.html)
