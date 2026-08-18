/**
 * Slot engine behaviour.
 *
 * The engine is pure, so every scheduling rule — buffers, minimum notice, grid
 * alignment, conflicts, group capacity, truncation — is verifiable here without
 * a database or a clock.
 */
import { describe, expect, it } from 'vitest';
import {
  generateSlots,
  isSlotBookable,
  type BusyInterval,
  type SlotEngineInput,
  type WorkingWindow,
} from '../../src/scheduling/slotEngine';

const at = (iso: string) => new Date(iso);
const times = (slots: Array<{ startsAt: Date }>) => slots.map((s) => s.startsAt.toISOString());

/** A single 09:00–12:00 UTC working window on 2025-06-02. */
function morning(locationId: string | null = 'loc-1'): WorkingWindow {
  return { start: at('2025-06-02T09:00:00Z'), end: at('2025-06-02T12:00:00Z'), locationId };
}

function baseInput(overrides: Partial<SlotEngineInput> = {}): SlotEngineInput {
  return {
    rangeStart: at('2025-06-02T00:00:00Z'),
    rangeEnd: at('2025-06-03T00:00:00Z'),
    workingWindows: [morning()],
    busy: [],
    durationMinutes: 30,
    preBufferMinutes: 0,
    postBufferMinutes: 0,
    slotIntervalMinutes: 30,
    minNoticeMinutes: 0,
    now: at('2025-06-01T00:00:00Z'),
    maxSlots: 500,
    ...overrides,
  };
}

describe('grid generation', () => {
  it('produces slots on the interval grid and never past the closing time', () => {
    const { slots } = generateSlots(baseInput());
    expect(times(slots)).toEqual([
      '2025-06-02T09:00:00.000Z',
      '2025-06-02T09:30:00.000Z',
      '2025-06-02T10:00:00.000Z',
      '2025-06-02T10:30:00.000Z',
      '2025-06-02T11:00:00.000Z',
      '2025-06-02T11:30:00.000Z',
    ]);
    // The 11:30 slot ends exactly at 12:00; nothing may start after that.
    expect(slots.at(-1)!.endsAt.toISOString()).toBe('2025-06-02T12:00:00.000Z');
  });

  it('anchors the grid to the window start, not to midnight', () => {
    // A clinic opening at 09:10 must not offer an unusable 09:00.
    const { slots } = generateSlots(
      baseInput({
        workingWindows: [
          { start: at('2025-06-02T09:10:00Z'), end: at('2025-06-02T10:30:00Z'), locationId: null },
        ],
        slotIntervalMinutes: 15,
      }),
    );
    expect(times(slots)).toEqual([
      '2025-06-02T09:10:00.000Z',
      '2025-06-02T09:25:00.000Z',
      '2025-06-02T09:40:00.000Z',
      '2025-06-02T09:55:00.000Z',
    ]);
  });

  it('offers overlapping start times when the interval is finer than the duration', () => {
    const { slots } = generateSlots(baseInput({ durationMinutes: 60, slotIntervalMinutes: 15 }));
    expect(times(slots).slice(0, 3)).toEqual([
      '2025-06-02T09:00:00.000Z',
      '2025-06-02T09:15:00.000Z',
      '2025-06-02T09:30:00.000Z',
    ]);
    expect(slots.at(-1)!.startsAt.toISOString()).toBe('2025-06-02T11:00:00.000Z');
  });

  it('returns nothing when the service is longer than the window', () => {
    expect(generateSlots(baseInput({ durationMinutes: 240 })).slots).toEqual([]);
  });
});

describe('conflicts', () => {
  const busyAt = (from: string, to: string): BusyInterval => ({
    start: at(from),
    end: at(to),
    reason: 'APPOINTMENT',
  });

  it('removes slots overlapping an existing appointment but keeps back-to-back ones', () => {
    const { slots } = generateSlots(
      baseInput({ busy: [busyAt('2025-06-02T10:00:00Z', '2025-06-02T10:30:00Z')] }),
    );
    expect(times(slots)).toEqual([
      '2025-06-02T09:00:00.000Z',
      '2025-06-02T09:30:00.000Z',
      // 10:00 is taken; 10:30 starts exactly when it ends and is offered.
      '2025-06-02T10:30:00.000Z',
      '2025-06-02T11:00:00.000Z',
      '2025-06-02T11:30:00.000Z',
    ]);
  });

  it('reports why a slot was rejected in explain mode', () => {
    const { rejected } = generateSlots(
      baseInput({
        busy: [
          {
            start: at('2025-06-02T10:00:00Z'),
            end: at('2025-06-02T10:30:00Z'),
            reason: 'BLACKOUT',
          },
        ],
        explain: true,
      }),
    );
    const conflict = rejected.find((r) => r.startsAt.toISOString() === '2025-06-02T10:00:00.000Z');
    expect(conflict).toMatchObject({ reason: 'CONFLICT', conflictReason: 'BLACKOUT' });
  });

  it('folds overlapping busy blocks instead of double-counting them', () => {
    const { slots } = generateSlots(
      baseInput({
        busy: [
          busyAt('2025-06-02T10:00:00Z', '2025-06-02T10:45:00Z'),
          busyAt('2025-06-02T10:30:00Z', '2025-06-02T11:00:00Z'),
        ],
      }),
    );
    expect(times(slots)).toEqual([
      '2025-06-02T09:00:00.000Z',
      '2025-06-02T09:30:00.000Z',
      '2025-06-02T11:00:00.000Z',
      '2025-06-02T11:30:00.000Z',
    ]);
  });
});

