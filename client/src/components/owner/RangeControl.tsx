import { DateTime } from 'luxon';
import { useCallback, useMemo, useState } from 'react';
import { DatePicker, Select } from '@/components/ui';
import { FilterField } from './filters';

/**
 * The reporting window every analytics panel shares.
 *
 * The API caps a window at 366 days and answers 422 past it, so the cap is
 * enforced here rather than discovered — a manager comparing two years should
 * be told why they cannot before they wait for six failed requests.
 *
 * Both bounds are calendar dates in the *workspace's* zone, not instants. "1
 * March" means 1 March where the business is, whichever clock the browser
 * happens to sit in, which is exactly how the server resolves them.
 */
export const MAX_RANGE_DAYS = 366;

export interface DateRange {
  from: string;
  to: string;
}

export type RangePresetKey = '7d' | '30d' | '90d' | 'mtd' | 'ytd' | 'custom';

interface PresetSpec {
  label: string;
  /** Returns the window, or null for the custom option, which keeps the dates. */
  resolve: ((today: DateTime) => DateRange) | null;
}

const PRESETS: Record<RangePresetKey, PresetSpec> = {
  '7d': {
    label: 'Last 7 days',
    resolve: (today) => ({
      from: today.minus({ days: 6 }).toISODate() ?? '',
      to: today.toISODate() ?? '',
    }),
  },
  '30d': {
    label: 'Last 30 days',
    resolve: (today) => ({
      from: today.minus({ days: 29 }).toISODate() ?? '',
      to: today.toISODate() ?? '',
    }),
  },
  '90d': {
    label: 'Last 90 days',
    resolve: (today) => ({
      from: today.minus({ days: 89 }).toISODate() ?? '',
      to: today.toISODate() ?? '',
    }),
  },
  mtd: {
    label: 'This month',
    resolve: (today) => ({
      from: today.startOf('month').toISODate() ?? '',
      to: today.toISODate() ?? '',
    }),
  },
  ytd: {
    label: 'This year',
    resolve: (today) => ({
      from: today.startOf('year').toISODate() ?? '',
      to: today.toISODate() ?? '',
    }),
  },
  custom: { label: 'Custom range', resolve: null },
};

const PRESET_OPTIONS = (Object.keys(PRESETS) as RangePresetKey[]).map((key) => ({
  value: key,
  label: PRESETS[key].label,
}));

export function defaultRange(timezone: string, preset: RangePresetKey = '30d'): DateRange {
  const today = DateTime.now().setZone(timezone).startOf('day');
  return PRESETS[preset].resolve?.(today) ?? { from: '', to: '' };
}

/** Inclusive span, in days — one day is a span of one, matching the server. */
export function rangeSpanDays(range: DateRange): number {
  const from = DateTime.fromISO(range.from);
  const to = DateTime.fromISO(range.to);
  if (!from.isValid || !to.isValid) return 0;
  return Math.floor(to.diff(from, 'days').days) + 1;
}

export interface RangeControlProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  timezone: string;
  /** Shown beside the controls; use for the "times are in …" disclosure. */
  hint?: string;
}

/**
 * Preset plus two date pickers.
 *
 * The presets carry the everyday questions so nobody has to count back 89 days;
 * the pickers are there for the ones the presets do not cover. Choosing a date
 * moves the control to "Custom range" rather than silently contradicting the
 * preset still shown next to it.
 */
export function RangeControl({ value, onChange, timezone, hint }: RangeControlProps): JSX.Element {
  const [preset, setPreset] = useState<RangePresetKey>('30d');

  const today = useMemo(() => DateTime.now().setZone(timezone).startOf('day'), [timezone]);

  const span = rangeSpanDays(value);
  const tooWide = span > MAX_RANGE_DAYS;
  const inverted = span < 1;

  const applyPreset = useCallback(
    (next: RangePresetKey) => {
      setPreset(next);
      const resolved = PRESETS[next].resolve?.(today);
      if (resolved) onChange(resolved);
    },
    [onChange, today],
  );

  /** The latest `to` that keeps the window inside the cap, given `from`. */
  const maxTo = useMemo(() => {
    const from = DateTime.fromISO(value.from);
    if (!from.isValid) return undefined;
    return from.plus({ days: MAX_RANGE_DAYS - 1 }).toISODate() ?? undefined;
  }, [value.from]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <FilterField label="Period">
          {({ id }) => (
            <Select
              id={id}
              options={PRESET_OPTIONS}
              value={preset}
              selectSize="sm"
              onChange={(event) => applyPreset(event.target.value as RangePresetKey)}
            />
          )}
        </FilterField>

        <FilterField label="From">
          {({ id }) => (
            <DatePicker
              id={id}
              value={value.from}
              timezone={timezone}
              max={value.to}
              onChange={(from) => {
                setPreset('custom');
                onChange({ ...value, from });
              }}
            />
          )}
        </FilterField>

        <FilterField label="To">
          {({ id }) => (
            <DatePicker
              id={id}
              value={value.to}
              timezone={timezone}
              min={value.from}
              max={maxTo}
              onChange={(to) => {
                setPreset('custom');
                onChange({ ...value, to });
              }}
            />
          )}
        </FilterField>
      </div>

      <p className="text-xs text-fg-muted" aria-live="polite">
        {inverted
          ? 'The end of the range cannot come before its start.'
          : tooWide
            ? `A reporting window may span at most ${MAX_RANGE_DAYS} days; this one covers ${span}.`
            : `${span} day${span === 1 ? '' : 's'}${hint ? ` · ${hint}` : ''}`}
      </p>
    </div>
  );
}
