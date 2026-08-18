/**
 * Reading a workspace's own audit trail.
 *
 * The read side lives here rather than in audit.service.ts because that file
 * makes one promise — the trail is append-only, and inside a transaction a
 * failed audit insert fails the change it describes — and folding queries into
 * it would blur what its header guarantees. Nothing below writes a row.
 *
 * One invariant governs every statement in this file: **the caller's
 * `businessId` is bound into the query, always, and never comes from the
 * request.** Two consequences follow, and both are load-bearing:
 *
 *  1. Another tenant's rows cannot be reached. A single entry is fetched by
 *     `id` AND `business_id`, so an id belonging to somebody else's workspace
 *     matches nothing and answers 404 — never a 403, which would confirm the row
 *     exists and turn this endpoint into an existence oracle.
 *  2. Platform-level rows never appear. `audit_logs.business_id` is NULL for
 *     events that belong to the deployment rather than to any tenant (a sign-in,
 *     a suspension by a platform operator), and `l.business_id = $businessId` is
 *     UNKNOWN — never true — for those rows. The exclusion is the tenant
 *     predicate itself; no second clause is needed and none should be added.
 *
 * Two things this file deliberately does not do:
 *
 *  - **It does not join.** `actorLabel`, `entityType` and `entityId` are
 *    denormalised snapshots of what was true when the entry was written, which
 *    is exactly why the trail still reads correctly after the user or the
 *    booking it describes has been deleted. Resolving them against the live
 *    tables would rewrite history every time somebody changed their name.
 *  - **It does not filter `metadata`.** `sanitiseMetadata` in audit.service.ts
 *    strips secrets and bounds string length on the way *in*, so what is stored
 *    is already safe to hand back; redacting again on the way out would only
 *    withhold the context the trail exists to provide.
 *
 * The SQL idiom is admin.service.ts's, for the same reasons: nothing a caller
 * sends is ever concatenated into a statement, every filter is a bind tested
 * against NULL, and search terms arrive as bound patterns with their LIKE
 * wildcards already escaped.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database';
import type { AuditActorType } from '../../database/models/AuditLog';
import { NotFoundError } from '../../utils/errors';
import { type Numeric, toNumber } from '../analytics/sql';
import type { ExportAuditEntriesQuery, ListAuditEntriesQuery } from './audit.validation';

/** The most rows one CSV export may contain. */
export const CSV_MAX_ROWS = 50_000;

/**
 * Rows fetched per round trip while streaming, matching reports.service.ts:
 * large enough that a full export is fifty queries rather than fifty thousand,
 * small enough that only a few hundred kilobytes are ever resident.
 */
const CSV_BATCH_ROWS = 1_000;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One entry as a tenant sees it.
 *
 * `businessId` is not among the fields, and its absence is deliberate: every row
 * this module can return belongs to the caller's own workspace, so echoing the
 * id back would imply the feed could ever contain anything else.
 */
