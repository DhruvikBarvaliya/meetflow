import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SOCKET_EVENTS, useSocketEvent, type SocketEventName } from '@/context/SocketContext';

/**
 * The events that mean "the diary you are looking at has moved".
 *
 * `dashboard.metrics_updated` is deliberately separate: it fires once per
 * booking change for the whole workspace, so a screen showing aggregates wants
 * it while a screen showing rows does not need it on top of the row events.
 */
export const APPOINTMENT_EVENTS: readonly SocketEventName[] = [
  SOCKET_EVENTS.appointmentCreated,
  SOCKET_EVENTS.appointmentUpdated,
  SOCKET_EVENTS.appointmentCancelled,
  SOCKET_EVENTS.appointmentRescheduled,
  SOCKET_EVENTS.appointmentCompleted,
  SOCKET_EVENTS.appointmentNoShow,
] as const;

/**
 * How long to wait before refetching after a live event.
 *
 * A single operator action fans out into several events (an appointment
 * update, a metrics update, sometimes a staff reassignment). Refetching on each
 * one would fire the dashboard's seven analytics queries three times over for
 * one booking, so they are coalesced into one pass.
 */
const COALESCE_MS = 400;

export interface LiveRefreshOptions {
  /** Which server events should trigger a refetch. */
  events: readonly SocketEventName[];
  /** Called once per coalesced burst. Invalidate whatever the screen shows. */
  onRefresh: () => void;
  /** Set false to suspend while a modal owns the screen. */
  enabled?: boolean;
}

/**
 * Refetches a screen when the server says its data changed.
 *
 * Returns the instant of the last refresh so a page can show "updated a moment
 * ago" — an aggregate that silently rewrites itself is unsettling without one.
 */
export function useLiveRefresh({ events, onRefresh, enabled = true }: LiveRefreshOptions): {
  lastUpdatedAt: Date | null;
} {
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const timerRef = useRef<number | null>(null);
  const refreshRef = useRef(onRefresh);

  useEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);

  const schedule = useCallback(() => {
    if (!enabled) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      refreshRef.current();
      setLastUpdatedAt(new Date());
    }, COALESCE_MS);
  }, [enabled]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // `useSocketEvent` subscribes to exactly one event, and hooks cannot be
  // called in a loop over a variable-length list — so the union is covered by
  // one subscription per known event, each a no-op when the caller opted out.
  const listen = (event: SocketEventName): void => {
    if (events.includes(event)) schedule();
  };

  useSocketEvent(SOCKET_EVENTS.appointmentCreated, () => listen(SOCKET_EVENTS.appointmentCreated));
  useSocketEvent(SOCKET_EVENTS.appointmentUpdated, () => listen(SOCKET_EVENTS.appointmentUpdated));
  useSocketEvent(SOCKET_EVENTS.appointmentCancelled, () =>
    listen(SOCKET_EVENTS.appointmentCancelled),
  );
  useSocketEvent(SOCKET_EVENTS.appointmentRescheduled, () =>
    listen(SOCKET_EVENTS.appointmentRescheduled),
  );
  useSocketEvent(SOCKET_EVENTS.appointmentCompleted, () =>
    listen(SOCKET_EVENTS.appointmentCompleted),
  );
  useSocketEvent(SOCKET_EVENTS.appointmentNoShow, () => listen(SOCKET_EVENTS.appointmentNoShow));
  useSocketEvent(SOCKET_EVENTS.dashboardMetricsUpdated, () =>
    listen(SOCKET_EVENTS.dashboardMetricsUpdated),
  );
  useSocketEvent(SOCKET_EVENTS.availabilityUpdated, () =>
    listen(SOCKET_EVENTS.availabilityUpdated),
  );
  useSocketEvent(SOCKET_EVENTS.waitlistSlotAvailable, () =>
    listen(SOCKET_EVENTS.waitlistSlotAvailable),
  );

  return { lastUpdatedAt };
}

/**
 * The common case: invalidate every query under one owner key prefix.
 *
 * Passing the prefix rather than a list of exact keys means a screen with five
 * filtered variants in cache refreshes all of them, including the one the user
 * is about to page back to.
 */
export function useInvalidatePrefix(prefix: readonly unknown[]): () => void {
  const queryClient = useQueryClient();
  const serialised = JSON.stringify(prefix);

  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: JSON.parse(serialised) as unknown[] });
  }, [queryClient, serialised]);
}
