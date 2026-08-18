# Scheduling Engine

How stored configuration becomes bookable times.

## Shape

Three layers, deliberately separated so the hard parts are testable without a
database:

```
availability.service.ts   loads configuration, resolves wall-clock rules to instants   (I/O)
        ↓
slotEngine.ts             generates candidate slots from instants                      (pure)
        ↓
smartMatch.ts             ranks eligible providers                                     (pure)
```

`slotEngine.ts` performs no I/O and reads no clock — `now` is an input. That is
what makes DST behaviour, buffers, notice periods and truncation exhaustively
unit-testable.

## Inputs

| Source                     | Contributes                                                                      |
| -------------------------- | -------------------------------------------------------------------------------- |
| `services`                 | duration, capacity, buffers, notice, horizon, slot interval, assignment strategy |
| `business_settings`        | defaults for everything a service does not override                              |
| `staff_profiles`           | own timezone, per-staff buffer/notice overrides, daily and weekly caps           |
| `service_staff`            | who can deliver it, plus per-pairing duration and price overrides                |
| `business_hours`           | when the business (or a specific location) is open                               |
| `staff_availability_rules` | recurring weekly working hours, optionally date-bounded                          |
| `availability_overrides`   | date-specific additions and removals, including leave                            |
| `holidays`                 | closures, optionally recurring annually                                          |
| `blackout_periods`         | absolute unavailable spans                                                       |
| `appointment_staff`        | existing blocking reservations                                                   |
| `appointments`             | group sessions with remaining capacity                                           |

### Policy resolution

Every rule follows one fallback chain, resolved once in `resolvePolicy()`:

```
staff override  →  service override  →  business setting  →  engine default
```

`NULL` means "inherit". Changing one business default therefore propagates
everywhere it was not deliberately overridden.

## Producing working windows

For each requested date, per provider:

1. **Business open windows** — `business_hours` for that weekday, resolved in
   the _business or location_ timezone. Location-specific rows, when present,
   replace the business-wide rows for that location entirely.
2. **Staff working windows** — `staff_availability_rules` for that weekday,
   resolved in the _staff member's own_ timezone, filtered by
   `effective_from` / `effective_to`.
3. **Overrides** — `is_available = true` rows _replace_ the recurring rules for
   that date (an unusual working Saturday); `is_available = false` rows subtract
   a window, or the whole day when no window is given (leave, sickness).
4. **Holidays** — a closing holiday removes the day. Recurring holidays match on
   month and day across every requested year.
5. **Intersection** — bookable time is where the business is open **and** the
   provider is working, computed as instants.

Because each rule set is resolved in the zone it was authored in and only then
intersected, cross-zone staffing stays correct even when the two zones change
offset on different dates. See `TimezoneAndDST.md`.

## Generating slots

`generateSlots()` walks each working window on a grid.

- **Grid anchoring** — candidates align to `slotIntervalMinutes` from the
  _window start_, not midnight. A clinic opening at 09:10 offers 09:10 / 09:25 /
  09:40, never an unusable 09:00.
- **Fit test** — the _appointment_ must fit inside working hours; the _buffered_
  window must not overlap anything busy. Buffers can therefore extend past
  opening time, which is what businesses actually want from prep time.
- **Conflict skipping** — on a conflict the cursor jumps past the blocking
  interval instead of stepping through a two-hour meeting one grid unit at a
  time. Merged, sorted busy intervals plus a monotonic cursor keep generation
  O(n + m).
- **Minimum notice** — candidates before `now + minNoticeMinutes` are dropped.
- **Group services** — an existing session with remaining capacity is emitted as
  a joinable slot carrying `joinsAppointmentId` and `remainingCapacity`, rather
  than being treated as busy.
- **Truncation** — capped by `AVAILABILITY_MAX_SLOTS`. When the cap bites, the
  response says `truncated: true` rather than implying the day is full.
- **Explain mode** — optionally returns rejected candidates with a reason
  (`TOO_SOON`, `CONFLICT` + what it collided with, `OUTSIDE_WORKING_HOURS`), so
  "why is 14:00 not offered?" has an answer.

## Smart Match

When several providers can deliver a service at the same time, something has to
choose. Smart Match is a deterministic weighted sum over observable facts:

| Factor               | Weight | Meaning                                       |
| -------------------- | ------ | --------------------------------------------- |
| Preferred provider   | 100    | the customer nominated them                   |
| Previous provider    | 45     | continuity of care                            |
| Location match       | 30     | assigned to the requested site                |
| Workload balance     | 25     | lighter current load, damped near a daily cap |
| Round-robin fairness | 20     | longest since last assigned, scaled by weight |
| Configured priority  | 15     | explicit ordering on the assignment           |

Every contribution is returned with a human-readable reason, so a ranking can be
explained to a business owner. Ties break on priority, then on
`staffProfileId` — so two API instances answering the same query agree.

`ROUND_ROBIN` deliberately ignores workload and preference: its entire purpose is
even distribution by turn, and blending other factors would make it something
else. `COLLECTIVE` requires every member free; `POOLED` takes the first match.

This is **not** AI, and booking correctness does not depend on any model. If an
AI-assisted strategy is added later it goes behind this same interface.

## Confirmation-time revalidation

`verifySlot()` re-checks one exact requested time against live data at booking
time. It deliberately does **not** reuse `generateSlots()`: grid alignment is
right for _offering_ times but must never reject a time the engine itself just
offered, and confirmation only cares whether this exact window is free and in
policy. That also allows legitimately off-grid bookings — a waitlist claim, or a
receptionist booking 09:07 by hand.

## Bounds

Availability search is a public, unauthenticated, relatively expensive read, so
it is bounded on every axis:

- date range capped by `AVAILABILITY_MAX_RANGE_DAYS` (default 62)
- results capped by `AVAILABILITY_MAX_SLOTS` (default 750)
- requested range clamped to the booking horizon before any work happens
- one query per rule kind for _all_ providers, never one query per provider
- rate limited per IP by `availabilityRateLimit`
