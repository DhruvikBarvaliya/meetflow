# Timezones and DST

Scheduling software that gets this wrong is wrong twice a year, quietly, for
every business in a DST-observing region. MeetFlow treats it as a correctness
requirement with tests, not as a formatting concern.

## Two kinds of time

Everything in the domain is one of these, and they are never mixed:

|           | Instant                                                | Wall-clock rule                                                        |
| --------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Means     | a specific point in time                               | a repeating human schedule                                             |
| Example   | "this appointment starts at 2025-06-02T13:00:00Z"      | "we open at 09:00 on Tuesdays"                                         |
| Stored as | `timestamptz` (UTC)                                    | minutes from local midnight + weekday/date + IANA zone                 |
| Examples  | `appointments.starts_at`, `blackout_periods.starts_at` | `business_hours`, `staff_availability_rules`, `availability_overrides` |

A wall-clock rule becomes an instant only through `resolveWallClock()`, and only
against a named IANA zone.

## Why offsets are banned

`isValidTimezone()` rejects `+05:30` and accepts `Asia/Kolkata`.

An offset is a property of _an instant in a zone_, not of the zone itself.
`America/New_York` is `-05:00` in January and `-04:00` in July. Storing the
offset freezes a decision that the calendar is supposed to make later, and every
DST transition then shifts every recurring rule by an hour.

Equally banned: computing a local time as `startOfDay + N minutes`. Luxon adds
time units as _exact elapsed duration_, so on a spring-forward day
`midnight + 540 minutes` lands at 10:00 local, not 09:00. MeetFlow always
constructs the wall-clock reading directly:

```ts
DateTime.fromObject({ year, month, day, hour, minute }, { zone });
```

## The two edge cases

`resolveWallClock(date, minutes, zone)` returns the instant plus a `resolution`
that names what happened.

### Spring forward — the time that never happened

`America/New_York`, 2024-03-10: the clock jumps 02:00 → 03:00, so 02:30 does not
exist. Luxon silently shifts such a time forward. MeetFlow detects the shift by
comparing the wall clock it asked for against the one it got back, and reports
`resolution: 'skipped'`.

The scheduling engine **drops** skipped windows. Offering 02:30 on a day when
02:30 does not exist would produce a slot that cannot be honoured.

### Fall back — the time that happens twice

`America/New_York`, 2024-11-03: the clock repeats 01:00 → 02:00, so 01:30 occurs
twice, once at `-04:00` and once at `-05:00`. MeetFlow detects this (the same
wall-clock reading recurs one real hour later) and reports
`resolution: 'ambiguous'`, deterministically choosing the **earlier** offset.

Deterministic matters more than which one: two API instances answering the same
query must agree.

### The property that matters most

A 09:00 opening rule stays 09:00 local on **both** transition days:

| Date                        | Local | Instant  | Offset |
| --------------------------- | ----- | -------- | ------ |
| 2024-03-10 (spring forward) | 09:00 | `13:00Z` | −04:00 |
| 2024-06-10 (normal)         | 09:00 | `13:00Z` | −04:00 |
| 2024-11-03 (fall back)      | 09:00 | `14:00Z` | −05:00 |

The instant moves; the promise to the customer does not.

## Multiple zones in one query

Three zones can be involved in a single availability search:

1. **Business / location zone** — resolves `business_hours`. A location carries
   its own zone, because a chain has branches in different regions.
2. **Staff zone** — resolves `staff_availability_rules` and overrides. Staff
   author their hours in their own local time.
3. **Customer zone** — used only to bound the search to their calendar days and
   to render results.

Each rule set is resolved to instants **in its own zone**, and the sets are then
intersected **as instants**. A clinic open 09:00–17:00 London staffed by someone
working 09:00–17:00 Mumbai therefore yields only the genuinely overlapping
hours, and stays correct when the two zones change offset on different dates.

## Durations vs. rules

- **Duration arithmetic** (`addMinutes`) is exact elapsed time. A 30-minute
  appointment lasts 30 real minutes even across a transition.
- **Rule arithmetic** always goes back through `resolveWallClock`.

Overnight windows use minutes beyond 1440: 22:00–02:00 is stored as `1320–1560`,
and the day offset is applied as a _calendar_ day before the wall-clock time is
pinned — which keeps "the next day at 01:00 local" correct across a transition.

## Half-open intervals

Every overlap test — in the engine and in the database exclusion constraints —
uses `[start, end)`. An appointment ending at 10:30 and one starting at 10:30 do
not overlap, so back-to-back booking works without a fudge factor.

## Verified cases

`server/tests/unit/time.test.ts` covers:

- spring-forward: before / during (skipped) / after
- fall-back: ambiguity detection and the chosen offset
- 09:00 rules on both transition days
- `Asia/Kolkata` (+05:30, no DST) and `Europe/London` (UTC in winter, +01:00 in summer)
- midnight boundaries, `24:00`, overnight windows past 1440
- leap-year date ranges, weekday mapping, half-open overlap
- rejection of fixed offsets and unknown zones
