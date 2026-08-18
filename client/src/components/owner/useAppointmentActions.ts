import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useToast } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions';
import type { Appointment, AppointmentStatus } from '@/types/api';
import { ownerKeys } from './queryKeys';
import { canTransition } from './types';

/**
 * The appointment lifecycle, as the management surface drives it.
 *
 * The server gives each transition its own endpoint because each has its own
 * consequences — cancelling releases the reservation and mails the customer,
 * completing does neither — so this never becomes "PATCH the status field".
 *
 * The six plain transitions share one mutation keyed by action rather than six
 * near-identical ones: they differ only in the path they post to and the words
 * they report, and six copies would drift on the invalidation, which is the
 * part that matters.
 *
 * Every success invalidates the whole appointments prefix rather than patching
 * the cached row. A reschedule moves the booking between calendar windows and
 * changes a staff member's workload; reconciling that by hand is how a diary
 * ends up showing the same appointment twice.
 */

export const TRANSITIONS = [
  'approve',
  'reject',
  'check-in',
  'complete',
  'no-show',
  'cancel',
] as const;

export type TransitionAction = (typeof TRANSITIONS)[number];

interface TransitionSpec {
  /** The verb an operator would use, for buttons and menu items. */
  label: string;
  successTitle: string;
  failureTitle: string;
  /** Whether the endpoint accepts an explanation. */
  takesReason: boolean;
  permission: PermissionKey;
  /**
   * The status the transition lands on, used to hide actions the state machine
   * would refuse. `check-in` is absent because it stamps an arrival time
   * without changing status.
   */
  resultingStatus: AppointmentStatus | null;
  destructive: boolean;
}

export const TRANSITION_SPECS: Record<TransitionAction, TransitionSpec> = {
  approve: {
    label: 'Approve',
    successTitle: 'Booking approved',
    failureTitle: 'Could not approve this booking',
    takesReason: false,
    permission: PERMISSIONS.APPOINTMENTS_APPROVE,
    resultingStatus: 'CONFIRMED',
    destructive: false,
  },
  reject: {
    label: 'Reject',
    successTitle: 'Booking rejected',
    failureTitle: 'Could not reject this booking',
    takesReason: true,
    permission: PERMISSIONS.APPOINTMENTS_APPROVE,
    resultingStatus: 'REJECTED',
    destructive: true,
  },
  'check-in': {
    label: 'Check in',
    successTitle: 'Customer checked in',
    failureTitle: 'Could not check this customer in',
    takesReason: false,
    permission: PERMISSIONS.APPOINTMENTS_COMPLETE,
    resultingStatus: null,
    destructive: false,
  },
  complete: {
    label: 'Mark complete',
    successTitle: 'Appointment completed',
    failureTitle: 'Could not complete this appointment',
    takesReason: false,
    permission: PERMISSIONS.APPOINTMENTS_COMPLETE,
    resultingStatus: 'COMPLETED',
    destructive: false,
  },
  'no-show': {
    label: 'Mark no-show',
    successTitle: 'Marked as a no-show',
    failureTitle: 'Could not mark this as a no-show',
    takesReason: false,
    permission: PERMISSIONS.APPOINTMENTS_NO_SHOW,
    resultingStatus: 'NO_SHOW',
    destructive: true,
  },
  cancel: {
    label: 'Cancel booking',
    successTitle: 'Appointment cancelled',
    failureTitle: 'Could not cancel this appointment',
    takesReason: true,
    permission: PERMISSIONS.APPOINTMENTS_CANCEL,
    resultingStatus: 'CANCELLED',
    destructive: true,
  },
};

/** Statuses in which an arrival can still be recorded. */
const CHECK_IN_STATUSES: readonly AppointmentStatus[] = [
  'PENDING',
  'CONFIRMED',
  'RESCHEDULED',
  'IN_PROGRESS',
];

export interface TransitionVariables {
  id: string;
  action: TransitionAction;
  reason?: string | null;
}

