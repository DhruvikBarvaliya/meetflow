import { toSearchParams, ownerKeys, type QueryScope } from '@/components/owner';
import { api } from '@/lib/apiClient';
import type {
  AuditLogEntry,
  AuditLogEntryDetail,
  AuditLogFilters,
  CreateWebhookRequest,
  CreatedWebhookEndpoint,
  InviteMemberRequest,
  MemberFilters,
  MemberPermissionOverride,
  MemberPermissions,
  MemberRecord,
  Page,
  UpdateMemberRequest,
  NotificationTemplate,
  NotificationTemplateChannel,
  NotificationTemplateKey,
  NotificationTemplatePreview,
  UpdateWebhookRequest,
  UpsertNotificationTemplateRequest,
  WebhookDeliveryFilters,
  WebhookDeliveryRecord,
  WebhookEndpoint,
  WebhookEndpointDetail,
  WebhookFilters,
} from '@/types/api';

/**
 * Every call the three workspace-administration screens make, in one place.
 *
 * A thin wrapper and nothing more: no caching, no retries, no error mapping.
 * TanStack Query owns the first two and `ApiError` already owns the third, so
 * anything added here would be a second policy competing with them. What this
 * file does own is the URL and the query string, so no screen builds either by
 * hand and none can quietly diverge from the contract in
 * `server/src/modules/{members,audit,webhooks}/*.validation.ts`.
 *
 * **Nothing here names a workspace.** All three routers are mounted on the
 * management router, behind `authenticate -> apiRateLimit -> requireTenant`, so
 * the tenant comes from the caller's membership by way of the `X-Business-Id`
 * header the shared request interceptor attaches. Every one of these query
 * schemas is `.strict()`, so a `businessId` sent as a parameter would be a loud
 * 422 rather than a silently ignored field — which is the correct behaviour for
 * something that could only ever be an attempt to read another tenant's rows.
 *
 * Query strings are built with `toSearchParams`, which drops `undefined` and
 * empty strings. That is a correctness requirement rather than tidiness: the
 * schemas carry `min(1)` on every search term, so an empty `?search=` is a
 * validation failure and not an absent filter.
 */

/**
 * Rows per page on all three lists.
 *
 * None of these screens offers a page-size control, and the server caps the
 * parameter at 100 regardless. The audit trail is the fastest-growing table in
 * the schema, so an uncapped page there would turn a read endpoint into an
 * unbounded export with no row limit in front of it.
 */
export const WORKSPACE_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

/**
 * Keys for the three surfaces, hung off the same `['owner', businessId]` root
 * every other management key uses.
 *
 * They live here rather than in `components/owner/queryKeys.ts` because these
 * three endpoints are new and this file is the only reader of them; sharing the
 * root is what still guarantees a workspace switch evicts them along with
 * everything else. `ownerKeys.members` is a different key for a different
 * endpoint — the older unpaginated `GET /workspace/members` that `StaffPage`
 * reads — and the two must not be conflated, which is why the invalidation
 * helper below names both.
 *
 * Filters are folded into the key rather than read inside the query function,
 * so a filter change is a different query. That is what lets a paged table hold
 * the previous page on screen while the next one loads instead of flashing a
 * skeleton between every click.
 */
export const workspaceKeys = {
  members: (businessId: string | null, scope: QueryScope) =>
    [...ownerKeys.root(businessId), 'members', 'list', scope] as const,
  memberPermissions: (businessId: string | null, membershipId: string) =>
    [...ownerKeys.root(businessId), 'members', 'permissions', membershipId] as const,

  auditEntries: (businessId: string | null, scope: QueryScope) =>
    [...ownerKeys.root(businessId), 'audit-logs', 'list', scope] as const,
  auditEntry: (businessId: string | null, id: string) =>
    [...ownerKeys.root(businessId), 'audit-logs', 'detail', id] as const,

  webhooks: (businessId: string | null, scope: QueryScope) =>
    [...ownerKeys.root(businessId), 'webhooks', 'list', scope] as const,
  webhookDeliveries: (businessId: string | null, endpointId: string, scope: QueryScope) =>
    [...ownerKeys.root(businessId), 'webhooks', 'deliveries', endpointId, scope] as const,

  // One key for the whole catalogue rather than one per message: the listing is
  // a single unpaginated response and every write invalidates it, so a per-key
  // cache entry would be sixteen entries that are always refetched together.
  notificationTemplates: (businessId: string | null) =>
    [...ownerKeys.root(businessId), 'notification-templates', 'list'] as const,
} as const;

/**
 * Everything a membership write invalidates.
 *
 * Two prefixes, not one, and the second is the whole reason this is a function
 * rather than a literal at the call site: `StaffPage` builds its "who can be
 * given a staff profile" picker from `ownerKeys.members`, which is
 * `GET /workspace/members` and a different cache entry entirely. Inviting or
 * removing somebody changes what that picker should offer, and forgetting the
 * second key leaves a departed colleague selectable until the page is reloaded.
 */
