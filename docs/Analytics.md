# Analytics

Every figure MeetFlow displays is computed from persisted rows. There are no
hard-coded metrics, no seeded "sample" numbers on a dashboard, and no estimates
presented as measurements. If a number cannot be computed, the UI shows an empty
state rather than a plausible-looking zero.

## Metrics

### Overview (`GET /api/v1/analytics/overview`)

| Metric                                              | Definition                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `totalBookings`                                     | appointments created in the window                                                                   |
| `confirmed` / `completed` / `cancelled` / `noShows` | counts by terminal or current status                                                                 |
| `reschedules`                                       | rows in `reschedule_history`                                                                         |
| `cancellationRate`                                  | cancelled ÷ total                                                                                    |
| `noShowRate`                                        | no-shows ÷ (completed + no-shows) — the denominator is appointments that _should_ have been attended |
| `newCustomers` / `returningCustomers`               | first appointment inside vs before the window                                                        |
| `averageLeadTimeHours`                              | mean of `starts_at − created_at`                                                                     |
| `averageDurationMinutes`                            | mean of `duration_minutes`                                                                           |
| `revenueAmount`                                     | sum of `price_amount` for **completed** appointments only                                            |

Revenue counts completed work, not booked work. Counting confirmations would
overstate it every time someone cancels.

### Trends, staff, services, locations, peak times, customers

- **Trends** — daily buckets of bookings, completions, cancellations, revenue.
- **Staff** — appointments, completions, no-shows, revenue, and **utilisation**:
  booked minutes ÷ available working minutes in the window. Availability comes
  from the same rules the scheduling engine uses, so "80% utilised" means the
  same thing as it does on the calendar.
- **Services** — bookings, completions, cancellations, revenue, average duration.
- **Locations** — bookings and utilisation per site.
- **Peak times** — counts bucketed by weekday and hour **in the business
  timezone**, so a Bengaluru clinic sees its own mornings, not UTC's.
- **Customers** — repeat rate, new vs returning, top customers by completions.

## Implementation rules

- Aggregates are SQL, not JavaScript. Loading 50,000 appointments into Node to
  count them is both slow and a memory risk.
- `businessId` is a **bound parameter in every query**. No exceptions, no string
  interpolation of user input anywhere.
- Date bucketing uses PostgreSQL `AT TIME ZONE` with the business timezone, not
  JavaScript date maths — the same reasoning as everywhere else in the product.
- Reporting windows are capped at **366 days**; a longer request is a clear 422
  rather than a query that ties up a connection.
- Every endpoint is tenant-scoped and requires `analytics:read`.

## Reports and export

`GET /api/v1/reports/appointments` returns a paginated tabular report with the
same filters as the diary.

`GET /api/v1/reports/appointments.csv` streams CSV, capped at 50,000 rows, with
proper escaping of quotes, commas and newlines. Export requires
`reports:export` and writes an audit record — exporting customer data is an
action worth being able to account for later.

## Freshness

Figures are read live from PostgreSQL. There is no pre-aggregation layer and no
materialised view, because at the volumes a scheduling business generates the
indexed queries are fast and correctness beats a caching tier that can go stale.

Dashboards refresh on the `dashboard.metrics_updated` socket event. That event
carries only a reason, not the numbers — recomputing analytics server-side for
every connected socket would be wasteful, so the client refetches exactly what
it is displaying.

## Denormalised counters

`customers` carries `total_bookings`, `completed_count`, `cancelled_count` and
`no_show_count`, maintained by the booking and lifecycle services.

These are **reporting accelerators for the customer record**, not the source of
truth. Analytics never reads them; appointments remain authoritative. They exist
so a customer list can show "3 no-shows" without an aggregate per row, and they
are exposed read-only — no API path lets a client write them.
