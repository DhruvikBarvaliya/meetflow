/**
 * The booking horizon, enforced at confirmation.
 *
 * `maxHorizonDays` is a published policy — every booking page renders it — but
 * for a long time it was only ever applied to the availability *search*. A
 * caller who named a provider and posted a start time, which the "choose your
 * provider" path and any API client do, never went near that clamp and could
 * book years out. These tests pin the rule where the booking is actually
 * committed.
 *
 * The parity test is the important one: it asks the search for the furthest
 * slot it is willing to offer and then books it. If the clamp and the
 * confirmation check ever disagree about which day the horizon ends on, that
 * test fails and says so — a slot the search offers must never be refused.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Appointment, BusinessSettings } from '../../src/database/models';
import { createBooking } from '../../src/modules/appointments/booking.service';
import { searchAvailability } from '../../src/scheduling/availability.service';
import { addDaysToDate, toIsoDateInZone } from '../../src/utils/time';
import { ErrorCode, type AppError } from '../../src/utils/errors';
import {
  closeDatabaseConnection,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

const DAY_MS = 24 * 60 * 60 * 1000;

let fixture: WorkspaceFixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

function bookingInput(fixtureRef: WorkspaceFixture, startsAt: Date, email: string) {
  return {
    businessId: fixtureRef.business.id,
    serviceId: fixtureRef.service.id,
    staffProfileId: fixtureRef.staffProfile.id,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: { firstName: 'Test', lastName: 'Customer', email },
    source: 'PUBLIC' as const,
    actor: { type: 'CUSTOMER' as const, label: email },
  };
}

async function setWorkspaceHorizon(fixtureRef: WorkspaceFixture, days: number): Promise<void> {
  await BusinessSettings.update(
    { maxHorizonDays: days },
    { where: { businessId: fixtureRef.business.id } },
  );
}

/**
 * Asserts a rejection is the horizon refusing, not some other 409.
 *
 * The code is deliberately the same one the minimum-notice refusal uses, so
 * clients handle both identically — which means the wording is the only thing
 * that distinguishes them here.
 */
async function expectHorizonRefusal(promise: Promise<unknown>): Promise<void> {
  const error = (await promise.then(
    () => null,
    (rejection: unknown) => rejection,
  )) as AppError | null;

  expect(error, 'expected the booking to be refused').not.toBeNull();
  expect(error!.statusCode).toBe(409);
  expect(error!.code).toBe(ErrorCode.SLOT_UNAVAILABLE);
  expect(error!.message).toMatch(/further ahead/i);
}

describe('booking horizon', () => {
  it('refuses a booking beyond the horizon even when the provider is named', async () => {
    await setWorkspaceHorizon(fixture, 30);

    // A perfectly ordinary weekday slot inside working hours — the only thing
    // wrong with it is that it is 45-odd days out on a 30-day policy.
    const beyond = nextWeekdayAt(10, 45);
    await expectHorizonRefusal(createBooking(bookingInput(fixture, beyond, 'far@meetflow.test')));

    // Nothing may be left behind by a refused booking.
    expect(await Appointment.count({ where: { businessId: fixture.business.id } })).toBe(0);
  });

  it('accepts a booking just inside the horizon', async () => {
    await setWorkspaceHorizon(fixture, 30);

    const inside = nextWeekdayAt(10, 25);
    const result = await createBooking(bookingInput(fixture, inside, 'near@meetflow.test'));

    expect(result.appointment.startsAt.toISOString()).toBe(inside.toISOString());
  });

  it('books the furthest slot the availability search is willing to offer', async () => {
    const now = new Date();

    // Land the horizon on a weekday, so the boundary day is one this fixture
    // actually works and the test exercises the edge rather than the Friday
    // before it.
    let horizonDays = 30;
    while ([0, 6].includes(new Date(now.getTime() + horizonDays * DAY_MS).getUTCDay())) {
      horizonDays += 1;
    }
    await setWorkspaceHorizon(fixture, horizonDays);

    const horizonDate = toIsoDateInZone(new Date(now.getTime() + horizonDays * DAY_MS), 'UTC');
    const result = await searchAvailability({
      businessId: fixture.business.id,
      businessTimezone: 'UTC',
      serviceId: fixture.service.id,
      staffProfileId: fixture.staffProfile.id,
      fromDate: addDaysToDate(horizonDate, -2),
      // Deliberately past the horizon: the search must clamp it back.
      toDate: addDaysToDate(horizonDate, 4),
      timezone: 'UTC',
      now,
    });

    const furthest = result.slots.at(-1);
    expect(furthest, 'the search offered nothing to book').toBeDefined();
    // The search offers the whole of the horizon day, right to its last slot.
    expect(toIsoDateInZone(furthest!.startsAt, 'UTC')).toBe(horizonDate);

    // And confirmation must accept exactly what the search offered. A failure
    // here means the clamp and the confirmation check have drifted apart, and
    // customers are being shown times they cannot book.
    const booked = await createBooking(
      bookingInput(fixture, furthest!.startsAt, 'boundary@meetflow.test'),
    );
    expect(booked.appointment.startsAt.toISOString()).toBe(furthest!.startsAt.toISOString());
  });

  it('lets a service horizon override the workspace default', async () => {
    await setWorkspaceHorizon(fixture, 60);

    // The workspace alone is happy with a booking three weeks out.
    const first = nextWeekdayAt(10, 20);
    await createBooking(bookingInput(fixture, first, 'workspace@meetflow.test'));

    // The service says one week, and the service wins.
    await fixture.service.update({ maxHorizonDays: 7 });
    const second = nextWeekdayAt(11, 20);
    await expectHorizonRefusal(
      createBooking(bookingInput(fixture, second, 'service@meetflow.test')),
    );

    expect(await Appointment.count({ where: { businessId: fixture.business.id } })).toBe(1);
  });
});