export function memberInvalidationKeys(
  businessId: string | null,
): ReadonlyArray<readonly unknown[]> {
  return [[...ownerKeys.root(businessId), 'members'], ownerKeys.members(businessId)];
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/*
 * The scope builders below produce the object that goes into both the query key
 * and the query string, so a cache entry and the request it caches cannot
 * describe different filters. Pass the same object to `workspaceKeys.*` as the
 * fetch receives and a stale key is not a bug that can be written.
 *
 * Free-text terms are trimmed on the way through: a term of nothing but spaces
 * becomes an empty string, which `toSearchParams` then drops, so an accidental
 * space does not send a search the server would reject.
 */

export function memberScope(filters: MemberFilters): QueryScope {
  return {
    page: filters.page,
    pageSize: WORKSPACE_PAGE_SIZE,
    search: filters.search.trim(),
    status: filters.status,
    roleId: filters.roleId,
    // Sent only when true. The parameter defaults to false on the server, and
    // `?includeRemoved=false` is the same request as omitting it — but sending
    // it would put a second distinct value into the query key for no change in
    // the rows, so the default view and the explicit-false view would be two
    // cache entries holding identical data.
    includeRemoved: filters.includeRemoved ? 'true' : '',
  };
}

export function auditScope(filters: AuditLogFilters): QueryScope {
  return {
    page: filters.page,
    pageSize: WORKSPACE_PAGE_SIZE,
    action: filters.action.trim(),
    entityType: filters.entityType.trim(),
    entityId: filters.entityId,
    actorUserId: filters.actorUserId,
    search: filters.search.trim(),
    from: filters.from,
    to: filters.to,
  };
}

export function webhookScope(filters: WebhookFilters): QueryScope {
  return {
    page: filters.page,
    pageSize: WORKSPACE_PAGE_SIZE,
    isActive: filters.isActive,
    event: filters.event,
  };
}

export function deliveryScope(filters: WebhookDeliveryFilters): QueryScope {
  return {
    page: filters.page,
    pageSize: WORKSPACE_PAGE_SIZE,
    status: filters.status,
    event: filters.event.trim(),
  };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export function fetchMembers(filters: MemberFilters): Promise<Page<MemberRecord>> {
  return api.getPage<MemberRecord>(`/members${toSearchParams(memberScope(filters))}`);
}

/**
 * Invites an email address, never a user id.
 *
 * The server resolves the address to an account and creates one when there is
 * none, which is what keeps this surface from becoming an oracle for which
 * accounts exist on the platform. A live membership for the same address is a
 * 409 with a message worth showing verbatim, because "already invited" and
 * "already a member" are different situations with different next steps.
 *
 * `firstName` and `lastName` are dropped when blank rather than sent empty: the
 * schema is `.strict()` with `min(1)` on both, so `''` is a validation error
 * rather than "no name given".
 */
export function inviteMember(input: InviteMemberRequest): Promise<MemberRecord> {
  const firstName = input.firstName?.trim();
  const lastName = input.lastName?.trim();

  return api.post<MemberRecord>('/members/invite', {
    email: input.email,
    roleId: input.roleId,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
  });
}

/**
 * Changes a member's role, their status, or both.
 *
 * Several refusals come back as a 409 and are the server's to make, not this
 * client's to predict: the owner's membership cannot be changed, nobody may act
 * on their own, an unaccepted invitation cannot be activated from this side,
 * and the last member holding `roles:manage` cannot be stripped of it. The
 * first two are knowable from a row and the screen disables them with a reason;
 * the last needs every member's overrides under a row lock, so it is a message
 * to surface rather than a state to mirror.
 */
export function updateMember(
  membershipId: string,
  input: UpdateMemberRequest,
): Promise<MemberRecord> {
  return api.patch<MemberRecord>(`/members/${membershipId}`, input);
}

/**
 * Removes a member. Soft delete plus a REMOVED status: the history stays, the
 * partial unique index is released so the same person can be invited back, and
 * any staff profile is soft-deleted in the same transaction.
 *
 * Refused with a 409 when the member still has upcoming appointments — the
 * message carries the count, and suspending instead is the alternative it
 * names.
 */
export function removeMember(membershipId: string): Promise<void> {
  return api.delete(`/members/${membershipId}`);
}

export function fetchMemberPermissions(membershipId: string): Promise<MemberPermissions> {
  return api.get<MemberPermissions>(`/members/${membershipId}/permissions`);
}

/**
 * Replaces a member's permission overrides wholesale.
 *
 * A full replacement, not a patch, and the caller must send the complete set:
 * a merge would make "remove this DENY" impossible to express. Sending an empty
 * array is how every exception is cleared and the member falls back to their
 * role alone.
 */
export function replaceMemberPermissions(
  membershipId: string,
  overrides: MemberPermissionOverride[],
): Promise<MemberPermissions> {
  return api.put<MemberPermissions>(`/members/${membershipId}/permissions`, { overrides });
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export function fetchAuditEntries(filters: AuditLogFilters): Promise<Page<AuditLogEntry>> {
  return api.getPage<AuditLogEntry>(`/audit-logs${toSearchParams(auditScope(filters))}`);
}

/**
 * One entry in full. Worth a request of its own rather than reusing the list
 * row: this is the only shape that carries `userAgent`, and the trail is
 * append-only so the answer can never contradict the row that was clicked.
 */
export function fetchAuditEntry(id: string): Promise<AuditLogEntryDetail> {
  return api.get<AuditLogEntryDetail>(`/audit-logs/${id}`);
}

/**
 * The URL the CSV export is fetched from, filters and all.
 *
 * A URL rather than a call because the download goes through `useCsvExport`,
 * which needs the raw axios instance to read `Content-Disposition` and
 * `X-Report-Truncated` off the response. Pagination is deliberately absent —
 * the export is bounded by the server's row cap, and a page number would only
 * produce a truncated file that looks complete.
 */
export function auditExportUrl(filters: AuditLogFilters): string {
  // `page` and `pageSize` are dropped rather than never built: the same scope
  // feeds the list, and rebuilding it here by hand is how the file on disk comes
  // to describe a different set of rows from the screen it was launched from.
  const { page: _page, pageSize: _pageSize, ...rest } = auditScope(filters);
  return `/audit-logs/export.csv${toSearchParams(rest)}`;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export function fetchWebhooks(filters: WebhookFilters): Promise<Page<WebhookEndpoint>> {
  return api.getPage<WebhookEndpoint>(`/webhooks${toSearchParams(webhookScope(filters))}`);
}

export function fetchWebhook(id: string): Promise<WebhookEndpointDetail> {
  return api.get<WebhookEndpointDetail>(`/webhooks/${id}`);
}

/**
 * Registers an endpoint and answers the **only** body in the API that carries a
 * signing secret.
 *
 * The plaintext exists in one variable on the server and is never written
 * anywhere a read could reach, so this response is the single moment it is
 * visible. A caller that discards it has cost the user the secret, and the only
 * remedy is to delete the endpoint and register another.
 */
export function createWebhook(input: CreateWebhookRequest): Promise<CreatedWebhookEndpoint> {
  return api.post<CreatedWebhookEndpoint>('/webhooks', input);
}

export function updateWebhook(id: string, input: UpdateWebhookRequest): Promise<WebhookEndpoint> {
  return api.patch<WebhookEndpoint>(`/webhooks/${id}`, input);
}

export function deleteWebhook(id: string): Promise<void> {
  return api.delete(`/webhooks/${id}`);
}

/**
 * Queues a signed `webhook.test` event to one endpoint.
 *
 * 202 semantics under a 201: the delivery row exists, the attempt has not
 * happened yet, and the outcome shows up in delivery history like any other
 * event. Refused with a 409 for a disabled endpoint, because the worker cancels
 * anything addressed to one — answering 201 and then delivering nothing is the
 * least useful possible response to "is this endpoint working?".
 */
export function sendWebhookTest(id: string): Promise<WebhookDeliveryRecord> {
  return api.post<WebhookDeliveryRecord>(`/webhooks/${id}/test`);
}

export function fetchWebhookDeliveries(
  endpointId: string,
  filters: WebhookDeliveryFilters,
): Promise<Page<WebhookDeliveryRecord>> {
  return api.getPage<WebhookDeliveryRecord>(
    `/webhooks/${endpointId}/deliveries${toSearchParams(deliveryScope(filters))}`,
  );
}

// ---------------------------------------------------------------------------
// Notification templates
//
// The address of a message is its key *and* channel, because the table's unique
// index is on both and a workspace may well rewrite the email confirmation and
// leave the SMS one alone.
// ---------------------------------------------------------------------------

export function fetchNotificationTemplates(): Promise<NotificationTemplate[]> {
  return api.get<NotificationTemplate[]>('/notification-templates');
}

export function saveNotificationTemplate(
  key: NotificationTemplateKey,
  channel: NotificationTemplateChannel,
  input: UpsertNotificationTemplateRequest,
): Promise<NotificationTemplate> {
  return api.put<NotificationTemplate>(`/notification-templates/${key}/${channel}`, input);
}

/**
 * Drops the workspace's copy, restoring MeetFlow's.
 *
 * Answers 404 when there is nothing to reset, which the screen only ever
 * reaches by racing itself — the control is hidden for a message that has no
 * override.
 */
export function resetNotificationTemplate(
  key: NotificationTemplateKey,
  channel: NotificationTemplateChannel,
): Promise<void> {
  return api.delete(`/notification-templates/${key}/${channel}`);
}

/**
 * Renders a draft against sample data without saving it.
 *
 * A POST despite reading nothing: a body somebody is still editing does not
 * belong in a query string, a proxy log, or browser history.
 */
export function previewNotificationTemplate(
  key: NotificationTemplateKey,
  channel: NotificationTemplateChannel,
  input: { subject?: string; bodyText: string },
): Promise<NotificationTemplatePreview> {
  return api.post<NotificationTemplatePreview>(
    `/notification-templates/${key}/${channel}/preview`,
    input,
  );
}
