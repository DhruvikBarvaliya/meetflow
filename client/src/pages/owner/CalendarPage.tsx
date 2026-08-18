import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import { DateTime } from 'luxon';
import { useCallback, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout';
import {
  APPOINTMENT_EVENTS,
  AppointmentDetailDrawer,
  DataState,
  FilterBar,
  FilterField,
  MonthGrid,
  TimeGrid,
  filterOptions,
  ownerKeys,
  toSearchParams,
  useLiveRefresh,
  useLocationsLookup,
  useServicesLookup,
  useStaffLookup,
  type CalendarEvent,
  type CalendarMeta,
} from '@/components/owner';
import { Button, Card, EmptyState, Select, Skeleton, Tabs } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import type { ApiSuccess } from '@/types/api';

type CalendarView = 'day' | 'week' | 'month';

/**
 * The diary, drawn.
 *
 * The window is always explicit: `GET /appointments/calendar` requires `from`
 * and `to` as offset-bearing instants and caps the span at 92 days, so a view
 * change computes a new window rather than paging through an open-ended list.
 *
 * Every date here is resolved in the workspace timezone. "This week" is the
 * business's week, which is the only reading that makes sense when the person
 * looking is in another country.
 */
export default function CalendarPage(): JSX.Element {
  const { activeBusinessId, activeTimezone } = useAuth();
  const queryClient = useQueryClient();
  const staff = useStaffLookup();
  const services = useServicesLookup();
  const locations = useLocationsLookup();

  const [view, setView] = useState<CalendarView>('week');
  const [anchorIso, setAnchorIso] = useState<string>(
    () => DateTime.now().setZone(activeTimezone).toISODate() ?? '',
  );
  const [staffFilter, setStaffFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const anchor = useMemo(
    () => DateTime.fromISO(anchorIso, { zone: activeTimezone }).startOf('day'),
    [anchorIso, activeTimezone],
  );

  /** The visible span, and the exact instants the API is asked for. */
  const window = useMemo(() => {
    if (view === 'day') return { start: anchor, end: anchor.endOf('day') };
    if (view === 'week') {
      const start = anchor.startOf('week');
      return { start, end: start.plus({ days: 6 }).endOf('day') };
    }
    // The month grid always draws six full weeks, so the query has to cover the
    // leading and trailing days too or those cells would render empty.
    const monthStart = anchor.startOf('month');
    const gridStart = monthStart.minus({ days: monthStart.weekday - 1 });
    return { start: gridStart, end: gridStart.plus({ days: 41 }).endOf('day') };
  }, [anchor, view]);

  const scope = {
    from: window.start.toISO() ?? '',
    to: window.end.toISO() ?? '',
    staffProfileId: staffFilter === '' ? undefined : staffFilter,
    serviceId: serviceFilter === '' ? undefined : serviceFilter,
    locationId: locationFilter === '' ? undefined : locationFilter,
  };

  const calendarQuery = useQuery({
    queryKey: ownerKeys.calendar(activeBusinessId, scope),
    queryFn: () =>
      api.getWithMeta<CalendarEvent[]>(`/appointments/calendar${toSearchParams(scope)}`),
    // The window is the unit here, so keeping the previous one on screen while
    // the next loads is what makes paging through weeks feel continuous.
    placeholderData: (previous: ApiSuccess<CalendarEvent[]> | undefined) => previous,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [...ownerKeys.root(activeBusinessId), 'appointments'],
    });
  }, [queryClient, activeBusinessId]);

  useLiveRefresh({ events: APPOINTMENT_EVENTS, onRefresh: refresh });

  const events = calendarQuery.data?.data ?? [];
  const meta = calendarQuery.data?.meta as unknown as CalendarMeta | undefined;

  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    if (view === 'week') {
      const start = anchor.startOf('week');
      return Array.from({ length: 7 }, (_, index) => start.plus({ days: index }));
    }
    return [];
  }, [view, anchor]);

  const step = (direction: 1 | -1): void => {
    const unit = view === 'day' ? 'days' : view === 'week' ? 'weeks' : 'months';
    setAnchorIso(anchor.plus({ [unit]: direction }).toISODate() ?? anchorIso);
  };

  const heading =
    view === 'month'
      ? anchor.toFormat('LLLL yyyy')
      : view === 'week'
        ? `${window.start.toFormat('d LLL')} – ${window.start.plus({ days: 6 }).toFormat('d LLL yyyy')}`
        : anchor.toFormat('cccc d LLLL yyyy');

  const openDay = (date: DateTime): void => {
    setAnchorIso(date.toISODate() ?? anchorIso);
    setView('day');
  };

  return (
    <>
      <PageHeader
        title="Calendar"
        description={`Shown in ${activeTimezone}, the workspace clock.`}
        actions={
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="icon"
              className="size-9"
              aria-label={`Previous ${view}`}
              onClick={() => step(-1)}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setAnchorIso(DateTime.now().setZone(activeTimezone).toISODate() ?? anchorIso)
              }
            >
              Today
            </Button>
            <Button
              variant="secondary"
              size="icon"
              className="size-9"
              aria-label={`Next ${view}`}
              onClick={() => step(1)}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight text-fg" aria-live="polite">
              {heading}
            </h2>
            <Tabs
              label="Calendar view"
              value={view}
              onValueChange={setView}
              items={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
              ]}
            />
          </div>

          <FilterBar>
            <FilterField label="Provider">
              {({ id }) => (
                <Select
                  id={id}
                  selectSize="sm"
                  value={staffFilter}
                  onChange={(event) => setStaffFilter(event.target.value)}
                  options={filterOptions(staff.items, 'Everyone', (profile) => ({
                    value: profile.id,
                    label: profile.displayName,
                  }))}
                />
              )}
            </FilterField>
            <FilterField label="Service">
              {({ id }) => (
                <Select
                  id={id}
                  selectSize="sm"
                  value={serviceFilter}
                  onChange={(event) => setServiceFilter(event.target.value)}
                  options={filterOptions(services.items, 'Every service', (service) => ({
                    value: service.id,
                    label: service.name,
                  }))}
                />
              )}
            </FilterField>
            <FilterField label="Location">
              {({ id }) => (
                <Select
                  id={id}
                  selectSize="sm"
                  value={locationFilter}
                  onChange={(event) => setLocationFilter(event.target.value)}
                  options={filterOptions(locations.items, 'Everywhere', (location) => ({
                    value: location.id,
                    label: location.name,
                  }))}
                />
              )}
            </FilterField>
          </FilterBar>
        </div>
      </PageHeader>

      {meta?.truncated === true ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-subtle px-3.5 py-2.5 text-sm text-warning-text"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          This window holds more appointments than the calendar can draw. Narrow it by provider or
          location, or switch to the day view, to be sure you are seeing everything.
        </p>
      ) : null}

      <Card className="overflow-hidden">
        <DataState
          isPending={calendarQuery.isPending}
          isError={calendarQuery.isError}
          error={calendarQuery.error}
          onRetry={() => void calendarQuery.refetch()}
          isEmpty={events.length === 0 && view !== 'month'}
          skeleton={
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          }
          empty={
            <EmptyState
              icon={<CalendarDays className="size-6" aria-hidden="true" />}
              title="Nothing booked in this window"
              description={
                staffFilter !== '' || serviceFilter !== '' || locationFilter !== ''
                  ? 'No appointment matches these filters here. Clear them, or move to another week.'
                  : 'Move to another week, or share a booking link so customers can fill it.'
              }
              action={
                staffFilter !== '' || serviceFilter !== '' || locationFilter !== '' ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setStaffFilter('');
                      setServiceFilter('');
                      setLocationFilter('');
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        >
          {view === 'month' ? (
            <MonthGrid
              anchor={anchor}
              events={events}
              zone={activeTimezone}
              onSelect={(event) => setSelectedId(event.id)}
              onOpenDay={openDay}
            />
          ) : (
            <TimeGrid
              days={days}
              events={events}
              zone={activeTimezone}
              onSelect={(event) => setSelectedId(event.id)}
            />
          )}
        </DataState>
      </Card>

      <AppointmentDetailDrawer
        appointmentId={selectedId}
        open={selectedId !== null}
        onClose={() => setSelectedId(null)}
      />
    </>
  );
}
