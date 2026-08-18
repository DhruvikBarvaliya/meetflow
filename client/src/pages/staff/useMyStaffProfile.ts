import { useQueryClient } from '@tanstack/react-query';
import { ownerKeys, useStaffLookup } from '@/components/owner';
import { useAuth } from '@/context/AuthContext';
import type { StaffProfile } from '@/types/api';

export interface MyStaffProfileResult {
  /** The caller's own provider profile, or null once resolved and absent. */
  profile: StaffProfile | null;
  staffProfileId: string | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Resolves the signed-in member's provider profile in the active workspace.
 *
 * `GET /auth/me` publishes `activeWorkspace.staffProfileId`, and that is used
 * the moment the API populates it. In practice it is always null — `/auth/me`
 * is mounted without tenant context, as `lib/permissions.ts` explains — so the
 * fallback reads the roster and matches on the user id. `staff:read` is held by
 * every system role, including STAFF, so this works for exactly the people who
 * need it, and it shares the roster cache with every other screen that already
 * loads it.
 */
export function useMyStaffProfile(): MyStaffProfileResult {
  const { activeBusinessId, staffProfileId: fromIdentity, user } = useAuth();
  const queryClient = useQueryClient();
  const roster = useStaffLookup();

  const refetch = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'staff'],
    });
  };

  if (fromIdentity !== null) {
    return {
      profile: roster.items.find((entry) => entry.id === fromIdentity) ?? null,
      staffProfileId: fromIdentity,
      isLoading: false,
      isError: false,
      refetch,
    };
  }

  const userId = user?.id ?? null;
  const profile = roster.items.find((entry) => entry.userId === userId) ?? null;

  return {
    profile,
    staffProfileId: profile?.id ?? null,
    isLoading: roster.isLoading,
    isError: roster.isError,
    refetch,
  };
}