export interface AuditEntry {
  id: string;
  /** Who acted: a member, a customer booking publicly, the system, an API key. */
  actorType: AuditActorType;
  /** Nulls out when the account behind the entry is deleted — see `actorLabel`. */
  actorUserId: string | null;
  actorCustomerId: string | null;
  /** The snapshot that survives that deletion, e.g. "priya@example.com". */
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Correlates the entry with the HTTP request and its application logs. */
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

/**
 * The single-entry and export shape. It differs from a list row by one column:
 * `userAgent` is long, repetitive and near-useless twenty rows at a time, but it
 * is exactly what an investigation into one entry wants.
 */
export interface AuditEntryDetail extends AuditEntry {
  userAgent: string | null;
}

export interface AuditEntryPage {
  rows: AuditEntry[];
  page: number;
  pageSize: number;
  totalItems: number;
}

interface AuditRow {
  id: string;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  actor_customer_id: string | null;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
  ip_address: string | null;
  created_at: Date;
  metadata: Record<string, unknown> | null;
}

interface AuditDetailRow extends AuditRow {
  user_agent: string | null;
}

/** The streaming query carries the keyset cursor alongside the row. */
interface AuditExportRow extends AuditDetailRow {
  cursor_created_at: string;
}

/** timestamptz columns arrive as Date; the API speaks ISO 8601 throughout. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    actorCustomerId: row.actor_customer_id,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    requestId: row.request_id,
    ipAddress: row.ip_address,
    createdAt: toIso(row.created_at),
    // The column is NOT NULL with a `{}` default, but a JSONB `null` literal
    // would still arrive as null and break a client that spreads it.
    metadata: row.metadata ?? {},
  };
}

function toDetail(row: AuditDetailRow): AuditEntryDetail {
  return { ...toEntry(row), userAgent: row.user_agent };
}

// ---------------------------------------------------------------------------
// Bind parameters
// ---------------------------------------------------------------------------

/**
 * `%` and `_` are wildcards to LIKE, so an unescaped search for "%" would match
 * every entry in the workspace instead of the one being looked for. The escaped
 * term is passed as a bind and never concatenated, so the pattern is data in
 * both senses. Backslash is LIKE's default escape character, which is why the
 * statements below need no `ESCAPE` clause.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
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
  action: string | null;
  entityType: string | null;
  entityId: string | null;
  actorUserId: string | null;
  from: string | null;
  to: string | null;
  search: string | null;
};

function filterBind(
  businessId: string,
  timezone: string,
  filters: ExportAuditEntriesQuery,
): FilterBind {
  return {
    businessId,
    tz: timezone,
    action: filters.action ?? null,
    entityType: filters.entityType ?? null,
    entityId: filters.entityId ?? null,
    actorUserId: filters.actorUserId ?? null,
    from: filters.from ?? null,
    to: filters.to ?? null,
    search: filters.search ? `%${escapeLike(filters.search)}%` : null,
  };
}

// ---------------------------------------------------------------------------
// Shared SQL
// ---------------------------------------------------------------------------

/**
 * The tenant predicate leads, and it is a plain equality against a NOT NULL bind
 * rather than an `IS NOT DISTINCT FROM`: that is precisely what excludes the
 * platform-level rows described in the file header.
 *
 * `from`/`to` are inclusive calendar days cut on the *workspace's* clock, not in
 * UTC as on the platform surface. A workspace asking what happened on 3 March
 * means their 3 March; the zone is bound rather than left to the session, so the
 * boundary of a day cannot depend on how a connection happens to be configured.
 * Adding a day and taking a half-open upper bound keeps the whole of the closing
 * day inside the range, and stays correct across a DST change in a way that
 * adding twenty-four hours would not.
 *
 * The search clause covers the three columns a person actually scans: the actor
 * snapshot, the verb and the entity type. `metadata` is deliberately not
 * searched — a JSONB scan over the fastest-growing table in the schema is an
 * unindexed read of everything, and the filters above are the supported way to
 * narrow down to one entity.
 */
const FILTER_SQL = `
    l.business_id = $businessId::uuid
    AND ($action::text IS NULL OR l.action = $action::text)
    AND ($entityType::text IS NULL OR l.entity_type = $entityType::text)
    AND ($entityId::uuid IS NULL OR l.entity_id = $entityId::uuid)
    AND ($actorUserId::uuid IS NULL OR l.actor_user_id = $actorUserId::uuid)
    AND ($from::text IS NULL
         OR l.created_at >= (($from::text::date)::timestamp AT TIME ZONE $tz::text))
    AND ($to::text IS NULL
         OR l.created_at < (($to::text::date + 1)::timestamp AT TIME ZONE $tz::text))
    AND ($search::text IS NULL
         OR l.actor_label ILIKE $search::text
         OR l.action ILIKE $search::text
         OR l.entity_type ILIKE $search::text)`;

const LIST_COLUMNS_SQL = `
    l.id, l.actor_type, l.actor_user_id, l.actor_customer_id, l.actor_label,
    l.action, l.entity_type, l.entity_id, l.request_id, l.ip_address,
    l.created_at, l.metadata`;

const DETAIL_COLUMNS_SQL = `${LIST_COLUMNS_SQL}, l.user_agent`;

/**
 * Newest first, tie-broken by id so the ordering is total: entries written by
 * one transaction share `created_at` to the microsecond, and without the
 * tie-break a row could appear on both page one and page two. The direction
 * matches `audit_logs_business_created_idx (business_id, created_at DESC)`.
 */
const PAGE_SQL = `
  SELECT${LIST_COLUMNS_SQL}
  FROM audit_logs l
  WHERE${FILTER_SQL}
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT $limit::int OFFSET $offset::int`;

const COUNT_SQL = `
  SELECT count(*) AS total_items
  FROM audit_logs l
  WHERE${FILTER_SQL}`;

/**
 * Both predicates, in one statement, on purpose. Fetching by id and *then*
 * comparing the tenant in TypeScript would work right up until somebody added
 * an early return above the check; making the workspace part of the lookup means
 * the only answer another tenant's id can produce is "no row".
 */
const ENTRY_SQL = `
  SELECT${DETAIL_COLUMNS_SQL}
  FROM audit_logs l
  WHERE l.business_id = $businessId::uuid AND l.id = $id::uuid`;

/**
 * Keyset pagination on `(created_at, id)`, descending like the list, so the file
 * reads in the same order as the screen it was launched from and the walk stays
 * on the same index.
 *
 * The cursor travels as microsecond-precision text rather than as a `Date`,
 * because a JavaScript Date only holds milliseconds and rounding the cursor
 * would silently skip or repeat entries written within the same millisecond —
 * which, for the rows one transaction inserts together, is the common case
 * rather than the corner one.
 */
const EXPORT_SQL = `
  SELECT${DETAIL_COLUMNS_SQL},
    to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US"+00"') AS cursor_created_at
  FROM audit_logs l
  WHERE${FILTER_SQL}
    AND ($cursorCreatedAt::text IS NULL
         OR (l.created_at, l.id) < ($cursorCreatedAt::text::timestamptz, $cursorId::text::uuid))
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT $batchSize::int`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listAuditEntries(
  businessId: string,
  timezone: string,
  query: ListAuditEntriesQuery,
): Promise<AuditEntryPage> {
  const bind = filterBind(businessId, timezone, query);

  const [rows, totals] = await Promise.all([
    sequelize.query<AuditRow>(PAGE_SQL, {
      type: QueryTypes.SELECT,
      bind: { ...bind, limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
    }),
    sequelize.query<{ total_items: Numeric }>(COUNT_SQL, { type: QueryTypes.SELECT, bind }),
  ]);

  return {
    rows: rows.map(toEntry),
    page: query.page,
    pageSize: query.pageSize,
    totalItems: toNumber(totals[0]?.total_items ?? 0),
  };
}

/**
 * One entry in full.
 *
 * A `NotFoundError` covers three cases with one indistinguishable answer: the
 * entry does not exist, it belongs to another workspace, or it is a
 * platform-level row. Telling them apart would leak exactly what the tenant
 * boundary exists to hide.
 */
export async function getAuditEntry(businessId: string, id: string): Promise<AuditEntryDetail> {
  const rows = await sequelize.query<AuditDetailRow>(ENTRY_SQL, {
    type: QueryTypes.SELECT,
    bind: { businessId, id },
  });

  const row = rows[0];
  if (!row) throw new NotFoundError('Audit entry');
  return toDetail(row);
}

/** How many entries the filters match in total, ignoring pagination. */
export async function countAuditEntries(
  businessId: string,
  timezone: string,
  filters: ExportAuditEntriesQuery,
): Promise<number> {
  const rows = await sequelize.query<{ total_items: Numeric }>(COUNT_SQL, {
    type: QueryTypes.SELECT,
    bind: filterBind(businessId, timezone, filters),
  });
  return toNumber(rows[0]?.total_items ?? 0);
}

/**
 * Yields the export in batches, newest first, stopping at `CSV_MAX_ROWS`.
 *
 * A generator rather than an array: the caller writes each batch to the socket
 * and only then asks for the next one, which is what keeps the memory cost of a
 * 50,000-row export flat.
 */
export async function* streamAuditEntries(
  businessId: string,
  timezone: string,
  filters: ExportAuditEntriesQuery,
): AsyncGenerator<AuditEntryDetail[], void, undefined> {
  const bind = filterBind(businessId, timezone, filters);
  let cursor: { createdAt: string; id: string } | null = null;
  let emitted = 0;

  while (emitted < CSV_MAX_ROWS) {
    const batchSize = Math.min(CSV_BATCH_ROWS, CSV_MAX_ROWS - emitted);

    // Annotated rather than inferred: `cursor` is written from these rows and
    // read back into the next query's binds, and without a declared type here
    // the compiler chases that loop round and gives up.
    const rows: AuditExportRow[] = await sequelize.query<AuditExportRow>(EXPORT_SQL, {
      type: QueryTypes.SELECT,
      bind: {
        ...bind,
        cursorCreatedAt: cursor?.createdAt ?? null,
        cursorId: cursor?.id ?? null,
        batchSize,
      },
    });

    const last = rows.at(-1);
    if (last === undefined) return;

    yield rows.map(toDetail);

    emitted += rows.length;
    // A short batch means the index scan reached the end of the matches.
    if (rows.length < batchSize) return;

    cursor = { createdAt: last.cursor_created_at, id: last.id };
  }
}

/**
 * The CSV layout, defined next to the row it renders so the two cannot drift.
 * Order is the column order in the file; changing it changes every consumer's
 * spreadsheet, so it is append-only in practice.
 *
 * `metadata` is serialised whole rather than flattened into columns — it is
 * shaped differently for every action — and it is safe to emit because
 * `sanitiseMetadata` redacted it on the way in, before it was ever stored.
 */
export const CSV_COLUMNS: ReadonlyArray<{
  header: string;
  value: (row: AuditEntryDetail) => string | number | null;
}> = [
  { header: 'Recorded at (UTC)', value: (row) => row.createdAt },
  { header: 'Action', value: (row) => row.action },
  { header: 'Entity type', value: (row) => row.entityType },
  { header: 'Entity id', value: (row) => row.entityId },
  { header: 'Actor', value: (row) => row.actorLabel },
  { header: 'Actor type', value: (row) => row.actorType },
  { header: 'Actor user id', value: (row) => row.actorUserId },
  { header: 'Actor customer id', value: (row) => row.actorCustomerId },
  { header: 'IP address', value: (row) => row.ipAddress },
  { header: 'User agent', value: (row) => row.userAgent },
  { header: 'Request id', value: (row) => row.requestId },
  { header: 'Entry id', value: (row) => row.id },
  { header: 'Metadata (JSON)', value: (row) => JSON.stringify(row.metadata) },
];
