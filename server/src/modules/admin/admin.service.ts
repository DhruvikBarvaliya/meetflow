/**
 * Platform administration.
 *
 * This module answers one question — "how is the platform itself doing?" — for
 * an operator who is not a member of any of the workspaces they can see. That
 * makes it the only service in MeetFlow that reads across tenants, and two
 * rules follow from it.
 *
 * **1. The privacy boundary is the shape of the response, not a filter.**
 * This surface exposes workspaces, platform user accounts, and counts. It never
 * exposes customer PII (names, emails, phone numbers), appointment contents, or
 * notes. Someone running the platform has no business reading a clinic's
 * patient list; a support ticket about a double booking is answered by the
 * workspace's own owner, not by an operator browsing the diary. Every response
 * is therefore assembled by a builder that names each field it emits, so a
 * column added to `customers` or `appointments` tomorrow cannot arrive in an
 * admin payload by accident — it has to be typed out here first, where the
 * decision is visible in review.
 *
 * **2. Aggregates are computed by PostgreSQL, one statement per page.**
 * Six counts across a page of twenty workspaces is one query with scalar
 * subqueries and a LATERAL join, never twenty round trips. The idiom, and the
 * bind-parameter discipline behind it, is the one analytics.service.ts sets
 * out: nothing a caller sends is ever concatenated into SQL, and search terms
 * arrive as bound patterns with their LIKE wildcards already escaped.
 *
 * Soft deletes: `businesses`, `users`, `memberships`, `customers`, `services`,
 * `locations` and `staff_profiles` are all paranoid. Every count in this file
 * excludes soft-deleted rows, because the question an operator is asking is
 * "what does this workspace have now", not "what has it ever had". Appointments
 * are the exception and are counted in full — that table has no soft delete at
 * all, since a cancelled booking keeps its row as history.
 */
import { Op, QueryTypes, type Transaction } from 'sequelize';
import { databaseHealth, sequelize } from '../../config/database';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { redisHealth } from '../../config/redis';
import { Business, RefreshToken, User } from '../../database/models';
import type { AuditActorType } from '../../database/models/AuditLog';
import type { BusinessStatus } from '../../database/models/Business';
import type { PlatformRole, UserStatus } from '../../database/models/User';
import { ConflictError, ErrorCode, NotFoundError } from '../../utils/errors';
import { type Numeric, toNumber } from '../analytics/sql';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import type {
  ListAuditLogsQuery,
  ListUsersQuery,
  ListWorkspacesQuery,
  UpdatePlatformRoleBody,
  UpdateUserStatusBody,
  UpdateWorkspaceStatusBody,
} from './admin.validation';

const log = createLogger('admin');

/** How many days the overview's booking series covers, inclusive of today. */
const BOOKINGS_BY_DAY_WINDOW = 14;

/** How many workspaces the overview leaderboard returns. */
const TOP_WORKSPACES = 5;

/** How many audit rows a workspace's detail view carries. */
const WORKSPACE_ACTIVITY_LIMIT = 20;

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface AdminActor {
  userId: string;
  email: string;
}

export interface AdminOverview {
  workspaces: {
    total: number;
    active: number;
    suspended: number;
    archived: number;
    createdLast30Days: number;
  };
  users: {
    total: number;
    active: number;
    invited: number;
    suspended: number;
    deactivated: number;
    admins: number;
    createdLast30Days: number;
  };
  appointments: {
    total: number;
    upcoming: number;
    last30Days: number;
    cancelledLast30Days: number;
  };
  customers: { total: number };
  bookingsByDay: Array<{ date: string; count: number }>;
  topWorkspaces: Array<{
    businessId: string;
    name: string;
    slug: string;
    status: BusinessStatus;
    appointmentsLast30Days: number;
  }>;
  generatedAt: string;
}

export interface AdminWorkspaceOwner {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface AdminWorkspaceCounts {
  members: number;
  staff: number;
  services: number;
  locations: number;
  appointments: number;
  customers: number;
}

export interface AdminWorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  status: BusinessStatus;
  timezone: string;
  currency: string;
  industry: string | null;
  owner: AdminWorkspaceOwner | null;
  counts: AdminWorkspaceCounts;
  lastAppointmentAt: string | null;
  createdAt: string;
}

export interface AdminWorkspaceMember {
  membershipId: string;
  status: string;
  roleKey: string;
  roleName: string;
  joinedAt: string | null;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    status: UserStatus;
    platformRole: PlatformRole;
  };
}

export interface AdminWorkspaceActivity {
  id: string;
  action: string;
  entityType: string;
  actorLabel: string | null;
  createdAt: string;
}

export interface AdminWorkspaceDetail extends AdminWorkspaceSummary {
  legalName: string | null;
  description: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  locale: string;
  members: AdminWorkspaceMember[];
  appointmentsByStatus: Array<{ status: string; count: number }>;
  recentActivity: AdminWorkspaceActivity[];
}

export interface AdminUserSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  platformRole: PlatformRole;
  status: UserStatus;
  emailVerified: boolean;
  lastLoginAt: string | null;
  workspaceCount: number;
  ownedWorkspaceCount: number;
  createdAt: string;
}

export interface AdminUserMembership {
  membershipId: string;
  businessId: string;
  businessName: string;
  businessSlug: string;
  businessStatus: BusinessStatus;
  roleKey: string;
  roleName: string;
  status: string;
  joinedAt: string | null;
  isOwner: boolean;
}

export interface AdminUserDetail extends AdminUserSummary {
  phone: string | null;
  timezone: string;
  locale: string;
  lockedUntil: string | null;
  failedLoginCount: number;
  activeSessionCount: number;
  memberships: AdminUserMembership[];
}

