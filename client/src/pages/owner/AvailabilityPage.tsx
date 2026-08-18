import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange, CalendarX, Plus, Trash2, Umbrella } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/layout';
import {
  DataState,
  FilterField,
  WeeklyWindowEditor,
  clockToMinutes,
  filterOptions,
  minutesToClock,
  newWindowKey,
  ownerKeys,
  toSearchParams,
  useLocationsLookup,
  useResourcesLookup,
  useStaffLookup,
  type BlackoutPeriod,
  type BusinessHours,
  type Holiday,
  type WeeklyWindow,
} from '@/components/owner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  DatePicker,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Tabs,
  Textarea,
  TimePicker,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { formatDateLong, formatDateTime, humanizeEnum } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { FormBanner } from '@/pages/auth/FormBanner';

type Section = 'hours' | 'holidays' | 'blackouts';

/** Mirrors `BLACKOUT_REASONS` on the server. */
const BLACKOUT_REASONS = [
  'MAINTENANCE',
  'PUBLIC_HOLIDAY',
  'PRIVATE_EVENT',
  'EMERGENCY',
  'CUSTOM',
] as const;

/** Mirrors `BLACKOUT_SCOPES`; each scope names exactly one kind of target. */
type BlackoutScopeValue = 'BUSINESS' | 'LOCATION' | 'STAFF' | 'RESOURCE';

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

