import { toSearchParams, type QueryScope } from '@/components/owner';
import { api } from '@/lib/apiClient';
import type {
  AdminAuditEntry,
  AdminAuditFilters,
  AdminHealth,
  AdminOverview,
  AdminUserDetail,
  AdminUserFilters,
  AdminUserStatusUpdate,
  AdminUserSummary,
  AdminWorkspaceDetail,
  AdminWorkspaceFilters,
  AdminWorkspaceStatusUpdate,
  AdminWorkspaceSummary,
  Page,
  PlatformRole,
} from '@/types/api';

/**
 * Every call the platform-administration screens make, in one place.
 *
 * A thin wrapper and nothing more: no caching, no retries, no error mapping.
 * TanStack Query owns the first two and `ApiError` already owns the third, so
 * anything added here would be a second policy competing with them. What this
 * file does own is the URL and the query string, so that a page never builds
 * either by hand and no screen can quietly diverge from the contract in
 * `server/src/modules/admin/admin.validation.ts`.
 *
 * **No workspace context travels with these requests, and none is needed.**
 * The shared request interceptor in `lib/apiClient.ts` attaches `X-Business-Id`
 * to every credentialed call, so it rides along here too — harmlessly. This
 * router is mounted behind `authenticate -> apiRateLimit -> requirePlatformAdmin`
 * and never behind `requireTenant`, so nothing on the server ever reads that
 * header on this surface. It is worth knowing rather than fixing: an operator
 * holds no membership in the workspaces they administer, so tenant resolution
 * would answer 404 to every call here, which is exactly why the admin surface
 * is its own router rather than another mount on the management one. A
 * workspace id is therefore an ordinary path parameter below, not something
 * proven from the session.
 *
 * Query strings are built with `toSearchParams`, which drops `undefined` and
 * empty strings. That is a correctness requirement rather than tidiness: the
 * server's query schemas are `.strict()` with a `min(1)` on every search term,
 * so an empty `?search=` is a validation failure and not an absent filter.
 */

const BASE = '/admin';

/**
 * Rows per page on every admin list.
 *
 * Held here rather than in the filter state because no screen offers a page-size
 * control; the server caps the parameter at 100 regardless, since these
 * endpoints return counts instead of contents and an uncapped page would still
 * turn the workspace directory into a bulk export.
 */
export const ADMIN_PAGE_SIZE = 20;

/*
 * The scope builders below produce the object that goes into both the query key
 * and the query string, so the cache entry and the request it caches cannot
 * describe different filters. Pass the same object to `adminKeys.workspaces()`
 * as the fetch receives, and a stale key is not a bug that can be written.
 *
 * `search` is trimmed on the way through: a term of nothing but spaces becomes
 * an empty string, which `toSearchParams` then drops, so an accidental space
 * does not send a search the server would reject.
 */

export function adminWorkspaceScope(filters: AdminWorkspaceFilters): QueryScope {
  return {
    page: filters.page,
    pageSize: ADMIN_PAGE_SIZE,
    search: filters.search.trim(),
    status: filters.status,
    sort: filters.sort,
  };
}

export function adminUserScope(filters: AdminUserFilters): QueryScope {
  return {
    page: filters.page,
    pageSize: ADMIN_PAGE_SIZE,
    search: filters.search.trim(),
    status: filters.status,
    platformRole: filters.platformRole,
    sort: filters.sort,
  };
}

export function adminAuditScope(filters: AdminAuditFilters): QueryScope {
  return {
    page: filters.page,
    pageSize: ADMIN_PAGE_SIZE,
    businessId: filters.businessId,
    action: filters.action.trim(),
    entityType: filters.entityType.trim(),
    actorUserId: filters.actorUserId,
    from: filters.from,
    to: filters.to,
  };
}

// ---------------------------------------------------------------------------
// Overview and health
// ---------------------------------------------------------------------------

export function fetchAdminOverview(): Promise<AdminOverview> {
  return api.get<AdminOverview>(`${BASE}/overview`);
}

/**
 * The dependency and backlog report.
 *
 * Answers 200 even when a dependency is down — a 503 would take the one page
 * that could explain an outage down with it — so the caller reads `ok` on each
 * check rather than treating a resolved promise as good news.
 */
export function fetchAdminHealth(): Promise<AdminHealth> {
  return api.get<AdminHealth>(`${BASE}/health`);
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export function fetchAdminWorkspaces(
  filters: AdminWorkspaceFilters,
): Promise<Page<AdminWorkspaceSummary>> {
  return api.getPage<AdminWorkspaceSummary>(
    `${BASE}/workspaces${toSearchParams(adminWorkspaceScope(filters))}`,
  );
}

export function fetchAdminWorkspace(id: string): Promise<AdminWorkspaceDetail> {
  return api.get<AdminWorkspaceDetail>(`${BASE}/workspaces/${id}`);
}

/**
 * Suspend, archive or reinstate a workspace. Answers the full detail record, so
 * the calling screen can seed the cache from the response instead of refetching.
 */
export function updateAdminWorkspaceStatus(
  id: string,
  input: AdminWorkspaceStatusUpdate,
): Promise<AdminWorkspaceDetail> {
  const reason = input.reason?.trim();
  // The schema is `.strict()` with `min(1)` on `reason`, so an untouched field
  // has to be left out of the payload entirely: sending `reason: ''` would be
  // rejected as a validation error rather than read as "no reason given".
  const body: AdminWorkspaceStatusUpdate =
    reason === undefined || reason === ''
      ? { status: input.status }
      : { status: input.status, reason };

  return api.patch<AdminWorkspaceDetail>(`${BASE}/workspaces/${id}/status`, body);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function fetchAdminUsers(filters: AdminUserFilters): Promise<Page<AdminUserSummary>> {
  return api.getPage<AdminUserSummary>(`${BASE}/users${toSearchParams(adminUserScope(filters))}`);
}

export function fetchAdminUser(id: string): Promise<AdminUserDetail> {
  return api.get<AdminUserDetail>(`${BASE}/users/${id}`);
}

/**
 * Suspending or deactivating also revokes the account's live refresh tokens, in
 * the same transaction on the server, so the session is gone rather than merely
 * marked. The API refuses the change outright when the target is the operator
 * making it — an admin cannot lock themselves out of the only surface that
 * could unlock them — and answers 409, which the screen surfaces as-is.
 */
export function updateAdminUserStatus(
  id: string,
  status: AdminUserStatusUpdate,
): Promise<AdminUserDetail> {
  return api.patch<AdminUserDetail>(`${BASE}/users/${id}/status`, { status });
}

/**
 * Separate from the status call rather than one PATCH taking both: promoting
 * someone and suspending them are different decisions with different guards.
 * The server refuses to demote the operator making the request, and refuses to
 * demote the last active ADMIN; both come back as a 409 with a message worth
 * showing verbatim.
 */
export function updateAdminPlatformRole(
  id: string,
  platformRole: PlatformRole,
): Promise<AdminUserDetail> {
  return api.patch<AdminUserDetail>(`${BASE}/users/${id}/platform-role`, { platformRole });
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

/**
 * The platform-wide trail, newest first. `from` and `to` are calendar dates and
 * both bounds are inclusive; the server turns `to` into a half-open upper bound
 * so the client never has to reason about the last second of a day.
 */
export function fetchAdminAuditLogs(filters: AdminAuditFilters): Promise<Page<AdminAuditEntry>> {
  return api.getPage<AdminAuditEntry>(
    `${BASE}/audit-logs${toSearchParams(adminAuditScope(filters))}`,
  );
}
