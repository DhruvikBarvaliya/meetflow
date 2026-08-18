/**
 * Utilisation denominators against real PostgreSQL.
 *
 * This file exists because the denominator used to be the rota and nothing but
 * the rota. A provider on a week's approved leave still counted as fully
 * rostered, so their utilisation read close to zero and the staff report
 * suggested idleness where there was absence — while docs/Analytics.md promised
 * that "80% utilised" meant the same thing on the report as on the calendar.
 *
 * Every assertion here is on the **number**, not on the direction of a change.
 * "It went down" would pass for an off-by-one that subtracted the wrong day, and
 * the whole point of a utilisation figure is that a business acts on its value:
 * a week of Mon–Fri 09:00–17:00 is 2,400 minutes, one day of leave takes it to
 * 1,920, and a 30-minute appointment against that is 0.0156.
 *
 * The window is next week rather than last, because appointments are made in
 * the future and a booking has to go through the real booking path to be
 * counted by the real query.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AvailabilityOverride,
  BlackoutPeriod,
  Holiday,
  Location,
  Membership,
  Role,
  StaffProfile,
} from '../../src/database/models';
import {
  locationPerformance,
  staffPerformance,
} from '../../src/modules/analytics/analytics.service';
import { createBooking } from '../../src/modules/appointments/booking.service';
import { toIsoDateInZone } from '../../src/utils/time';
import {
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

let fixture: WorkspaceFixture;

/** Mon–Fri 09:00–17:00 is eight hours a day, five days a week. */
const ROSTERED_MINUTES_PER_WEEK = 5 * 8 * 60;
const ROSTERED_MINUTES_PER_DAY = 8 * 60;

/**
 * The Monday of a week that is entirely in the future.
 *
 * Far enough ahead that the whole week is bookable whatever day the suite runs
 * on, and returned at UTC midnight because the fixture workspace keeps UTC —
 * which makes every calendar-day boundary in these assertions exact.
 */
function upcomingMonday(): Date {
  const monday = new Date();
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() + 8);
  while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
  return monday;
}

/** `offsetDays` after `from`, at `hour` UTC. */
function dayAt(from: Date, offsetDays: number, hour = 0): Date {
  const date = new Date(from.getTime());
  date.setUTCDate(date.getUTCDate() + offsetDays);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

let monday: Date;
let window: { from: string; to: string };

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
  monday = upcomingMonday();
  window = {
    from: toIsoDateInZone(monday, 'UTC'),
    to: toIsoDateInZone(dayAt(monday, 6), 'UTC'),
  };
});

afterAll(async () => {
  await closeDatabaseConnection();
});

/** One 30-minute appointment on the Monday of the reported week. */
async function bookMondayMorning(locationId: string | null = null): Promise<void> {
  await createBooking({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId: fixture.staffProfile.id,
    locationId,
    startsAt: dayAt(monday, 0, 10),
    timezone: 'UTC',
    customer: { firstName: 'Ada', lastName: 'Customer', email: 'utilisation@meetflow.test' },
    source: 'STAFF',
    actor: { type: 'OWNER', label: 'owner@meetflow.test' },
  });
}

/** A second provider, so scoping assertions have somebody to be scoped away from. */
async function addProvider(displayName: string): Promise<StaffProfile> {
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

  return StaffProfile.create({
    businessId: fixture.business.id,
    userId: user.id,
    membershipId: membership.id,
    displayName,
    title: null,
    bio: null,
    avatarUrl: null,
    timezone: 'UTC',
    defaultLocationId: null,
    preBufferMinutes: null,
    postBufferMinutes: null,
    minNoticeMinutes: null,
    maxDailyAppointments: null,
    maxWeeklyAppointments: null,
    lastAssignedAt: null,
  });
}

async function rowForOwner() {
  const rows = await staffPerformance(fixture.business.id, 'UTC', window);
  const row = rows.find((entry) => entry.staffProfileId === fixture.staffProfile.id);
  if (!row) throw new Error('the provider should always appear on the staff report');
  return row;
}

