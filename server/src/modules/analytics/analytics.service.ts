/**
 * Analytics aggregates.
 *
 * Everything here is a `GROUP BY` over real appointment rows. There is no
 * counter table, no cached rollup and no figure assembled in JavaScript from
 * anything other than values PostgreSQL returned, because a reporting layer that
 * can drift from the diary is worse than no reporting layer at all.
 *
 * Four rules run through every query in this file:
 *
 *  1. **`businessId` is bound into every statement.** These are raw queries, so
 *     the tenant filter is not something a forgotten Sequelize scope can drop:
 *     it is written into each `WHERE` and supplied as a bind parameter. Nothing
 *     a client sends is ever concatenated into SQL — `locationId` and
 *     `staffProfileId` arrive as binds too, and because they are applied *inside*
 *     the tenant filter, an id from another workspace matches no rows rather
 *     than reaching them.
 *  2. **Days are cut in the workspace's timezone, by PostgreSQL.** `AT TIME
 *     ZONE` decides which calendar day an instant belongs to. Bucketing in
 *     JavaScript would silently use the server's zone, which is UTC in
 *     production and the developer's in testing — the same data would produce
 *     two different Monday totals.
 *  3. **Rates are divided in SQL, over the aggregates that produced them.**
 *     `NULLIF(denominator, 0)` turns the empty-window case into NULL and
 *     `COALESCE` turns that into 0, so an empty range answers 0 rather than
 *     erroring or inventing a plausible-looking figure.
 *  4. **The window is capped.** See range.ts.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database';
import { NotFoundError } from '../../utils/errors';
import { assertRangeWithinCap } from './range';
import { AVERAGE_DECIMALS, type Numeric, RATE_DECIMALS, round, toNumber } from './sql';
import type { AnalyticsRangeQuery } from './analytics.validation';

/**
 * How many customers the "top customers" table returns.
 *
 * Fixed rather than client-chosen: this is a leaderboard on a dashboard panel,
 * and letting a caller ask for ten thousand rows would turn an analytics
 * endpoint into an undocumented customer export.
 */
const TOP_CUSTOMERS = 10;

// ---------------------------------------------------------------------------
// Bind parameters
// ---------------------------------------------------------------------------

/**
 * The binds every analytics statement takes.
 *
 * A plain object type rather than an interface so it satisfies Sequelize's
 * index-signature bind type, and every key is always present — a named bind
 * that is `undefined` is a hard error from the driver, so "no filter" has to be
 * an explicit NULL that the SQL tests for.
 */
type ScopeBind = {
  businessId: string;
  tz: string;
  fromDate: string;
  toDate: string;
  locationId: string | null;
  staffProfileId: string | null;
};

