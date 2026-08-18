/**
 * Query keys for the management surface.
 *
 * Every key is scoped by `businessId` because the workspace switcher changes
 * the tenant without signing anyone out: without the scope, switching would
 * paint the previous workspace's cached diary under the new workspace's name
 * for as long as the refetch takes.
 *
 * Filters are folded into the key rather than read inside the query function,
 * so a filter change is a different query — which is what makes
 * `keepPreviousData`-style transitions and cache reuse behave.
 */

/** Anything that can appear in a query string, in a shape a key can hash. */
export type QueryScope = Record<string, string | number | boolean | null | undefined>;

const root = (businessId: string | null): readonly unknown[] => ['owner', businessId ?? 'none'];

export const ownerKeys = {
  root,

  analytics: (businessId: string | null, panel: string, scope: QueryScope) =>
    [...root(businessId), 'analytics', panel, scope] as const,

  reportAppointments: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'reports', 'appointments', scope] as const,

  appointments: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'appointments', 'list', scope] as const,
  calendar: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'appointments', 'calendar', scope] as const,
  appointment: (businessId: string | null, id: string) =>
    [...root(businessId), 'appointments', 'detail', id] as const,
  slots: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'appointments', 'slots', scope] as const,

  customers: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'customers', 'list', scope] as const,
  customer: (businessId: string | null, id: string) =>
    [...root(businessId), 'customers', 'detail', id] as const,
  customerAppointments: (businessId: string | null, id: string, page: number) =>
    [...root(businessId), 'customers', 'appointments', id, page] as const,

  services: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'services', 'list', scope] as const,
  service: (businessId: string | null, id: string) =>
    [...root(businessId), 'services', 'detail', id] as const,
  serviceCategories: (businessId: string | null) =>
    [...root(businessId), 'services', 'categories'] as const,
  serviceRequirements: (businessId: string | null, serviceId: string) =>
    [...root(businessId), 'services', 'requirements', serviceId] as const,

  staff: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'staff', 'list', scope] as const,
  staffServices: (businessId: string | null, id: string) =>
    [...root(businessId), 'staff', 'services', id] as const,

  locations: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'locations', scope] as const,
  resources: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'resources', scope] as const,
  teams: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'teams', 'list', scope] as const,
  team: (businessId: string | null, id: string) =>
    [...root(businessId), 'teams', 'detail', id] as const,

  bookingLinks: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'booking-links', scope] as const,
  waitlist: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'waitlist', scope] as const,

  businessHours: (businessId: string | null, locationId: string | null) =>
    [...root(businessId), 'availability', 'business-hours', locationId ?? 'workspace'] as const,
  staffRules: (businessId: string | null, staffProfileId: string) =>
    [...root(businessId), 'availability', 'staff-rules', staffProfileId] as const,
  overrides: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'availability', 'overrides', scope] as const,
  holidays: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'availability', 'holidays', scope] as const,
  blackouts: (businessId: string | null, scope: QueryScope) =>
    [...root(businessId), 'availability', 'blackouts', scope] as const,

  workspace: (businessId: string | null) => [...root(businessId), 'workspace'] as const,
  workspaceSettings: (businessId: string | null) =>
    [...root(businessId), 'workspace', 'settings'] as const,
  members: (businessId: string | null) => [...root(businessId), 'workspace', 'members'] as const,
  roles: (businessId: string | null) => [...root(businessId), 'workspace', 'roles'] as const,
} as const;

/**
 * Drops `undefined` and empty strings so an unset filter never reaches the URL.
 *
 * The API's query schemas are `.strict()` and reject an empty `?q=`, so this is
 * a correctness requirement rather than tidiness.
 */
export function toSearchParams(scope: QueryScope): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}