export interface AdminAuditEntry {
  id: string;
  businessId: string | null;
  businessName: string | null;
  actorType: AuditActorType;
  actorLabel: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface AdminHealth {
  database: { ok: boolean; latencyMs: number; error: string | null };
  redis: { ok: boolean; latencyMs: number; error: string | null };
  outbox: {
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    cancelled: number;
    dueNow: number;
    oldestPendingAgeSeconds: number | null;
  };
  api: { environment: string; node: string; uptimeSeconds: number; apiVersion: 'v1' };
  generatedAt: string;
}

/** The page shape every list endpoint on this surface hands to `sendPage`. */
export interface AdminPage<T> {
  rows: T[];
  page: number;
  pageSize: number;
  totalItems: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * `%` and `_` are wildcards to LIKE, so an unescaped search of "%" would match
 * every row on the platform instead of the one the operator is looking for. The
 * escaped term is passed as a bind and never concatenated, so the pattern is
 * data in both senses. Backslash is LIKE's default escape character, which is
 * why the statements below need no `ESCAPE` clause.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function likePattern(term: string | undefined): string | null {
  return term ? `%${escapeLike(term)}%` : null;
}

/** timestamptz columns arrive as Date; the API speaks ISO 8601 throughout. */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The non-null form, for columns the schema declares NOT NULL. A row that
 * somehow arrived without one is a database bug, and answering with the epoch
 * would hide it, so this throws rather than guessing.
 */
function toRequiredIso(value: Date | string | null): string {
  const iso = toIso(value);
  if (iso === null) throw new Error('Expected a non-null timestamp column.');
  return iso;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

interface WorkspaceTotalsRow {
  total: Numeric;
  active: Numeric;
  suspended: Numeric;
  archived: Numeric;
  created_last_30_days: Numeric;
}

interface UserTotalsRow {
  total: Numeric;
  active: Numeric;
  invited: Numeric;
  suspended: Numeric;
  deactivated: Numeric;
  admins: Numeric;
  created_last_30_days: Numeric;
}

interface VolumeTotalsRow {
  appointments_total: Numeric;
  appointments_upcoming: Numeric;
  appointments_last_30_days: Numeric;
  appointments_cancelled_last_30_days: Numeric;
  customers_total: Numeric;
}

interface BookingsByDayRow {
  date: string;
  count: Numeric;
}

interface TopWorkspaceRow {
  business_id: string;
  name: string;
  slug: string;
  status: BusinessStatus;
  appointments_last_30_days: Numeric;
}

const WORKSPACE_TOTALS_SQL = `
  SELECT count(*)                                                          AS total,
         count(*) FILTER (WHERE b.status = 'ACTIVE')                       AS active,
         count(*) FILTER (WHERE b.status = 'SUSPENDED')                    AS suspended,
         count(*) FILTER (WHERE b.status = 'ARCHIVED')                     AS archived,
         count(*) FILTER (WHERE b.created_at >= now() - interval '30 days') AS created_last_30_days
  FROM businesses b
  WHERE b.deleted_at IS NULL`;

const USER_TOTALS_SQL = `
  SELECT count(*)                                                          AS total,
         count(*) FILTER (WHERE u.status = 'ACTIVE')                       AS active,
         count(*) FILTER (WHERE u.status = 'INVITED')                      AS invited,
         count(*) FILTER (WHERE u.status = 'SUSPENDED')                    AS suspended,
         count(*) FILTER (WHERE u.status = 'DEACTIVATED')                  AS deactivated,
         count(*) FILTER (WHERE u.platform_role = 'ADMIN')                 AS admins,
         count(*) FILTER (WHERE u.created_at >= now() - interval '30 days') AS created_last_30_days
  FROM users u
  WHERE u.deleted_at IS NULL`;

/**
 * `upcoming` counts only the statuses that still occupy a calendar: a booking
 * cancelled last week is not something anyone is turning up for, and counting
 * it would make an idle platform look busy.
 *
 * The two "last 30 days" figures are cut on `created_at`, not `starts_at`.
 * This is a measure of platform activity — how much was booked, and how much of
 * it was then called off — rather than of how full next month's diary is.
 */
const VOLUME_TOTALS_SQL = `
  SELECT (SELECT count(*) FROM appointments)                                       AS appointments_total,
         (SELECT count(*) FROM appointments
           WHERE starts_at >= now()
             AND status IN ('PENDING', 'CONFIRMED', 'RESCHEDULED', 'IN_PROGRESS')) AS appointments_upcoming,
         (SELECT count(*) FROM appointments
           WHERE created_at >= now() - interval '30 days')                         AS appointments_last_30_days,
         (SELECT count(*) FROM appointments
           WHERE status = 'CANCELLED'
             AND created_at >= now() - interval '30 days')                         AS appointments_cancelled_last_30_days,
         (SELECT count(*) FROM customers WHERE deleted_at IS NULL)                 AS customers_total`;

/**
 * Bookings per UTC day over a fixed window, zero-filled.
 *
 * UTC rather than any workspace's own zone: this series spans every tenant at
 * once, so there is no single local clock to cut the days on, and an operator
 * comparing today's figure with yesterday's needs the two buckets to be the
 * same length. `generate_series` supplies every day in the window, so a quiet
 * Saturday is a zero and not a gap and the client never has to reason about
 * missing keys.
 */
const BOOKINGS_BY_DAY_SQL = `
  WITH bounds AS (
    SELECT date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $windowDays - 1) AS from_day,
           date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'                       AS to_day
  ),
  days AS (
    SELECT generate_series(b.from_day, b.to_day - interval '1 day', interval '1 day')::date AS bucket
    FROM bounds b
  ),
  booked AS (
    SELECT (a.created_at AT TIME ZONE 'UTC')::date AS bucket, count(*) AS count
    FROM appointments a
    CROSS JOIN bounds b
    WHERE a.created_at >= b.from_day AT TIME ZONE 'UTC'
      AND a.created_at <  b.to_day   AT TIME ZONE 'UTC'
    GROUP BY 1
  )
  SELECT to_char(d.bucket, 'YYYY-MM-DD') AS date,
         COALESCE(k.count, 0)            AS count
  FROM days d
  LEFT JOIN booked k ON k.bucket = d.bucket
  ORDER BY d.bucket ASC`;

/**
 * The busiest workspaces of the last thirty days. Soft-deleted workspaces are
 * excluded; suspended and archived ones are not. A workspace that was busy right
 * up to the moment it was suspended is exactly what an operator wants to see.
 */
const TOP_WORKSPACES_SQL = `
  SELECT b.id AS business_id, b.name, b.slug, b.status,
         count(a.id) AS appointments_last_30_days
  FROM businesses b
  LEFT JOIN appointments a
    ON a.business_id = b.id
   AND a.created_at >= now() - interval '30 days'
  WHERE b.deleted_at IS NULL
  GROUP BY b.id, b.name, b.slug, b.status
  ORDER BY appointments_last_30_days DESC, b.name ASC
  LIMIT $limit`;

export async function getOverview(): Promise<AdminOverview> {
  // Five independent aggregates over four tables. Issued together because none
  // depends on another's result, and the panel is only as fresh as its slowest
  // query either way.
  const [workspaceRows, userRows, volumeRows, bookingRows, topRows] = await Promise.all([
    sequelize.query<WorkspaceTotalsRow>(WORKSPACE_TOTALS_SQL, { type: QueryTypes.SELECT }),
    sequelize.query<UserTotalsRow>(USER_TOTALS_SQL, { type: QueryTypes.SELECT }),
    sequelize.query<VolumeTotalsRow>(VOLUME_TOTALS_SQL, { type: QueryTypes.SELECT }),
    sequelize.query<BookingsByDayRow>(BOOKINGS_BY_DAY_SQL, {
      type: QueryTypes.SELECT,
      bind: { windowDays: BOOKINGS_BY_DAY_WINDOW },
    }),
    sequelize.query<TopWorkspaceRow>(TOP_WORKSPACES_SQL, {
      type: QueryTypes.SELECT,
      bind: { limit: TOP_WORKSPACES },
    }),
  ]);

  const workspaces = workspaceRows[0];
  const users = userRows[0];
  const volume = volumeRows[0];

  // An aggregate with no GROUP BY always returns exactly one row, so a missing
  // one means the query did not run as written rather than that the platform is
  // empty. Answering with zeros would present that as a healthy, quiet system.
  if (!workspaces || !users || !volume) {
    throw new Error('Platform overview aggregates returned no row.');
  }

  return {
    workspaces: {
      total: toNumber(workspaces.total),
      active: toNumber(workspaces.active),
      suspended: toNumber(workspaces.suspended),
      archived: toNumber(workspaces.archived),
      createdLast30Days: toNumber(workspaces.created_last_30_days),
    },
    users: {
      total: toNumber(users.total),
      active: toNumber(users.active),
      invited: toNumber(users.invited),
      suspended: toNumber(users.suspended),
      deactivated: toNumber(users.deactivated),
      admins: toNumber(users.admins),
      createdLast30Days: toNumber(users.created_last_30_days),
    },
    appointments: {
      total: toNumber(volume.appointments_total),
      upcoming: toNumber(volume.appointments_upcoming),
      last30Days: toNumber(volume.appointments_last_30_days),
      cancelledLast30Days: toNumber(volume.appointments_cancelled_last_30_days),
    },
    customers: { total: toNumber(volume.customers_total) },
    bookingsByDay: bookingRows.map((row) => ({ date: row.date, count: toNumber(row.count) })),
    topWorkspaces: topRows.map((row) => ({
      businessId: row.business_id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      appointmentsLast30Days: toNumber(row.appointments_last_30_days),
    })),
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

interface WorkspaceSummaryRow {
  id: string;
  name: string;
  slug: string;
  status: BusinessStatus;
  timezone: string;
  currency: string;
  industry: string | null;
  created_at: Date;
  owner_id: string | null;
  owner_email: string | null;
  owner_first_name: string | null;
  owner_last_name: string | null;
  members: Numeric;
  staff: Numeric;
  services: Numeric;
  locations: Numeric;
  appointments: Numeric;
  customers: Numeric;
  last_appointment_at: Date | null;
}

interface WorkspaceDetailRow extends WorkspaceSummaryRow {
  legal_name: string | null;
  description: string | null;
  website_url: string | null;
  support_email: string | null;
  support_phone: string | null;
  locale: string;
}

/**
 * Counts only.
 *
 * There is no join here that returns a customer's name, an appointment's notes
 * or a service's private configuration, and there must never be one. Adding a
 * column to this list is the moment to ask whether an operator needs to read
 * it; for anything belonging to a workspace's own clients the answer is no.
 */
const WORKSPACE_SUMMARY_COLUMNS = `
  b.id, b.name, b.slug, b.status, b.timezone, b.currency, b.industry, b.created_at,
  ow.id         AS owner_id,
  ow.email      AS owner_email,
  ow.first_name AS owner_first_name,
  ow.last_name  AS owner_last_name,
  appt.appointments,
  appt.last_appointment_at,
  (SELECT count(*) FROM memberships m    WHERE m.business_id  = b.id AND m.deleted_at IS NULL)  AS members,
  (SELECT count(*) FROM staff_profiles s WHERE s.business_id  = b.id AND s.deleted_at IS NULL)  AS staff,
  (SELECT count(*) FROM services sv      WHERE sv.business_id = b.id AND sv.deleted_at IS NULL) AS services,
  (SELECT count(*) FROM locations l      WHERE l.business_id  = b.id AND l.deleted_at IS NULL)  AS locations,
  (SELECT count(*) FROM customers c      WHERE c.business_id  = b.id AND c.deleted_at IS NULL)  AS customers`;

/**
 * `last_appointment_at` is the most recent booking *taken*, not the furthest
 * date in the diary. An operator reads this column to answer "is anyone still
 * using this workspace", and a single appointment booked six months out would
 * otherwise make a dormant workspace look permanently current.
 *
 * The owner join drops a soft-deleted account rather than reporting a ghost:
 * `owner_user_id` is ON DELETE RESTRICT, so the workspace row outlives the
 * person, and `owner: null` is the honest answer once they are gone.
 */
const WORKSPACE_JOINS = `
  LEFT JOIN users ow ON ow.id = b.owner_user_id AND ow.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT count(*)          AS appointments,
           max(a.created_at) AS last_appointment_at
    FROM appointments a
    WHERE a.business_id = b.id
  ) appt ON TRUE`;

/**
 * Whitelisted ORDER BY fragments, selected by the validated `sort` enum. These
 * are constants chosen by a key, never assembled from input, so this is a
 * lookup and not an injection point.
 *
 * Every fragment ends in `b.id` so the ordering is total. Without a tiebreak,
 * two workspaces created in the same millisecond could swap places between one
 * page request and the next, and one of them would never be listed at all.
 */
const WORKSPACE_ORDER: Record<ListWorkspacesQuery['sort'], string> = {
  newest: 'b.created_at DESC, b.id DESC',
  oldest: 'b.created_at ASC, b.id ASC',
  name: 'lower(b.name) ASC, b.id ASC',
  appointments: 'appt.appointments DESC, b.created_at DESC, b.id DESC',
};

/**
 * The lateral the page selection needs *only* when it is ordering by volume.
 * Left out otherwise, so choosing a page of workspaces by date does not first
 * count every appointment on the platform.
 */
const WORKSPACE_SORT_SUPPORT: Record<ListWorkspacesQuery['sort'], string> = {
  newest: '',
  oldest: '',
  name: '',
  appointments: `
      LEFT JOIN LATERAL (
        SELECT count(*) AS appointments FROM appointments a WHERE a.business_id = b.id
      ) appt ON TRUE`,
};

const WORKSPACE_FILTER_SQL = `
      b.deleted_at IS NULL
      AND ($status::text IS NULL OR b.status = $status::text)
      AND (
        $search::text IS NULL
        OR b.name ILIKE $search::text
        OR b.slug ILIKE $search::text
      )`;

/**
 * The privacy boundary, written out.
 *
 * Constructed field by field rather than spread from the row, so a column added
 * to `businesses` — or to any table joined above — cannot leak through this
 * function without someone typing its name here first.
 */
function toWorkspaceSummary(row: WorkspaceSummaryRow): AdminWorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    timezone: row.timezone,
    currency: row.currency,
    industry: row.industry,
    owner:
      row.owner_id !== null
        ? {
            id: row.owner_id,
            // All three columns are NOT NULL on a row that exists; the fallback
            // is here only because the LEFT JOIN widens their type.
            email: row.owner_email ?? '',
            firstName: row.owner_first_name ?? '',
            lastName: row.owner_last_name ?? '',
          }
        : null,
    counts: {
      members: toNumber(row.members),
      staff: toNumber(row.staff),
      services: toNumber(row.services),
      locations: toNumber(row.locations),
      appointments: toNumber(row.appointments),
      customers: toNumber(row.customers),
    },
    lastAppointmentAt: toIso(row.last_appointment_at),
    createdAt: toRequiredIso(row.created_at),
  };
}

export async function listWorkspaces(
  query: ListWorkspacesQuery,
): Promise<AdminPage<AdminWorkspaceSummary>> {
  const bind = {
    status: query.status ?? null,
    search: likePattern(query.search),
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
  const order = WORKSPACE_ORDER[query.sort];

  // Two statements rather than one with `count(*) OVER ()`: the window would be
  // computed over every matching row before the LIMIT, which defeats the index
  // the ORDER BY exists to use. The page's ids are selected first and the six
  // counts are then computed for those rows only, never for the whole table.
  const pageSql = `
    WITH page AS (
      SELECT b.id
      FROM businesses b${WORKSPACE_SORT_SUPPORT[query.sort]}
      WHERE ${WORKSPACE_FILTER_SQL}
      ORDER BY ${order}
      LIMIT $limit OFFSET $offset
    )
    SELECT ${WORKSPACE_SUMMARY_COLUMNS}
    FROM page p
    JOIN businesses b ON b.id = p.id${WORKSPACE_JOINS}
    ORDER BY ${order}`;

  const countSql = `
    SELECT count(*) AS total_items
    FROM businesses b
    WHERE ${WORKSPACE_FILTER_SQL}`;

  const [rows, totals] = await Promise.all([
    sequelize.query<WorkspaceSummaryRow>(pageSql, { type: QueryTypes.SELECT, bind }),
    sequelize.query<{ total_items: Numeric }>(countSql, {
      type: QueryTypes.SELECT,
      // The count statement takes the filters and nothing else: a bind the SQL
      // never mentions is rejected by the driver, so the pagination values
      // cannot simply be passed along with them.
      bind: { status: bind.status, search: bind.search },
    }),
  ]);

  return {
    rows: rows.map(toWorkspaceSummary),
    page: query.page,
    pageSize: query.pageSize,
    totalItems: toNumber(totals[0]?.total_items ?? 0),
  };
}

interface WorkspaceMemberRow {
  membership_id: string;
  membership_status: string;
  role_key: string;
  role_name: string;
  joined_at: Date | null;
  user_id: string;
  email: string;
  first_name: string;
  last_name: string;
  user_status: UserStatus;
  platform_role: PlatformRole;
}

/**
 * The members of a workspace are platform *user accounts* — the people who sign
 * in and run it, and who the platform already holds an account for. They are
 * inside the boundary this module draws. The workspace's customers are not, and
 * there is deliberately no equivalent query for them anywhere in this file.
 */
const WORKSPACE_MEMBERS_SQL = `
  SELECT m.id     AS membership_id,
         m.status AS membership_status,
         r.key    AS role_key,
         r.name   AS role_name,
         m.joined_at,
         u.id     AS user_id,
         u.email, u.first_name, u.last_name,
         u.status AS user_status,
         u.platform_role
  FROM memberships m
  JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
  JOIN roles r ON r.id = m.role_id
  WHERE m.business_id = $businessId AND m.deleted_at IS NULL
  ORDER BY lower(u.last_name) ASC, lower(u.first_name) ASC, u.id ASC`;

const WORKSPACE_STATUS_BREAKDOWN_SQL = `
  SELECT a.status, count(*) AS count
  FROM appointments a
  WHERE a.business_id = $businessId
  GROUP BY a.status
  ORDER BY 2 DESC, 1 ASC`;

/**
 * The tail of this workspace's own trail: the verb, the entity type and who did
 * it. `metadata` is left out because it is written by every module in the
 * product and its contents are the workspace's business, not the platform's.
 */
const WORKSPACE_ACTIVITY_SQL = `
  SELECT l.id, l.action, l.entity_type, l.actor_label, l.created_at
  FROM audit_logs l
  WHERE l.business_id = $businessId
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT $limit`;

export async function getWorkspace(id: string): Promise<AdminWorkspaceDetail> {
  const detailSql = `
    SELECT ${WORKSPACE_SUMMARY_COLUMNS},
           b.legal_name, b.description, b.website_url, b.support_email, b.support_phone, b.locale
    FROM businesses b${WORKSPACE_JOINS}
    WHERE b.id = $businessId AND b.deleted_at IS NULL`;

  const rows = await sequelize.query<WorkspaceDetailRow>(detailSql, {
    type: QueryTypes.SELECT,
    bind: { businessId: id },
  });
  const row = rows[0];
  if (!row) throw new NotFoundError('Workspace');

  const [members, byStatus, activity] = await Promise.all([
    sequelize.query<WorkspaceMemberRow>(WORKSPACE_MEMBERS_SQL, {
      type: QueryTypes.SELECT,
      bind: { businessId: id },
    }),
    sequelize.query<{ status: string; count: Numeric }>(WORKSPACE_STATUS_BREAKDOWN_SQL, {
      type: QueryTypes.SELECT,
      bind: { businessId: id },
    }),
    sequelize.query<{
      id: string;
      action: string;
      entity_type: string;
      actor_label: string | null;
      created_at: Date;
    }>(WORKSPACE_ACTIVITY_SQL, {
      type: QueryTypes.SELECT,
      bind: { businessId: id, limit: WORKSPACE_ACTIVITY_LIMIT },
    }),
  ]);

  return {
    ...toWorkspaceSummary(row),
    legalName: row.legal_name,
    description: row.description,
    websiteUrl: row.website_url,
    supportEmail: row.support_email,
    supportPhone: row.support_phone,
    locale: row.locale,
    members: members.map((member) => ({
      membershipId: member.membership_id,
      status: member.membership_status,
      roleKey: member.role_key,
      roleName: member.role_name,
      joinedAt: toIso(member.joined_at),
      user: {
        id: member.user_id,
        email: member.email,
        firstName: member.first_name,
        lastName: member.last_name,
        status: member.user_status,
        platformRole: member.platform_role,
      },
    })),
    appointmentsByStatus: byStatus.map((entry) => ({
      status: entry.status,
      count: toNumber(entry.count),
    })),
    recentActivity: activity.map((entry) => ({
      id: entry.id,
      action: entry.action,
      entityType: entry.entity_type,
      actorLabel: entry.actor_label,
      createdAt: toRequiredIso(entry.created_at),
    })),
  };
}

export async function updateWorkspaceStatus(
  id: string,
  input: UpdateWorkspaceStatusBody,
  actor: AdminActor,
  metadata: RequestMetadata,
): Promise<AdminWorkspaceDetail> {
  await sequelize.transaction(async (transaction) => {
    // Paranoid model: a soft-deleted workspace is not administrable, and must
    // be indistinguishable from one that never existed.
    const business = await Business.findByPk(id, { transaction });
    if (!business) throw new NotFoundError('Workspace');

    const previousStatus = business.status;
    await business.update({ status: input.status }, { transaction });

    // Same transaction as the change: a workspace must never be found suspended
    // with no record of who suspended it, or why.
    await recordAudit(
      {
        businessId: business.id,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.PLATFORM_WORKSPACE_STATUS_CHANGED,
        entityType: 'business',
        entityId: business.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          before: previousStatus,
          after: input.status,
          reason: input.reason ?? null,
        },
      },
      { transaction },
    );

    log.info(
      { businessId: business.id, before: previousStatus, after: input.status },
      'workspace status changed by platform admin',
    );
  });

  // Read after commit, so the response is the state every other reader will now
  // see rather than this transaction's private view of it.
  return getWorkspace(id);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface UserSummaryRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  platform_role: PlatformRole;
  status: UserStatus;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  workspace_count: Numeric;
  owned_workspace_count: Numeric;
}

interface UserDetailRow extends UserSummaryRow {
  phone: string | null;
  timezone: string;
  locale: string;
  locked_until: Date | null;
  failed_login_count: number;
  active_session_count: Numeric;
}

/**
 * Account facts and counts. No password hash, no reset token, no verification
 * token: the `users` defaultScope excludes those from the ORM, and this raw
 * statement has to keep the same promise on its own.
 *
 * `workspace_count` ignores memberships whose workspace has been soft-deleted,
 * so it always equals the length of the `memberships` array on the detail
 * response. Two figures that disagreed would send someone hunting for a bug.
 */
const USER_SUMMARY_COLUMNS = `
  u.id, u.email, u.first_name, u.last_name, u.platform_role, u.status,
  u.email_verified_at, u.last_login_at, u.created_at,
  (SELECT count(*)
     FROM memberships m
     JOIN businesses mb ON mb.id = m.business_id AND mb.deleted_at IS NULL
    WHERE m.user_id = u.id AND m.deleted_at IS NULL)         AS workspace_count,
  (SELECT count(*)
     FROM businesses ob
    WHERE ob.owner_user_id = u.id AND ob.deleted_at IS NULL) AS owned_workspace_count`;

/**
 * `lastLogin` puts accounts that have never signed in last rather than first:
 * NULL sorts high in PostgreSQL's default descending order, so an operator
 * looking for the most recently active people would otherwise open the page on
 * a wall of accounts that have never been used at all.
 */
const USER_ORDER: Record<ListUsersQuery['sort'], string> = {
  newest: 'u.created_at DESC, u.id DESC',
  oldest: 'u.created_at ASC, u.id ASC',
  name: 'lower(u.last_name) ASC, lower(u.first_name) ASC, u.id ASC',
  lastLogin: 'u.last_login_at DESC NULLS LAST, u.id DESC',
};

/**
 * `email` is `citext`, so it is cast to text before ILIKE. Without the cast
 * PostgreSQL has no `citext ILIKE text` operator to resolve and the statement
 * fails at plan time rather than returning the wrong rows.
 */
const USER_FILTER_SQL = `
      u.deleted_at IS NULL
      AND ($status::text IS NULL OR u.status = $status::text)
      AND ($platformRole::text IS NULL OR u.platform_role = $platformRole::text)
      AND (
        $search::text IS NULL
        OR u.email::text ILIKE $search::text
        OR u.first_name ILIKE $search::text
        OR u.last_name ILIKE $search::text
      )`;

/** The privacy boundary for accounts: named fields only, same rule as above. */
function toUserSummary(row: UserSummaryRow): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`.trim(),
    platformRole: row.platform_role,
    status: row.status,
    // The timestamp itself is not published: whether the address is confirmed
    // is the fact an operator acts on.
    emailVerified: row.email_verified_at !== null,
    lastLoginAt: toIso(row.last_login_at),
    workspaceCount: toNumber(row.workspace_count),
    ownedWorkspaceCount: toNumber(row.owned_workspace_count),
    createdAt: toRequiredIso(row.created_at),
  };
}

export async function listUsers(query: ListUsersQuery): Promise<AdminPage<AdminUserSummary>> {
  const bind = {
    status: query.status ?? null,
    platformRole: query.platformRole ?? null,
    search: likePattern(query.search),
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
  const order = USER_ORDER[query.sort];

  const pageSql = `
    WITH page AS (
      SELECT u.id
      FROM users u
      WHERE ${USER_FILTER_SQL}
      ORDER BY ${order}
      LIMIT $limit OFFSET $offset
    )
    SELECT ${USER_SUMMARY_COLUMNS}
    FROM page p
    JOIN users u ON u.id = p.id
    ORDER BY ${order}`;

  const countSql = `
    SELECT count(*) AS total_items
    FROM users u
    WHERE ${USER_FILTER_SQL}`;

  const [rows, totals] = await Promise.all([
    sequelize.query<UserSummaryRow>(pageSql, { type: QueryTypes.SELECT, bind }),
    sequelize.query<{ total_items: Numeric }>(countSql, {
      type: QueryTypes.SELECT,
      bind: { status: bind.status, platformRole: bind.platformRole, search: bind.search },
    }),
  ]);

  return {
    rows: rows.map(toUserSummary),
    page: query.page,
    pageSize: query.pageSize,
    totalItems: toNumber(totals[0]?.total_items ?? 0),
  };
}

interface UserMembershipRow {
  membership_id: string;
  business_id: string;
  business_name: string;
  business_slug: string;
  business_status: BusinessStatus;
  role_key: string;
  role_name: string;
  membership_status: string;
  joined_at: Date | null;
  is_owner: boolean;
}

const USER_MEMBERSHIPS_SQL = `
  SELECT m.id     AS membership_id,
         b.id     AS business_id,
         b.name   AS business_name,
         b.slug   AS business_slug,
         b.status AS business_status,
         r.key    AS role_key,
         r.name   AS role_name,
         m.status AS membership_status,
         m.joined_at,
         (b.owner_user_id = m.user_id) AS is_owner
  FROM memberships m
  JOIN businesses b ON b.id = m.business_id AND b.deleted_at IS NULL
  JOIN roles r ON r.id = m.role_id
  WHERE m.user_id = $userId AND m.deleted_at IS NULL
  ORDER BY lower(b.name) ASC, b.id ASC`;

export async function getUser(id: string): Promise<AdminUserDetail> {
  // `active_session_count` is the number of refresh tokens that could still be
  // exchanged right now. It is what makes a suspension legible: it should read
  // zero immediately afterwards, and an operator who sees otherwise is looking
  // at a bug rather than at a stale page.
  const detailSql = `
    SELECT ${USER_SUMMARY_COLUMNS},
           u.phone, u.timezone, u.locale, u.locked_until, u.failed_login_count,
           (SELECT count(*)
              FROM refresh_tokens rt
             WHERE rt.user_id = u.id
               AND rt.revoked_at IS NULL
               AND rt.expires_at > now()) AS active_session_count
    FROM users u
    WHERE u.id = $userId AND u.deleted_at IS NULL`;

  const [rows, memberships] = await Promise.all([
    sequelize.query<UserDetailRow>(detailSql, { type: QueryTypes.SELECT, bind: { userId: id } }),
    sequelize.query<UserMembershipRow>(USER_MEMBERSHIPS_SQL, {
      type: QueryTypes.SELECT,
      bind: { userId: id },
    }),
  ]);

  const row = rows[0];
  if (!row) throw new NotFoundError('User');

  return {
    ...toUserSummary(row),
    phone: row.phone,
    timezone: row.timezone,
    locale: row.locale,
    lockedUntil: toIso(row.locked_until),
    failedLoginCount: row.failed_login_count,
    activeSessionCount: toNumber(row.active_session_count),
    memberships: memberships.map((membership) => ({
      membershipId: membership.membership_id,
      businessId: membership.business_id,
      businessName: membership.business_name,
      businessSlug: membership.business_slug,
      businessStatus: membership.business_status,
      roleKey: membership.role_key,
      roleName: membership.role_name,
      status: membership.membership_status,
      joinedAt: toIso(membership.joined_at),
      isOwner: membership.is_owner,
    })),
  };
}

/**
 * Ends every session the account still has.
 *
 * Setting `revoked_at` across the user's whole token population is what makes a
 * suspension take effect now rather than whenever a refresh token happened to
 * expire. `authenticate.ts` closes the other half of the gap: it re-reads the
 * user on every request and refuses SUSPENDED and DEACTIVATED accounts, and it
 * also counts live tokens in the session's family — so the 15-minute access
 * token already in the caller's hands dies at its very next call rather than at
 * its expiry.
 */
async function revokeAllSessions(userId: string, transaction: Transaction): Promise<number> {
  const [affected] = await RefreshToken.update(
    { revokedAt: new Date(), revokedReason: 'ADMIN_REVOKED' },
    { where: { userId, revokedAt: { [Op.is]: null } }, transaction },
  );
  return affected;
}

export async function updateUserStatus(
  id: string,
  input: UpdateUserStatusBody,
  actor: AdminActor,
  metadata: RequestMetadata,
): Promise<AdminUserDetail> {
  // An admin who suspends their own account loses access to the only surface
  // that could restore it, and nothing in the product can undo that. Refused
  // before anything else happens.
  if (id === actor.userId) {
    throw new ConflictError(
      'You cannot change your own account status. Ask another platform administrator.',
      ErrorCode.CONFLICT,
    );
  }

  await sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(id, { transaction });
    if (!user) throw new NotFoundError('User');

    const previousStatus = user.status;
    await user.update({ status: input.status }, { transaction });

    // Losing access and being recorded as having lost it are one atomic unit,
    // so the revocation happens inside this transaction rather than after it.
    const revokedSessions =
      input.status === 'SUSPENDED' || input.status === 'DEACTIVATED'
        ? await revokeAllSessions(user.id, transaction)
        : 0;

    await recordAudit(
      {
        // Platform-level event: it belongs to no single tenant, and no
        // workspace's audit feed may surface it.
        businessId: null,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.PLATFORM_USER_STATUS_CHANGED,
        entityType: 'user',
        entityId: user.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { before: previousStatus, after: input.status, revokedSessions },
      },
      { transaction },
    );

    log.info(
      { userId: user.id, before: previousStatus, after: input.status, revokedSessions },
      'user status changed by platform admin',
    );
  });

  return getUser(id);
}

export async function updatePlatformRole(
  id: string,
  input: UpdatePlatformRoleBody,
  actor: AdminActor,
  metadata: RequestMetadata,
): Promise<AdminUserDetail> {
  // Same reasoning as status: an admin who demotes themselves cannot promote
  // themselves back.
  if (id === actor.userId) {
    throw new ConflictError(
      'You cannot change your own platform role. Ask another platform administrator.',
      ErrorCode.CONFLICT,
    );
  }

  await sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(id, { transaction });
    if (!user) throw new NotFoundError('User');

    const previousRole = user.platformRole;

    if (previousRole === 'ADMIN' && input.platformRole === 'USER') {
      /*
       * Last-admin protection.
       *
       * `SELECT ... FOR UPDATE`, not `count(*)`: PostgreSQL refuses row locking
       * on an aggregate, and an unlocked count is exactly the race this guard
       * exists to close. Two operators each demoting the other would both read
       * "there is still another admin" and both commit, leaving the platform
       * with none and no way back in.
       *
       * The lock is taken over every active admin row in a deterministic `id`
       * order, which is what stops those two transactions from deadlocking on
       * each other. The second one blocks; when it is released it re-reads
       * under READ COMMITTED, sees the first demotion, and correctly refuses.
       *
       * Defence in depth rather than the only line of it: over HTTP the caller
       * is by definition an ACTIVE ADMIN and cannot demote themselves, so one
       * admin always survives. This guard is what holds the invariant when the
       * service is called from anywhere else — a script, a future job, a test.
       */
      const activeAdmins = await User.findAll({
        where: { platformRole: 'ADMIN', status: 'ACTIVE' },
        attributes: ['id'],
        order: [['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      const others = activeAdmins.filter((admin) => admin.id !== user.id);
      // A suspended admin is not one of the accounts that can still administer
      // the platform, so demoting one takes nothing away that was there.
      if (user.status === 'ACTIVE' && others.length === 0) {
        throw new ConflictError(
          'This is the last active platform administrator. Promote another account first.',
          ErrorCode.CONFLICT,
        );
      }
    }

    await user.update({ platformRole: input.platformRole }, { transaction });

    await recordAudit(
      {
        businessId: null,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.PLATFORM_USER_ROLE_CHANGED,
        entityType: 'user',
        entityId: user.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { before: previousRole, after: input.platformRole },
      },
      { transaction },
    );

    log.info(
      { userId: user.id, before: previousRole, after: input.platformRole },
      'platform role changed',
    );
  });

  return getUser(id);
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  business_id: string | null;
  business_name: string | null;
  actor_type: AuditActorType;
  actor_label: string | null;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
  ip_address: string | null;
  created_at: Date;
  metadata: Record<string, unknown> | null;
}

/**
 * The workspace join deliberately does not exclude soft-deleted workspaces. An
 * audit trail describes what happened; the entry for a workspace that has since
 * been removed is still readable history and should carry the name it had.
 *
 * `from`/`to` are inclusive calendar dates cut in UTC. The zone is written into
 * the statement rather than left to the session, so the boundary of a day does
 * not depend on how the connection happens to be configured. `to` becomes a
 * half-open upper bound, which is what makes "1 March to 1 March" mean the
 * whole of that day rather than its first instant.
 */
const AUDIT_FILTER_SQL = `
      ($businessId::uuid IS NULL OR l.business_id = $businessId::uuid)
      AND ($action::text IS NULL OR l.action = $action::text)
      AND ($actorUserId::uuid IS NULL OR l.actor_user_id = $actorUserId::uuid)
      AND ($entityType::text IS NULL OR l.entity_type = $entityType::text)
      AND ($from::text IS NULL OR l.created_at >= ($from::date)::timestamp AT TIME ZONE 'UTC')
      AND ($to::text IS NULL OR l.created_at < ($to::date + 1)::timestamp AT TIME ZONE 'UTC')`;

export async function listAuditLogs(
  query: ListAuditLogsQuery,
): Promise<AdminPage<AdminAuditEntry>> {
  const filters = {
    businessId: query.businessId ?? null,
    action: query.action ?? null,
    actorUserId: query.actorUserId ?? null,
    entityType: query.entityType ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
  };

  const pageSql = `
    SELECT l.id, l.business_id, b.name AS business_name,
           l.actor_type, l.actor_label, l.actor_user_id,
           l.action, l.entity_type, l.entity_id,
           l.request_id, l.ip_address, l.created_at, l.metadata
    FROM audit_logs l
    LEFT JOIN businesses b ON b.id = l.business_id
    WHERE ${AUDIT_FILTER_SQL}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT $limit OFFSET $offset`;

  const countSql = `
    SELECT count(*) AS total_items
    FROM audit_logs l
    WHERE ${AUDIT_FILTER_SQL}`;

  const [rows, totals] = await Promise.all([
    sequelize.query<AuditRow>(pageSql, {
      type: QueryTypes.SELECT,
      bind: { ...filters, limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
    }),
    sequelize.query<{ total_items: Numeric }>(countSql, {
      type: QueryTypes.SELECT,
      bind: filters,
    }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      businessName: row.business_name,
      actorType: row.actor_type,
      actorLabel: row.actor_label,
      actorUserId: row.actor_user_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      requestId: row.request_id,
      ipAddress: row.ip_address,
      createdAt: toRequiredIso(row.created_at),
      // The column is NOT NULL with a `{}` default, but a JSONB `null` literal
      // would still arrive as null and break a client that spreads it.
      metadata: row.metadata ?? {},
    })),
    page: query.page,
    pageSize: query.pageSize,
    totalItems: toNumber(totals[0]?.total_items ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

interface OutboxRow {
  pending: Numeric;
  processing: Numeric;
  sent: Numeric;
  failed: Numeric;
  cancelled: Numeric;
  due_now: Numeric;
  oldest_pending_age_seconds: Numeric;
}

/**
 * The outbox in one pass.
 *
 * `due_now` is the number this page exists to surface. Notifications are
 * inserted in the same transaction as the change that caused them and picked up
 * afterwards by the delivery worker, so a `due_now` that keeps climbing while
 * `sent` stands still means the worker is down: every confirmation and reminder
 * the platform has promised is sitting in this table, unsent, and nothing else
 * in the product will say so.
 *
 * `oldest_pending_age_seconds` measures from `scheduled_for` and only over rows
 * that are already due — a reminder scheduled for next Tuesday is not late, and
 * counting it would make a healthy queue look hours behind.
 */
const OUTBOX_SQL = `
  SELECT count(*) FILTER (WHERE status = 'PENDING')    AS pending,
         count(*) FILTER (WHERE status = 'PROCESSING') AS processing,
         count(*) FILTER (WHERE status = 'SENT')       AS sent,
         count(*) FILTER (WHERE status = 'FAILED')     AS failed,
         count(*) FILTER (WHERE status = 'CANCELLED')  AS cancelled,
         count(*) FILTER (WHERE status = 'PENDING' AND scheduled_for <= now()) AS due_now,
         EXTRACT(EPOCH FROM (
           now() - min(scheduled_for) FILTER (WHERE status = 'PENDING' AND scheduled_for <= now())
         )) AS oldest_pending_age_seconds
  FROM notifications`;

const EMPTY_OUTBOX: AdminHealth['outbox'] = {
  pending: 0,
  processing: 0,
  sent: 0,
  failed: 0,
  cancelled: 0,
  dueNow: 0,
  oldestPendingAgeSeconds: null,
};

export async function getSystemHealth(): Promise<AdminHealth> {
  const [database, redis] = await Promise.all([databaseHealth(), redisHealth()]);

  // The outbox figures come from PostgreSQL, so when PostgreSQL is the thing
  // that is down this query cannot answer. The page still has to render — a
  // database outage is precisely when someone is looking at it — so the counts
  // degrade to zeros and the `database` block carries the real story.
  let outbox = EMPTY_OUTBOX;
  if (database.ok) {
    try {
      const rows = await sequelize.query<OutboxRow>(OUTBOX_SQL, { type: QueryTypes.SELECT });
      const row = rows[0];
      if (row) {
        outbox = {
          pending: toNumber(row.pending),
          processing: toNumber(row.processing),
          sent: toNumber(row.sent),
          failed: toNumber(row.failed),
          cancelled: toNumber(row.cancelled),
          dueNow: toNumber(row.due_now),
          // Null means nothing is due at all, which is not the same as "the
          // oldest due message is zero seconds old". The distinction is the
          // whole signal, so it survives instead of collapsing to 0.
          oldestPendingAgeSeconds:
            row.oldest_pending_age_seconds === null
              ? null
              : Math.round(toNumber(row.oldest_pending_age_seconds)),
        };
      }
    } catch (error) {
      log.error({ err: error }, 'outbox health query failed');
    }
  }

  return {
    database: { ok: database.ok, latencyMs: database.latencyMs, error: database.error ?? null },
    redis: { ok: redis.ok, latencyMs: redis.latencyMs, error: redis.error ?? null },
    outbox,
    api: {
      environment: env.APP_ENV,
      node: process.version,
      // Process uptime, not host uptime: a figure that keeps resetting is a
      // crash loop, and that is worth seeing beside the dependency checks.
      uptimeSeconds: Math.floor(process.uptime()),
      apiVersion: 'v1',
    },
    generatedAt: new Date().toISOString(),
  };
}
