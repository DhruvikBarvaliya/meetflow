import {
  Ban,
  CalendarClock,
  CheckCheck,
  CircleCheck,
  LogIn,
  MoreHorizontal,
  UserX,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DropdownItem,
  DropdownMenu,
  Field,
  Textarea,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { PERMISSIONS } from '@/lib/permissions';
import type { AppointmentStatus } from '@/types/api';
import {
  TRANSITION_SPECS,
  availableTransitions,
  useAppointmentActions,
  type TransitionAction,
} from './useAppointmentActions';

const ACTION_ICONS: Record<TransitionAction, LucideIcon> = {
  approve: CircleCheck,
  reject: Ban,
  'check-in': LogIn,
  complete: CheckCheck,
  'no-show': UserX,
  cancel: Ban,
};

/** What the user is told they are about to do, before anything irreversible. */
const CONFIRMATIONS: Partial<Record<TransitionAction, { title: string; description: string }>> = {
  complete: {
    title: 'Mark this appointment complete?',
    description:
      'Completing records the appointment as delivered and counts it towards revenue. It cannot be undone.',
  },
  'no-show': {
    title: 'Mark this customer as a no-show?',
    description:
      "A no-show is final and shows on the customer's record. If they arrived late, check them in and complete the appointment instead.",
  },
};

export interface AppointmentActionsProps {
  appointment: { id: string; status: AppointmentStatus };
  /** Buttons in a drawer footer, a menu in a dense table row. */
  variant: 'buttons' | 'menu';
  /** Opens the reschedule dialog, which the parent owns. */
  onReschedule?: () => void;
  /** Called after any transition succeeds. */
  onCompleted?: () => void;
}

/**
 * Every lifecycle action a booking can take, filtered to the ones that will
 * work.
 *
 * The two that carry an explanation — cancel and reject — open a dialog rather
 * than firing straight away, because the reason is copied into the customer's
 * email and into the booking's history, and an operator who never sees the
 * field will never write one. The two that are irreversible but silent —
 * complete and no-show — get a confirmation instead.
 */
export function AppointmentActions({
  appointment,
  variant,
  onReschedule,
  onCompleted,
}: AppointmentActionsProps): JSX.Element | null {
  const { can } = useAuth();
  const { transition, isBusy, runningAction } = useAppointmentActions();
  const [reasonFor, setReasonFor] = useState<TransitionAction | null>(null);
  const [confirmFor, setConfirmFor] = useState<TransitionAction | null>(null);
  const [reason, setReason] = useState('');

  const actions = availableTransitions(appointment.status, can);
  const canReschedule =
    can(PERMISSIONS.APPOINTMENTS_RESCHEDULE) &&
    onReschedule !== undefined &&
    (['PENDING', 'CONFIRMED', 'RESCHEDULED'] as AppointmentStatus[]).includes(appointment.status);

  if (actions.length === 0 && !canReschedule) return null;

  const run = (action: TransitionAction, withReason?: string): void => {
    transition.mutate(
      { id: appointment.id, action, reason: withReason ?? null },
      { onSuccess: () => onCompleted?.() },
    );
  };

  const start = (action: TransitionAction): void => {
    if (TRANSITION_SPECS[action].takesReason) {
      setReason('');
      setReasonFor(action);
      return;
    }
    if (CONFIRMATIONS[action]) {
      setConfirmFor(action);
      return;
    }
    run(action);
  };

  const reasonSpec = reasonFor ? TRANSITION_SPECS[reasonFor] : null;
  const confirmation = confirmFor ? CONFIRMATIONS[confirmFor] : null;

  return (
    <>
      {variant === 'buttons' ? (
        <div className="flex flex-wrap items-center gap-2">
          {canReschedule ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onReschedule}
              disabled={isBusy}
              leadingIcon={<CalendarClock className="size-4" aria-hidden="true" />}
            >
              Move
            </Button>
          ) : null}

          {actions.map((action) => {
            const spec = TRANSITION_SPECS[action];
            const Icon = ACTION_ICONS[action];
            return (
              <Button
                key={action}
                size="sm"
                variant={spec.destructive ? 'outline' : 'primary'}
                className={spec.destructive ? 'text-danger-text' : undefined}
                onClick={() => start(action)}
                loading={runningAction === action}
                disabled={isBusy && runningAction !== action}
                leadingIcon={<Icon className="size-4" aria-hidden="true" />}
              >
                {spec.label}
              </Button>
            );
          })}
        </div>
      ) : (
        <DropdownMenu
          label={`Actions for this appointment`}
          trigger={({ ref, ...props }) => (
            <button
              ref={ref}
              {...props}
              type="button"
              aria-label="Appointment actions"
              className="inline-flex size-8 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          )}
        >
          {canReschedule ? (
            <DropdownItem
              onSelect={onReschedule}
              icon={<CalendarClock className="size-4" aria-hidden="true" />}
            >
              Move to another time
            </DropdownItem>
          ) : null}
          {actions.map((action) => {
            const spec = TRANSITION_SPECS[action];
            const Icon = ACTION_ICONS[action];
            return (
              <DropdownItem
                key={action}
                onSelect={() => start(action)}
                destructive={spec.destructive}
                icon={<Icon className="size-4" aria-hidden="true" />}
              >
                {spec.label}
              </DropdownItem>
            );
          })}
        </DropdownMenu>
      )}

      <Dialog
        open={reasonFor !== null}
        onClose={() => setReasonFor(null)}
        title={reasonSpec ? `${reasonSpec.label}?` : ''}
        description="The reason is stored on the booking's history and sent to the customer. Leave it blank if there is nothing to explain."
        width="sm"
        dismissOnBackdrop={false}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setReasonFor(null)}
              disabled={transition.isPending}
            >
              Keep this booking
            </Button>
            <Button
              variant="danger"
              loading={transition.isPending}
              onClick={() => {
                if (!reasonFor) return;
                const action = reasonFor;
                setReasonFor(null);
                run(action, reason.trim() === '' ? undefined : reason.trim());
              }}
            >
              {reasonSpec?.label ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <Field label="Reason" hint="Up to 500 characters.">
          {(field) => (
            <Textarea
              {...field}
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Studio closed for maintenance."
            />
          )}
        </Field>
      </Dialog>

      <ConfirmDialog
        open={confirmFor !== null}
        onCancel={() => setConfirmFor(null)}
        onConfirm={() => {
          if (!confirmFor) return;
          const action = confirmFor;
          setConfirmFor(null);
          run(action);
        }}
        title={confirmation?.title ?? ''}
        description={confirmation?.description ?? ''}
        confirmLabel={confirmFor ? TRANSITION_SPECS[confirmFor].label : 'Confirm'}
        cancelLabel="Not yet"
        destructive={confirmFor ? TRANSITION_SPECS[confirmFor].destructive : false}
        loading={transition.isPending}
      />
    </>
  );
}
