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

|               |                                                                                     |
| ------------- | ----------------------------------------------------------------------------------- |
| **Met**       | Built, and covered by a test that would fail if it regressed.                       |
| **Partial**   | Built, with a named limitation.                                                     |
| **Not built** | Absent, deliberately, and disclosed.                                                |
| **Gap**       | Required, absent, and not yet addressed. Tracked in [GapAudit.html](GapAudit.html). |

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

**Standing: Partial.** All five dimensions are modelled and enforced. The
limitation is membership: a workspace can be created with an owner, and no API
can add a second member, so Manager, Receptionist and Staff exist as fully
enforced roles that a real deployment cannot reach. See gap 01.

### B. Advanced scheduling engine

Per-service duration, buffers, capacity, notice and horizon; per-staff weekly
rules, overrides, holidays and blackouts; DST-correct wall-clock semantics;
group services; resource requirements.

**Standing: Partial.** The engine is the strongest part of the product — see
[SchedulingEngine.md](SchedulingEngine.md) and [TimezoneAndDST.md](TimezoneAndDST.md).
Known limitations: resource availability is not an input to slot search (gap 25),
location-scoped holidays and overrides are accepted and not applied (gap 27),
and per-customer booking caps are enforced at commit but invisible in search
(gap 26).

### C. Intelligent scheduling

Assignment strategies across a team — round robin, pooled, least busy, smart
match — resolved deterministically.

**Standing: Met.** Scoring is deterministic and explainable, never a model. See
[ADR/README.md](ADR/README.md), ADR-0010.

### D. Customer relationship layer

Per-workspace customer records, history, preferences, notes, and a portal for
the customer's own bookings.

**Standing: Partial.** Records, history and preferences exist and are correct.
The portal is reachable only by a user who also holds a workspace membership,
because there is no customer identity — see gap 02.

### E. Workflow automation

Rules that react to appointment events.

**Standing: Not built.** `AutomationRule` and `AutomationExecution` are modelled
and a queue name is reserved; there is no producer, processor or API. Disclosed
in the README.

### F. Waitlist

Customers wait for a slot and are offered it when one frees.

**Standing: Partial.** Entries, matching and offer notifications work and are
triggered on cancellation. The offer email links to a claim URL that has no
route behind it, and rejection and reschedule-away do not trigger matching —
gaps 19 and 49.

### G. Resource scheduling

Rooms, equipment and vehicles reserved alongside the appointment, with capacity.

**Standing: Partial.** Reservation at booking is correct and concurrency-safe.
Reschedule moves the reservation without re-checking capacity — gap 14.

### H. Booking policies

Approval, notice, horizon, cancellation and reschedule deadlines, per-customer
limits.

**Standing: Partial.** Resolved per service, then workspace. `requiresApproval`
on a booking link is settable and not consulted — gap 23.

### I. Real-time collaboration

Live diary updates across connected staff.

**Standing: Met.** Socket.IO with rooms derived from live memberships, never
from client request. See [SocketIOEvents.md](SocketIOEvents.md). Two declared
events are never emitted — gap 30.

### J. Analytics

Aggregations over real appointment rows, and exportable reports.

**Standing: Met, with one wrong denominator.** Every figure is a live query;
there is no rollup table. Utilisation excludes leave and holidays from its
denominator, which [Analytics.md](Analytics.md) claims it includes — gap 31.

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

**Standing: Partial.** The four workspace roles are fully specified and enforced,
and the platform admin surface is complete. Two gaps: no route can create a
membership, so three of the four are unreachable (gap 01); and Customer is not an
identity the system can authenticate (gap 02).

---

## 4. Multi-tenancy

The workspace is the tenant boundary. Every tenant-owned row carries its id, and
that id is derived from an authenticated membership — never from client input. A
request for another tenant's resource answers **404, not 403**, so the API cannot
be used to enumerate what exists.

**Standing: Met.** See [MultiTenancy.md](MultiTenancy.md). Enforced in one
middleware, verified by integration and end-to-end tests. Cross-tenant _writes_
are not yet covered by a test — gap 39.

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

**Standing: three links broken.**

| Step                                                   | Standing                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Register → create workspace                            | Met                                                                                               |
| Configure services, availability, locations, resources | Met                                                                                               |
| **Add staff**                                          | **Gap 01** — no API can add a member; requires manual database editing                            |
| Publish booking link → customer books                  | Met                                                                                               |
| Appointment safely persisted                           | Met                                                                                               |
| Real-time update                                       | Met                                                                                               |
| Confirmation and reminders processed                   | Met                                                                                               |
| Customer reschedules or cancels                        | Met — but as a guest via an opaque link, not as an authenticated customer (gap 02)                |
| Business sees analytics                                | Met                                                                                               |
| **Business sees audit trail**                          | **Gap 03** — audit rows are written by eighteen services and readable only by a platform operator |

Until gaps 01 and 03 close, the product does not meet its own definition of
success. Both are tracked, neither is disguised, and the honest reading is that
the scheduling core is production-grade while the surrounding operating layer is
not yet complete.

---

## 8. What is deliberately not built

Listed so that absence is never mistaken for oversight.

|                                | Why                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMS delivery                   | Channel modelled; no provider integrated. Rows close as cancelled with a reason rather than reporting success.                                       |
| Google Calendar / Outlook sync | Declined in ADR-0009: an empty adapter that syncs nothing is worse than an honest absence.                                                           |
| Payments and invoicing         | Out of scope for this revision.                                                                                                                      |
| Workflow automation engine     | Models and queue reserved; no producer or processor.                                                                                                 |
| Response schemas in OpenAPI    | Request schemas are generated from zod; response shapes are documented in `client/src/types/api.ts` instead. The cost is real and tracked as gap 42. |

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
