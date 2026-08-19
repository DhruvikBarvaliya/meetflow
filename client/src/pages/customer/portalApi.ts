/**
 * The customer portal's data layer — everything under `GET/POST/PATCH /me`.
 *
 * Kept apart from the management surface's `ownerKeys`/`api` conventions for a
 * structural reason rather than a stylistic one. Every management call carries
 * an `X-Business-Id` and is answered inside one workspace; **nothing here does,
 * and nothing here may.** `/api/v1/me` is mounted before the management router,
 * outside `requireTenant`, and its scope is "the `Customer` rows pointing at the
 * signed-in account" across every workspace at once. A workspace id in one of
 * these requests would not merely be ignored — `portal.validation.ts` is
 * `.strict()` and would answer 422 — but the more important point is that it
 * would be the client asking to widen a scope the server alone decides. So no
 * query key here is namespaced by a business, and no function takes one.
 *
 * The pages this serves replaced an earlier set that searched the workspace
 * address book for the signed-in email and needed `customers:read` to do it — a
 * permission a customer, who holds no membership at all, never has. That is why
 * they showed a permissions error to the very people they were built for.
 *
 * Every shape below is copied from `portal.service.ts`, with the `Date` fields
 * it declares written as the ISO strings JSON actually carries.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from '@/lib/apiClient';
import type {
  AppointmentStatus,
  AuthUser,
  LocationType,
  Page,
  PublicAppointment,
} from '@/types/api';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A workspace as one of its customers sees it.
 *
 * Deliberately carries no workspace id — only the `cus_…` handle for this
 * person's record there. Grouping and filtering on this surface therefore have
 * nothing but the display name to key on, which is why the bookings list labels
 * each row with its workspace rather than bucketing rows under headings: two
 * businesses may share a name, and a heading that silently merged them would be
 * worse than a label repeated a few times.
 */
export interface PortalWorkspace {
  customerPublicId: string;
  business: {
    name: string;
    logoUrl: string | null;
    timezone: string;
    supportEmail: string | null;
    supportPhone: string | null;
  };
  /** When that workspace first had a record of this person. */
  knownSince: string;
  upcomingBookings: number;
}

export interface PortalProfile {
  /**
   * `portal.service.ts` types this as `Record<string, unknown>` because it hands
   * back `User.toPublicJSON()` verbatim; that method's fields are exactly
   * `AuthUser`, which is the shape login and refresh already return.
   */
  user: AuthUser;
  workspaces: PortalWorkspace[];
  /** Live bookings across every workspace at once. */
  upcomingBookings: number;
}

/**
 * One row of the bookings list.
 *
 * Lighter than the detail view by design: the full record — answers, notes, the
 * cancellation policy, the video link — is one request away at
 * `/me/bookings/:publicId`, and joining all of it across a dozen workspaces for
 * a list would cost far more than it shows.
 */
export interface PortalBooking {
  publicId: string;
  /** Typed as `string` server-side; the column's CHECK constraint is this union. */
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  /** The zone the workspace confirmed this booking in, which need not be yours. */
  timezone: string;
  /** Minor units of `currency`. */
  priceAmount: number;
  currency: string;
  title: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  rescheduleCount: number;
  business: { name: string; logoUrl: string | null; timezone: string };
  service: { name: string; durationMinutes: number } | null;
  staff: { displayName: string; avatarUrl: string | null } | null;
  location: { name: string; type: LocationType; timezone: string } | null;
}

export interface PortalPreferences {
  emailEnabled: boolean;
  smsEnabled: boolean;
  marketingOptIn: boolean;
  /** Null means "follow each workspace's own reminder schedule". */
  reminderOffsetsMinutes: number[] | null;
}

export interface PortalPreferencesView {
  preferences: PortalPreferences;
  /**
   * True when the linked workspaces do not all hold the same answer.
   *
   * They can: preferences live on each `Customer` row and staff can edit one
   * from the address book. Where they disagree the reported value is the
   * conservative reading, and this flag is what lets the page say "these differ
   * between businesses" instead of presenting one workspace's answer as though
   * it were universal.
   */
  divergent: boolean;
  workspaceCount: number;
}

/**
 * Which end of their history the person is looking at.
 *
 * Purely temporal, and the server treats it that way: a cancelled appointment
 * next Tuesday is still upcoming. Filtering by outcome is what `status` is for.
 */
export const BOOKING_WINDOWS = ['UPCOMING', 'PAST', 'ALL'] as const;
export type BookingWindow = (typeof BOOKING_WINDOWS)[number];

export interface BookingListParams {
  when: BookingWindow;
  status?: AppointmentStatus;
  page: number;
}

/** `listBookingsQuerySchema` caps this at 50; ten fills a portal screen. */
export const PORTAL_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

