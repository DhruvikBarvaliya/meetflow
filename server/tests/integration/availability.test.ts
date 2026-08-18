/**
 * The availability rule-resolution layer, against real PostgreSQL.
 *
 * `computeWorkingWindows`, `resolvePolicy`, `searchAvailability` and
 * `verifySlot` stand between stored configuration and offered times, and not
 * one of them was called by a test. That absence is most of the explanation for
 * how four defects lived here at once: rules the API happily accepted and
 * stored — location-scoped holidays and overrides, resource requirements,
 * daily booking caps — were dropped on the floor, and nothing said so.
 *
 * Every case below defends one invariant:
 *
 *   A slot the search offers must never be refused at commit, and a slot the
 *   search hides must never be bookable.
 *
 * `search and commit agree` is the test that matters most. It asks the search
 * what it is willing to offer and then books all of it, rather than checking
 * the two paths independently — checking them independently is precisely how
 * they drifted apart.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AvailabilityOverride,
  BlackoutPeriod,
  BusinessHours,
  BusinessSettings,
  Holiday,
  Location,
  Membership,
  Resource,
  Role,
  ServiceResourceRequirement,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
} from '../../src/database/models';
import { createBooking } from '../../src/modules/appointments/booking.service';
import {
  searchAvailability,
  type AvailabilitySearchInput,
  type AvailabilitySearchResult,
} from '../../src/scheduling/availability.service';
import { ErrorCode } from '../../src/utils/errors';
import { resolveWallClock, toIsoDateInZone } from '../../src/utils/time';
import {
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

const HOUR = 60 * 60 * 1000;

let fixture: WorkspaceFixture;
let counter = 0;

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dateOf = (instant: Date): string => toIsoDateInZone(instant, 'UTC');
const times = (slots: Array<{ startsAt: Date }>): string[] =>
  slots.map((slot) => slot.startsAt.toISOString());

/**
 * Midnight UTC on the next date with the given weekday, at least `minDaysAhead`
 * out.
 *
 * Every fixture works in UTC, so "midnight plus N hours" is also the local wall
 * clock — which keeps the expectations below readable without hiding the
 * timezone work the engine is actually doing.
 */
