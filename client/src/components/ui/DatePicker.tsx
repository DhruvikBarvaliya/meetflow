import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { DateTime } from 'luxon';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { cn } from '@/lib/cn';
import { Popover } from './Popover';

export interface DatePickerProps {
  /** `YYYY-MM-DD`, the shape every date-only API field uses. */
  value: string | null;
  onChange: (value: string) => void;
  /**
   * The zone "today" is measured in — the workspace's, not the browser's.
   * A studio in Kolkata must not highlight yesterday because the viewer is in
   * London.
   */
  timezone: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  className?: string;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function parse(value: string | null, zone: string): DateTime | null {
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { zone });
  return parsed.isValid ? parsed : null;
}

/**
 * A calendar popover over a read-only text trigger.
 *
 * Native `<input type="date">` was the alternative and was rejected for one
 * reason: it reads and displays dates in the *browser's* locale and clock,
 * which is exactly the bug this product cannot afford. Everything here is
 * resolved in the workspace timezone instead.
 *
 * Keyboard model follows the grid pattern: arrows move a day, PageUp/PageDown a
 * month, Home/End to the ends of the week, Enter or Space selects, Escape
 * closes and returns focus to the trigger.
 */
export function DatePicker({
  value,
  onChange,
  timezone,
  min,
  max,
  disabled = false,
  placeholder = 'Select a date',
  id,
  className,
  ...aria
}: DatePickerProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const triggerId = id ?? generatedId;

  const today = useMemo(() => DateTime.now().setZone(timezone).startOf('day'), [timezone]);
  const selected = useMemo(() => parse(value, timezone), [value, timezone]);

  const [open, setOpen] = useState(false);
  // The day the arrow keys are on, which is not the same as the selected day —
  // a user can browse March without committing to a date in it.
  const [cursor, setCursor] = useState<DateTime>(() => selected ?? today);

  useEffect(() => {
    if (open) setCursor(selected ?? today);
  }, [open, selected, today]);

  const minDate = useMemo(() => parse(min ?? null, timezone), [min, timezone]);
  const maxDate = useMemo(() => parse(max ?? null, timezone), [max, timezone]);

  const isOutOfRange = useCallback(
    (day: DateTime): boolean =>
      (minDate !== null && day < minDate) || (maxDate !== null && day > maxDate),
    [minDate, maxDate],
  );

  const days = useMemo(() => {
    const monthStart = cursor.startOf('month');
    // Luxon's `weekday` is 1=Monday, so this always lands on the Monday on or
    // before the 1st — the grid never starts mid-week.
    const gridStart = monthStart.minus({ days: monthStart.weekday - 1 });
    return Array.from({ length: 42 }, (_, index) => gridStart.plus({ days: index }));
  }, [cursor]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const select = useCallback(
    (day: DateTime) => {
      if (isOutOfRange(day)) return;
      const iso = day.toISODate();
      if (iso) onChange(iso);
      close();
    },
    [isOutOfRange, onChange, close],
  );

  // Focus follows the cursor so the browser scrolls the grid and the screen
  // reader announces each day as the user arrows through the month.
  useEffect(() => {
    if (!open) return;
    const iso = cursor.toISODate();
    if (!iso) return;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-day="${iso}"]`)
      ?.focus({ preventScroll: true });
  }, [open, cursor]);

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const moves: Record<string, () => DateTime> = {
      ArrowLeft: () => cursor.minus({ days: 1 }),
      ArrowRight: () => cursor.plus({ days: 1 }),
      ArrowUp: () => cursor.minus({ weeks: 1 }),
      ArrowDown: () => cursor.plus({ weeks: 1 }),
      PageUp: () => cursor.minus({ months: 1 }),
      PageDown: () => cursor.plus({ months: 1 }),
      Home: () => cursor.startOf('week'),
      End: () => cursor.endOf('week').startOf('day'),
    };

    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setCursor(move());
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(cursor);
    }
  };

  const label = selected ? selected.toFormat('d LLL yyyy') : placeholder;

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'flex h-10 w-full items-center gap-2 rounded-md border border-border bg-surface px-3 text-left text-sm shadow-xs transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
          'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-muted',
          'aria-[invalid=true]:border-danger',
          selected ? 'text-fg' : 'text-fg-muted',
        )}
        {...aria}
      >
        <CalendarDays className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </button>

      <Popover
        open={open}
        onClose={close}
        anchorRef={wrapperRef}
        role="dialog"
        ariaLabel="Choose a date"
        className="w-[19rem] p-3"
      >
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setCursor(cursor.minus({ months: 1 }))}
            aria-label="Previous month"
            className="rounded-md p-1.5 text-fg-secondary transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <p aria-live="polite" className="text-sm font-semibold text-fg">
            {cursor.toFormat('LLLL yyyy')}
          </p>
          <button
            type="button"
            onClick={() => setCursor(cursor.plus({ months: 1 }))}
            aria-label="Next month"
            className="rounded-md p-1.5 text-fg-secondary transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mb-1 grid grid-cols-7 gap-0.5" aria-hidden="true">
          {WEEKDAY_LABELS.map((weekday) => (
            <span
              key={weekday}
              className="flex h-7 items-center justify-center text-xs font-medium text-fg-muted"
            >
              {weekday.charAt(0)}
            </span>
          ))}
        </div>

        <div
          ref={gridRef}
          role="grid"
          aria-label={cursor.toFormat('LLLL yyyy')}
          onKeyDown={onGridKeyDown}
          className="grid grid-cols-7 gap-0.5"
        >
          {days.map((day) => {
            const iso = day.toISODate() ?? '';
            const inMonth = day.month === cursor.month;
            const isSelected = selected !== null && day.hasSame(selected, 'day');
            const isToday = day.hasSame(today, 'day');
            const unavailable = isOutOfRange(day);

            return (
              <button
                key={iso}
                type="button"
                role="gridcell"
                data-day={iso}
                // One tab stop for the whole grid; arrows do the rest.
                tabIndex={day.hasSame(cursor, 'day') ? 0 : -1}
                aria-selected={isSelected}
                aria-current={isToday ? 'date' : undefined}
                aria-label={day.toFormat('cccc d LLLL yyyy')}
                disabled={unavailable}
                onClick={() => select(day)}
                className={cn(
                  'flex h-9 items-center justify-center rounded-md text-sm tabular-nums transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
                  'disabled:pointer-events-none disabled:opacity-35',
                  isSelected
                    ? 'bg-brand font-semibold text-on-brand'
                    : inMonth
                      ? 'text-fg hover:bg-surface-hover'
                      : 'text-fg-muted hover:bg-surface-hover',
                  !isSelected && isToday && 'ring-1 ring-inset ring-brand-border font-semibold',
                )}
              >
                {day.day}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => select(today)}
          disabled={isOutOfRange(today)}
          className="mt-2 w-full rounded-md py-1.5 text-sm font-medium text-brand-text transition-colors hover:bg-brand-subtle focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-45"
        >
          Today
        </button>
      </Popover>
    </div>
  );
}
