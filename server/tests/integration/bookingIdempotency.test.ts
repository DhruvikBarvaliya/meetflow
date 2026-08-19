/**
 * What an idempotency key hashes.
 *
 * Delete these and the two failures the request hash exists to prevent both
 * come back, in opposite directions:
 *
 *  - **A retry refused as reuse.** On the public "no preference" path the
 *    provider is chosen by Smart Match *inside* the request, so a customer
 *    whose confirmation timed out and whose client retried can resolve to a
 *    different provider than the first attempt did. Hash the resolution and
 *    that retry is answered with IDEMPOTENCY_KEY_REUSED — a customer told their
 *    booking failed while it sits confirmed in the diary.
 *  - **A different booking replayed as a retry.** The hash once covered only
 *    the service, provider, slot and email, so the same key sent with different
 *    answers, notes, name or phone number silently returned the first
 *    appointment and threw the second request's content away.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Appointment,
  Location,
  Membership,
  Role,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
} from '../../src/database/models';
import {
  createBooking,
  type CreateBookingInput,
} from '../../src/modules/appointments/booking.service';
import { ErrorCode } from '../../src/utils/errors';
import {
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

let fixture: WorkspaceFixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
});

afterAll(async () => {
  await closeDatabaseConnection();
});

/** A second bookable provider, so Smart Match has something to choose between. */
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

  const profile = await StaffProfile.create({
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

/**
 * A booking as the public "no preference" path makes it: the provider above is
 * what the server resolved, and `requested` is the empty preference the
 * customer actually expressed.
 */
function noPreferenceBooking(
  startsAt: Date,
  resolvedStaffProfileId: string,
  overrides: Partial<CreateBookingInput> = {},
): CreateBookingInput {
  return {
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId: resolvedStaffProfileId,
    locationId: null,
    requested: { staffProfileId: null, locationId: null },
    startsAt,
    timezone: 'UTC',
    customer: {
      firstName: 'Ada',
      lastName: 'Customer',
      email: 'retry@meetflow.test',
      phone: '+441234567890',
    },
    source: 'PUBLIC',
    customerNotes: 'Wheelchair access, please.',
    answers: { referral: 'a friend' },
    idempotencyKey: 'retry-key-0000000001',
    actor: { type: 'CUSTOMER', label: 'retry@meetflow.test' },
    ...overrides,
  };
}

describe('a retry under the same key', () => {
  it('replays even when the provider was resolved differently', async () => {
    const startsAt = nextWeekdayAt(10);
    const other = await addProvider('Second provider');

    const first = await createBooking(noPreferenceBooking(startsAt, fixture.staffProfile.id));
    expect(first.replayed).toBe(false);

    // The retry: identical request, and Smart Match happened to land on the
    // other provider this time because the first booking now occupies the
    // original one.
    const retry = await createBooking(noPreferenceBooking(startsAt, other.id));

    expect(retry.replayed).toBe(true);
    expect(retry.appointment.id).toBe(first.appointment.id);
    expect(retry.appointment.staffProfileId).toBe(fixture.staffProfile.id);

    // And no second appointment was made behind the replay.
    const count = await Appointment.count({ where: { businessId: fixture.business.id } });
    expect(count).toBe(1);
  });

  it('replays even when the site was resolved differently', async () => {
    const startsAt = nextWeekdayAt(11);
    const site = await Location.create({
      businessId: fixture.business.id,
      name: 'Riverside branch',
      slug: `riverside-${process.pid}`,
      description: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: null,
      postalCode: null,
      countryCode: null,
      phone: null,
      email: null,
      virtualMeetingUrl: null,
      capacity: null,
      deletedAt: null,
    });

    const first = await createBooking(noPreferenceBooking(startsAt, fixture.staffProfile.id));
    const retry = await createBooking(
      // The site comes off the matched slot on the public path, so it varies
      // with the provider Smart Match picked. The customer named neither, and
      // `requested.locationId` stays null on both attempts.
      noPreferenceBooking(startsAt, fixture.staffProfile.id, { locationId: site.id }),
    );

    expect(retry.replayed).toBe(true);
    expect(retry.appointment.id).toBe(first.appointment.id);
  });
});

describe('a different payload under the same key', () => {
  it('is refused when the note to the business changes', async () => {
    const startsAt = nextWeekdayAt(10);
    await createBooking(noPreferenceBooking(startsAt, fixture.staffProfile.id));

    await expect(
      createBooking(
        noPreferenceBooking(startsAt, fixture.staffProfile.id, {
          customerNotes: 'Actually, I need a ground-floor room.',
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_KEY_REUSED });
  });

  it('is refused when the answers to the booking questions change', async () => {
    const startsAt = nextWeekdayAt(10);
    await createBooking(noPreferenceBooking(startsAt, fixture.staffProfile.id));

    await expect(
      createBooking(
        noPreferenceBooking(startsAt, fixture.staffProfile.id, {
          answers: { referral: 'a search engine' },
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_KEY_REUSED });
  });

  it('is refused when the customer is a different person under the same email', async () => {
    const startsAt = nextWeekdayAt(10);
    await createBooking(noPreferenceBooking(startsAt, fixture.staffProfile.id));

    await expect(
      createBooking(
        noPreferenceBooking(startsAt, fixture.staffProfile.id, {
          customer: {
            firstName: 'Grace',
            lastName: 'Someone-Else',
            email: 'retry@meetflow.test',
            phone: '+447777777777',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_KEY_REUSED });
  });

  it('is refused when the caller asked for a different provider', async () => {
    const startsAt = nextWeekdayAt(10);
    const other = await addProvider('Second provider');

    // A staff-made booking: here the provider *is* the request, so dropping it
    // from the hash to fix the public path would have made this replay somebody
    // else's appointment back at the caller.
    await createBooking(
      noPreferenceBooking(startsAt, fixture.staffProfile.id, {
        requested: { staffProfileId: fixture.staffProfile.id, locationId: null },
        source: 'STAFF',
      }),
    );

    await expect(
      createBooking(
        noPreferenceBooking(startsAt, other.id, {
          requested: { staffProfileId: other.id, locationId: null },
          source: 'STAFF',
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_KEY_REUSED });
  });
});
