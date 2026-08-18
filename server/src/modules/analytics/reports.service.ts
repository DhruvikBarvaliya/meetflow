/**
 * Operational reports.
 *
 * Where analytics answers "how did the month go", a report answers "show me the
 * rows". One flat table, one set of filters, two renderings — JSON for the
 * screen and CSV for the download — built from the same SQL so an export always
 * reproduces the table it was launched from.
 *
 * The same rules as analytics.service.ts apply: `businessId` is bound into every
 * statement, no client value is ever concatenated into SQL, and calendar dates
 * are resolved against the workspace's clock inside PostgreSQL.
 *
 * The export is bounded three ways, because "download everything" is exactly the
 * request that turns a report endpoint into an outage:
 *
 *  - a hard cap of 50,000 rows;
 *  - keyset pagination, so the query is an index range scan at row 50,000 just
 *    as it was at row 1, instead of an OFFSET that re-reads everything before it;
 *  - batched delivery that respects socket backpressure, so a slow client cannot
 *    make the process buffer the whole file in memory.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database';
import type { AppointmentSource, AppointmentStatus } from '../../database/models/Appointment';
import { assertRangeWithinCap } from './range';
import { type Numeric, toNumber } from './sql';
import type { AppointmentExportQuery, AppointmentReportQuery } from './reports.validation';

/** The most rows one CSV export may contain. */
export const CSV_MAX_ROWS = 50_000;

/**
 * Rows fetched per round trip while streaming.
 *
 * Large enough that a 50,000-row export is fifty queries rather than fifty
 * thousand, small enough that only a few hundred kilobytes are ever resident.
 */
const CSV_BATCH_ROWS = 1_000;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface AppointmentReportRow {
  bookingReference: string;
  status: AppointmentStatus;
  /** The instant, in UTC, to the second. */
  startsAt: string;
  endsAt: string;
  /** The same instant on the workspace's own clock — what an operator recognises. */
  startsAtLocal: string;
  /** The zone `startsAtLocal` is rendered in, so the CSV is self-describing. */
  timezone: string;
  durationMinutes: number;
  service: string | null;
  staff: string | null;
  location: string | null;
  customerName: string | null;
  customerEmail: string | null;
  priceAmount: number;
  currency: string;
  source: AppointmentSource;
  rescheduleCount: number;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  noShowAt: string | null;
  cancellationReason: string | null;
}

interface RawReportRow {
  booking_reference: string;
  status: AppointmentStatus;
  starts_at: string;
  ends_at: string;
  starts_at_local: string;
  duration_minutes: Numeric;
  service: string | null;
  staff: string | null;
  location: string | null;
  customer_name: string | null;
  customer_email: string | null;
  price_amount: Numeric;
  currency: string;
  source: AppointmentSource;
  reschedule_count: Numeric;
  created_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  no_show_at: string | null;
  cancellation_reason: string | null;
}

/** The streaming query carries the keyset cursor alongside the row. */
interface RawExportRow extends RawReportRow {
  cursor_id: string;
  cursor_starts_at: string;
}

function toReportRow(raw: RawReportRow, timezone: string): AppointmentReportRow {
  return {
    bookingReference: raw.booking_reference,
    status: raw.status,
    startsAt: raw.starts_at,
    endsAt: raw.ends_at,
    startsAtLocal: raw.starts_at_local,
    timezone,
    durationMinutes: toNumber(raw.duration_minutes),
    service: raw.service,
    staff: raw.staff,
    location: raw.location,
    customerName: raw.customer_name,
    customerEmail: raw.customer_email,
    priceAmount: toNumber(raw.price_amount),
    currency: raw.currency,
    source: raw.source,
    rescheduleCount: toNumber(raw.reschedule_count),
    createdAt: raw.created_at,
    completedAt: raw.completed_at,
    cancelledAt: raw.cancelled_at,
    noShowAt: raw.no_show_at,
    cancellationReason: raw.cancellation_reason,
  };
}

/**
 * The CSV layout, defined next to the row it renders so the two cannot drift.
 * Order is the column order in the file; changing it changes every consumer's
 * spreadsheet, so it is append-only in practice.
 */