function OpeningHoursPanel(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const locations = useLocationsLookup();

  const [locationId, setLocationId] = useState('');
  const [windows, setWindows] = useState<WeeklyWindow[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canManage = can(PERMISSIONS.AVAILABILITY_MANAGE);
  const scopeKey = locationId === '' ? null : locationId;

  const hoursQuery = useQuery({
    queryKey: ownerKeys.businessHours(activeBusinessId, scopeKey),
    queryFn: () =>
      api.getPage<BusinessHours>(
        `/availability/business-hours${toSearchParams({
          pageSize: 100,
          locationId: locationId === '' ? undefined : locationId,
        })}`,
      ),
  });

  useEffect(() => {
    if (!hoursQuery.data) return;
    setWindows(
      hoursQuery.data.items.map((row) => ({
        key: newWindowKey(),
        dayOfWeek: row.dayOfWeek,
        startTime: minutesToClock(row.startMinute),
        endTime: minutesToClock(row.endMinute),
        isActive: row.isActive,
        locationId: row.locationId,
      })),
    );
  }, [hoursQuery.data]);

  const save = useMutation<unknown, unknown, void>({
    mutationFn: () =>
      api.put('/availability/business-hours', {
        locationId: locationId === '' ? null : locationId,
        hours: windows.map((window) => ({
          dayOfWeek: window.dayOfWeek,
          startTime: window.startTime,
          endTime: window.endTime,
          isActive: window.isActive,
        })),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...ownerKeys.root(activeBusinessId), 'availability'],
      });
      setSaveError(null);
      toast({ tone: 'success', title: 'Opening hours saved' });
    },
    onError: (error) => {
      setSaveError(
        isApiError(error)
          ? (error.details[0]?.message ?? error.message)
          : 'Could not save these opening hours.',
      );
    },
  });

  const weeklyHours = windows
    .filter((window) => window.isActive)
    .reduce((total, window) => {
      const start = clockToMinutes(window.startTime);
      const end = clockToMinutes(window.endTime);
      return total + (end > start ? end - start : end + 1440 - start);
    }, 0);

  return (
    <Card>
      <CardHeader
        as="h2"
        title="Opening hours"
        description={`Wall-clock windows in ${activeTimezone}. Nothing outside them is ever offered, whatever a staff rota says.`}
        actions={
          <FilterField label="Scope">
            {({ id }) => (
              <Select
                id={id}
                selectSize="sm"
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                options={filterOptions(locations.items, 'Whole workspace', (location) => ({
                  value: location.id,
                  label: location.name,
                }))}
              />
            )}
          </FilterField>
        }
      />

      <CardBody className="flex flex-col gap-4">
        {hoursQuery.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
        ) : (
          <>
            {saveError ? <FormBanner message={saveError} /> : null}

            <p className="text-sm text-fg-muted">
              {locationId === ''
                ? 'These are the hours every location inherits unless it sets its own.'
                : 'These hours replace the workspace-wide set for this location.'}{' '}
              Currently {(weeklyHours / 60).toFixed(1)} hours a week.
            </p>

            <WeeklyWindowEditor windows={windows} onChange={setWindows} disabled={!canManage} />
          </>
        )}
      </CardBody>

      {canManage && !hoursQuery.isPending ? (
        <CardFooter>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save opening hours
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

function HolidaysPanel(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const locations = useLocationsLookup();

  const today = DateTime.now().setZone(activeTimezone).startOf('day');
  const scope = {
    from: today.minus({ months: 1 }).toISODate() ?? '',
    to: today.plus({ months: 18 }).toISODate() ?? '',
    pageSize: 100,
  };

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [date, setDate] = useState(today.toISODate() ?? '');
  const [locationId, setLocationId] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [closes, setCloses] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Holiday | null>(null);

  const canManage = can(PERMISSIONS.AVAILABILITY_MANAGE);

  const listQuery = useQuery({
    queryKey: ownerKeys.holidays(activeBusinessId, scope),
    queryFn: () => api.getPage<Holiday>(`/availability/holidays${toSearchParams(scope)}`),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'availability'],
    });
  };

  const create = useMutation<unknown, unknown, void>({
    mutationFn: () =>
      api.post('/availability/holidays', {
        name,
        date,
        locationId: locationId === '' ? null : locationId,
        isRecurringAnnually: recurring,
        closesBusiness: closes,
      }),
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setName('');
      setError(null);
      toast({ tone: 'success', title: 'Holiday added' });
    },
    onError: (mutationError) => {
      setError(
        isApiError(mutationError)
          ? (mutationError.details[0]?.message ?? mutationError.message)
          : 'Could not add this holiday.',
      );
    },
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/availability/holidays/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      toast({ tone: 'success', title: 'Holiday removed' });
    },
    onError: (mutationError) => {
      toast({
        tone: 'error',
        title: 'Could not remove that holiday',
        description: isApiError(mutationError) ? mutationError.message : undefined,
      });
      setDeleting(null);
    },
  });

  const items = listQuery.data?.items ?? [];

  return (
    <>
      <Card>
        <CardHeader
          as="h2"
          title="Holidays"
          description="Days the workspace observes. A holiday that closes the business removes every slot on it."
          actions={
            canManage ? (
              <Button
                size="sm"
                onClick={() => setAdding(true)}
                leadingIcon={<Plus className="size-4" aria-hidden="true" />}
              >
                Add holiday
              </Button>
            ) : null
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
              icon={<Umbrella className="size-6" aria-hidden="true" />}
              title="No holidays on file"
              description="Add the days you close so customers are never offered a slot you cannot honour."
              action={
                canManage ? (
                  <Button
                    onClick={() => setAdding(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Add holiday
                  </Button>
                ) : null
              }
            />
          }
        >
          <ul className="divide-y divide-border">
            {items.map((holiday) => (
              <li key={holiday.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">{holiday.name}</p>
                  <p className="text-xs tabular-nums text-fg-muted">
                    {formatDateLong(holiday.date, activeTimezone)}
                    {holiday.locationId
                      ? ` · ${
                          locations.items.find((location) => location.id === holiday.locationId)
                            ?.name ?? 'one location'
                        }`
                      : ' · every location'}
                  </p>
                </div>
                {holiday.isRecurringAnnually ? <Badge tone="info">Every year</Badge> : null}
                <Badge tone={holiday.closesBusiness ? 'warning' : 'neutral'}>
                  {holiday.closesBusiness ? 'Closed' : 'Marked only'}
                </Badge>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-danger-text"
                    aria-label={`Remove ${holiday.name}`}
                    onClick={() => setDeleting(holiday)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </DataState>
      </Card>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a holiday"
        width="md"
        dismissOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={name.trim() === ''}
              onClick={() => create.mutate()}
            >
              Add holiday
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormBanner message={error} />

          <Field label="Name" required>
            {(field) => (
              <Input
                {...field}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Republic Day"
                maxLength={160}
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" required>
              {(field) => (
                <DatePicker {...field} value={date} onChange={setDate} timezone={activeTimezone} />
              )}
            </Field>
            <Field label="Location" hint="Leave open for every site.">
              {(field) => (
                <Select
                  {...field}
                  value={locationId}
                  onChange={(event) => setLocationId(event.target.value)}
                  options={filterOptions(locations.items, 'Every location', (location) => ({
                    value: location.id,
                    label: location.name,
                  }))}
                />
              )}
            </Field>
          </div>

          <Checkbox
            label="Repeats every year"
            description="Same month and day, from this date onwards."
            checked={recurring}
            onChange={() => setRecurring((current) => !current)}
          />
          <Checkbox
            label="Closes the business"
            description="Turn off to label the day for customers without removing any availability."
            checked={closes}
            onChange={() => setCloses((current) => !current)}
          />
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title={deleting ? `Remove ${deleting.name}?` : ''}
        description="Slots on that day become bookable again. Appointments already booked are unaffected."
        confirmLabel="Remove holiday"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Blackouts
// ---------------------------------------------------------------------------

function BlackoutsPanel(): JSX.Element {
  const { activeBusinessId, activeTimezone, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const locations = useLocationsLookup();
  const staff = useStaffLookup();
  const resources = useResourcesLookup();

  /*
   * Snapped to midnight before it reaches a query key.
   *
   * The blackout endpoint bounds its window with instants rather than dates, so
   * an unrounded `now` would put the current millisecond in the key and make
   * every render a different query — an infinite refetch loop rather than a
   * stale cache.
   */
  const now = DateTime.now().setZone(activeTimezone).startOf('day');
  const scope = {
    from: now.minus({ days: 30 }).toISO() ?? '',
    to: now.plus({ days: 180 }).toISO() ?? '',
    pageSize: 100,
  };

  const [adding, setAdding] = useState(false);
  const [blackoutScope, setBlackoutScope] = useState<BlackoutScopeValue>('BUSINESS');
  const [targetId, setTargetId] = useState('');
  const [startDate, setStartDate] = useState(now.toISODate() ?? '');
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState(now.toISODate() ?? '');
  const [endTime, setEndTime] = useState('17:00');
  const [reason, setReason] = useState<string>('CUSTOM');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<BlackoutPeriod | null>(null);

  const canManage = can(PERMISSIONS.AVAILABILITY_MANAGE);

  const listQuery = useQuery({
    queryKey: ownerKeys.blackouts(activeBusinessId, scope),
    queryFn: () => api.getPage<BlackoutPeriod>(`/availability/blackouts${toSearchParams(scope)}`),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'availability'],
    });
  };

  const create = useMutation<unknown, unknown, void>({
    mutationFn: () => {
      const startsAt = DateTime.fromISO(`${startDate}T${startTime}`, {
        zone: activeTimezone,
      }).toISO();
      const endsAt = DateTime.fromISO(`${endDate}T${endTime}`, { zone: activeTimezone }).toISO();

      return api.post('/availability/blackouts', {
        scope: blackoutScope,
        // Each scope names exactly one target, mirroring the database's own
        // check constraint; anything else is a 422.
        locationId: blackoutScope === 'LOCATION' ? targetId : null,
        staffProfileId: blackoutScope === 'STAFF' ? targetId : null,
        resourceId: blackoutScope === 'RESOURCE' ? targetId : null,
        startsAt,
        endsAt,
        reason,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setNote('');
      setError(null);
      toast({ tone: 'success', title: 'Blackout added' });
    },
    onError: (mutationError) => {
      setError(
        isApiError(mutationError)
          ? (mutationError.details[0]?.message ?? mutationError.message)
          : 'Could not add this blackout.',
      );
    },
  });

  const remove = useMutation<void, unknown, string>({
    mutationFn: (id) => api.delete(`/availability/blackouts/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      toast({ tone: 'success', title: 'Blackout removed' });
    },
    onError: (mutationError) => {
      toast({
        tone: 'error',
        title: 'Could not remove that blackout',
        description: isApiError(mutationError) ? mutationError.message : undefined,
      });
      setDeleting(null);
    },
  });

  const targetOptions =
    blackoutScope === 'LOCATION'
      ? locations.items.map((location) => ({ value: location.id, label: location.name }))
      : blackoutScope === 'STAFF'
        ? staff.items.map((profile) => ({ value: profile.id, label: profile.displayName }))
        : blackoutScope === 'RESOURCE'
          ? resources.items.map((resource) => ({ value: resource.id, label: resource.name }))
          : [];

  const describeTarget = (blackout: BlackoutPeriod): string => {
    if (blackout.scope === 'BUSINESS') return 'Whole workspace';
    if (blackout.scope === 'LOCATION') {
      return (
        locations.items.find((location) => location.id === blackout.locationId)?.name ??
        'One location'
      );
    }
    if (blackout.scope === 'STAFF') {
      return (
        staff.items.find((profile) => profile.id === blackout.staffProfileId)?.displayName ??
        'One provider'
      );
    }
    return (
      resources.items.find((resource) => resource.id === blackout.resourceId)?.name ??
      'One resource'
    );
  };

  const items = listQuery.data?.items ?? [];

  return (
    <>
      <Card>
        <CardHeader
          as="h2"
          title="Blackouts"
          description="A period nothing may be booked into — a refit, a private event, a closure. Unlike a holiday, it is bounded by instants rather than a calendar day."
          actions={
            canManage ? (
              <Button
                size="sm"
                onClick={() => setAdding(true)}
                leadingIcon={<Plus className="size-4" aria-hidden="true" />}
              >
                Add blackout
              </Button>
            ) : null
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
              icon={<CalendarX className="size-6" aria-hidden="true" />}
              title="No blackouts"
              description="Nothing is blocked out in the next six months."
              action={
                canManage ? (
                  <Button
                    onClick={() => setAdding(true)}
                    leadingIcon={<Plus className="size-4" aria-hidden="true" />}
                  >
                    Add blackout
                  </Button>
                ) : null
              }
            />
          }
        >
          <ul className="divide-y divide-border">
            {items.map((blackout) => (
              <li key={blackout.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">{describeTarget(blackout)}</p>
                  <p className="text-xs tabular-nums text-fg-muted">
                    {formatDateTime(blackout.startsAt, activeTimezone)} –{' '}
                    {formatDateTime(blackout.endsAt, activeTimezone)}
                  </p>
                  {blackout.note ? (
                    <p className="mt-0.5 truncate text-xs italic text-fg-muted">{blackout.note}</p>
                  ) : null}
                </div>
                <Badge tone="warning">{humanizeEnum(blackout.reason)}</Badge>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-danger-text"
                    aria-label="Remove this blackout"
                    onClick={() => setDeleting(blackout)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </DataState>
      </Card>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a blackout"
        description={`Times are entered in ${activeTimezone}.`}
        width="md"
        dismissOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={blackoutScope !== 'BUSINESS' && targetId === ''}
              onClick={() => create.mutate()}
            >
              Add blackout
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormBanner message={error} />

          <Field label="Applies to" required>
            {(field) => (
              <Select
                {...field}
                value={blackoutScope}
                onChange={(event) => {
                  setBlackoutScope(event.target.value as BlackoutScopeValue);
                  setTargetId('');
                }}
                options={[
                  { value: 'BUSINESS', label: 'The whole workspace' },
                  { value: 'LOCATION', label: 'One location' },
                  { value: 'STAFF', label: 'One provider' },
                  { value: 'RESOURCE', label: 'One resource' },
                ]}
              />
            )}
          </Field>

          {blackoutScope !== 'BUSINESS' ? (
            <Field label="Which one" required>
              {(field) => (
                <Select
                  {...field}
                  value={targetId}
                  onChange={(event) => setTargetId(event.target.value)}
                  placeholder="Choose one"
                  options={targetOptions}
                />
              )}
            </Field>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts on" required>
              {(field) => (
                <DatePicker
                  {...field}
                  value={startDate}
                  onChange={setStartDate}
                  timezone={activeTimezone}
                />
              )}
            </Field>
            <Field label="Starts at" required>
              {(field) => <TimePicker {...field} value={startTime} onChange={setStartTime} />}
            </Field>
            <Field label="Ends on" required>
              {(field) => (
                <DatePicker
                  {...field}
                  value={endDate}
                  onChange={setEndDate}
                  timezone={activeTimezone}
                  min={startDate}
                />
              )}
            </Field>
            <Field label="Ends at" required>
              {(field) => <TimePicker {...field} value={endTime} onChange={setEndTime} />}
            </Field>
          </div>

          <Field label="Reason">
            {(field) => (
              <Select
                {...field}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                options={BLACKOUT_REASONS.map((entry) => ({
                  value: entry,
                  label: humanizeEnum(entry),
                }))}
              />
            )}
          </Field>

          <Field label="Note" hint="Visible to your team only.">
            {(field) => (
              <Textarea
                {...field}
                rows={2}
                maxLength={1000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Studio floor being refinished."
              />
            )}
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        title="Remove this blackout?"
        description="That period becomes bookable again."
        confirmLabel="Remove blackout"
        cancelLabel="Keep it"
        destructive
        loading={remove.isPending}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Everything that decides when the workspace is open, above the level of one
 * person's rota.
 *
 * A staff member's own working hours and leave live on their profile, because
 * that is where an operator looks for them; this page owns the three rules that
 * apply to everybody — opening hours, holidays and blackouts.
 */
export default function AvailabilityPage(): JSX.Element {
  const [section, setSection] = useState<Section>('hours');

  return (
    <>
      <PageHeader
        title="Availability"
        description="When the workspace is open, when it is closed, and the periods nothing may be booked into."
      >
        <Tabs
          label="Availability sections"
          value={section}
          onValueChange={setSection}
          items={[
            { value: 'hours', label: 'Opening hours', icon: <CalendarRange className="size-4" /> },
            { value: 'holidays', label: 'Holidays', icon: <Umbrella className="size-4" /> },
            { value: 'blackouts', label: 'Blackouts', icon: <CalendarX className="size-4" /> },
          ]}
        />
      </PageHeader>

      {section === 'hours' ? (
        <OpeningHoursPanel />
      ) : section === 'holidays' ? (
        <HolidaysPanel />
      ) : (
        <BlackoutsPanel />
      )}
    </>
  );
}