function scopeBind(businessId: string, timezone: string, query: AnalyticsRangeQuery): ScopeBind {
  assertRangeWithinCap(query.from, query.to);
  return {
    businessId,
    tz: timezone,
    fromDate: query.from,
    toDate: query.to,
    locationId: query.locationId ?? null,
    staffProfileId: query.staffProfileId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------------------

/**
 * The window as two instants.
 *
 * `to` is inclusive as a calendar date and exclusive as an instant: the day
 * after `to`, at local midnight. Half-open comparison is what makes the range
 * safe across a DST boundary — a day is 23 or 25 hours long twice a year, and
 * `+ 1` on a `date` is immune to that in a way that `+ 24 hours` is not.
 */
const BOUNDS_CTE = `
  bounds AS (
    SELECT ($fromDate::date)::timestamp AT TIME ZONE $tz::text        AS from_ts,
           (($toDate::date + 1)::timestamp) AT TIME ZONE $tz::text    AS to_ts
  )`;

/** Every calendar day in the window, so a quiet day is a zero and not a gap. */
const DAYS_CTE = `
  days AS (
    SELECT generated::date AS bucket
    FROM generate_series($fromDate::date, $toDate::date, interval '1 day') AS generated
  )`;

/**
 * The appointment rows every figure on this surface is drawn from.
 *
 * Membership of the window is decided by `starts_at`: an appointment belongs to
 * the period it was scheduled for, not the period it was booked or cancelled in,
 * which is what makes a month's totals stable once the month has passed.
 */
const SCOPED_CTE = `
  scoped AS (
    SELECT a.id, a.status, a.starts_at, a.created_at, a.duration_minutes,
           a.price_amount, a.reschedule_count, a.service_id, a.staff_profile_id,
           a.location_id, a.customer_id
    FROM appointments a
    CROSS JOIN bounds b
    WHERE a.business_id = $businessId
      AND a.starts_at >= b.from_ts
      AND a.starts_at <  b.to_ts
      AND ($locationId::uuid IS NULL OR a.location_id = $locationId::uuid)
      AND ($staffProfileId::uuid IS NULL OR a.staff_profile_id = $staffProfileId::uuid)
  )`;

/**
 * Appointments that actually consumed diary time.
 *
 * A no-show consumed its slot just as surely as a completed booking did — that
 * is precisely what makes it expensive — so utilisation counts it. A cancelled
 * or rejected booking released its slot and does not.
 */
const OCCUPIED_SQL = `status NOT IN ('CANCELLED', 'REJECTED')`;

/**
 * A wall-clock minute-of-day on one calendar day, as an instant.
 *
 * Rosters and opening hours are stored as minutes past local midnight, and a
 * denominator has to be measured against absolute time before leave and
 * blackouts — which are instants — can be taken out of it. `AT TIME ZONE` is
 * also what makes the two short and long days of the year come out right: a
 * 09:00–17:00 rota is eight hours on most days and seven on the day the clocks
 * go forward, and only PostgreSQL knows which day that is for this zone.
 *
 * Every argument is literal SQL written in this file. Nothing a client sends
 * reaches it — `zone` is either the `$tz` bind or a column, never a value.
 */
function wallClock(dayExpr: string, minuteExpr: string, zone = '$tz::text'): string {
  return `((${dayExpr}) + make_interval(mins => ${minuteExpr})) AT TIME ZONE ${zone}`;
}

/** One whole calendar day as an instant range, in the same zone as its windows. */
function wholeDay(dayExpr: string, zone = '$tz::text'): string {
  return `tstzrange(${wallClock(dayExpr, '0', zone)}, ${wallClock(dayExpr, '1440', zone)})`;
}

/**
 * Minutes a set of windows is worth once unavailability has been taken out.
 *
 * Both callers build two CTEs of this exact shape — `windows`, the time the
 * rota or the opening hours offer, and `unavailable`, the time leave, holidays
 * and blackouts take back — each keyed by `owner_id` and carrying one
 * `tstzrange`. Both sides are unioned by `range_agg` before they meet, which is
 * what makes the arithmetic idempotent in both directions: a staff member
 * covered by both an any-location rule and a rule for the branch being filtered
 * is not credited with the same hour twice, and an absence recorded twice —
 * leave booked as an override *and* as a blackout, which is exactly what a
 * careful administrator does — does not subtract it twice either. Summing the
 * rows directly would get both wrong, inflating one denominator and hollowing
 * out the other.
 *
 * An owner whose windows are entirely eaten drops out of the result rather than
 * appearing as 0; the outer LEFT JOIN turns the absence back into 0, and
 * `NULLIF` keeps the rate at 0 instead of dividing by it.
 */
const NET_WINDOW_MINUTES_SQL = `
    SELECT net.owner_id,
           (SUM(EXTRACT(EPOCH FROM (upper(segment) - lower(segment)))) / 60)::bigint AS minutes
    FROM (
      SELECT rostered.owner_id,
             rostered.spans - COALESCE(absent.spans, '{}'::tstzmultirange) AS spans
      FROM (
        SELECT owner_id, range_agg(span) AS spans
        FROM windows
        WHERE NOT isempty(span)
        GROUP BY owner_id
      ) rostered
      LEFT JOIN (
        SELECT owner_id, range_agg(span) AS spans
        FROM unavailable
        WHERE NOT isempty(span)
        GROUP BY owner_id
      ) absent ON absent.owner_id = rostered.owner_id
    ) net, unnest(net.spans) AS segment
    GROUP BY net.owner_id`;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface AnalyticsOverview {
  totalBookings: number;
  confirmed: number;
  completed: number;
  cancelled: number;
  noShows: number;
  reschedules: number;
  cancellationRate: number;
  noShowRate: number;
  newCustomers: number;
  returningCustomers: number;
  averageLeadTimeHours: number;
  averageDurationMinutes: number;
  revenueAmount: number;
  currency: string;
}

interface OverviewRow {
  total_bookings: Numeric;
  confirmed: Numeric;
  completed: Numeric;
  cancelled: Numeric;
  no_shows: Numeric;
  reschedules: Numeric;
  cancellation_rate: Numeric;
  no_show_rate: Numeric;
  new_customers: Numeric;
  returning_customers: Numeric;
  average_lead_time_hours: Numeric;
  average_duration_minutes: Numeric;
  revenue_amount: Numeric;
  currency: string;
}

/**
 * `confirmed` counts RESCHEDULED alongside CONFIRMED because RESCHEDULED *is*
 * confirmed — it is the status a confirmed booking takes once it has been moved
 * (see the appointments table definition). Counting only the literal value would
 * report a workspace that reschedules a lot as one that confirms very little.
 *
 * `reschedules` sums the per-appointment counter rather than counting rows in
 * reschedule_history, so a booking moved three times contributes three, and the
 * figure obeys the same location and staff filters as everything beside it.
 *
 * "New" means new to the workspace, not new to the filtered slice: the first
 * appointment is looked up across the customer's whole history here, so someone
 * who has been coming for years but visited this branch for the first time is
 * correctly counted as returning.
 */
const OVERVIEW_SQL = `
  WITH${BOUNDS_CTE},${SCOPED_CTE},
  lifetime AS (
    SELECT a.customer_id, MIN(a.starts_at) AS first_at
    FROM appointments a
    WHERE a.business_id = $businessId
      AND a.customer_id IN (SELECT customer_id FROM scoped WHERE customer_id IS NOT NULL)
    GROUP BY a.customer_id
  ),
  customer_split AS (
    SELECT
      COUNT(*) FILTER (WHERE l.first_at >= b.from_ts)::int AS new_customers,
      COUNT(*) FILTER (WHERE l.first_at <  b.from_ts)::int AS returning_customers
    FROM lifetime l
    CROSS JOIN bounds b
  ),
  totals AS (
    SELECT
      COUNT(*)::int                                                       AS total_bookings,
      COUNT(*) FILTER (WHERE s.status IN ('CONFIRMED', 'RESCHEDULED'))::int AS confirmed,
      COUNT(*) FILTER (WHERE s.status = 'COMPLETED')::int                 AS completed,
      COUNT(*) FILTER (WHERE s.status = 'CANCELLED')::int                 AS cancelled,
      COUNT(*) FILTER (WHERE s.status = 'NO_SHOW')::int                   AS no_shows,
      COALESCE(SUM(s.reschedule_count), 0)::bigint                        AS reschedules,
      COALESCE(AVG(EXTRACT(EPOCH FROM (s.starts_at - s.created_at)) / 3600.0), 0)::float8
                                                                          AS average_lead_time_hours,
      COALESCE(AVG(s.duration_minutes), 0)::float8                        AS average_duration_minutes,
      COALESCE(SUM(s.price_amount) FILTER (WHERE s.status = 'COMPLETED'), 0)::bigint
                                                                          AS revenue_amount
    FROM scoped s
  )
  SELECT
    t.total_bookings,
    t.confirmed,
    t.completed,
    t.cancelled,
    t.no_shows,
    t.reschedules,
    t.average_lead_time_hours,
    t.average_duration_minutes,
    t.revenue_amount,
    cs.new_customers,
    cs.returning_customers,
    biz.currency,
    COALESCE(t.cancelled::float8 / NULLIF(t.total_bookings, 0), 0)          AS cancellation_rate,
    COALESCE(t.no_shows::float8 / NULLIF(t.completed + t.no_shows, 0), 0)   AS no_show_rate
  FROM totals t
  CROSS JOIN customer_split cs
  CROSS JOIN (
    SELECT currency FROM businesses WHERE id = $businessId AND deleted_at IS NULL
  ) biz`;

export async function overview(
  businessId: string,
  timezone: string,
  query: AnalyticsRangeQuery,
): Promise<AnalyticsOverview> {
  const rows = await sequelize.query<OverviewRow>(OVERVIEW_SQL, {
    type: QueryTypes.SELECT,
    bind: scopeBind(businessId, timezone, query),
  });

  const row = rows[0];
  // The cross join with `businesses` is what can eliminate the row, and only if
  // the workspace vanished between tenant resolution and this query.
  if (!row) throw new NotFoundError('Workspace');

  return {
    totalBookings: toNumber(row.total_bookings),
    confirmed: toNumber(row.confirmed),
    completed: toNumber(row.completed),
    cancelled: toNumber(row.cancelled),
    noShows: toNumber(row.no_shows),
    reschedules: toNumber(row.reschedules),
    cancellationRate: round(toNumber(row.cancellation_rate), RATE_DECIMALS),
    noShowRate: round(toNumber(row.no_show_rate), RATE_DECIMALS),
    newCustomers: toNumber(row.new_customers),
    returningCustomers: toNumber(row.returning_customers),
    averageLeadTimeHours: round(toNumber(row.average_lead_time_hours), AVERAGE_DECIMALS),
    averageDurationMinutes: round(toNumber(row.average_duration_minutes), AVERAGE_DECIMALS),
    revenueAmount: toNumber(row.revenue_amount),
    currency: row.currency,
  };
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

export interface TrendBucket {
  date: string;
  bookings: number;
  completed: number;
  cancelled: number;
  revenue: number;
}

interface TrendRow {
  date: string;
  bookings: Numeric;
  completed: Numeric;
  cancelled: Numeric;
  revenue: Numeric;
}

/**
 * `to_char` rather than a bare `date`: node-postgres materialises a `date`
 * column as a JavaScript Date at the *server's* local midnight, which is a
 * different calendar day for anyone west of Greenwich. The bucket label is a
 * calendar date, so it leaves the database as text and stays one.
 */
const TRENDS_SQL = `
  WITH${BOUNDS_CTE},${DAYS_CTE},${SCOPED_CTE},
  bucketed AS (
    SELECT
      (s.starts_at AT TIME ZONE $tz::text)::date                        AS bucket,
      COUNT(*)::int                                                     AS bookings,
      COUNT(*) FILTER (WHERE s.status = 'COMPLETED')::int               AS completed,
      COUNT(*) FILTER (WHERE s.status = 'CANCELLED')::int               AS cancelled,
      COALESCE(SUM(s.price_amount) FILTER (WHERE s.status = 'COMPLETED'), 0)::bigint AS revenue
    FROM scoped s
    GROUP BY 1
  )
  SELECT
    to_char(d.bucket, 'YYYY-MM-DD')     AS date,
    COALESCE(b.bookings, 0)::int        AS bookings,
    COALESCE(b.completed, 0)::int       AS completed,
    COALESCE(b.cancelled, 0)::int       AS cancelled,
    COALESCE(b.revenue, 0)::bigint      AS revenue
  FROM days d
  LEFT JOIN bucketed b ON b.bucket = d.bucket
  ORDER BY d.bucket ASC`;

export async function trends(
  businessId: string,
  timezone: string,
  query: AnalyticsRangeQuery,
): Promise<TrendBucket[]> {
  const rows = await sequelize.query<TrendRow>(TRENDS_SQL, {
    type: QueryTypes.SELECT,
    bind: scopeBind(businessId, timezone, query),
  });

  return rows.map((row) => ({
    date: row.date,
    bookings: toNumber(row.bookings),
    completed: toNumber(row.completed),
    cancelled: toNumber(row.cancelled),
    revenue: toNumber(row.revenue),
  }));
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export interface StaffPerformance {
  staffProfileId: string;
  displayName: string;
  appointments: number;
  completed: number;
  noShows: number;
  bookedMinutes: number;
  workingMinutes: number;
  utilisationRate: number;
  revenue: number;
}

interface StaffRow {
  staff_profile_id: string;
  display_name: string;
  appointments: Numeric;
  completed: Numeric;
  no_shows: Numeric;
  booked_minutes: Numeric;
  working_minutes: Numeric;
  utilisation_rate: Numeric;
  revenue: Numeric;
}

/**
 * Utilisation is booked minutes over the minutes the provider was actually
 * available to be booked.
 *
 * The denominator starts as the weekly availability rules that were in force on
 * each day of the window — `effective_from`/`effective_to` are what make a rota
 * change mid-period come out right instead of retroactively rewriting last
 * month's utilisation. A rule with no location applies wherever the member
 * works, so it survives a location filter.
 *
 * The rota on its own is not availability, though, and treating it as such is
 * how this figure used to lie: a provider on a week's approved leave still
 * counted as fully rostered, so their utilisation read close to zero and the
 * report suggested idleness where there was absence. Three sources of genuine
 * unavailability are therefore subtracted, all of them the same rows the
 * scheduling engine refuses to sell against:
 *
 *   - **leave and other date exceptions** — `availability_overrides` with
 *     `is_available = false`, at STAFF scope for this provider and at BUSINESS
 *     or LOCATION scope for the site they work at, since a closed branch takes
 *     everybody with it;
 *   - **holidays that close the business**, workspace-wide (`location_id IS
 *     NULL`) or scoped to that site, including the recurring ones matched on
 *     month and day;
 *   - **blackout periods** overlapping the window, at BUSINESS, STAFF or
 *     LOCATION scope.
 *
 * The site is `COALESCE($locationId, staff_profiles.default_location_id)`,
 * which is how booking and the availability search resolve it too — anything
 * else would scope holidays to a branch nobody is being booked into.
 *
 * Staff with no appointments still appear, at 0%: an idle provider is the single
 * most interesting row on this report, and an inner join would hide them.
 */
const STAFF_SQL = `
  WITH${BOUNDS_CTE},${DAYS_CTE},${SCOPED_CTE},
  booked AS (
    SELECT
      s.staff_profile_id,
      COUNT(*)::int                                                        AS appointments,
      COUNT(*) FILTER (WHERE s.status = 'COMPLETED')::int                  AS completed,
      COUNT(*) FILTER (WHERE s.status = 'NO_SHOW')::int                    AS no_shows,
      COALESCE(SUM(s.duration_minutes) FILTER (WHERE s.${OCCUPIED_SQL}), 0)::bigint AS booked_minutes,
      COALESCE(SUM(s.price_amount) FILTER (WHERE s.status = 'COMPLETED'), 0)::bigint AS revenue
    FROM scoped s
    WHERE s.staff_profile_id IS NOT NULL
    GROUP BY s.staff_profile_id
  ),
  windows AS (
    SELECT
      r.staff_profile_id                          AS owner_id,
      tstzrange(${wallClock('d.bucket', 'r.start_minute')},
                ${wallClock('d.bucket', 'r.end_minute')}) AS span
    FROM days d
    JOIN staff_availability_rules r
      ON r.business_id = $businessId
     AND r.is_active
     AND r.day_of_week = EXTRACT(DOW FROM d.bucket)::int
     AND (r.effective_from IS NULL OR r.effective_from <= d.bucket)
     AND (r.effective_to   IS NULL OR r.effective_to   >= d.bucket)
     AND ($locationId::uuid IS NULL OR r.location_id IS NULL OR r.location_id = $locationId::uuid)
     AND ($staffProfileId::uuid IS NULL OR r.staff_profile_id = $staffProfileId::uuid)
  ),
  -- The branch each provider's day is read at, resolved exactly as booking
  -- resolves it: the filtered location when there is one, otherwise the
  -- provider's own default. A closure at another branch must not reach them.
  staff_scope AS (
    SELECT sp.id                                               AS staff_profile_id,
           COALESCE($locationId::uuid, sp.default_location_id) AS location_id
    FROM staff_profiles sp
    WHERE sp.business_id = $businessId
      AND ($staffProfileId::uuid IS NULL OR sp.id = $staffProfileId::uuid)
  ),
  unavailable AS (
    SELECT ss.staff_profile_id AS owner_id, ${wholeDay('d.bucket')} AS span
    FROM days d
    CROSS JOIN staff_scope ss
    JOIN holidays h
      ON h.business_id = $businessId
     AND h.is_active
     AND h.closes_business
     AND (h.location_id IS NULL OR h.location_id = ss.location_id)
     AND CASE WHEN h.is_recurring_annually
              -- A recurring holiday records the first year it was observed and
              -- matches on month and day in every year after it.
              THEN to_char(h.date, 'MM-DD') = to_char(d.bucket, 'MM-DD')
              ELSE h.date = d.bucket
         END
    UNION ALL
    -- A removal with no window at all is a whole day gone — leave, sickness, an
    -- unscheduled closure — which is why the minute columns fall back to the
    -- full day here, exactly as \`applyOverrides\` reads them.
    SELECT ss.staff_profile_id,
           tstzrange(${wallClock('d.bucket', 'COALESCE(o.start_minute, 0)')},
                     ${wallClock('d.bucket', 'COALESCE(o.end_minute, 1440)')})
    FROM days d
    CROSS JOIN staff_scope ss
    JOIN availability_overrides o
      ON o.business_id = $businessId
     AND NOT o.is_available
     AND o.date = d.bucket
     AND (
       (o.scope = 'STAFF' AND o.staff_profile_id = ss.staff_profile_id)
       OR o.scope = 'BUSINESS'
       OR (o.scope = 'LOCATION' AND o.location_id = ss.location_id)
     )
    UNION ALL
    -- Blackouts are absolute instants already, so nothing has to be resolved.
    -- The bounds test is what keeps the scan off a workspace's whole history.
    SELECT ss.staff_profile_id, tstzrange(bp.starts_at, bp.ends_at)
    FROM staff_scope ss
    CROSS JOIN bounds b
    JOIN blackout_periods bp
      ON bp.business_id = $businessId
     AND bp.starts_at < b.to_ts
     AND bp.ends_at   > b.from_ts
     AND (
       bp.scope = 'BUSINESS'
       OR (bp.scope = 'STAFF' AND bp.staff_profile_id = ss.staff_profile_id)
       OR (bp.scope = 'LOCATION' AND bp.location_id = ss.location_id)
     )
  ),
  working AS (${NET_WINDOW_MINUTES_SQL}
  )
  SELECT
    sp.id                                    AS staff_profile_id,
    sp.display_name,
    COALESCE(b.appointments, 0)::int         AS appointments,
    COALESCE(b.completed, 0)::int            AS completed,
    COALESCE(b.no_shows, 0)::int             AS no_shows,
    COALESCE(b.booked_minutes, 0)::bigint    AS booked_minutes,
    COALESCE(w.minutes, 0)::bigint           AS working_minutes,
    COALESCE(b.revenue, 0)::bigint           AS revenue,
    COALESCE(b.booked_minutes::float8 / NULLIF(w.minutes, 0), 0) AS utilisation_rate
  FROM staff_profiles sp
  LEFT JOIN booked  b ON b.staff_profile_id = sp.id
  LEFT JOIN working w ON w.owner_id         = sp.id
  WHERE sp.business_id = $businessId
    AND ($staffProfileId::uuid IS NULL OR sp.id = $staffProfileId::uuid)
    -- A departed provider is soft-deleted but still owns the appointments they
    -- ran, so they stay on the report for any period they actually worked.
    AND (sp.deleted_at IS NULL OR EXISTS (SELECT 1 FROM booked x WHERE x.staff_profile_id = sp.id))
  ORDER BY appointments DESC, sp.display_name ASC`;

export async function staffPerformance(
  businessId: string,
  timezone: string,
  query: AnalyticsRangeQuery,
): Promise<StaffPerformance[]> {
  const rows = await sequelize.query<StaffRow>(STAFF_SQL, {
    type: QueryTypes.SELECT,
    bind: scopeBind(businessId, timezone, query),
  });

  return rows.map((row) => ({
    staffProfileId: row.staff_profile_id,
    displayName: row.display_name,
    appointments: toNumber(row.appointments),
    completed: toNumber(row.completed),
    noShows: toNumber(row.no_shows),
    bookedMinutes: toNumber(row.booked_minutes),
    workingMinutes: toNumber(row.working_minutes),
    utilisationRate: round(toNumber(row.utilisation_rate), RATE_DECIMALS),
    revenue: toNumber(row.revenue),
  }));
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface ServicePerformance {
  serviceId: string;
  name: string;
  bookings: number;
  completed: number;
  cancelled: number;
  revenue: number;
  averageDurationMinutes: number;
}

interface ServiceRow {
  service_id: string;
  name: string;
  bookings: Numeric;
  completed: Numeric;
  cancelled: Numeric;
  revenue: Numeric;
  average_duration_minutes: Numeric;
}

/**
 * The average duration is taken from the appointments, not from the service's
 * configured `duration_minutes`: a service whose length was overridden at
 * booking time should report what was actually delivered.
 */
const SERVICES_SQL = `
  WITH${BOUNDS_CTE},${SCOPED_CTE}
  SELECT
    sv.id                                                             AS service_id,
    sv.name,
    COUNT(s.id)::int                                                  AS bookings,
    COUNT(s.id) FILTER (WHERE s.status = 'COMPLETED')::int            AS completed,
    COUNT(s.id) FILTER (WHERE s.status = 'CANCELLED')::int            AS cancelled,
    COALESCE(SUM(s.price_amount) FILTER (WHERE s.status = 'COMPLETED'), 0)::bigint AS revenue,
    COALESCE(AVG(s.duration_minutes), 0)::float8                      AS average_duration_minutes
  FROM services sv
  LEFT JOIN scoped s ON s.service_id = sv.id
  WHERE sv.business_id = $businessId
    -- A retired service keeps its line for any period it was still being sold.
    AND (sv.deleted_at IS NULL OR EXISTS (SELECT 1 FROM scoped x WHERE x.service_id = sv.id))
  GROUP BY sv.id, sv.name
  ORDER BY bookings DESC, sv.name ASC`;

export async function servicePerformance(
  businessId: string,
  timezone: string,
  query: AnalyticsRangeQuery,
): Promise<ServicePerformance[]> {
  const rows = await sequelize.query<ServiceRow>(SERVICES_SQL, {
    type: QueryTypes.SELECT,
    bind: scopeBind(businessId, timezone, query),
  });

  return rows.map((row) => ({
    serviceId: row.service_id,
    name: row.name,
    bookings: toNumber(row.bookings),
    completed: toNumber(row.completed),
    cancelled: toNumber(row.cancelled),
    revenue: toNumber(row.revenue),
    averageDurationMinutes: round(toNumber(row.average_duration_minutes), AVERAGE_DECIMALS),
  }));
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface LocationPerformance {
  locationId: string;
  name: string;
  bookings: number;
  bookedMinutes: number;
  openMinutes: number;
  utilisationRate: number;
}

interface LocationRow {
  location_id: string;
  name: string;
  bookings: Numeric;
  booked_minutes: Numeric;
  open_minutes: Numeric;
  utilisation_rate: Numeric;
}

/**
 * A location's denominator is the hours it was genuinely open.
 *
 * business_hours rows carrying a `location_id` replace the workspace-wide rows
 * for that branch entirely rather than adding to them — that is the rule the
 * availability engine follows, and utilisation has to divide by the same hours
 * the engine was willing to sell. Days the branch was shut are then taken back
 * out, from the same three sources as the staff report: holidays it observes,
 * BUSINESS- and LOCATION-scoped overrides that remove time, and blackouts.
 * STAFF-scoped rows are deliberately absent — one provider's leave does not
 * close a site, and counting it as though it did would credit a branch with
 * being shut every time somebody took a day off.
 *
 * Wall-clock minutes are resolved in the branch's own timezone rather than the
 * workspace's, because that is the zone its opening hours were authored in;
 * `locations.timezone` exists for exactly this reason.
 *
 * Appointments with no location (a virtual booking, say) are absent from this
 * breakdown by construction: they belong to no branch's day.
 */
const LOCATIONS_SQL = `
  WITH${BOUNDS_CTE},${DAYS_CTE},${SCOPED_CTE},
  booked AS (
    SELECT
      s.location_id,
      COUNT(*)::int AS bookings,
      COALESCE(SUM(s.duration_minutes) FILTER (WHERE s.${OCCUPIED_SQL}), 0)::bigint AS booked_minutes
    FROM scoped s
    WHERE s.location_id IS NOT NULL
    GROUP BY s.location_id
  ),
  branch_hours AS (
    SELECT DISTINCT location_id
    FROM business_hours
    WHERE business_id = $businessId AND is_active AND location_id IS NOT NULL
  ),
  branches AS (
    SELECT l.id, l.timezone
    FROM locations l
    WHERE l.business_id = $businessId
      AND l.deleted_at IS NULL
      AND ($locationId::uuid IS NULL OR l.id = $locationId::uuid)
  ),
  windows AS (
    SELECT
      l.id                                     AS owner_id,
      tstzrange(${wallClock('d.bucket', 'h.start_minute', 'l.timezone')},
                ${wallClock('d.bucket', 'h.end_minute', 'l.timezone')}) AS span
    FROM branches l
    CROSS JOIN days d
    JOIN business_hours h
      ON h.business_id = $businessId
     AND h.is_active
     AND h.day_of_week = EXTRACT(DOW FROM d.bucket)::int
     AND (
       CASE WHEN l.id IN (SELECT location_id FROM branch_hours)
            THEN h.location_id = l.id
            ELSE h.location_id IS NULL
       END
     )
  ),
  unavailable AS (
    SELECT l.id AS owner_id, ${wholeDay('d.bucket', 'l.timezone')} AS span
    FROM days d
    CROSS JOIN branches l
    JOIN holidays h
      ON h.business_id = $businessId
     AND h.is_active
     AND h.closes_business
     AND (h.location_id IS NULL OR h.location_id = l.id)
     AND CASE WHEN h.is_recurring_annually
              THEN to_char(h.date, 'MM-DD') = to_char(d.bucket, 'MM-DD')
              ELSE h.date = d.bucket
         END
    UNION ALL
    SELECT l.id,
           tstzrange(${wallClock('d.bucket', 'COALESCE(o.start_minute, 0)', 'l.timezone')},
                     ${wallClock('d.bucket', 'COALESCE(o.end_minute, 1440)', 'l.timezone')})
    FROM days d
    CROSS JOIN branches l
    JOIN availability_overrides o
      ON o.business_id = $businessId
     AND NOT o.is_available
     AND o.date = d.bucket
     AND (o.scope = 'BUSINESS' OR (o.scope = 'LOCATION' AND o.location_id = l.id))
    UNION ALL
    SELECT l.id, tstzrange(bp.starts_at, bp.ends_at)
    FROM branches l
    CROSS JOIN bounds b
    JOIN blackout_periods bp
      ON bp.business_id = $businessId
     AND bp.starts_at < b.to_ts
     AND bp.ends_at   > b.from_ts
     AND (bp.scope = 'BUSINESS' OR (bp.scope = 'LOCATION' AND bp.location_id = l.id))
  ),
  open_time AS (${NET_WINDOW_MINUTES_SQL}
  )
  SELECT
    l.id                                     AS location_id,
    l.name,
    COALESCE(b.bookings, 0)::int             AS bookings,
    COALESCE(b.booked_minutes, 0)::bigint    AS booked_minutes,
    COALESCE(o.minutes, 0)::bigint           AS open_minutes,
    COALESCE(b.booked_minutes::float8 / NULLIF(o.minutes, 0), 0) AS utilisation_rate
  FROM locations l
  LEFT JOIN booked    b ON b.location_id = l.id
  LEFT JOIN open_time o ON o.owner_id    = l.id
  WHERE l.business_id = $businessId
    AND ($locationId::uuid IS NULL OR l.id = $locationId::uuid)
    AND (l.deleted_at IS NULL OR EXISTS (SELECT 1 FROM booked x WHERE x.location_id = l.id))
  ORDER BY bookings DESC, l.name ASC`;

export async function locationPerformance(
  businessId: string,
  timezone: string,
  query: AnalyticsRangeQuery,
): Promise<LocationPerformance[]> {
  const rows = await sequelize.query<LocationRow>(LOCATIONS_SQL, {
    type: QueryTypes.SELECT,
    bind: scopeBind(businessId, timezone, query),
  });

  return rows.map((row) => ({
    locationId: row.location_id,
    name: row.name,
    bookings: toNumber(row.bookings),
    bookedMinutes: toNumber(row.booked_minutes),
    openMinutes: toNumber(row.open_minutes),
    utilisationRate: round(toNumber(row.utilisation_rate), RATE_DECIMALS),
  }));
}

// ---------------------------------------------------------------------------
// Peak times
// ---------------------------------------------------------------------------

export interface PeakTimeBucket {
  /** Sunday = 0 … Saturday = 6, matching `day_of_week` everywhere else. */
  weekday: number;
  /** Hour of the local day, 0–23. */
  hour: number;
  bookings: number;
}

interface PeakTimeRow {
  weekday: Numeric;
  hour: Numeric;
  bookings: Numeric;
}

/**
 * "Tuesday at 2pm" is a wall-clock fact, so both parts are extracted after the
 * instant has been converted into the workspace's zone. Doing this in UTC would
 * shift every bucket by the offset and split one busy afternoon across two
 * columns of the heatmap — and move the split twice a year with DST.
 *
 * Only observed buckets are returned. An hour with no bookings has nothing to
 * report, and emitting the full 168-cell grid would mean inventing the zeros.
 */
const PEAK_TIMES_SQL = `
  WITH${BOUNDS_CTE},${SCOPED_CTE}
  SELECT
    EXTRACT(DOW  FROM (s.starts_at AT TIME ZONE $tz::text))::int AS weekday,
    EXTRACT(HOUR FROM (s.starts_at AT TIME ZONE $tz::text))::int AS hour,
    COUNT(*)::int                                                AS bookings
  FROM scoped s
  GROUP BY 1, 2
  ORDER BY 1 ASC, 2 ASC`;

export async function peakTimes(
  businessId: string,
  timezone: string,
  query: AnalyticsRangeQuery,
): Promise<PeakTimeBucket[]> {
  const rows = await sequelize.query<PeakTimeRow>(PEAK_TIMES_SQL, {
    type: QueryTypes.SELECT,
    bind: scopeBind(businessId, timezone, query),
  });

  return rows.map((row) => ({
    weekday: toNumber(row.weekday),
    hour: toNumber(row.hour),
    bookings: toNumber(row.bookings),
  }));
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface TopCustomer {
  customerId: string;
  publicId: string;
  name: string;
  appointments: number;
  completed: number;
  revenue: number;
}

export interface CustomerAnalytics {
  activeCustomers: number;
  repeatCustomers: number;
  repeatRate: number;
  newVsReturning: { new: number; returning: number };
  topCustomers: TopCustomer[];
}

interface CustomerSummaryRow {
  active_customers: Numeric;
  repeat_customers: Numeric;
  new_customers: Numeric;
  returning_customers: Numeric;
  repeat_rate: Numeric;
}

interface TopCustomerRow {
  customer_id: string;
  public_id: string;
  name: string;
  appointments: Numeric;
  completed: Numeric;
  revenue: Numeric;
}

/**
 * Loyalty is a lifetime property, measured on the customers seen in the window.
 *
 * `repeatRate` is the share of those customers who have booked with the
 * workspace more than once *ever*, not more than once inside the window —
 * otherwise every report over a short period would claim the business has no
 * repeat custom at all. `newVsReturning` splits the same population by whether
 * their very first appointment falls inside the window.
 */
const CUSTOMER_SUMMARY_SQL = `
  WITH${BOUNDS_CTE},${SCOPED_CTE},
  lifetime AS (
    SELECT a.customer_id,
           COUNT(*)::int      AS lifetime_bookings,
           MIN(a.starts_at)   AS first_at
    FROM appointments a
    WHERE a.business_id = $businessId
      AND a.customer_id IN (SELECT customer_id FROM scoped WHERE customer_id IS NOT NULL)
    GROUP BY a.customer_id
  ),
  summary AS (
    SELECT
      COUNT(*)::int                                                 AS active_customers,
      COUNT(*) FILTER (WHERE l.lifetime_bookings > 1)::int          AS repeat_customers,
      COUNT(*) FILTER (WHERE l.first_at >= b.from_ts)::int          AS new_customers,
      COUNT(*) FILTER (WHERE l.first_at <  b.from_ts)::int          AS returning_customers
    FROM lifetime l
    CROSS JOIN bounds b
  )
  SELECT
    active_customers,
    repeat_customers,
    new_customers,
    returning_customers,
    COALESCE(repeat_customers::float8 / NULLIF(active_customers, 0), 0) AS repeat_rate
  FROM summary`;

/**
 * Ranked by completed appointments, which is the spec: attendance is what a
 * "top customer" table is being asked about, not bookings made and abandoned.
 *
 * The row carries a display name and the customer's public handle, and stops
 * there. Contact details are governed by `customers:read`, which this endpoint
 * does not require, so an analytics dashboard must not become a way around it.
 */
const TOP_CUSTOMERS_SQL = `
  WITH${BOUNDS_CTE},${SCOPED_CTE}
  SELECT
    c.id                                                              AS customer_id,
    c.public_id,
    TRIM(CONCAT_WS(' ', c.first_name, c.last_name))                   AS name,
    COUNT(*)::int                                                     AS appointments,
    COUNT(*) FILTER (WHERE s.status = 'COMPLETED')::int               AS completed,
    COALESCE(SUM(s.price_amount) FILTER (WHERE s.status = 'COMPLETED'), 0)::bigint AS revenue
  FROM scoped s
  JOIN customers c ON c.id = s.customer_id AND c.business_id = $businessId
  GROUP BY c.id, c.public_id, c.first_name, c.last_name
  ORDER BY completed DESC, appointments DESC, name ASC
  LIMIT $topLimit::int`;

export async function customerAnalytics(
  businessId: string,
  timezone: string,
  query: AnalyticsRangeQuery,
): Promise<CustomerAnalytics> {
  const bind = scopeBind(businessId, timezone, query);

  const [summaryRows, topRows] = await Promise.all([
    sequelize.query<CustomerSummaryRow>(CUSTOMER_SUMMARY_SQL, {
      type: QueryTypes.SELECT,
      bind,
    }),
    sequelize.query<TopCustomerRow>(TOP_CUSTOMERS_SQL, {
      type: QueryTypes.SELECT,
      bind: { ...bind, topLimit: TOP_CUSTOMERS },
    }),
  ]);

  const summary = summaryRows[0];

  return {
    // An aggregate with no GROUP BY always yields a row; the fallbacks exist so
    // the mapping is total rather than because the row can be missing.
    activeCustomers: toNumber(summary?.active_customers ?? 0),
    repeatCustomers: toNumber(summary?.repeat_customers ?? 0),
    repeatRate: round(toNumber(summary?.repeat_rate ?? 0), RATE_DECIMALS),
    newVsReturning: {
      new: toNumber(summary?.new_customers ?? 0),
      returning: toNumber(summary?.returning_customers ?? 0),
    },
    topCustomers: topRows.map((row) => ({
      customerId: row.customer_id,
      publicId: row.public_id,
      name: row.name,
      appointments: toNumber(row.appointments),
      completed: toNumber(row.completed),
      revenue: toNumber(row.revenue),
    })),
  };
}