describe('buffers', () => {
  it('reserves pre and post buffer around each slot', () => {
    const { slots } = generateSlots(
      baseInput({ preBufferMinutes: 10, postBufferMinutes: 5, slotIntervalMinutes: 60 }),
    );
    const first = slots[0]!;
    expect(first.startsAt.toISOString()).toBe('2025-06-02T09:00:00.000Z');
    expect(first.bufferStartAt.toISOString()).toBe('2025-06-02T08:50:00.000Z');
    expect(first.bufferEndAt.toISOString()).toBe('2025-06-02T09:35:00.000Z');
  });

  it('rejects a slot whose buffer — not the appointment itself — collides', () => {
    // The appointment 10:00–10:30 does not touch the 10:35 block, but its
    // 15-minute cleanup buffer runs to 10:45 and does.
    const withoutBuffer = generateSlots(
      baseInput({
        slotIntervalMinutes: 60,
        durationMinutes: 30,
        busy: [
          {
            start: at('2025-06-02T10:35:00Z'),
            end: at('2025-06-02T10:50:00Z'),
            reason: 'APPOINTMENT',
          },
        ],
      }),
    );
    expect(times(withoutBuffer.slots)).toContain('2025-06-02T10:00:00.000Z');

    const withBuffer = generateSlots(
      baseInput({
        slotIntervalMinutes: 60,
        durationMinutes: 30,
        postBufferMinutes: 15,
        busy: [
          {
            start: at('2025-06-02T10:35:00Z'),
            end: at('2025-06-02T10:50:00Z'),
            reason: 'APPOINTMENT',
          },
        ],
      }),
    );
    expect(times(withBuffer.slots)).not.toContain('2025-06-02T10:00:00.000Z');
  });
});

describe('minimum notice', () => {
  it('drops slots that start sooner than the required notice', () => {
    const { slots } = generateSlots(
      baseInput({
        now: at('2025-06-02T09:00:00Z'),
        minNoticeMinutes: 120, // nothing before 11:00
      }),
    );
    expect(times(slots)).toEqual(['2025-06-02T11:00:00.000Z', '2025-06-02T11:30:00.000Z']);
  });

  it('labels too-soon slots distinctly from conflicts', () => {
    const { rejected } = generateSlots(
      baseInput({ now: at('2025-06-02T09:00:00Z'), minNoticeMinutes: 120, explain: true }),
    );
    expect(rejected.every((r) => r.reason === 'TOO_SOON')).toBe(true);
  });
});

describe('range clamping and truncation', () => {
  it('clips working windows to the requested range', () => {
    const { slots } = generateSlots(
      baseInput({
        rangeStart: at('2025-06-02T10:00:00Z'),
        rangeEnd: at('2025-06-02T11:00:00Z'),
      }),
    );
    expect(times(slots)).toEqual(['2025-06-02T10:00:00.000Z', '2025-06-02T10:30:00.000Z']);
  });

  it('reports truncation honestly rather than implying no more availability', () => {
    const result = generateSlots(baseInput({ maxSlots: 2 }));
    expect(result.slots).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('does not flag truncation when everything fits', () => {
    expect(generateSlots(baseInput()).truncated).toBe(false);
  });
});

describe('multiple windows and locations', () => {
  it('merges split shifts and skips the closed period between them', () => {
    const { slots } = generateSlots(
      baseInput({
        slotIntervalMinutes: 60,
        workingWindows: [
          { start: at('2025-06-02T09:00:00Z'), end: at('2025-06-02T11:00:00Z'), locationId: 'a' },
          { start: at('2025-06-02T13:00:00Z'), end: at('2025-06-02T15:00:00Z'), locationId: 'a' },
        ],
      }),
    );
    expect(times(slots)).toEqual([
      '2025-06-02T09:00:00.000Z',
      '2025-06-02T10:00:00.000Z',
      '2025-06-02T13:00:00.000Z',
      '2025-06-02T14:00:00.000Z',
    ]);
  });

  it('keeps the same time at two different locations, but never duplicates one', () => {
    const { slots } = generateSlots(
      baseInput({
        slotIntervalMinutes: 180,
        workingWindows: [
          { start: at('2025-06-02T09:00:00Z'), end: at('2025-06-02T10:00:00Z'), locationId: 'a' },
          { start: at('2025-06-02T09:00:00Z'), end: at('2025-06-02T10:00:00Z'), locationId: 'b' },
          { start: at('2025-06-02T09:00:00Z'), end: at('2025-06-02T10:00:00Z'), locationId: 'a' },
        ],
      }),
    );
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.locationId).sort()).toEqual(['a', 'b']);
  });
});

