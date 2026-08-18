import { Plus, X } from 'lucide-react';
import { useMemo } from 'react';
import { Button, Checkbox, Select, type SelectOption } from '@/components/ui';
import { formatMinuteOfDay } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * The weekly rota editor, shared by business hours and staff availability.
 *
 * Both are the same idea at two scopes — a set of wall-clock windows per
 * weekday — and both are replaced wholesale by a PUT rather than patched, so
 * one editor producing one array serves both.
 *
 * Times are wall-clock, not instants. A window is stored as minutes from local
 * midnight, and an end at or before the start means the shift runs into the
 * next day (22:00–02:00 is stored as 1320–1560). The editor says so in words
 * rather than leaving an operator to discover it.
 */

export const MINUTES_PER_DAY = 1440;

/** Sunday = 0, matching the API's `day_of_week` column. */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Monday-first, which is how a rota is read almost everywhere this ships. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export interface WeeklyWindow {
  /** Stable across re-renders so React does not remount a row being edited. */
  key: string;
  dayOfWeek: number;
  /** `HH:mm`, 24-hour. */
  startTime: string;
  endTime: string;
  isActive: boolean;
  /** Null means "any location"; only the staff editor uses this. */
  locationId: string | null;
}

/**
 * Minutes from local midnight back to the `HH:mm` the API accepts.
 *
 * An end above 1440 is an overnight window and renders as the next morning;
 * exactly 1440 is midnight at the *end* of the day, which the API spells
 * `24:00` and which is not the same as `00:00`.
 */
export function minutesToClock(minute: number): string {
  if (minute === MINUTES_PER_DAY) return '24:00';
  const wrapped = minute % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function clockToMinutes(clock: string): number {
  if (clock === '24:00') return MINUTES_PER_DAY;
  const [hours, minutes] = clock.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

let sequence = 0;
export function newWindowKey(): string {
  sequence += 1;
  return `window-${sequence}`;
}

/**
 * Time options on a fixed grid.
 *
 * A rota is authored in quarter hours; offering every minute would make the
 * list unusable and would not match the intervals the booking engine hands out
 * anyway. `24:00` is offered only as an end, because a window cannot start at
 * midnight-end-of-day.
 */
function useTimeOptions(includeEndOfDay: boolean, stepMinutes: number): SelectOption[] {
  return useMemo(() => {
    const options: SelectOption[] = [];
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += stepMinutes) {
      options.push({ value: minutesToClock(minute), label: formatMinuteOfDay(minute) });
    }
    if (includeEndOfDay) options.push({ value: '24:00', label: 'midnight (end of day)' });
    return options;
  }, [includeEndOfDay, stepMinutes]);
}

export interface WeeklyWindowEditorProps {
  windows: WeeklyWindow[];
  onChange: (windows: WeeklyWindow[]) => void;
  disabled?: boolean;
  /** Granularity of the offered times. */
  stepMinutes?: number;
  /** Offers a per-window location, for rules that differ by site. */
  locationOptions?: SelectOption[];
  className?: string;
}

export function WeeklyWindowEditor({
  windows,
  onChange,
  disabled = false,
  stepMinutes = 15,
  locationOptions,
  className,
}: WeeklyWindowEditorProps): JSX.Element {
  const startOptions = useTimeOptions(false, stepMinutes);
  const endOptions = useTimeOptions(true, stepMinutes);

  const update = (key: string, patch: Partial<WeeklyWindow>): void => {
    onChange(windows.map((window) => (window.key === key ? { ...window, ...patch } : window)));
  };

  const addWindow = (dayOfWeek: number): void => {
    onChange([
      ...windows,
      {
        key: newWindowKey(),
        dayOfWeek,
        startTime: '09:00',
        endTime: '17:00',
        isActive: true,
        locationId: null,
      },
    ]);
  };

  const removeWindow = (key: string): void => {
    onChange(windows.filter((window) => window.key !== key));
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {WEEK_ORDER.map((dayOfWeek) => {
        const dayWindows = windows.filter((window) => window.dayOfWeek === dayOfWeek);
        const dayName = DAY_NAMES[dayOfWeek] ?? `Day ${dayOfWeek}`;

        return (
          <div
            key={dayOfWeek}
            className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-fg">{dayName}</h4>
              {!disabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => addWindow(dayOfWeek)}
                  leadingIcon={<Plus className="size-3.5" aria-hidden="true" />}
                >
                  Add window
                </Button>
              ) : null}
            </div>

            {dayWindows.length === 0 ? (
              <p className="text-sm text-fg-muted">Closed</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {dayWindows.map((window) => {
                  const overnight =
                    clockToMinutes(window.endTime) <= clockToMinutes(window.startTime);
                  return (
                    <li key={window.key} className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="mf-sr-only" htmlFor={`${window.key}-start`}>
                          {dayName} window start
                        </label>
                        <Select
                          id={`${window.key}-start`}
                          selectSize="sm"
                          className="w-32"
                          disabled={disabled}
                          options={startOptions}
                          value={window.startTime}
                          onChange={(event) =>
                            update(window.key, { startTime: event.target.value })
                          }
                        />
                        <span className="text-sm text-fg-muted" aria-hidden="true">
                          to
                        </span>
                        <label className="mf-sr-only" htmlFor={`${window.key}-end`}>
                          {dayName} window end
                        </label>
                        <Select
                          id={`${window.key}-end`}
                          selectSize="sm"
                          className="w-40"
                          disabled={disabled}
                          options={endOptions}
                          value={window.endTime}
                          onChange={(event) => update(window.key, { endTime: event.target.value })}
                        />

                        {locationOptions ? (
                          <>
                            <label className="mf-sr-only" htmlFor={`${window.key}-location`}>
                              {dayName} window location
                            </label>
                            <Select
                              id={`${window.key}-location`}
                              selectSize="sm"
                              className="w-44"
                              disabled={disabled}
                              options={locationOptions}
                              value={window.locationId ?? ''}
                              onChange={(event) =>
                                update(window.key, {
                                  locationId: event.target.value === '' ? null : event.target.value,
                                })
                              }
                            />
                          </>
                        ) : null}

                        {/*
                         * A checkbox rather than a switch, and inline rather
                         * than stacked: a week of split shifts can run to a
                         * dozen rows, and a full switch with its own
                         * description under each one turns the editor into a
                         * page of scrolling.
                         */}
                        {!disabled ? (
                          <Checkbox
                            label={<span className="text-xs font-normal">In force</span>}
                            aria-label={`Apply the ${dayName} ${window.startTime} window`}
                            checked={window.isActive}
                            onChange={() => update(window.key, { isActive: !window.isActive })}
                          />
                        ) : null}

                        {!disabled ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="ml-auto size-8 text-danger-text"
                            aria-label={`Remove the ${dayName} ${window.startTime} window`}
                            onClick={() => removeWindow(window.key)}
                          >
                            <X className="size-4" aria-hidden="true" />
                          </Button>
                        ) : null}
                      </div>

                      {overnight ? (
                        <p className="text-xs text-warning-text">
                          Runs past midnight into {DAY_NAMES[(dayOfWeek + 1) % 7]}.
                        </p>
                      ) : null}

                      {!window.isActive ? (
                        <p className="text-xs text-fg-muted">
                          On file but not applied — this window offers no slots.
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