function nextDayOfWeek(dayOfWeek: number, minDaysAhead = 4): Date {
  const candidate = new Date();
  candidate.setUTCDate(candidate.getUTCDate() + minDaysAhead);
  candidate.setUTCHours(0, 0, 0, 0);
  while (candidate.getUTCDay() !== dayOfWeek) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

/** The next ordinary working day for this fixture: Mon–Fri, 09:00–17:00. */
function nextWorkingDay(minDaysAhead = 4): Date {
  const candidate = new Date();
  candidate.setUTCDate(candidate.getUTCDate() + minDaysAhead);
  candidate.setUTCHours(0, 0, 0, 0);
  while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

const at = (day: Date, hours: number): Date => new Date(day.getTime() + hours * HOUR);

type SearchOptions = Partial<AvailabilitySearchInput> & { fromDate: string; toDate: string };

async function search(options: SearchOptions): Promise<AvailabilitySearchResult> {
  return searchAvailability({
    businessId: fixture.business.id,
    businessTimezone: fixture.business.timezone,
    serviceId: fixture.service.id,
    timezone: 'UTC',
    ...options,
  });
}

async function book(
  startsAt: Date,
  options: {
    email?: string;
    staffProfileId?: string;
    customerId?: string;
    locationId?: string | null;
  } = {},
): Promise<Awaited<ReturnType<typeof createBooking>>> {
  counter += 1;
  const email = options.email ?? `slot-${process.pid}-${counter}@meetflow.test`;
  return createBooking({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId: options.staffProfileId ?? fixture.staffProfile.id,
    locationId: options.locationId ?? null,
    startsAt,
    timezone: 'UTC',
    customer: options.customerId
      ? { id: options.customerId, firstName: 'Ada', email: fixture.customer.email }
      : { firstName: 'Ada', lastName: 'Customer', email },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: email },
  });
}

/** The error a rejected promise settled with, or null when it resolved. */
async function refusalOf(
  promise: Promise<unknown>,
): Promise<{ code?: string; message: string } | null> {
  return promise.then(
    () => null,
    (error: unknown) => error as { code?: string; message: string },
  );
}

/** Rewrites one weekday's hours in both layers at once. */
async function setHoursFor(
  dayOfWeek: number,
  startMinute: number,
  endMinute: number,
): Promise<void> {
  await BusinessHours.update(
    { startMinute, endMinute },
    { where: { businessId: fixture.business.id, dayOfWeek } },
  );
  await StaffAvailabilityRule.update(
    { startMinute, endMinute },
    { where: { businessId: fixture.business.id, dayOfWeek } },
  );
}

/**
 * A second bookable provider with the fixture's hours.
 *
 * Resource contention needs appointments that overlap in time, and
 * `appointment_staff_no_overlap` forbids that for one provider — so a shared
 * room can only be filled up by several people using it at once.
 */
async function addProvider(
  displayName: string,
  defaultLocationId: string | null = null,
): Promise<StaffProfile> {
  const user = await createUser();
  const role = await Role.findOne({ where: { businessId: fixture.business.id } });
  if (!role) throw new Error('fixture expected the workspace to have system roles');

  const membership = await Membership.create({
    userId: user.id,
    businessId: fixture.business.id,
    roleId: role.id,
    status: 'ACTIVE',
    invitedByUserId: null,
    invitedAt: null,
    joinedAt: new Date(),
  });

  const profile = await StaffProfile.create({
    businessId: fixture.business.id,
    userId: user.id,
    membershipId: membership.id,
    displayName,
    title: null,
    bio: null,
    avatarUrl: null,
    timezone: 'UTC',
    defaultLocationId,
    preBufferMinutes: null,
    postBufferMinutes: null,
    minNoticeMinutes: null,
    maxDailyAppointments: null,
    maxWeeklyAppointments: null,
    lastAssignedAt: null,
  });

  await ServiceStaff.create({
    serviceId: fixture.service.id,
    staffProfileId: profile.id,
    durationMinutesOverride: null,
    priceAmountOverride: null,
  });

  await StaffAvailabilityRule.bulkCreate(
    [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      businessId: fixture.business.id,
      staffProfileId: profile.id,
      locationId: null,
      dayOfWeek,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      effectiveFrom: null,
      effectiveTo: null,
    })),
  );

  return profile;
}