/**
 * No workspace segment anywhere, unlike `ownerKeys`.
 *
 * There is nothing to scope by: these caches hold the signed-in person's own
 * records across every workspace, and switching the management app's active
 * workspace changes none of them. Adding a business id would silently
 * re-fetch the same data under a second key.
 */
export const portalKeys = {
  all: ['portal'] as const,
  profile: () => ['portal', 'profile'] as const,
  preferences: () => ['portal', 'preferences'] as const,
  bookings: (params: BookingListParams) => ['portal', 'bookings', params] as const,
  booking: (publicId: string) => ['portal', 'booking', publicId] as const,
} as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function usePortalProfile(): UseQueryResult<PortalProfile> {
  return useQuery({
    queryKey: portalKeys.profile(),
    queryFn: () => api.get<PortalProfile>('/me/profile'),
    // The workspace list and its counters change when a booking is made, which
    // the mutations below invalidate; a minute of staleness costs nothing.
    staleTime: 60_000,
  });
}

export function usePortalBookings(params: BookingListParams): UseQueryResult<Page<PortalBooking>> {
  return useQuery({
    queryKey: portalKeys.bookings(params),
    queryFn: () =>
      api.getPage<PortalBooking>('/me/bookings', {
        params: {
          when: params.when,
          page: params.page,
          pageSize: PORTAL_PAGE_SIZE,
          // Dropped by axios when undefined, which matters: the query schema is
          // `.strict()` and would refuse an explicit empty string.
          status: params.status,
        },
      }),
    // Keeps the previous page on screen while the next one loads, so the list
    // does not blank out under the reader between pages.
    placeholderData: (previous) => previous,
  });
}

/**
 * One booking in full.
 *
 * The server answers with the same view the anonymous manage page uses, which
 * is the only shape that carries the customer *policy* — whether this booking
 * can still be moved or cancelled, and how many moves are left. The management
 * endpoints deliberately omit it, because a workspace acting on a customer's
 * phone call is not bound by the customer's own deadline.
 */
export function usePortalBooking(publicId: string): UseQueryResult<PublicAppointment> {
  return useQuery({
    queryKey: portalKeys.booking(publicId),
    queryFn: () => api.get<PublicAppointment>(`/me/bookings/${encodeURIComponent(publicId)}`),
    enabled: publicId.length > 0,
    retry: false,
  });
}

export function usePortalPreferences(): UseQueryResult<PortalPreferencesView> {
  return useQuery({
    queryKey: portalKeys.preferences(),
    queryFn: () => api.get<PortalPreferencesView>('/me/preferences'),
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Everything a change to one booking can invalidate.
 *
 * The lists go as a group rather than by key, because a cancellation moves a
 * row between the upcoming and past windows and changes both totals — and the
 * profile's headline count with them.
 */
function useInvalidateBooking(publicId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: portalKeys.booking(publicId) });
    void queryClient.invalidateQueries({ queryKey: ['portal', 'bookings'] });
    void queryClient.invalidateQueries({ queryKey: portalKeys.profile() });
  };
}

export function useCancelPortalBooking(
  publicId: string,
): UseMutationResult<PublicAppointment, unknown, { reason?: string }> {
  const invalidate = useInvalidateBooking(publicId);

  return useMutation({
    mutationFn: (body: { reason?: string }) =>
      api.post<PublicAppointment>(`/me/bookings/${encodeURIComponent(publicId)}/cancel`, body),
    // A policy refusal is the answer, not a transport fault; retrying would only
    // be refused again.
    retry: false,
    onSuccess: invalidate,
  });
}

export function useReschedulePortalBooking(
  publicId: string,
): UseMutationResult<PublicAppointment, unknown, { startsAt: string; reason?: string }> {
  const invalidate = useInvalidateBooking(publicId);

  return useMutation({
    mutationFn: (body: { startsAt: string; reason?: string }) =>
      api.post<PublicAppointment>(`/me/bookings/${encodeURIComponent(publicId)}/reschedule`, body),
    retry: false,
    onSuccess: invalidate,
  });
}

/**
 * One patch, applied to every linked workspace at once.
 *
 * That is the server's decision, not a shortcut taken here: the request may not
 * name a workspace, and somebody who no longer wants reminder emails wants them
 * to stop — not to be switched off once per business they have ever visited.
 */
export function useUpdatePortalPreferences(): UseMutationResult<
  PortalPreferencesView,
  unknown,
  Partial<PortalPreferences>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: Partial<PortalPreferences>) =>
      api.patch<PortalPreferencesView>('/me/preferences', patch),
    retry: false,
    onSuccess: (updated) => {
      // The response is the folded view of what was actually stored, so it is
      // written straight into the cache rather than triggering a second read.
      queryClient.setQueryData(portalKeys.preferences(), updated);
    },
  });
}
