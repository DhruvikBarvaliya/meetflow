import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import { PERMISSIONS } from '@/lib/permissions';
import type { Location, Resource, Service, ServiceCategory, StaffProfile, Team } from '@/types/api';
import type { SelectOption } from '@/components/ui';
import { ownerKeys, toSearchParams } from './queryKeys';

/**
 * The reference lists every management screen filters and forms against.
 *
 * They are fetched once per workspace and cached for longer than the default:
 * a service catalogue changes a few times a year, and re-reading it on every
 * page would put five requests behind every navigation.
 *
 * Each hook is gated on the permission its endpoint requires. A receptionist
 * who cannot read the staff list still gets a working filter bar — the staff
 * filter simply is not offered, rather than rendering an empty select whose
 * only behaviour is a 403.
 */

const LOOKUP_STALE_TIME = 5 * 60_000;

/** Every lookup asks for the maximum page: these lists are configuration, not data. */
const LOOKUP_PAGE_SIZE = 100;

export interface LookupList<T> {
  items: T[];
  isLoading: boolean;
  isError: boolean;
  /** The failure itself, so a caller can show the API's own message. */
  error: unknown;
  refetch: () => void;
}

function toLookup<T>(query: UseQueryResult<T[]>, enabled: boolean): LookupList<T> {
  return {
    items: query.data ?? [],
    // A hook that never ran is not loading; a caller waiting on it would hang.
    isLoading: enabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useStaffLookup(): LookupList<StaffProfile> {
  const { activeBusinessId, can } = useAuth();
  const enabled = can(PERMISSIONS.STAFF_READ) && activeBusinessId !== null;
  const scope = { pageSize: LOOKUP_PAGE_SIZE, isActive: true } as const;

  const query = useQuery({
    queryKey: ownerKeys.staff(activeBusinessId, scope),
    queryFn: () => api.get<StaffProfile[]>(`/staff${toSearchParams(scope)}`),
    enabled,
    staleTime: LOOKUP_STALE_TIME,
  });

  return toLookup(query, enabled);
}

export function useServicesLookup(): LookupList<Service> {
  const { activeBusinessId, can } = useAuth();
  const enabled = can(PERMISSIONS.SERVICES_READ) && activeBusinessId !== null;
  const scope = { pageSize: LOOKUP_PAGE_SIZE } as const;

  const query = useQuery({
    queryKey: ownerKeys.services(activeBusinessId, scope),
    queryFn: () => api.get<Service[]>(`/services${toSearchParams(scope)}`),
    enabled,
    staleTime: LOOKUP_STALE_TIME,
  });

  return toLookup(query, enabled);
}

export function useServiceCategoriesLookup(): LookupList<ServiceCategory> {
  const { activeBusinessId, can } = useAuth();
  const enabled = can(PERMISSIONS.SERVICES_READ) && activeBusinessId !== null;

  const query = useQuery({
    queryKey: ownerKeys.serviceCategories(activeBusinessId),
    queryFn: () =>
      api.get<ServiceCategory[]>(
        `/services/categories${toSearchParams({ pageSize: LOOKUP_PAGE_SIZE })}`,
      ),
    enabled,
    staleTime: LOOKUP_STALE_TIME,
  });

  return toLookup(query, enabled);
}

export function useLocationsLookup(): LookupList<Location> {
  const { activeBusinessId, can } = useAuth();
  const enabled = can(PERMISSIONS.LOCATIONS_READ) && activeBusinessId !== null;
  const scope = { pageSize: LOOKUP_PAGE_SIZE } as const;

  const query = useQuery({
    queryKey: ownerKeys.locations(activeBusinessId, scope),
    queryFn: () => api.get<Location[]>(`/locations${toSearchParams(scope)}`),
    enabled,
    staleTime: LOOKUP_STALE_TIME,
  });

  return toLookup(query, enabled);
}

export function useResourcesLookup(): LookupList<Resource> {
  const { activeBusinessId, can } = useAuth();
  const enabled = can(PERMISSIONS.RESOURCES_READ) && activeBusinessId !== null;
  const scope = { pageSize: LOOKUP_PAGE_SIZE } as const;

  const query = useQuery({
    queryKey: ownerKeys.resources(activeBusinessId, scope),
    queryFn: () => api.get<Resource[]>(`/resources${toSearchParams(scope)}`),
    enabled,
    staleTime: LOOKUP_STALE_TIME,
  });

  return toLookup(query, enabled);
}

export function useTeamsLookup(): LookupList<Team> {
  const { activeBusinessId, can } = useAuth();
  const enabled = can(PERMISSIONS.TEAMS_READ) && activeBusinessId !== null;
  const scope = { pageSize: LOOKUP_PAGE_SIZE } as const;

  const query = useQuery({
    queryKey: ownerKeys.teams(activeBusinessId, scope),
    queryFn: () => api.get<Team[]>(`/teams${toSearchParams(scope)}`),
    enabled,
    staleTime: LOOKUP_STALE_TIME,
  });

  return toLookup(query, enabled);
}

/**
 * Turns a lookup into `<Select>` options with a leading "everything" entry.
 *
 * A plain function rather than a hook: these lists are at most a hundred short
 * strings, and memoising them would cost more in dependency churn than the map
 * it saves.
 */
export function filterOptions<T>(
  items: T[],
  allLabel: string,
  toOption: (item: T) => SelectOption,
): SelectOption[] {
  return [{ value: '', label: allLabel }, ...items.map(toOption)];
}
