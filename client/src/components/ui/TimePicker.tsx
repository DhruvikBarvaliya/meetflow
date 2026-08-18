import { Clock } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { cn } from '@/lib/cn';
import { formatMinuteOfDay } from '@/lib/format';
import { Popover } from './Popover';

export interface TimePickerProps {
  /** `HH:mm` in 24-hour form — what every time-of-day API field expects. */
  value: string | null;
  onChange: (value: string) => void;
  /** Granularity of the offered times. Defaults to the API's own 15-minute grid. */
  stepMinutes?: number;
  minMinutes?: number;
  maxMinutes?: number;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  className?: string;
}

function toMinutes(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function toClock(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * A listbox of times on a fixed grid.
 *
 * This is the one place a native control loses: `<input type="time">` accepts
 * any minute, while the scheduling engine only ever offers slots on the
 * workspace's interval. Presenting the real grid stops a user entering 10:07
 * and being told afterwards that it does not exist.
 *
 * Follows the listbox pattern — arrows move, Home/End jump, Enter selects,
 * typing jumps to the first matching time.
 */
export function TimePicker({
  value,
  onChange,
  stepMinutes = 15,
  minMinutes = 0,
  maxMinutes = 24 * 60 - 1,
  disabled = false,
  placeholder = 'Select a time',
  id,
  className,
  ...aria
}: TimePickerProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const listId = `${generatedId}-listbox`;
  const typeaheadRef = useRef({ buffer: '', at: 0 });

  const [open, setOpen] = useState(false);

  const options = useMemo(() => {
    const step = Math.max(1, Math.round(stepMinutes));
    const result: number[] = [];
    for (let minute = minMinutes; minute <= maxMinutes; minute += step) result.push(minute);
    return result;
  }, [stepMinutes, minMinutes, maxMinutes]);

  const selected = toMinutes(value);
  const [active, setActive] = useState<number>(() => selected ?? options[0] ?? 0);

  useEffect(() => {
    if (open) setActive(selected ?? options[0] ?? 0);
  }, [open, selected, options]);

  // Scroll the active option into view so a 09:00 default is not 36 rows down,
  // and hand the list keyboard focus the moment it opens.
  useEffect(() => {
    if (!open) return;
    listRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-minute="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (minuteOfDay: number) => {
      onChange(toClock(minuteOfDay));
      close();
    },
    [onChange, close],
  );

  const moveTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(options.length - 1, index));
      const next = options[clamped];
      if (next !== undefined) setActive(next);
    },
    [options],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = options.indexOf(active);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveTo(index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(index - 1);
        return;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        return;
      case 'End':
        event.preventDefault();
        moveTo(options.length - 1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(active);
        return;
      default:
        break;
    }

    // Type-ahead: "930" jumps to 9:30. The buffer resets after a pause so a new
    // search does not append to an abandoned one.
    if (/^[0-9]$/.test(event.key)) {
      const now = Date.now();
      const state = typeaheadRef.current;
      state.buffer = now - state.at > 1000 ? event.key : state.buffer + event.key;
      state.at = now;

      const digits = state.buffer.padEnd(4, '0').slice(0, 4);
      const target = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
      const nearest = options.reduce((best, option) =>
        Math.abs(option - target) < Math.abs(best - target) ? option : best,
      );
      setActive(nearest);
    }
  };

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          'flex h-10 w-full items-center gap-2 rounded-md border border-border bg-surface px-3 text-left text-sm shadow-xs transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
          'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-muted',
          'aria-[invalid=true]:border-danger',
          selected !== null ? 'text-fg' : 'text-fg-muted',
        )}
        {...aria}
      >
        <Clock className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
        <span className="truncate">
          {selected !== null ? formatMinuteOfDay(selected) : placeholder}
        </span>
      </button>

      <Popover open={open} onClose={close} anchorRef={wrapperRef} className="w-full min-w-[9rem]">
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Time"
          aria-activedescendant={`${generatedId}-option-${active}`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          // The list itself takes focus; `aria-activedescendant` moves the
          // screen reader's cursor without 96 options entering the tab order.
          className="flex flex-col outline-none"
        >
          {options.map((minuteOfDay) => {
            const isSelected = minuteOfDay === selected;
            const isActive = minuteOfDay === active;
            return (
              <div
                key={minuteOfDay}
                id={`${generatedId}-option-${minuteOfDay}`}
                role="option"
                data-minute={minuteOfDay}
                aria-selected={isSelected}
                onClick={() => commit(minuteOfDay)}
                className={cn(
                  'cursor-pointer rounded-md px-2.5 py-1.5 text-sm tabular-nums transition-colors',
                  isSelected
                    ? 'bg-brand font-medium text-on-brand'
                    : isActive
                      ? 'bg-surface-hover text-fg'
                      : 'text-fg-secondary hover:bg-surface-hover hover:text-fg',
                )}
              >
                {formatMinuteOfDay(minuteOfDay)}
              </div>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}