describe('group services', () => {
  it('offers an existing group appointment that still has room', () => {
    const { slots } = generateSlots(
      baseInput({
        slotIntervalMinutes: 60,
        durationMinutes: 60,
        // The class occupies the calendar…
        busy: [
          {
            start: at('2025-06-02T10:00:00Z'),
            end: at('2025-06-02T11:00:00Z'),
            reason: 'APPOINTMENT',
          },
        ],
        // …but is joinable rather than blocking.
        joinable: [
          {
            appointmentId: 'apt-1',
            startsAt: at('2025-06-02T10:00:00Z'),
            endsAt: at('2025-06-02T11:00:00Z'),
            remainingCapacity: 4,
          },
        ],
      }),
    );
    const joined = slots.find((s) => s.startsAt.toISOString() === '2025-06-02T10:00:00.000Z');
    expect(joined).toMatchObject({ joinsAppointmentId: 'apt-1', remainingCapacity: 4 });
  });

  it('treats a full class as busy', () => {
    const { slots } = generateSlots(
      baseInput({
        slotIntervalMinutes: 60,
        durationMinutes: 60,
        busy: [
          {
            start: at('2025-06-02T10:00:00Z'),
            end: at('2025-06-02T11:00:00Z'),
            reason: 'APPOINTMENT',
          },
        ],
        joinable: [
          {
            appointmentId: 'apt-1',
            startsAt: at('2025-06-02T10:00:00Z'),
            endsAt: at('2025-06-02T11:00:00Z'),
            remainingCapacity: 0,
          },
        ],
      }),
    );
    expect(times(slots)).not.toContain('2025-06-02T10:00:00.000Z');
  });
});

describe('isSlotBookable — confirmation-time revalidation', () => {
  const common = {
    durationMinutes: 30,
    preBufferMinutes: 0,
    postBufferMinutes: 0,
    workingWindows: [morning()],
    busy: [] as BusyInterval[],
    minNoticeMinutes: 60,
    now: at('2025-06-01T00:00:00Z'),
  };

  it('accepts a time inside working hours with no conflict', () => {
    expect(isSlotBookable({ ...common, startsAt: at('2025-06-02T09:00:00Z') })).toEqual({
      bookable: true,
    });
  });

  it('accepts an off-grid time that is otherwise valid', () => {
    // Grid alignment governs what is *offered*, not what is legal to confirm —
    // e.g. a waitlist hold or a staff-side booking at 09:07.
    expect(isSlotBookable({ ...common, startsAt: at('2025-06-02T09:07:00Z') }).bookable).toBe(true);
  });

  it('rejects a time outside working hours', () => {
    expect(isSlotBookable({ ...common, startsAt: at('2025-06-02T13:00:00Z') })).toMatchObject({
      bookable: false,
      reason: 'OUTSIDE_WORKING_HOURS',
    });
  });

  it('rejects a slot that would run past closing time', () => {
    expect(isSlotBookable({ ...common, startsAt: at('2025-06-02T11:45:00Z') })).toMatchObject({
      bookable: false,
      reason: 'OUTSIDE_WORKING_HOURS',
    });
  });

  it('rejects a conflicting time and names the conflict', () => {
    expect(
      isSlotBookable({
        ...common,
        startsAt: at('2025-06-02T10:00:00Z'),
        busy: [
          {
            start: at('2025-06-02T10:15:00Z'),
            end: at('2025-06-02T10:45:00Z'),
            reason: 'RESOURCE',
          },
        ],
      }),
    ).toMatchObject({ bookable: false, reason: 'CONFLICT', conflictReason: 'RESOURCE' });
  });

  it('rejects a booking made inside the minimum notice window', () => {
    expect(
      isSlotBookable({
        ...common,
        startsAt: at('2025-06-02T09:00:00Z'),
        now: at('2025-06-02T08:30:00Z'),
      }),
    ).toMatchObject({ bookable: false, reason: 'TOO_SOON' });
  });
});