export interface RescheduleInput {
  /** An offset-bearing instant; the API refuses a bare local time. */
  startsAt: string;
  staffProfileId?: string;
  locationId?: string;
  reason?: string | null;
}

export interface UpdateNotesInput {
  title?: string | null;
  customerNotes?: string | null;
  internalNotes?: string | null;
}

export interface AppointmentActions {
  transition: UseMutationResult<Appointment, unknown, TransitionVariables>;
  reschedule: UseMutationResult<Appointment, unknown, { id: string; input: RescheduleInput }>;
  updateNotes: UseMutationResult<Appointment, unknown, { id: string; input: UpdateNotesInput }>;
  /** True while any transition is in flight, for disabling a whole action set. */
  isBusy: boolean;
  /** The action currently running, so one button spins rather than all of them. */
  runningAction: TransitionAction | null;
}

export function useAppointmentActions(): AppointmentActions {
  const { activeBusinessId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidate = useCallback(() => {
    const scope = ownerKeys.root(activeBusinessId);
    void queryClient.invalidateQueries({ queryKey: [...scope, 'appointments'] });
    // A customer's counters and the analytics aggregates both move when a
    // booking does, and both are on screen next to the diary often enough that
    // leaving them stale is visible.
    void queryClient.invalidateQueries({ queryKey: [...scope, 'customers'] });
    void queryClient.invalidateQueries({ queryKey: [...scope, 'analytics'] });
    void queryClient.invalidateQueries({ queryKey: [...scope, 'waitlist'] });
  }, [queryClient, activeBusinessId]);

  const reportFailure = useCallback(
    (error: unknown, fallback: string) => {
      toast({
        tone: 'error',
        title: fallback,
        description: isApiError(error) ? error.message : undefined,
      });
    },
    [toast],
  );

  const transition = useMutation<Appointment, unknown, TransitionVariables>({
    mutationFn: ({ id, action, reason }) =>
      api.post<Appointment>(
        `/appointments/${id}/${action}`,
        TRANSITION_SPECS[action].takesReason ? { reason: reason ?? null } : {},
      ),
    onSuccess: (_data, variables) => {
      invalidate();
      toast({ tone: 'success', title: TRANSITION_SPECS[variables.action].successTitle });
    },
    onError: (error, variables) =>
      reportFailure(error, TRANSITION_SPECS[variables.action].failureTitle),
  });

  const reschedule = useMutation<Appointment, unknown, { id: string; input: RescheduleInput }>({
    mutationFn: ({ id, input }) => api.post<Appointment>(`/appointments/${id}/reschedule`, input),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Appointment moved' });
    },
    onError: (error) => reportFailure(error, 'Could not move this appointment'),
  });

  const updateNotes = useMutation<Appointment, unknown, { id: string; input: UpdateNotesInput }>({
    mutationFn: ({ id, input }) => api.patch<Appointment>(`/appointments/${id}`, input),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Notes saved' });
    },
    onError: (error) => reportFailure(error, 'Could not save these notes'),
  });

  return {
    transition,
    reschedule,
    updateNotes,
    isBusy: transition.isPending || reschedule.isPending,
    runningAction: transition.isPending ? (transition.variables?.action ?? null) : null,
  };
}

/**
 * The transitions worth offering for a booking in this state, to this member.
 *
 * Both halves matter. Hiding what the state machine would refuse stops a button
 * whose only outcome is a 409; hiding what the role lacks stops one whose only
 * outcome is a 403. Neither is a security measure — the server decides — but an
 * action list that is honest about what will work is the difference between a
 * tool and a guessing game.
 */
export function availableTransitions(
  status: AppointmentStatus,
  can: (permission: PermissionKey) => boolean,
): TransitionAction[] {
  return TRANSITIONS.filter((action) => {
    const spec = TRANSITION_SPECS[action];
    if (!can(spec.permission)) return false;
    if (spec.resultingStatus === null) return CHECK_IN_STATUSES.includes(status);
    return canTransition(status, spec.resultingStatus);
  });
}
