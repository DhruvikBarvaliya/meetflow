/**
 * One opening, one offer — proven with the Redis lock switched off.
 *
 * The matcher's header used to claim that "the whole evaluation runs under a
 * Redis lock … so two slots freeing at the same instant cannot hand the same
 * customer two holds, or two customers the same slot". Two things were wrong
 * with that. What the lock guarded was a `SELECT count(*)` followed some
 * milliseconds later by an UPDATE, which is not atomic however well it is
 * locked; and `acquireLock` returns null — proceeding *unlocked* — the moment
 * Redis is unreachable. So the protection switched itself off during exactly
 * the incident that makes evaluations pile up, and two customers could each be
 * told the same slot was theirs with only one appointment behind it.
 *
 * These tests therefore run with the lock removed on purpose. `withLock` is
 * replaced by a pass-through, which is precisely what the real one degrades
 * into when Redis is down, so nothing here can pass by taking a lock. What has
 * to hold the line instead is `waitlist_live_offer_unique`, the partial unique
 * index the accompanying migration adds — the same answer booking already
 * uses, where the database is the authority and the lock is only a fast path.
 *
 * The race is staged with two providers freeing the same clock time, because
 * that is the shape in which two *different* customers can be served: each
 * entry names a different provider, so the two evaluations pick different
 * people, and only the opening itself is shared.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Imported for its type only, so the mock factory below can say what it is
// spreading without an inline `import()` annotation — which the shared lint
// config forbids, on the grounds that a type's origin should be visible at the
// top of the file rather than buried in an expression.
import type * as RedisConfig from '../../src/config/redis';
import {
  Customer,
  Membership,
  Notification,
  Role,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
  WaitlistEntry,
} from '../../src/database/models';
import {
  evaluateWaitlistForSlot,
  offerSlotToEntry,
} from '../../src/modules/waitlist/waitlist.matcher';
import { createWaitlistEntry } from '../../src/modules/waitlist/waitlist.service';
import { ErrorCode } from '../../src/utils/errors';
import { toIsoDateInZone } from '../../src/utils/time';
import {
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

// Redis as it behaves when it is not there: `acquireLock` hands back nothing
// and `withLock` runs the work anyway. Everything else in the module is left
// alone, so this is the outage the code has to survive rather than a fake.
vi.mock('../../src/config/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisConfig>();
  return {
    ...actual,
    isRedisReady: () => false,
    acquireLock: async () => null,
    withLock: async <T>(_key: string, _ttlMs: number, fn: () => Promise<T>): Promise<T> => fn(),
  };
});

interface FreedSlot {
  businessId: string;
  serviceId: string;
  staffProfileId: string;
  startsAt: Date;
  endsAt: Date;
}

let fixture: WorkspaceFixture;
let sequence = 0;

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
  sequence = 0;
});

afterAll(async () => {
  await closeDatabaseConnection();
});

/**
 * A second bookable provider in the same workspace, keeping the fixture's
 * Mon–Fri 09:00–17:00 hours.
 *
 * Two providers is what makes the race reproducible: the same minute can be
 * freed in two diaries at once, and each freeing is a separate evaluation of
 * one shared opening.
 */
