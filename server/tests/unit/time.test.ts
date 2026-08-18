/**
 * Timezone and DST correctness.
 *
 * These are the cases that silently corrupt a scheduler: a wall-clock rule that
 * drifts by an hour twice a year, a local time that does not exist, and a local
 * time that happens twice.
 */
import { describe, expect, it } from 'vitest';
import {
  addDaysToDate,
  addMinutes,
  dayOfWeekForDate,
  daysBetween,
  eachDateInRange,
  hhMmToMinutes,
  intervalsOverlap,
  isValidTimezone,
  mergeIntervals,
  minutesToHhMm,
  resolveWallClock,
  subtractIntervals,
  toIsoDateInZone,
  zoneObservesDst,
} from '../../src/utils/time';

const NEW_YORK = 'America/New_York';
const KOLKATA = 'Asia/Kolkata';
const LONDON = 'Europe/London';

describe('timezone validation', () => {
  it('accepts IANA identifiers', () => {
    expect(isValidTimezone(KOLKATA)).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects fixed UTC offsets, which cannot express DST', () => {
    expect(isValidTimezone('+05:30')).toBe(false);
    expect(isValidTimezone('-0500')).toBe(false);
  });

  it('rejects unknown zones', () => {
    expect(isValidTimezone('Nowhere/Land')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('resolveWallClock — DST spring forward (America/New_York, 2024-03-10)', () => {
  it('resolves a time before the transition at the standard offset', () => {
    const result = resolveWallClock('2024-03-10', hhMmToMinutes('01:30'), NEW_YORK);
    expect(result.resolution).toBe('exact');
    expect(result.instant.toISOString()).toBe('2024-03-10T06:30:00.000Z');
  });

  it('flags 02:30 as skipped — that local time never happens', () => {
    const result = resolveWallClock('2024-03-10', hhMmToMinutes('02:30'), NEW_YORK);
    expect(result.resolution).toBe('skipped');
  });

  it('resolves a time after the transition at the daylight offset', () => {
    const result = resolveWallClock('2024-03-10', hhMmToMinutes('03:30'), NEW_YORK);
    expect(result.resolution).toBe('exact');
    expect(result.instant.toISOString()).toBe('2024-03-10T07:30:00.000Z');
  });

  it('keeps a 09:00 opening rule at 09:00 local across the transition', () => {
    // The regression this whole design exists to prevent: naive arithmetic
    // (midnight + 540 minutes) yields 10:00 local on a spring-forward day.
    const springDay = resolveWallClock('2024-03-10', 540, NEW_YORK);
    const normalDay = resolveWallClock('2024-06-10', 540, NEW_YORK);
    expect(springDay.instant.toISOString()).toBe('2024-03-10T13:00:00.000Z');
    expect(normalDay.instant.toISOString()).toBe('2024-06-10T13:00:00.000Z');
  });
});

describe('resolveWallClock — DST fall back (America/New_York, 2024-11-03)', () => {
  it('flags 01:30 as ambiguous and picks the first occurrence deterministically', () => {
    const result = resolveWallClock('2024-11-03', hhMmToMinutes('01:30'), NEW_YORK);
    expect(result.resolution).toBe('ambiguous');
    // -04:00 (EDT) is the earlier of the two possible offsets.
    expect(result.offsetMinutes).toBe(-240);
    expect(result.instant.toISOString()).toBe('2024-11-03T05:30:00.000Z');
  });

  it('keeps a 09:00 opening rule at 09:00 local, now at the standard offset', () => {
    const result = resolveWallClock('2024-11-03', 540, NEW_YORK);
    expect(result.instant.toISOString()).toBe('2024-11-03T14:00:00.000Z');
    expect(result.offsetMinutes).toBe(-300);
  });
});

describe('resolveWallClock — half-hour offsets and overnight windows', () => {
  it('handles Asia/Kolkata (+05:30, no DST)', () => {
    const result = resolveWallClock('2024-03-10', 540, KOLKATA);
    expect(result.instant.toISOString()).toBe('2024-03-10T03:30:00.000Z');
    expect(result.offsetMinutes).toBe(330);
    expect(zoneObservesDst(KOLKATA)).toBe(false);
  });

  it('rolls minutes past 1440 into the following calendar day', () => {
    // 26:00 == 02:00 the next day, how overnight hours (22:00–02:00) are stored.
    const result = resolveWallClock('2024-06-10', 1560, NEW_YORK);
    expect(result.instant.toISOString()).toBe('2024-06-11T06:00:00.000Z');
  });

  it('treats 24:00 as midnight at the end of the day', () => {
    const result = resolveWallClock('2024-06-10', hhMmToMinutes('24:00'), NEW_YORK);
    expect(result.instant.toISOString()).toBe('2024-06-11T04:00:00.000Z');
  });

  it('handles Europe/London, whose standard offset is UTC', () => {
    expect(resolveWallClock('2024-01-15', 540, LONDON).instant.toISOString()).toBe(
      '2024-01-15T09:00:00.000Z',
    );
    expect(resolveWallClock('2024-07-15', 540, LONDON).instant.toISOString()).toBe(
      '2024-07-15T08:00:00.000Z',
    );
  });
});

describe('calendar helpers', () => {
  it('maps weekdays with Sunday = 0', () => {
    expect(dayOfWeekForDate('2024-08-18')).toBe(0); // Sunday
    expect(dayOfWeekForDate('2024-08-14')).toBe(3); // Wednesday
    expect(dayOfWeekForDate('2024-08-17')).toBe(6); // Saturday
  });

  it('enumerates an inclusive date range across a month boundary', () => {
    expect(eachDateInRange('2024-02-27', '2024-03-02')).toEqual([
      '2024-02-27',
      '2024-02-28',
      '2024-02-29', // leap year
      '2024-03-01',
      '2024-03-02',
    ]);
  });

  it('returns an empty range when the end precedes the start', () => {
    expect(eachDateInRange('2024-03-02', '2024-03-01')).toEqual([]);
  });

  it('counts days across a DST boundary without drifting', () => {
    expect(daysBetween('2024-03-09', '2024-03-11')).toBe(2);
    expect(addDaysToDate('2024-03-09', 2)).toBe('2024-03-11');
  });

  it('reports the local calendar date for an instant', () => {
    // 03:30 UTC is still the previous evening in New York.
    expect(toIsoDateInZone(new Date('2024-06-11T03:30:00Z'), NEW_YORK)).toBe('2024-06-10');
    expect(toIsoDateInZone(new Date('2024-06-11T03:30:00Z'), KOLKATA)).toBe('2024-06-11');
  });

  it('round-trips minutes and HH:mm', () => {
    expect(minutesToHhMm(540)).toBe('09:00');
    expect(minutesToHhMm(1439)).toBe('23:59');
    expect(hhMmToMinutes('09:30')).toBe(570);
    expect(() => hhMmToMinutes('25:00')).toThrow();
    expect(() => hhMmToMinutes('9-30')).toThrow();
  });
});

describe('interval algebra', () => {
  const at = (iso: string) => new Date(iso);

  it('treats intervals as half-open, so back-to-back does not overlap', () => {
    expect(
      intervalsOverlap(
        at('2024-06-10T10:00:00Z'),
        at('2024-06-10T10:30:00Z'),
        at('2024-06-10T10:30:00Z'),
        at('2024-06-10T11:00:00Z'),
      ),
    ).toBe(false);
    expect(
      intervalsOverlap(
        at('2024-06-10T10:00:00Z'),
        at('2024-06-10T10:31:00Z'),
        at('2024-06-10T10:30:00Z'),
        at('2024-06-10T11:00:00Z'),
      ),
    ).toBe(true);
  });

  it('merges overlapping and adjacent busy blocks', () => {
    const merged = mergeIntervals([
      { start: at('2024-06-10T14:00:00Z'), end: at('2024-06-10T15:00:00Z') },
      { start: at('2024-06-10T14:30:00Z'), end: at('2024-06-10T15:30:00Z') },
      { start: at('2024-06-10T16:00:00Z'), end: at('2024-06-10T17:00:00Z') },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.start.toISOString()).toBe('2024-06-10T14:00:00.000Z');
    expect(merged[0]!.end.toISOString()).toBe('2024-06-10T15:30:00.000Z');
  });

  it('subtracts busy time from a window', () => {
    const free = subtractIntervals(
      { start: at('2024-06-10T13:00:00Z'), end: at('2024-06-10T17:00:00Z') },
      [
        { start: at('2024-06-10T14:00:00Z'), end: at('2024-06-10T15:00:00Z') },
        { start: at('2024-06-10T14:30:00Z'), end: at('2024-06-10T15:30:00Z') },
      ],
    );
    expect(free.map((f) => [f.start.toISOString(), f.end.toISOString()])).toEqual([
      ['2024-06-10T13:00:00.000Z', '2024-06-10T14:00:00.000Z'],
      ['2024-06-10T15:30:00.000Z', '2024-06-10T17:00:00.000Z'],
    ]);
  });

  it('adds elapsed minutes as real elapsed time', () => {
    // A 30-minute appointment lasts 30 real minutes even across a transition.
    const start = at('2024-03-10T06:45:00Z'); // 01:45 EST
    expect(addMinutes(start, 30).toISOString()).toBe('2024-03-10T07:15:00.000Z'); // 03:15 EDT
  });
});