describe('staff utilisation', () => {
  it('divides by the full rota when nothing was taken out of it', async () => {
    await bookMondayMorning();

    const row = await rowForOwner();

    expect(row.workingMinutes).toBe(ROSTERED_MINUTES_PER_WEEK);
    expect(row.bookedMinutes).toBe(30);
    // 30 / 2400
    expect(row.utilisationRate).toBe(0.0125);
  });

  it('subtracts a day of approved leave from the denominator', async () => {
    await bookMondayMorning();

    // Leave as the product records it: a whole-day removal on the Wednesday.
    // Both minute columns NULL is what "all day" means — the same rows the
    // scheduling engine reads when it refuses to offer that day.
    await AvailabilityOverride.create({
      businessId: fixture.business.id,
      scope: 'STAFF',
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      resourceId: null,
      date: toIsoDateInZone(dayAt(monday, 2), 'UTC'),
      isAvailable: false,
      startMinute: null,
      endMinute: null,
      reason: 'LEAVE',
      note: null,
      createdByUserId: null,
    });

    const row = await rowForOwner();

    expect(row.workingMinutes).toBe(ROSTERED_MINUTES_PER_WEEK - ROSTERED_MINUTES_PER_DAY);
    expect(row.bookedMinutes).toBe(30);
    // 30 / 1920, which reads as 1.56% rather than the 1.25% a full week claims.
    expect(row.utilisationRate).toBe(0.0156);
  });

  it('subtracts only the hours a part-day override removes', async () => {
    await AvailabilityOverride.create({
      businessId: fixture.business.id,
      scope: 'STAFF',
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      resourceId: null,
      date: toIsoDateInZone(dayAt(monday, 1), 'UTC'),
      isAvailable: false,
      // 13:00–17:00 off: an afternoon, not a day.
      startMinute: 13 * 60,
      endMinute: 17 * 60,
      reason: 'TRAINING',
      note: null,
      createdByUserId: null,
    });

    const row = await rowForOwner();

    expect(row.workingMinutes).toBe(ROSTERED_MINUTES_PER_WEEK - 240);
  });

  it('subtracts a workspace holiday that closes the business', async () => {
    await Holiday.create({
      businessId: fixture.business.id,
      locationId: null,
      name: 'Founders Day',
      date: toIsoDateInZone(dayAt(monday, 3), 'UTC'),
      isRecurringAnnually: false,
      closesBusiness: true,
      isActive: true,
    });

    const row = await rowForOwner();

    expect(row.workingMinutes).toBe(ROSTERED_MINUTES_PER_WEEK - ROSTERED_MINUTES_PER_DAY);
  });

  it('leaves the denominator alone for a holiday that does not close the business', async () => {
    await Holiday.create({
      businessId: fixture.business.id,
      locationId: null,
      name: 'Name day',
      date: toIsoDateInZone(dayAt(monday, 3), 'UTC'),
      isRecurringAnnually: false,
      // Labelled for customers, open as usual — so it removes nothing.
      closesBusiness: false,
      isActive: true,
    });

    const row = await rowForOwner();

    expect(row.workingMinutes).toBe(ROSTERED_MINUTES_PER_WEEK);
  });

  it('subtracts a blackout, and only the part of it inside a rostered window', async () => {
    // 07:00–12:00 on the Friday. The three hours before 09:00 are not rostered
    // and were never in the denominator, so only 09:00–12:00 comes off.
    await BlackoutPeriod.create({
      businessId: fixture.business.id,
      scope: 'STAFF',
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      resourceId: null,
      startsAt: dayAt(monday, 4, 7),
      endsAt: dayAt(monday, 4, 12),
      reason: 'TRAINING',
      note: null,
      createdByUserId: null,
    });

    const row = await rowForOwner();

    expect(row.workingMinutes).toBe(ROSTERED_MINUTES_PER_WEEK - 180);
  });

  it('counts leave recorded twice only once', async () => {
    const wednesday = dayAt(monday, 2);

    await AvailabilityOverride.create({
      businessId: fixture.business.id,
      scope: 'STAFF',
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      resourceId: null,
      date: toIsoDateInZone(wednesday, 'UTC'),
      isAvailable: false,
      startMinute: null,
      endMinute: null,
      reason: 'LEAVE',
      note: null,
      createdByUserId: null,
    });
    // The same day again, as a blackout. A careful administrator does both, and
    // subtracting the day twice would take Thursday with it.
    await BlackoutPeriod.create({
      businessId: fixture.business.id,
      scope: 'STAFF',
      staffProfileId: fixture.staffProfile.id,
      locationId: null,
      resourceId: null,
      startsAt: dayAt(monday, 2, 0),
      endsAt: dayAt(monday, 3, 0),
      reason: 'LEAVE',
      note: null,
      createdByUserId: null,
    });

    const row = await rowForOwner();

    expect(row.workingMinutes).toBe(ROSTERED_MINUTES_PER_WEEK - ROSTERED_MINUTES_PER_DAY);
  });

  it('ignores leave belonging to a different provider', async () => {
    const other = await addProvider('Locum');

    await AvailabilityOverride.create({
      businessId: fixture.business.id,
      scope: 'STAFF',
      staffProfileId: other.id,
      locationId: null,
      resourceId: null,
      date: toIsoDateInZone(dayAt(monday, 2), 'UTC'),
      isAvailable: false,
      startMinute: null,
      endMinute: null,
      reason: 'LEAVE',
      note: null,
      createdByUserId: null,
    });

    const row = await rowForOwner();

    expect(row.workingMinutes).toBe(ROSTERED_MINUTES_PER_WEEK);
  });
});

describe('location utilisation', () => {
  it('subtracts a closure from the opening hours of a branch', async () => {
    const location = await Location.create({
      businessId: fixture.business.id,
      name: 'Main Street',
      slug: 'main-street',
      description: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: null,
      postalCode: null,
      countryCode: null,
      timezone: 'UTC',
      phone: null,
      email: null,
      virtualMeetingUrl: null,
      capacity: null,
    });

    await bookMondayMorning(location.id);

    await Holiday.create({
      businessId: fixture.business.id,
      locationId: location.id,
      name: 'Refit',
      date: toIsoDateInZone(dayAt(monday, 2), 'UTC'),
      isRecurringAnnually: false,
      closesBusiness: true,
      isActive: true,
    });

    const rows = await locationPerformance(fixture.business.id, 'UTC', window);
    const row = rows.find((entry) => entry.locationId === location.id);
    if (!row) throw new Error('the branch should appear on the location report');

    // The workspace's own hours apply to a branch with none of its own, so the
    // site is open the same 2,400 minutes — less the day it was shut.
    expect(row.openMinutes).toBe(ROSTERED_MINUTES_PER_WEEK - ROSTERED_MINUTES_PER_DAY);
    expect(row.bookedMinutes).toBe(30);
    expect(row.utilisationRate).toBe(0.0156);
  });
});