async function anotherProvider(): Promise<StaffProfile> {
  sequence += 1;
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
    displayName: `Locum ${sequence}`,
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
 * Somebody waiting for `startsAt`, optionally insisting on one provider.
 *
 * A provider preference is what lets two entries be top of two different
 * queues for the same minute — without it both evaluations would pick the same
 * person, which is a different (and harmless) collision.
 */
async function waitingCustomer(
  startsAt: Date,
  staffProfileId: string | null,
): Promise<WaitlistEntry> {
  sequence += 1;
  const customer = await Customer.create({
    businessId: fixture.business.id,
    publicId: `cus_race${process.pid}${sequence}`,
    userId: null,
    firstName: `Racer${sequence}`,
    lastName: 'Waiting',
    email: `racer-${process.pid}-${sequence}@meetflow.test`,
    phone: null,
    timezone: 'UTC',
    notes: null,
    preferredStaffProfileId: null,
    preferredLocationId: null,
    firstAppointmentAt: null,
    lastAppointmentAt: null,
  });

  const date = toIsoDateInZone(startsAt, 'UTC');
  return createWaitlistEntry(
    fixture.business.id,
    {
      customerId: customer.id,
      serviceId: fixture.service.id,
      staffProfileId,
      locationId: null,
      earliestDate: date,
      latestDate: date,
      earliestMinute: 0,
      latestMinute: 1440,
      daysOfWeek: [],
      timezone: 'UTC',
      priority: 100,
      notifyChannel: 'EMAIL',
      expiresAt: null,
      note: null,
    },
    { userId: fixture.user.id, email: fixture.user.email, type: 'OWNER' },
    { requestId: 'race', ipAddress: null, userAgent: null },
  );
}

function freedSlot(staffProfileId: string, startsAt: Date): FreedSlot {
  return {
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
  };
}

async function offersSent(): Promise<number> {
  return Notification.count({ where: { type: 'WAITLIST_SLOT_AVAILABLE' } });
}

describe('two providers freeing the same minute at once, with Redis unavailable', () => {
  it('serve one customer, not two', async () => {
    const startsAt = nextWeekdayAt(10);
    const locum = await anotherProvider();
    await waitingCustomer(startsAt, fixture.staffProfile.id);
    await waitingCustomer(startsAt, locum.id);

    // Both evaluations read "nobody holds this opening" before either writes —
    // the gap the count could never close, and the one an outage widens.
    const results = await Promise.all([
      evaluateWaitlistForSlot(freedSlot(fixture.staffProfile.id, startsAt)),
      evaluateWaitlistForSlot(freedSlot(locum.id, startsAt)),
    ]);

    expect(results.filter((entry) => entry !== null)).toHaveLength(1);

    const held = await WaitlistEntry.findAll({
      where: { businessId: fixture.business.id, status: 'NOTIFIED' },
    });
    expect(held).toHaveLength(1);
    expect(held[0]?.heldSlotStartsAt?.toISOString()).toBe(startsAt.toISOString());

    // The email is the part the customer experiences, and the part that cannot
    // be taken back once two of them have gone out.
    expect(await offersSent()).toBe(1);
  });

  it('refuse the second hold at the database, whatever the caller believed', async () => {
    // The same collision with no reliance on timing: one entry holds the
    // opening and another is offered it directly, which is the state a stale
    // read, a retried job or a second process arrives in.
    const startsAt = nextWeekdayAt(11);
    await waitingCustomer(startsAt, fixture.staffProfile.id);
    const other = await waitingCustomer(startsAt, (await anotherProvider()).id);

    expect(
      await evaluateWaitlistForSlot(freedSlot(fixture.staffProfile.id, startsAt)),
    ).not.toBeNull();

    await expect(
      offerSlotToEntry({
        entry: other,
        startsAt,
        endsAt: null,
        holdMinutes: 60,
        actor: { actorType: 'SYSTEM', userId: null, label: 'test' },
        metadata: {},
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: ErrorCode.CONFLICT });

    // The rollback took the audit line and the outbox row with it: an offer
    // that did not happen must leave nothing behind claiming it did.
    const stillWaiting = await WaitlistEntry.findByPk(other.id);
    expect(stillWaiting?.status).toBe('ACTIVE');
    expect(stillWaiting?.notificationCount).toBe(0);
    expect(await offersSent()).toBe(1);
  });

  it('let the opening be offered again once the hold has lapsed', async () => {
    // The other half of the constraint's bargain. An index predicate cannot
    // read a clock, so a lapsed hold would keep its opening unofferable for
    // ever if the matcher did not release it inline — one customer ignoring
    // one email would quietly freeze the queue behind them until the
    // maintenance sweep next ran.
    const startsAt = nextWeekdayAt(12);
    const waiting = await waitingCustomer(startsAt, fixture.staffProfile.id);

    expect((await evaluateWaitlistForSlot(freedSlot(fixture.staffProfile.id, startsAt)))?.id).toBe(
      waiting.id,
    );

    const held = await WaitlistEntry.findByPk(waiting.id);
    await held?.update({ holdExpiresAt: new Date(Date.now() - 60_000) });

    // Offered again, and to the same person: releasing a hold puts somebody
    // back where they were in the queue rather than sending them to the back.
    expect((await evaluateWaitlistForSlot(freedSlot(fixture.staffProfile.id, startsAt)))?.id).toBe(
      waiting.id,
    );

    const reoffered = await WaitlistEntry.findByPk(waiting.id);
    expect(reoffered?.status).toBe('NOTIFIED');
    expect(reoffered?.notificationCount).toBe(2);
    expect(reoffered?.holdExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });
});
