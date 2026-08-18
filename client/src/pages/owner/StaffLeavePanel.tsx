import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { DateTime } from 'luxon';
import { useState } from 'react';
import {
  DataState,
  clockToMinutes,
  minutesToClock,
  ownerKeys,
  toSearchParams,
  type AvailabilityOverride,
  type OverrideReason,
} from '@/components/owner';
import {
  Badge,
  Button,
  ConfirmDialog,
  DatePicker,
  EmptyState,
  Field,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { formatDateLong, formatMinuteOfDay, humanizeEnum } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';

/** How far ahead the panel lists. A rota is planned in months, not years. */
const HORIZON_DAYS = 180;

const REASONS: OverrideReason[] = ['LEAVE', 'SICK', 'TRAINING', 'HOLIDAY', 'EXTRA_HOURS', 'CUSTOM'];

const TIME_STEP = 15;

function timeOptions(includeEndOfDay: boolean): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];
  for (let minute = 0; minute < 1440; minute += TIME_STEP) {
    options.push({ value: minutesToClock(minute), label: formatMinuteOfDay(minute) });
  }
  if (includeEndOfDay) options.push({ value: '24:00', label: 'midnight (end of day)' });
  return options;
}

const START_OPTIONS = timeOptions(false);
const END_OPTIONS = timeOptions(true);

export interface StaffLeavePanelProps {
  staffProfileId: string;
  /** The zone the dates are read in — this person's, not the browser's. */
  timezone: string;
}

/**
 * Leave, sickness and one-off extra hours for a single provider.
 *
 * An override is a single calendar day that contradicts the recurring rota:
 * either it removes availability the weekly rules would have offered, or it
 * adds a window they do not cover. Whole-day and part-day are the same record
 * with the times left out, which is why the form asks the question that way
 * round rather than making an operator blank two fields.
 */
export function StaffLeavePanel({ staffProfileId, timezone }: StaffLeavePanelProps): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const today = DateTime.now().setZone(timezone).startOf('day');
  const from = today.toISODate() ?? '';
  const to = today.plus({ days: HORIZON_DAYS }).toISODate() ?? '';

  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState<string>(from);
  const [wholeDay, setWholeDay] = useState(true);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [available, setAvailable] = useState(false);
  const [reason, setReason] = useState<OverrideReason>('LEAVE');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AvailabilityOverride | null>(null);

  const canManage =
    can(PERMISSIONS.AVAILABILITY_MANAGE) || can(PERMISSIONS.AVAILABILITY_MANAGE_OWN);

  const scope = { staffProfileId, from, to, pageSize: 100 };

  const listQuery = useQuery({
    queryKey: ownerKeys.overrides(activeBusinessId, scope),
    queryFn: () =>
      api.getPage<AvailabilityOverride>(`/availability/overrides${toSearchParams(scope)}`),
    enabled: can(PERMISSIONS.AVAILABILITY_READ),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'availability'],
    });
  };

  const create = useMutation<unknown, unknown, void>({
    mutationFn: () =>
      api.post('/availability/overrides', {
        scope: 'STAFF',
        staffProfileId,
        date,
        isAvailable: available,
        // Both bounds or neither: a half-specified window has no meaning, and
        // the API rejects it.
        startTime: wholeDay ? null : startTime,
        endTime: wholeDay ? null : endTime,
        reason,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setNote('');
      setFormError(null);
      toast({ tone: 'success', title: 'Day added' });
    },
    onError: (error) => {
      setFormError(
        isApiError(error)
          ? (error.details[0]?.message ?? error.message)
          : 'Could not save this day.',
      );
    },
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/availability/overrides/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      toast({ tone: 'success', title: 'Day removed' });
    },
    onError: (error) => {
      toast({
        tone: 'error',
        title: 'Could not remove that day',
        description: isApiError(error) ? error.message : undefined,
      });
      setDeleting(null);
    },
  });

  const items = listQuery.data?.items ?? [];
  const sameDayWindow = !wholeDay && clockToMinutes(endTime) <= clockToMinutes(startTime);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">Leave and one-off changes</h3>
        {canManage && !adding ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setAdding(true);
              setFormError(null);
            }}
            leadingIcon={<Plus className="size-4" aria-hidden="true" />}
          >
            Add a day
          </Button>
        ) : null}
      </div>

      {adding ? (
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-sunken p-4">
          {formError ? (
            <p
              role="alert"
              className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-text"
            >
              {formError}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" required hint={`Read in ${timezone}.`}>
              {(field) => (
                <DatePicker {...field} value={date} onChange={setDate} timezone={timezone} />
              )}
            </Field>
            <Field label="Reason">
              {(field) => (
                <Select
                  {...field}
                  value={reason}
                  onChange={(event) => setReason(event.target.value as OverrideReason)}
                  options={REASONS.map((entry) => ({
                    value: entry,
                    label: humanizeEnum(entry),
                  }))}
                />
              )}
            </Field>
          </div>

          <Switch
            checked={available}
            onCheckedChange={setAvailable}
            label={available ? 'Adds availability' : 'Removes availability'}
            description={
              available
                ? 'An extra window on a day the weekly rules do not cover.'
                : 'Time off — the weekly rules stop offering this period.'
            }
          />

          <Switch
            checked={wholeDay}
            onCheckedChange={setWholeDay}
            label="Whole day"
            description="Turn off to name a window inside the day."
          />

          {!wholeDay ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From">
                {(field) => (
                  <Select
                    {...field}
                    options={START_OPTIONS}
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                )}
              </Field>
              <Field
                label="To"
                error={sameDayWindow ? 'The window must end after it starts.' : undefined}
              >
                {(field) => (
                  <Select
                    {...field}
                    options={END_OPTIONS}
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                )}
              </Field>
            </div>
          ) : null}

          <Field label="Note" hint="Visible to your team only.">
            {(field) => (
              <Textarea
                {...field}
                rows={2}
                maxLength={1000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Family wedding — full day off."
              />
            )}
          </Field>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              loading={create.isPending}
              disabled={sameDayWindow}
              onClick={() => create.mutate()}
            >
              Save day
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <DataState
        isPending={listQuery.isPending}
        isError={listQuery.isError}
        error={listQuery.error}
        onRetry={() => void listQuery.refetch()}
        isEmpty={items.length === 0}
        rows={2}
        columns={3}
        empty={
          <EmptyState
            icon={<CalendarOff className="size-6" aria-hidden="true" />}
            title="No leave booked"
            description={`Nothing contradicts the weekly rota in the next ${HORIZON_DAYS} days.`}
          />
        }
      >
        <ul className="flex flex-col gap-2">
          {items.map((override) => (
            <li
              key={override.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">
                  {formatDateLong(override.date, timezone)}
                </p>
                <p className="text-xs text-fg-muted">
                  {override.startMinute === null || override.endMinute === null
                    ? 'Whole day'
                    : `${formatMinuteOfDay(override.startMinute)} – ${formatMinuteOfDay(
                        override.endMinute % 1440,
                      )}`}
                  {override.note ? ` · ${override.note}` : ''}
                </p>
              </div>

              <Badge tone={override.isAvailable ? 'success' : 'warning'}>
                {override.isAvailable ? 'Extra hours' : humanizeEnum(override.reason ?? 'LEAVE')}
              </Badge>

              {canManage ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-danger-text"
                  aria-label={`Remove the override on ${override.date}`}
                  onClick={() => setDeleting(override)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </DataState>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Remove the change on ${formatDateLong(deleting.date, timezone)}?` : ''}
        description="The weekly rota applies to that day again. Appointments already booked are not moved."
        confirmLabel="Remove it"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </section>
  );
}