export const CSV_COLUMNS: ReadonlyArray<{
  header: string;
  value: (row: AppointmentReportRow) => string | number | null;
}> = [
  { header: 'Booking reference', value: (row) => row.bookingReference },
  { header: 'Status', value: (row) => row.status },
  { header: 'Starts at (UTC)', value: (row) => row.startsAt },
  { header: 'Ends at (UTC)', value: (row) => row.endsAt },
  { header: 'Starts at (local)', value: (row) => row.startsAtLocal },
  { header: 'Timezone', value: (row) => row.timezone },
  { header: 'Duration (minutes)', value: (row) => row.durationMinutes },
  { header: 'Service', value: (row) => row.service },
  { header: 'Staff', value: (row) => row.staff },
  { header: 'Location', value: (row) => row.location },
  { header: 'Customer', value: (row) => row.customerName },
  { header: 'Customer email', value: (row) => row.customerEmail },
  { header: 'Price amount', value: (row) => row.priceAmount },
  { header: 'Currency', value: (row) => row.currency },
  { header: 'Source', value: (row) => row.source },
  { header: 'Reschedules', value: (row) => row.rescheduleCount },
  { header: 'Booked at (UTC)', value: (row) => row.createdAt },
  { header: 'Completed at (UTC)', value: (row) => row.completedAt },
  { header: 'Cancelled at (UTC)', value: (row) => row.cancelledAt },
  { header: 'No-show at (UTC)', value: (row) => row.noShowAt },
  { header: 'Cancellation reason', value: (row) => row.cancellationReason },
];

// ---------------------------------------------------------------------------
// Bind parameters
// ---------------------------------------------------------------------------

/** Everything a client may narrow the report by. */
export interface AppointmentReportFilters {
  from?: string;
  to?: string;
  status?: AppointmentStatus[];
  serviceId?: string;
  staffProfileId?: string;
  locationId?: string;
}

/**
 * A plain object type, not an interface, so it satisfies Sequelize's
 * index-signature bind type. Every key is always present: a named bind left
 * `undefined` is a driver error, so "unfiltered" has to be an explicit NULL the
 * SQL tests for.
 */
type FilterBind = {
  businessId: string;
  tz: string;
  fromDate: string | null;
  toDate: string | null;
  status: string[] | null;
  serviceId: string | null;
  staffProfileId: string | null;
  locationId: string | null;
};

