import type { QueryScope } from '@/components/owner';

/**
 * Query keys for the platform-administration surface.
 *
 * The root is `['admin']` and nothing more. Every key on the management
 * surface is scoped by `businessId`, because switching workspace there has to
 * throw the previous tenant's cache away or the diary of one clinic would be
 * painted under the name of another. This surface is the opposite case: an
 * admin screen is a view *across* every workspace, so folding the active
 * workspace into these keys would evict the entire platform view each time the
 * operator switched workspace in the other shell — a refetch of the workspace
 * directory triggered by something that has no bearing on it.
 *
 * Which means the cache here outlives a workspace switch on purpose. That is
 * safe precisely because none of these responses are tenant-scoped: the same
 * request from the same operator returns the same rows whichever workspace the
 * management shell happens to be pointing at.
 *
 * Filters are folded into the key rather than read inside the query function,
 * so a filter change is a different query. That is what makes a paged table
 * hold the previous page on screen while the next one loads, instead of
 * flashing a skeleton between every click.
 */

const root = ['admin'] as const;

export const adminKeys = {
  /** Invalidate this to refetch every admin screen — e.g. after a mutation. */
  root,

  overview: () => [...root, 'overview'] as const,

  workspaces: (scope: QueryScope) => [...root, 'workspaces', 'list', scope] as const,
  workspace: (id: string) => [...root, 'workspaces', 'detail', id] as const,

  users: (scope: QueryScope) => [...root, 'users', 'list', scope] as const,
  user: (id: string) => [...root, 'users', 'detail', id] as const,

  auditLogs: (scope: QueryScope) => [...root, 'audit-logs', scope] as const,

  /**
   * Unfiltered and unscoped: there is one health report and it is about the
   * process answering the request, so the key never needs to say more.
   */
  health: () => [...root, 'health'] as const,
} as const;
