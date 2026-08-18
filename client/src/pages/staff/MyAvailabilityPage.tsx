import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarOff,
  CalendarPlus,
  CalendarRange,
  Info,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { DateTime } from 'luxon';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  DataState,
  MINUTES_PER_DAY,
  OVERRIDE_REASONS,
  WEEK_ORDER,
  WeeklyWindowEditor,
  clockToMinutes,
  filterOptions,
  minutesToClock,
  ownerKeys,
  toSearchParams,
  useLocationsLookup,
  type AvailabilityOverride,
  type Holiday,
  type OverrideReason,
  type StaffAvailabilityRule,
  type WeeklyWindow,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ConfirmDialog,
  DatePicker,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  Switch,
  Tabs,
  Textarea,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { SOCKET_EVENTS, useSocketEvent } from '@/context/SocketContext';
import { ApiError, api } from '@/lib/apiClient';
import { formatDateLong, formatMinuteOfDay, humanizeEnum } from '@/lib/format';
import type { BusinessSettings } from '@/types/api';
import { FormBanner } from '@/pages/auth/FormBanner';
import { useMyStaffProfile } from './useMyStaffProfile';

const DEFAULT_SLOT_INTERVAL = 15;

const HORIZON_OPTIONS = [
  { value: '90', label: 'Next 3 months' },
  { value: '180', label: 'Next 6 months' },
  { value: '365', label: 'Next 12 months' },
];

// ---------------------------------------------------------------------------
// Weekly hours
// ---------------------------------------------------------------------------

/** Exactly the body `PUT /availability/staff/:id/rules` accepts. */
interface RulePayload {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  locationId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
}

/**
 * A row's validity period, carried through the editor without being shown.
 *
 * `effectiveFrom` / `effectiveTo` let a schedule change take effect on a future
 * date. The editor does not offer them, but dropping them on save would
 * silently widen a dated rule to "always", so they ride along keyed by window.
 */
type ValidityMap = Record<string, { effectiveFrom: string | null; effectiveTo: string | null }>;

interface WeekState {
  windows: WeeklyWindow[];
  validity: ValidityMap;
}

function toWeekState(rules: StaffAvailabilityRule[]): WeekState {
  const windows: WeeklyWindow[] = [];
  const validity: ValidityMap = {};

  for (const rule of rules) {
    windows.push({
      key: rule.id,
      dayOfWeek: rule.dayOfWeek,
      startTime: minutesToClock(rule.startMinute),
      endTime: minutesToClock(rule.endMinute),
      isActive: rule.isActive,
      locationId: rule.locationId,
    });
    validity[rule.id] = { effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo };
  }

  windows.sort(
    (a, b) =>
      WEEK_ORDER.indexOf(a.dayOfWeek as (typeof WEEK_ORDER)[number]) -
        WEEK_ORDER.indexOf(b.dayOfWeek as (typeof WEEK_ORDER)[number]) ||
      a.startTime.localeCompare(b.startTime),
  );

  return { windows, validity };
}

function sameWindows(a: WeeklyWindow[], b: WeeklyWindow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((window, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      window.key === other.key &&
      window.dayOfWeek === other.dayOfWeek &&
      window.startTime === other.startTime &&
      window.endTime === other.endTime &&
      window.isActive === other.isActive &&
      window.locationId === other.locationId
    );
  });
}

interface WeeklyHoursProps {
  staffProfileId: string;
  slotIntervalMinutes: number;
}