function filterBind(
  businessId: string,
  timezone: string,
  filters: AppointmentReportFilters,
): FilterBind {
  // Only a *complete* range can be checked against the cap; a half-open filter
  // is bounded by pagination and the export row limit instead.
  if (filters.from !== undefined && filters.to !== undefined) {
    assertRangeWithinCap(filters.from, filters.to);
  }

  return {
    businessId,
    tz: timezone,
    fromDate: filters.from ?? null,
    toDate: filters.to ?? null,
    status: filters.status ?? null,
    serviceId: filters.serviceId ?? null,
    staffProfileId: filters.staffProfileId ?? null,
    locationId: filters.locationId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared SQL
// ---------------------------------------------------------------------------

/**
 * Every filter is a bind parameter tested against NULL rather than a clause
 * appended to a string, so the statement is a constant: there is no code path
 * on which client input can become SQL, and PostgreSQL sees one plan-cacheable
 * query instead of one per filter combination.
 *
 * `to` is inclusive as a calendar date and exclusive as an instant — the day
 * after it, at local midnight, which is DST-proof in a way that adding 24 hours
 * is not.
 */
const FILTER_SQL = `
    a.business_id = $businessId
    AND ($fromDate::text IS NULL
         OR a.starts_at >= (($fromDate::text::date)::timestamp AT TIME ZONE $tz::text))
    AND ($toDate::text IS NULL
         OR a.starts_at <  (($toDate::text::date + 1)::timestamp AT TIME ZONE $tz::text))
    AND ($status::text[] IS NULL OR a.status = ANY($status::text[]))
    AND ($serviceId::uuid IS NULL OR a.service_id = $serviceId::uuid)
    AND ($staffProfileId::uuid IS NULL OR a.staff_profile_id = $staffProfileId::uuid)
    AND ($locationId::uuid IS NULL OR a.location_id = $locationId::uuid)`;

/**
 * Timestamps are formatted by PostgreSQL rather than handed over as `Date`
 * objects: the driver's date parsing depends on the process timezone, and a
 * report whose column means something different on a developer's laptop than in
 * production is not a report. NULL columns stay NULL — `to_char` propagates it.
 *
 * The joins are all LEFT and none filters on `deleted_at`: an appointment that
 * was delivered by a provider who has since left, at a branch that has since
 * closed, is exactly the row a historical report exists to show.
 */
const COLUMNS_SQL = `
    a.public_id                                                            AS booking_reference,
    a.status,
    to_char(a.starts_at    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
    to_char(a.ends_at      AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
    to_char(a.starts_at    AT TIME ZONE $tz::text, 'YYYY-MM-DD HH24:MI')     AS starts_at_local,
    a.duration_minutes,
    sv.name                                                                AS service,
    sp.display_name                                                        AS staff,
    l.name                                                                 AS location,
    NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '')            AS customer_name,
    c.email::text                                                          AS customer_email,
    a.price_amount,
    a.currency,
    a.source,
    a.reschedule_count,
    to_char(a.created_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
    to_char(a.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS completed_at,
    to_char(a.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cancelled_at,
    to_char(a.no_show_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS no_show_at,
    a.cancellation_reason`;

const JOINS_SQL = `
  FROM appointments a
  LEFT JOIN services       sv ON sv.id = a.service_id
  LEFT JOIN staff_profiles sp ON sp.id = a.staff_profile_id
  LEFT JOIN locations      l  ON l.id  = a.location_id
  LEFT JOIN customers      c  ON c.id  = a.customer_id`;

const COUNT_SQL = `
  SELECT COUNT(*)::bigint AS total
  FROM appointments a
  WHERE${FILTER_SQL}`;

const PAGE_SQL = `
  SELECT${COLUMNS_SQL}
  ${JOINS_SQL}
  WHERE${FILTER_SQL}
  ORDER BY a.starts_at DESC, a.id DESC
  LIMIT $pageLimit::int OFFSET $pageOffset::int`;

/**
 * Keyset pagination on `(starts_at, id)`.
 *
 * The row comparison walks `appointments_business_start_idx` forward from wherever
 * the previous batch stopped, so the hundredth batch costs the same as the first.
 * The cursor travels as microsecond-precision text rather than as a `Date`,
 * because a JavaScript Date only holds milliseconds and rounding the cursor
 * would silently skip or repeat rows that share a minute.
 */
const EXPORT_SQL = `
  SELECT${COLUMNS_SQL},
    a.id                                                                   AS cursor_id,
    to_char(a.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US"+00"') AS cursor_starts_at
  ${JOINS_SQL}
  WHERE${FILTER_SQL}
    AND ($cursorStartsAt::text IS NULL
         OR (a.starts_at, a.id) > ($cursorStartsAt::text::timestamptz, $cursorId::text::uuid))
  ORDER BY a.starts_at ASC, a.id ASC
  LIMIT $batchSize::int`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface AppointmentReportPage {
  rows: AppointmentReportRow[];
  totalItems: number;
}

/** How many rows the filters match in total, ignoring pagination. */
export async function countAppointmentReport(
  businessId: string,
  timezone: string,
  filters: AppointmentReportFilters,
): Promise<number> {
  const rows = await sequelize.query<{ total: Numeric }>(COUNT_SQL, {
    type: QueryTypes.SELECT,
    bind: filterBind(businessId, timezone, filters),
  });
  return toNumber(rows[0]?.total ?? 0);
}

export async function appointmentReport(
  businessId: string,
  timezone: string,
  query: AppointmentReportQuery,
): Promise<AppointmentReportPage> {
  const bind = filterBind(businessId, timezone, query);

  const [rows, totals] = await Promise.all([
    sequelize.query<RawReportRow>(PAGE_SQL, {
      type: QueryTypes.SELECT,
      bind: {
        ...bind,
        pageLimit: query.pageSize,
        pageOffset: (query.page - 1) * query.pageSize,
      },
    }),
    sequelize.query<{ total: Numeric }>(COUNT_SQL, { type: QueryTypes.SELECT, bind }),
  ]);

  return {
    rows: rows.map((row) => toReportRow(row, timezone)),
    totalItems: toNumber(totals[0]?.total ?? 0),
  };
}

/**
 * Yields the export in batches, oldest first, stopping at `CSV_MAX_ROWS`.
 *
 * A generator rather than an array: the caller writes each batch to the socket
 * and only then asks for the next one, which is what keeps the memory cost of a
 * 50,000-row export flat.
 */
export async function* streamAppointmentReport(
  businessId: string,
  timezone: string,
  filters: AppointmentExportQuery,
): AsyncGenerator<AppointmentReportRow[], void, undefined> {
  const bind = filterBind(businessId, timezone, filters);
  let cursor: { startsAt: string; id: string } | null = null;
  let emitted = 0;

  while (emitted < CSV_MAX_ROWS) {
    const batchSize = Math.min(CSV_BATCH_ROWS, CSV_MAX_ROWS - emitted);

    // Annotated rather than inferred: `cursor` is written from these rows and
    // read back into the next query's binds, and without a declared type here
    // the compiler chases that loop round and gives up.
    const rows: RawExportRow[] = await sequelize.query<RawExportRow>(EXPORT_SQL, {
      type: QueryTypes.SELECT,
      bind: {
        ...bind,
        cursorStartsAt: cursor?.startsAt ?? null,
        cursorId: cursor?.id ?? null,
        batchSize,
      },
    });

    const last = rows.at(-1);
    if (last === undefined) return;

    yield rows.map((row) => toReportRow(row, timezone));

    emitted += rows.length;
    // A short batch means the index scan reached the end of the matches.
    if (rows.length < batchSize) return;

    cursor = { startsAt: last.cursor_starts_at, id: last.cursor_id };
  }
}