async function createBranch(name: string, timezone = 'UTC'): Promise<Location> {
  counter += 1;
  return Location.create({
    businessId: fixture.business.id,
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${process.pid}-${counter}`,
    description: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    countryCode: null,
    timezone,
    phone: null,
    email: null,
    virtualMeetingUrl: null,
    capacity: null,
    deletedAt: null,
  });
}

/** Makes the fixture service depend on a room, and returns the room. */
async function requireRoom(
  options: {
    capacity?: number;
    isRequired?: boolean;
    quantity?: number;
    locationId?: string | null;
  } = {},
): Promise<Resource> {
  counter += 1;
  const resource = await Resource.create({
    businessId: fixture.business.id,
    locationId: options.locationId ?? null,
    name: `Treatment room ${counter}`,
    slug: `treatment-room-${process.pid}-${counter}`,
    description: null,
    capacity: options.capacity ?? 1,
    color: null,
  });

  await ServiceResourceRequirement.create({
    serviceId: fixture.service.id,
    resourceId: resource.id,
    resourceType: null,
    quantity: options.quantity ?? 1,
    isRequired: options.isRequired ?? true,
  });

  return resource;
}

// ---------------------------------------------------------------------------
// Working windows
// ---------------------------------------------------------------------------

describe('working windows', () => {
  it('offers the intersection of the workspace hours and the provider hours', async () => {
    const day = nextWorkingDay();
    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });

    // 09:00–17:00 at a 30-minute grid, and nothing that would run past closing.
    expect(result.slots).toHaveLength(16);
    expect(result.slots[0]!.startsAt.toISOString()).toBe(at(day, 9).toISOString());
    expect(result.slots.at(-1)!.endsAt.toISOString()).toBe(at(day, 17).toISOString());
  });

  it('narrows to the provider when their hours are the shorter of the two', async () => {
    const day = nextWorkingDay();
    await StaffAvailabilityRule.update(
      { startMinute: 13 * 60 },
      { where: { businessId: fixture.business.id, dayOfWeek: day.getUTCDay() } },
    );

    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(result.slots).toHaveLength(8);
    expect(result.slots[0]!.startsAt.toISOString()).toBe(at(day, 13).toISOString());
  });

  it('narrows to the workspace when its hours are the shorter of the two', async () => {
    const day = nextWorkingDay();
    await BusinessHours.update(
      { endMinute: 12 * 60 },
      { where: { businessId: fixture.business.id, dayOfWeek: day.getUTCDay() } },
    );

    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(result.slots).toHaveLength(6);
    expect(result.slots.at(-1)!.endsAt.toISOString()).toBe(at(day, 12).toISOString());
  });

  it('offers nothing on a day the workspace keeps no hours', async () => {
    const sunday = nextDayOfWeek(0);
    const result = await search({ fromDate: dateOf(sunday), toDate: dateOf(sunday) });
    expect(result.slots).toEqual([]);
  });

  it('intersects two timezones as instants, not as clock readings', async () => {
    // A London clinic staffed from Mumbai: both sides read 09:00–17:00 on their
    // own wall clock, and only the hours that genuinely coincide are bookable.
    const abroad = await createWorkspace({ timezone: 'Europe/London' });
    await abroad.staffProfile.update({ timezone: 'Asia/Kolkata' });

    const day = nextWorkingDay();
    const date = dateOf(day);
    const result = await searchAvailability({
      businessId: abroad.business.id,
      businessTimezone: 'Europe/London',
      serviceId: abroad.service.id,
      fromDate: date,
      toDate: date,
      timezone: 'UTC',
    });

    // London opens after Mumbai does and Mumbai finishes long before London
    // closes, so the overlap runs from the London open to the Mumbai close.
    // Computed rather than hard-coded because British Summer Time moves one of
    // the two edges by an hour and the intersection has to follow it.
    const opensInLondon = resolveWallClock(date, 9 * 60, 'Europe/London').instant;
    const closesInMumbai = resolveWallClock(date, 17 * 60, 'Asia/Kolkata').instant;

    expect(result.slots.length).toBeGreaterThan(0);
    expect(result.slots[0]!.startsAt.toISOString()).toBe(opensInLondon.toISOString());
    expect(result.slots.at(-1)!.endsAt.toISOString()).toBe(closesInMumbai.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

describe('holidays', () => {
  it('closes the workspace on a holiday that shuts the business', async () => {
    const day = nextWorkingDay();
    await Holiday.create({
      businessId: fixture.business.id,
      locationId: null,
      name: 'Founders Day',
      date: dateOf(day),
    });

    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(result.slots).toEqual([]);
  });

  it('leaves a holiday that does not shut the business bookable', async () => {
    const day = nextWorkingDay();
    await Holiday.create({
      businessId: fixture.business.id,
      locationId: null,
      name: 'Awareness Day',
      date: dateOf(day),
      closesBusiness: false,
    });

    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(result.slots).toHaveLength(16);
  });

  it('matches a recurring holiday on month and day in later years', async () => {
    const day = nextWorkingDay();
    const [, month, dayOfMonth] = dateOf(day).split('-');
    await Holiday.create({
      businessId: fixture.business.id,
      locationId: null,
      name: 'Anniversary',
      // Recorded years ago; only the month and day are matched thereafter.
      date: `2020-${month}-${dayOfMonth}`,
      isRecurringAnnually: true,
    });

    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(result.slots).toEqual([]);
  });

  // Defect 27.
  it('shuts only the branch a location holiday names, leaving the other open', async () => {
    const branchA = await createBranch('Northside');
    const branchB = await createBranch('Southside');
    await fixture.staffProfile.update({ defaultLocationId: branchA.id });
    const atBranchB = await addProvider('Branch B provider', branchB.id);

    const day = nextWorkingDay();
    await Holiday.create({
      businessId: fixture.business.id,
      locationId: branchA.id,
      name: 'Northside street festival',
      date: dateOf(day),
    });

    const northside = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });
    const southside = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: atBranchB.id,
    });

    expect(northside.slots).toEqual([]);
    // The whole workspace used to shut for one branch's holiday, which quietly
    // cost every other branch a day of bookings.
    expect(southside.slots).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// Availability overrides
// ---------------------------------------------------------------------------

describe('availability overrides', () => {
  it('subtracts a staff override from that provider alone', async () => {
    const day = nextWorkingDay();
    const other = await addProvider('Unaffected provider');

    await AvailabilityOverride.create({
      businessId: fixture.business.id,
      scope: 'STAFF',
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      resourceId: null,
      date: dateOf(day),
      isAvailable: false,
      startMinute: 12 * 60,
      endMinute: 14 * 60,
      reason: 'TRAINING',
      note: null,
      createdByUserId: null,
    });

    const mine = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });
    const theirs = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: other.id,
    });

    expect(times(mine.slots)).not.toContain(at(day, 12).toISOString());
    expect(times(mine.slots)).not.toContain(at(day, 13.5).toISOString());
    expect(times(mine.slots)).toContain(at(day, 14).toISOString());
    expect(times(theirs.slots)).toContain(at(day, 12).toISOString());
  });

  it('removes time for everyone when the override is workspace-scoped', async () => {
    const day = nextWorkingDay();
    await addProvider('Second provider');

    await AvailabilityOverride.create({
      businessId: fixture.business.id,
      scope: 'BUSINESS',
      staffProfileId: null,
      locationId: null,
      resourceId: null,
      date: dateOf(day),
      isAvailable: false,
      startMinute: 12 * 60,
      endMinute: 13 * 60,
      reason: 'CUSTOM',
      note: null,
      createdByUserId: null,
    });

    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(times(result.slots)).not.toContain(at(day, 12).toISOString());
    expect(times(result.slots)).not.toContain(at(day, 12.5).toISOString());
    expect(times(result.slots)).toContain(at(day, 13).toISOString());
  });

  it('opens an unscheduled day only when both layers agree to it', async () => {
    const saturday = nextDayOfWeek(6);

    // The provider volunteers for a Saturday, but the doors stay shut: an
    // override on one layer cannot open the other.
    await AvailabilityOverride.create({
      businessId: fixture.business.id,
      scope: 'STAFF',
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      resourceId: null,
      date: dateOf(saturday),
      isAvailable: true,
      startMinute: 10 * 60,
      endMinute: 14 * 60,
      reason: 'EXTRA_HOURS',
      note: null,
      createdByUserId: null,
    });

    const staffOnly = await search({ fromDate: dateOf(saturday), toDate: dateOf(saturday) });
    expect(staffOnly.slots).toEqual([]);

    await AvailabilityOverride.create({
      businessId: fixture.business.id,
      scope: 'BUSINESS',
      staffProfileId: null,
      locationId: null,
      resourceId: null,
      date: dateOf(saturday),
      isAvailable: true,
      startMinute: 10 * 60,
      endMinute: 14 * 60,
      reason: 'EXTRA_HOURS',
      note: null,
      createdByUserId: null,
    });

    const bothLayers = await search({ fromDate: dateOf(saturday), toDate: dateOf(saturday) });
    expect(bothLayers.slots).toHaveLength(8);
    expect(bothLayers.slots[0]!.startsAt.toISOString()).toBe(at(saturday, 10).toISOString());
    expect(bothLayers.slots.at(-1)!.endsAt.toISOString()).toBe(at(saturday, 14).toISOString());
  });

  // Defect 27: LOCATION-scoped rows were never loaded by either consumer, so
  // the API accepted, stored and displayed configuration that did nothing.
  it('applies a location override to the branch it names', async () => {
    const branchA = await createBranch('Northside');
    const branchB = await createBranch('Southside');
    await fixture.staffProfile.update({ defaultLocationId: branchA.id });
    const atBranchB = await addProvider('Branch B provider', branchB.id);

    const day = nextWorkingDay();
    await AvailabilityOverride.create({
      businessId: fixture.business.id,
      scope: 'LOCATION',
      staffProfileId: null,
      locationId: branchA.id,
      resourceId: null,
      date: dateOf(day),
      isAvailable: false,
      startMinute: null,
      endMinute: null,
      reason: 'MAINTENANCE',
      note: null,
      createdByUserId: null,
    });

    const northside = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });
    const southside = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: atBranchB.id,
    });

    expect(northside.slots).toEqual([]);
    expect(southside.slots).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// Blackouts
// ---------------------------------------------------------------------------

describe('blackouts', () => {
  it('removes a staff blackout from that provider alone', async () => {
    const day = nextWorkingDay();
    const other = await addProvider('Unaffected provider');

    await BlackoutPeriod.create({
      businessId: fixture.business.id,
      scope: 'STAFF',
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      resourceId: null,
      startsAt: at(day, 10),
      endsAt: at(day, 11),
      note: null,
      createdByUserId: null,
    });

    const mine = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });
    const theirs = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: other.id,
    });

    expect(times(mine.slots)).not.toContain(at(day, 10).toISOString());
    expect(times(mine.slots)).not.toContain(at(day, 10.5).toISOString());
    expect(times(mine.slots)).toContain(at(day, 11).toISOString());
    expect(times(theirs.slots)).toContain(at(day, 10).toISOString());
  });

  it('applies a location blackout even when the caller named no location', async () => {
    // The provider is booked into their default branch whether or not the
    // customer filtered by one, so a closure there has to reach them.
    const branch = await createBranch('Northside');
    await fixture.staffProfile.update({ defaultLocationId: branch.id });

    const day = nextWorkingDay();
    await BlackoutPeriod.create({
      businessId: fixture.business.id,
      scope: 'LOCATION',
      staffProfileId: null,
      locationId: branch.id,
      resourceId: null,
      startsAt: at(day, 10),
      endsAt: at(day, 11),
      reason: 'MAINTENANCE',
      note: null,
      createdByUserId: null,
    });

    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(times(result.slots)).not.toContain(at(day, 10).toISOString());
    expect(times(result.slots)).not.toContain(at(day, 10.5).toISOString());
    expect(times(result.slots)).toContain(at(day, 11).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Resource requirements — defect 25
// ---------------------------------------------------------------------------

describe('resource requirements', () => {
  it('hides a slot whose required room is already taken', async () => {
    await requireRoom({ capacity: 1 });
    const other = await addProvider('Second provider');
    const day = nextWorkingDay();

    // The other provider is free, but there is only one room and it is now hers.
    await book(at(day, 10), { staffProfileId: other.id });

    const result = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });

    expect(times(result.slots)).not.toContain(at(day, 10).toISOString());
    expect(times(result.slots)).toContain(at(day, 9.5).toISOString());
    expect(times(result.slots)).toContain(at(day, 10.5).toISOString());

    // And the hidden slot really is unbookable: before the search knew about
    // resources this was the customer's first sign of the clash.
    const refusal = await refusalOf(book(at(day, 10)));
    expect(refusal?.code).toBe(ErrorCode.RESOURCE_UNAVAILABLE);
  });

  it('counts the spare places on a shared resource', async () => {
    await requireRoom({ capacity: 2 });
    const second = await addProvider('Second provider');
    const third = await addProvider('Third provider');
    const day = nextWorkingDay();

    await book(at(day, 10), { staffProfileId: second.id });

    const withOnePlaceLeft = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });
    // One of two places taken is not a clash — an exclusion constraint could
    // not express that, and neither may the search.
    expect(times(withOnePlaceLeft.slots)).toContain(at(day, 10).toISOString());

    await book(at(day, 10), { staffProfileId: third.id });

    const full = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });
    expect(times(full.slots)).not.toContain(at(day, 10).toISOString());
  });

  it('keeps offering a slot when the resource that is missing is optional', async () => {
    await requireRoom({ capacity: 1, isRequired: false });
    const other = await addProvider('Second provider');
    const day = nextWorkingDay();

    await book(at(day, 10), { staffProfileId: other.id });

    const result = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });

    // Booking proceeds without an optional resource, so hiding the slot would
    // break the invariant in the other direction.
    expect(times(result.slots)).toContain(at(day, 10).toISOString());
    await expect(book(at(day, 10))).resolves.toBeTruthy();
  });

  it('honours a resource blackout in the search and refuses it at commit', async () => {
    const room = await requireRoom({ capacity: 1 });
    const day = nextWorkingDay();

    await BlackoutPeriod.create({
      businessId: fixture.business.id,
      scope: 'RESOURCE',
      staffProfileId: null,
      locationId: null,
      resourceId: room.id,
      startsAt: at(day, 10),
      endsAt: at(day, 11),
      reason: 'MAINTENANCE',
      note: null,
      createdByUserId: null,
    });

    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(times(result.slots)).not.toContain(at(day, 10).toISOString());
    expect(times(result.slots)).not.toContain(at(day, 10.5).toISOString());
    expect(times(result.slots)).toContain(at(day, 11).toISOString());

    // Both consumers used to drop RESOURCE-scoped rows entirely, so a room
    // taken out of service was still advertised and still bookable.
    const refusal = await refusalOf(book(at(day, 10)));
    expect(refusal?.code).toBe(ErrorCode.SLOT_UNAVAILABLE);
  });

  it('offers nothing when a required resource type has no resources at all', async () => {
    await ServiceResourceRequirement.create({
      serviceId: fixture.service.id,
      resourceId: null,
      resourceType: 'VEHICLE',
      quantity: 1,
      isRequired: true,
    });

    const day = nextWorkingDay();
    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(result.slots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Daily booking caps — defect 26
// ---------------------------------------------------------------------------

describe('daily booking caps', () => {
  it('stops offering a customer times once they reach their daily cap', async () => {
    await BusinessSettings.update(
      { maxBookingsPerCustomerPerDay: 1 },
      { where: { businessId: fixture.business.id } },
    );

    const day = nextWorkingDay();
    const nextDay = nextWorkingDay(11);
    await book(at(day, 10), { customerId: fixture.customer.id });

    const capped = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      customerId: fixture.customer.id,
    });
    const later = await search({
      fromDate: dateOf(nextDay),
      toDate: dateOf(nextDay),
      customerId: fixture.customer.id,
    });

    // The cap was enforced at submit and invisible in search, so a customer at
    // their limit was shown a full day of times and refused on every one.
    expect(capped.slots).toEqual([]);
    expect(later.slots).toHaveLength(16);

    const refusal = await refusalOf(book(at(day, 14), { customerId: fixture.customer.id }));
    expect(refusal?.code).toBe(ErrorCode.POLICY_VIOLATION);

    // Somebody else's day is untouched: the cap is the customer's, not the day's.
    const anyone = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    expect(times(anyone.slots)).toContain(at(day, 14).toISOString());
  });

  it('stops offering a provider once they reach the workspace daily cap', async () => {
    await BusinessSettings.update(
      { maxBookingsPerStaffPerDay: 1 },
      { where: { businessId: fixture.business.id } },
    );

    const day = nextWorkingDay();
    const other = await addProvider('Second provider');
    await book(at(day, 10));

    const mine = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });
    const theirs = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: other.id,
    });

    expect(mine.slots).toEqual([]);
    expect(theirs.slots).toHaveLength(16);
  });

  // The decision recorded in `resolvePolicy`: a per-profile cap is a hard gate,
  // resolved into the policy so the search and the commit read one number.
  it('treats a per-profile daily cap as a hard gate on both paths', async () => {
    await fixture.staffProfile.update({ maxDailyAppointments: 1 });

    const day = nextWorkingDay();
    await book(at(day, 10));

    const result = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });
    expect(result.slots).toEqual([]);

    const refusal = await refusalOf(book(at(day, 14)));
    expect(refusal?.code).toBe(ErrorCode.POLICY_VIOLATION);
  });

  it('takes the tighter of the workspace cap and the provider cap', async () => {
    await BusinessSettings.update(
      { maxBookingsPerStaffPerDay: 8 },
      { where: { businessId: fixture.business.id } },
    );
    await fixture.staffProfile.update({ maxDailyAppointments: 2 });

    const day = nextWorkingDay();
    await book(at(day, 9));
    await book(at(day, 10));

    // A generous workspace default must not raise a cap the provider set.
    const result = await search({
      fromDate: dateOf(day),
      toDate: dateOf(day),
      staffProfileId: fixture.staffProfile.id,
    });
    expect(result.slots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Overnight hours — defect 28
// ---------------------------------------------------------------------------

describe('overnight hours', () => {
  it('offers and books a slot that falls after midnight in the previous day’s window', async () => {
    // A Friday 22:00–02:00 shift, stored as 1320–1560. Friday is chosen so the
    // small hours land on a Saturday, which keeps its own rules out of the way
    // and leaves only the window that runs over midnight.
    const friday = nextDayOfWeek(5);
    const saturday = new Date(friday.getTime() + 24 * HOUR);
    await setHoursFor(5, 22 * 60, 26 * 60);

    const result = await search({ fromDate: dateOf(friday), toDate: dateOf(saturday) });

    expect(times(result.slots)).toEqual([
      at(friday, 22).toISOString(),
      at(friday, 22.5).toISOString(),
      at(friday, 23).toISOString(),
      at(friday, 23.5).toISOString(),
      at(saturday, 0).toISOString(),
      at(saturday, 0.5).toISOString(),
      at(saturday, 1).toISOString(),
      at(saturday, 1.5).toISOString(),
    ]);

    // The confirmation check resolved one calendar date, so the small hours
    // belonged to no window it could see and every one of these was refused as
    // OUTSIDE_WORKING_HOURS after the customer had chosen it.
    const booked = await book(at(saturday, 0.5));
    expect(booked.appointment.startsAt.toISOString()).toBe(at(saturday, 0.5).toISOString());
  });

  it('offers the tail of an overnight window on a single-day search', async () => {
    // The day being searched keeps no hours of its own; everything on offer
    // comes from the rule that started the evening before.
    const friday = nextDayOfWeek(5);
    const saturday = new Date(friday.getTime() + 24 * HOUR);
    await setHoursFor(5, 22 * 60, 26 * 60);

    const result = await search({ fromDate: dateOf(saturday), toDate: dateOf(saturday) });
    expect(times(result.slots)).toEqual([
      at(saturday, 0).toISOString(),
      at(saturday, 0.5).toISOString(),
      at(saturday, 1).toISOString(),
      at(saturday, 1.5).toISOString(),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The invariant itself
// ---------------------------------------------------------------------------

describe('search and commit agree', () => {
  /**
   * The test worth more than the four individual ones.
   *
   * Every rule in this file is exercised at once, then the search is asked what
   * it will offer and each answer is booked. A slot the search offers that
   * confirmation refuses fails here immediately, whichever rule the two ended
   * up disagreeing about — including rules added long after this was written.
   */
  it('books every slot it offers, and refuses the ones it withheld', async () => {
    const day = nextWorkingDay();
    // A short day, so the assertion is about agreement rather than about how
    // many bookings a test can afford to make.
    await setHoursFor(day.getUTCDay(), 9 * 60, 13 * 60);

    const other = await addProvider('Second provider');
    await requireRoom({ capacity: 1 });

    // A workspace-wide closure over lunch...
    await BlackoutPeriod.create({
      businessId: fixture.business.id,
      scope: 'BUSINESS',
      staffProfileId: null,
      locationId: null,
      resourceId: null,
      startsAt: at(day, 11),
      endsAt: at(day, 12),
      reason: 'TRAINING',
      note: null,
      createdByUserId: null,
    });
    // ...and the only room taken at 10:00 by somebody already in the diary.
    await book(at(day, 10), { staffProfileId: other.id });

    const result = await search({ fromDate: dateOf(day), toDate: dateOf(day) });
    const offered = times(result.slots);

    expect(offered).toEqual([
      at(day, 9).toISOString(),
      at(day, 9.5).toISOString(),
      at(day, 10.5).toISOString(),
      at(day, 12).toISOString(),
      at(day, 12.5).toISOString(),
    ]);

    // Everything offered must commit. Booked in the order they were offered,
    // which is the order a customer would see them in.
    for (const slot of result.slots) {
      const refusal = await refusalOf(book(slot.startsAt, { staffProfileId: slot.staffProfileId }));
      expect(
        refusal,
        `the search offered ${slot.startsAt.toISOString()} and commit refused it`,
      ).toBeNull();
    }

    // And the other direction: what the search withheld is genuinely unbookable
    // rather than merely hidden.
    expect(await refusalOf(book(at(day, 11)))).not.toBeNull();
    expect(await refusalOf(book(at(day, 13)))).not.toBeNull();
  });
});