function WeeklyHours({ staffProfileId, slotIntervalMinutes }: WeeklyHoursProps): JSX.Element {
  const { activeBusinessId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const locations = useLocationsLookup();

  const rulesQuery = useQuery({
    queryKey: ownerKeys.staffRules(activeBusinessId, staffProfileId),
    queryFn: () =>
      api.getPage<StaffAvailabilityRule>(
        `/availability/staff/${staffProfileId}/rules${toSearchParams({ pageSize: 100 })}`,
      ),
  });

  const serverState = useMemo(() => toWeekState(rulesQuery.data?.items ?? []), [rulesQuery.data]);
  /** Null until the reader touches something — the stored rota shows through. */
  const [edits, setEdits] = useState<WeeklyWindow[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  /*
   * A fresh rota from the server discards an in-progress draft.
   *
   * `rulesQuery.data` keeps its identity across a refetch that returns the same
   * bytes — TanStack Query's structural sharing sees to that — so this fires
   * when the stored rota genuinely changed, not every time the window regains
   * focus.
   */
  useEffect(() => setEdits(null), [serverState]);

  const windows = edits ?? serverState.windows;
  const dirty = !sameWindows(windows, serverState.windows);

  const locationOptions = useMemo(
    () =>
      filterOptions(locations.items, 'Any location', (item) => ({
        value: item.id,
        label: item.name,
      })),
    [locations.items],
  );

  const save = useMutation({
    mutationFn: (rules: RulePayload[]) =>
      api.put<StaffAvailabilityRule[]>(`/availability/staff/${staffProfileId}/rules`, { rules }),
    onSuccess: () => {
      setSaveError(null);
      toast({ title: 'Working hours saved', tone: 'success' });
      void queryClient.invalidateQueries({
        queryKey: [...ownerKeys.root(activeBusinessId), 'availability'],
      });
    },
    onError: (error: unknown) => {
      setSaveError(
        error instanceof ApiError
          ? (error.details[0]?.message ?? error.message)
          : 'We could not save your hours. Please try again.',
      );
    },
  });

  const onSave = (): void => {
    // One check locally, because "a window must have a length" is worth saying
    // before a round trip. Everything else — overlaps, split shifts, validity
    // periods — is the server's to judge, and its messages are better than ours.
    if (windows.some((window) => window.startTime === window.endTime)) {
      setSaveError('A window must start and finish at different times.');
      return;
    }

    setSaveError(null);
    save.mutate(
      windows.map((window) => ({
        dayOfWeek: window.dayOfWeek,
        startTime: window.startTime,
        endTime: window.endTime,
        locationId: window.locationId,
        effectiveFrom: serverState.validity[window.key]?.effectiveFrom ?? null,
        effectiveTo: serverState.validity[window.key]?.effectiveTo ?? null,
        isActive: window.isActive,
      })),
    );
  };

  if (rulesQuery.isPending) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          {WEEK_ORDER.map((day) => (
            <Skeleton key={day} className="h-16 w-full" />
          ))}
        </CardBody>
      </Card>
    );
  }

  if (rulesQuery.isError) {
    return (
      <Card>
        <ErrorState error={rulesQuery.error} onRetry={() => void rulesQuery.refetch()} />
      </Card>
    );
  }

  const dated = windows.filter(
    (window) =>
      serverState.validity[window.key]?.effectiveFrom !== null ||
      serverState.validity[window.key]?.effectiveTo !== null,
  );

  return (
    <Card>
      <CardHeader
        as="h2"
        title="Weekly working hours"
        description="The pattern the booking engine offers your customers, week after week. A day with no window is a day you are not bookable."
      />
      <CardBody className="flex flex-col gap-4">
        <FormBanner message={saveError} />

        <WeeklyWindowEditor
          windows={windows}
          onChange={setEdits}
          stepMinutes={slotIntervalMinutes}
          locationOptions={locations.items.length > 0 ? locationOptions : undefined}
          disabled={save.isPending}
        />

        {dated.length > 0 ? (
          <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-3.5 py-2.5 text-xs leading-relaxed text-fg-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {dated.length} of these windows only applies between set dates. Those dates are kept as
            they are when you save; ask an owner or manager to change them.
          </p>
        ) : null}
      </CardBody>
      <CardFooter>
        <p className="mr-auto text-sm text-fg-muted" aria-live="polite">
          {windows.length} {windows.length === 1 ? 'window' : 'windows'} across the week
          {dirty ? ' · unsaved changes' : ''}
        </p>
        <Button
          variant="secondary"
          onClick={() => setEdits(null)}
          disabled={!dirty || save.isPending}
        >
          Discard
        </Button>
        <Button onClick={onSave} loading={save.isPending} disabled={!dirty}>
          Save working hours
        </Button>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Leave and one-off changes
// ---------------------------------------------------------------------------

const TIME_OFF_REASONS: OverrideReason[] = ['LEAVE', 'SICK', 'TRAINING', 'CUSTOM'];
const EXTRA_HOURS_REASONS: OverrideReason[] = ['EXTRA_HOURS', 'CUSTOM'];

/** A `<select>` yields a bare string; this is what turns it back into the enum. */
function isOverrideReason(value: string): value is OverrideReason {
  return (OVERRIDE_REASONS as readonly string[]).includes(value);
}

interface ExceptionsProps {
  staffProfileId: string;
  slotIntervalMinutes: number;
  timezone: string;
}

function Exceptions({
  staffProfileId,
  slotIntervalMinutes,
  timezone,
}: ExceptionsProps): JSX.Element {
  const { activeBusinessId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [horizon, setHorizon] = useState('180');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<AvailabilityOverride | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [kind, setKind] = useState<'TIME_OFF' | 'EXTRA_HOURS'>('TIME_OFF');
  const [date, setDate] = useState<string | null>(null);
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [reason, setReason] = useState<OverrideReason>('LEAVE');
  const [note, setNote] = useState('');

  const scope = useMemo(() => {
    const today = DateTime.now().setZone(timezone).startOf('day');
    return {
      staffProfileId,
      from: today.toISODate() ?? '',
      to: today.plus({ days: Number(horizon) }).toISODate() ?? '',
      pageSize: 100,
    };
  }, [timezone, horizon, staffProfileId]);

  const listQuery = useQuery({
    queryKey: ownerKeys.overrides(activeBusinessId, scope),
    queryFn: () =>
      api.getPage<AvailabilityOverride>(`/availability/overrides${toSearchParams(scope)}`),
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'availability'],
    });
  }, [queryClient, activeBusinessId]);

  useSocketEvent(SOCKET_EVENTS.availabilityUpdated, invalidate);

  const timeOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [];
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += slotIntervalMinutes) {
      options.push({ value: minutesToClock(minute), label: formatMinuteOfDay(minute) });
    }
    return options;
  }, [slotIntervalMinutes]);

  const endOptions = useMemo(
    () => [...timeOptions, { value: '24:00', label: 'midnight (end of day)' }],
    [timeOptions],
  );

  const resetForm = (): void => {
    setKind('TIME_OFF');
    setDate(DateTime.now().setZone(timezone).toISODate());
    setAllDay(true);
    setStartTime('09:00');
    setEndTime('17:00');
    setReason('LEAVE');
    setNote('');
    setFormError(null);
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<AvailabilityOverride>('/availability/overrides', body),
    onSuccess: () => {
      setDialogOpen(false);
      toast({ title: 'Exception added', tone: 'success' });
      invalidate();
    },
    onError: (error: unknown) => {
      setFormError(
        error instanceof ApiError
          ? error.requestId
            ? `${error.details[0]?.message ?? error.message} (reference ${error.requestId})`
            : (error.details[0]?.message ?? error.message)
          : 'We could not save that. Please try again.',
      );
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/availability/overrides/${id}`),
    onSuccess: () => {
      setDeleting(null);
      toast({ title: 'Exception removed', tone: 'success' });
      invalidate();
    },
    onError: (error: unknown) => {
      setDeleting(null);
      toast({
        title: 'Could not remove that exception',
        description: error instanceof ApiError ? error.message : 'Please try again in a moment.',
        tone: 'error',
      });
    },
  });

  const timed = kind === 'EXTRA_HOURS' || !allDay;

  const onSubmit = (): void => {
    if (date === null) {
      setFormError('Choose the date this applies to.');
      return;
    }
    if (timed && clockToMinutes(endTime) <= clockToMinutes(startTime)) {
      setFormError('The window must end after it starts.');
      return;
    }

    setFormError(null);
    create.mutate({
      scope: 'STAFF',
      staffProfileId,
      date,
      isAvailable: kind === 'EXTRA_HOURS',
      // Both bounds or neither: a half-specified window has no meaning to the API.
      startTime: timed ? startTime : null,
      endTime: timed ? endTime : null,
      reason,
      note: note.trim().length > 0 ? note.trim() : null,
    });
  };

  const items = listQuery.data?.items ?? [];
  const reasonOptions = (kind === 'EXTRA_HOURS' ? EXTRA_HOURS_REASONS : TIME_OFF_REASONS).map(
    (value) => ({ value, label: humanizeEnum(value) }),
  );

  const openDialog = (): void => {
    resetForm();
    setDialogOpen(true);
  };

  return (
    <>
      <Card>
        <CardHeader
          as="h2"
          title="Leave and one-off changes"
          description="Days that differ from your weekly pattern — time off, or hours you are working on top of it."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select
                options={HORIZON_OPTIONS}
                value={horizon}
                selectSize="sm"
                className="w-44"
                onChange={(event) => setHorizon(event.target.value)}
                aria-label="How far ahead to show exceptions"
              />
              <Button
                size="sm"
                leadingIcon={<CalendarPlus className="size-4" aria-hidden="true" />}
                onClick={openDialog}
              >
                Add an exception
              </Button>
            </div>
          }
        />

        <DataState
          isPending={listQuery.isPending}
          isError={listQuery.isError}
          error={listQuery.error}
          onRetry={() => void listQuery.refetch()}
          isEmpty={items.length === 0}
          rows={3}
          columns={3}
          empty={
            <EmptyState
              icon={<CalendarOff className="size-6" aria-hidden="true" />}
              title="No exceptions in this window"
              description="Your weekly pattern applies to every day between now and then. Add an exception when you need a day off or want to open extra hours."
              action={
                <Button
                  leadingIcon={<CalendarPlus className="size-4" aria-hidden="true" />}
                  onClick={openDialog}
                >
                  Add an exception
                </Button>
              }
            />
          }
        >
          <ul className="divide-y divide-border">
            {items.map((override) => (
              <li
                key={override.id}
                className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-fg">
                      {formatDateLong(override.date, timezone)}
                    </span>
                    <Badge tone={override.isAvailable ? 'success' : 'warning'} dot>
                      {override.isAvailable ? 'Extra hours' : 'Time off'}
                    </Badge>
                    {override.reason ? (
                      <Badge tone="neutral">{humanizeEnum(override.reason)}</Badge>
                    ) : null}
                  </div>
                  <p className="text-sm text-fg-secondary">
                    {override.startMinute === null || override.endMinute === null
                      ? 'All day'
                      : `${formatMinuteOfDay(override.startMinute)} – ${formatMinuteOfDay(
                          override.endMinute % MINUTES_PER_DAY,
                        )}`}
                  </p>
                  {override.note ? (
                    <p className="text-sm leading-relaxed text-fg-muted">{override.note}</p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-danger-text"
                  leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
                  onClick={() => setDeleting(override)}
                >
                  Remove
                  <span className="mf-sr-only">
                    {' '}
                    the exception on {formatDateLong(override.date, timezone)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </DataState>
      </Card>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Add an exception"
        description="This replaces your weekly pattern for one day."
        dismissOnBackdrop={false}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDialogOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button onClick={onSubmit} loading={create.isPending}>
              Add exception
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormBanner message={formError} />

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-fg">What is changing?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                {
                  value: 'TIME_OFF' as const,
                  label: 'Time off',
                  hint: 'Removes time your weekly pattern would offer.',
                },
                {
                  value: 'EXTRA_HOURS' as const,
                  label: 'Extra hours',
                  hint: 'Opens a window you do not normally work.',
                },
              ].map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                    kind === option.value
                      ? 'border-brand bg-brand-subtle'
                      : 'border-border bg-surface hover:bg-surface-hover'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="exception-kind"
                      value={option.value}
                      checked={kind === option.value}
                      onChange={() => {
                        setKind(option.value);
                        setReason(option.value === 'EXTRA_HOURS' ? 'EXTRA_HOURS' : 'LEAVE');
                        if (option.value === 'EXTRA_HOURS') setAllDay(false);
                      }}
                      className="mf-sr-only"
                    />
                    <span className="text-sm font-medium text-fg">{option.label}</span>
                  </span>
                  <span className="text-xs leading-relaxed text-fg-muted">{option.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <Field label="Date" required hint={`Read in ${timezone.replace(/_/g, ' ')}.`}>
            {(fieldProps) => (
              <DatePicker
                {...fieldProps}
                value={date}
                onChange={setDate}
                timezone={timezone}
                min={DateTime.now().setZone(timezone).toISODate() ?? undefined}
              />
            )}
          </Field>

          {kind === 'TIME_OFF' ? (
            <Switch
              checked={allDay}
              onCheckedChange={setAllDay}
              label="All day"
              description="Turn this off to take only part of the day."
            />
          ) : null}

          {timed ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From">
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    options={timeOptions}
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                )}
              </Field>
              <Field label="To">
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    options={endOptions}
                    value={endTime}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                )}
              </Field>
            </div>
          ) : null}

          <Field label="Reason">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                options={reasonOptions}
                value={reason}
                onChange={(event) => {
                  if (isOverrideReason(event.target.value)) setReason(event.target.value);
                }}
              />
            )}
          </Field>

          <Field label="Note" hint="Only your team sees this. Optional.">
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                maxLength={1000}
              />
            )}
          </Field>

          <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Time off cannot be taken over a day that already has bookings on it. Move or cancel them
            first and the API will accept the change.
          </p>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title="Remove this exception?"
        description={
          deleting
            ? `Your usual weekly pattern will apply again on ${formatDateLong(deleting.date, timezone)}.`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Workspace closures
// ---------------------------------------------------------------------------

/** Recurring holidays store their first occurrence, so the next one is derived. */
function nextOccurrence(holiday: Holiday, zone: string): DateTime {
  const base = DateTime.fromISO(holiday.date, { zone });
  if (!holiday.isRecurringAnnually) return base;
  const today = DateTime.now().setZone(zone).startOf('day');
  const thisYear = base.set({ year: today.year });
  return thisYear < today ? thisYear.plus({ years: 1 }) : thisYear;
}

function Closures({ timezone }: { timezone: string }): JSX.Element | null {
  const { activeBusinessId } = useAuth();
  const scope = { pageSize: 100, isActive: true };

  const holidaysQuery = useQuery({
    queryKey: ownerKeys.holidays(activeBusinessId, scope),
    queryFn: () => api.getPage<Holiday>(`/availability/holidays${toSearchParams(scope)}`),
    staleTime: 10 * 60_000,
  });

  const upcoming = useMemo(() => {
    const items = holidaysQuery.data?.items ?? [];
    return items
      .map((holiday) => ({ holiday, at: nextOccurrence(holiday, timezone) }))
      .sort((a, b) => a.at.toMillis() - b.at.toMillis())
      .slice(0, 5);
  }, [holidaysQuery.data, timezone]);

  // Silent when there is nothing to say: an empty card is noise, and a failed
  // read of a supporting list must not take the page down with it.
  if (holidaysQuery.isError || upcoming.length === 0) return null;

  return (
    <Card>
      <CardHeader
        as="h2"
        title="Workspace closures"
        description="Set by the workspace, not by you. Days marked closed remove availability for everyone."
      />
      <CardBody>
        <ul className="flex flex-col gap-2">
          {upcoming.map(({ holiday, at }) => (
            <li key={holiday.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium text-fg">{formatDateLong(at, timezone)}</span>
              <span className="text-fg-secondary">{holiday.name}</span>
              {holiday.closesBusiness ? (
                <Badge tone="warning">Closed</Badge>
              ) : (
                <Badge tone="neutral">Open, marked</Badge>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MyAvailabilityPage(): JSX.Element {
  const { activeBusinessId, activeTimezone } = useAuth();
  const { staffProfileId, profile, isLoading, isError, refetch } = useMyStaffProfile();
  const [tab, setTab] = useState<'hours' | 'exceptions'>('hours');

  const settingsQuery = useQuery({
    queryKey: ownerKeys.workspaceSettings(activeBusinessId),
    queryFn: () => api.get<BusinessSettings>('/workspace/settings'),
    staleTime: 10 * 60_000,
  });

  // The provider's own zone is the one their hours are written in; the
  // workspace's is the fallback the API itself uses.
  const zone = profile?.timezone ?? activeTimezone;
  const slotInterval = settingsQuery.data?.slotIntervalMinutes ?? DEFAULT_SLOT_INTERVAL;
  const description = `Your hours are read in ${zone.replace(/_/g, ' ')}. Changes take effect immediately for new bookings.`;

  if (isLoading) {
    return (
      <>
        <PageHeader title="My availability" description={description} />
        <Card>
          <CardBody className="flex flex-col gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </CardBody>
        </Card>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <PageHeader title="My availability" description={description} />
        <Card>
          {/* The roster lookup reports failure without surfacing the error
              object, so the generic presentation is the honest one here. */}
          <ErrorState
            error={null}
            onRetry={refetch}
            title="We could not work out whose hours to show"
          />
        </Card>
      </>
    );
  }

  if (staffProfileId === null) {
    return (
      <>
        <PageHeader title="My availability" description={description} />
        <Card>
          <EmptyState
            icon={<TriangleAlert className="size-6" aria-hidden="true" />}
            title="You have no provider profile here"
            description="Working hours belong to a provider profile, and your account does not have one in this workspace. An owner or manager can create it."
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="My availability"
        description={description}
        actions={
          profile ? (
            <Badge tone={profile.isBookable ? 'success' : 'warning'} dot>
              {profile.isBookable ? 'Bookable' : 'Not bookable'}
            </Badge>
          ) : null
        }
      />

      {profile && !profile.isBookable ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-md border border-warning-border bg-warning-subtle px-3.5 py-3 text-sm text-warning-text"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="leading-relaxed">
            Your profile is switched off for booking, so customers cannot book you whatever these
            hours say. An owner or manager can turn it back on.
          </p>
        </div>
      ) : null}

      <Tabs
        label="Availability sections"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'hours', label: 'Weekly hours', icon: <CalendarRange className="size-4" /> },
          {
            value: 'exceptions',
            label: 'Leave & one-offs',
            icon: <CalendarOff className="size-4" />,
          },
        ]}
      >
        {tab === 'hours' ? (
          <div className="flex flex-col gap-6">
            <WeeklyHours staffProfileId={staffProfileId} slotIntervalMinutes={slotInterval} />
            <Closures timezone={zone} />
          </div>
        ) : (
          <Exceptions
            staffProfileId={staffProfileId}
            slotIntervalMinutes={slotInterval}
            timezone={zone}
          />
        )}
      </Tabs>
    </>
  );
}
