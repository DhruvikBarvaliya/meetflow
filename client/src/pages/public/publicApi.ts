/**
 * The unauthenticated booking surface.
 *
 * Kept apart from the rest of the app's data layer on purpose: none of these
 * calls carry a token or a workspace header, and none of them may ever be given
 * one. The tenant is resolved server-side from the link slug alone.
 *
 * Every shape here is re-exported from `@/types/api`, which mirrors
 * `publicBooking.service.ts`. Declaring a convenient-but-wrong shape locally is
 * how a success page ends up linking to `/appointments/undefined`, so the
 * envelope is described exactly once.
 */
import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/apiClient';
import type {
  PublicAppointment,
  PublicAvailability,
  PublicBookingConfirmation,
  PublicBookingLink,
} from '@/types/api';

export type { PublicAvailability, PublicBookingConfirmation, PublicSlot } from '@/types/api';

/**
 * A custom-question answer, in the JSON type the server demands for it.
 *
 * `answerProblem()` server-side type-checks per question: NUMBER must be a
 * number, CHECKBOX a boolean, MULTI_SELECT an array of offered options. Sending
 * the raw string an `<input>` produces earns a 422.
 */
export type AnswerValue = string | number | boolean | string[];

export interface CreateBookingPayload {
  serviceId: string;
  staffProfileId?: string;
  locationId?: string;
  /** An ISO-8601 instant *with* its offset — the server rejects a bare local time. */
  startsAt: string;
  timezone: string;
  customer: { firstName: string; lastName?: string; email: string; phone?: string };
  customerNotes?: string;
  answers?: Record<string, AnswerValue>;
}

const linkBase = (slug: string) => `/public/booking-links/${encodeURIComponent(slug)}`;
const appointmentBase = (publicId: string) =>
  `/public/appointments/${encodeURIComponent(publicId)}`;

export function useBookingLink(slug: string): UseQueryResult<PublicBookingLink> {
  return useQuery({
    queryKey: ['public', 'link', slug],
    queryFn: () => api.get<PublicBookingLink>(linkBase(slug)),
    enabled: slug.length > 0,
    // The link's services and policy rarely change mid-session, and refetching
    // on window focus would restart the visitor's flow for no benefit.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export interface AvailabilityParams {
  serviceId: string | null;
  /**
   * Only ever set when the link permits a choice. The server answers 422 for a
   * provider sent to a link that assigns one itself, which would break the page
   * rather than merely be ignored.
   */
  staffProfileId?: string | null;
  locationId?: string | null;
  /** Inclusive calendar dates, read in `timezone`. */
  fromDate: string;
  toDate: string;
  timezone: string;
}

export function useAvailability(
  slug: string,
  params: AvailabilityParams,
  enabled = true,
): UseQueryResult<PublicAvailability> {
  return useQuery({
    queryKey: ['public', 'availability', slug, params],
    enabled: enabled && slug.length > 0 && Boolean(params.serviceId),
    queryFn: () =>
      api.get<PublicAvailability>(`${linkBase(slug)}/availability`, {
        params: {
          serviceId: params.serviceId,
          ...(params.staffProfileId ? { staffProfileId: params.staffProfileId } : {}),
          ...(params.locationId ? { locationId: params.locationId } : {}),
          fromDate: params.fromDate,
          toDate: params.toDate,
          timezone: params.timezone,
        },
      }),
    // Availability is the one thing that genuinely goes stale while the visitor
    // is deciding, so it is re-read whenever they return to the tab.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useCreateBooking(slug: string, idempotencyKey: string) {
  return useMutation<PublicBookingConfirmation, unknown, CreateBookingPayload>({
    mutationFn: (payload) =>
      api.post<PublicBookingConfirmation>(`${linkBase(slug)}/bookings`, payload, {
        // The same key for every attempt at *this* booking: a double-click, a
        // flaky connection or an impatient retry all resolve to one appointment.
        headers: { 'X-Idempotency-Key': idempotencyKey },
      }),
    // A lost slot race is a normal outcome here, not a transport failure —
    // an automatic retry would only lose the race again.
    retry: false,
  });
}

export function usePublicAppointment(publicId: string): UseQueryResult<PublicAppointment> {
  return useQuery({
    queryKey: ['public', 'appointment', publicId],
    queryFn: () => api.get<PublicAppointment>(appointmentBase(publicId)),
    enabled: publicId.length > 0,
    retry: false,
  });
}

export function useReschedulePublicAppointment(publicId: string) {
  return useMutation<PublicAppointment, unknown, { startsAt: string; reason?: string }>({
    mutationFn: (body) =>
      api.post<PublicAppointment>(`${appointmentBase(publicId)}/reschedule`, body),
    retry: false,
  });
}

export function useCancelPublicAppointment(publicId: string) {
  return useMutation<PublicAppointment, unknown, { reason?: string }>({
    mutationFn: (body) => api.post<PublicAppointment>(`${appointmentBase(publicId)}/cancel`, body),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Remembering which link an appointment was booked through
// ---------------------------------------------------------------------------

/**
 * Availability is only published per booking link, and an appointment does not
 * carry the slug it was booked through — so the manage page can only show a
 * slot grid when this browser happens to remember the link.
 *
 * When it does not (the usual case: the customer opened the link from their
 * confirmation email on another device) the page falls back to picking a date
 * and time outright and letting the server rule on it. Storing the slug is a
 * progressive enhancement, never a prerequisite.
 */
const SLUG_STORAGE_PREFIX = 'meetflow.booking-link.';

export function rememberBookingLink(publicId: string, slug: string): void {
  try {
    window.localStorage.setItem(`${SLUG_STORAGE_PREFIX}${publicId}`, slug);
  } catch {
    // Private browsing and full quotas both throw here. The manage page works
    // without this, so a failure to remember is not worth surfacing.
  }
}

export function recallBookingLink(publicId: string): string | null {
  try {
    return window.localStorage.getItem(`${SLUG_STORAGE_PREFIX}${publicId}`);
  } catch {
    return null;
  }
}
