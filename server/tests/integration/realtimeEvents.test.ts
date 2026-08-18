/**
 * The two declared Socket.IO events that nothing used to emit.
 *
 * `staff.assigned` and `notification.created` were named in `sockets/index.ts`,
 * documented in docs/SocketIOEvents.md and mirrored into the client — and no
 * code path published either. A declared event with no emitter is a promise the
 * product cannot keep: a client that subscribes waits forever and has no way to
 * tell that from a quiet afternoon.
 *
 * The assertions are made on the **Redis bridge**, which is the production path
 * out of a process with no Socket.IO server attached — the worker's path, and
 * the one a test process is on. Every emit lands there as `{ rooms, event,
 * payload }`, so the room derivation is observable exactly as the API instances
 * receive it, without standing up a socket server, an adapter and a client to
 * watch one broadcast. That derivation is the security-relevant half: rooms come
 * from live memberships, never from what a client asks for, so a test that only
 * checked the payload would be checking the uninteresting half.
 */
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { createRedisConnection } from '../../src/config/redis';
import {
  Membership,
  Role,
  ServiceStaff,
  StaffAvailabilityRule,
  StaffProfile,
} from '../../src/database/models';
import { createBooking } from '../../src/modules/appointments/booking.service';
import { rescheduleAppointment } from '../../src/modules/appointments/lifecycle.service';
import { enqueueNotification } from '../../src/modules/notifications/notification.service';
import { Rooms } from '../../src/sockets';
import {
  closeDatabaseConnection,
  createUser,
  createWorkspace,
  nextWeekdayAt,
  resetDatabase,
  type WorkspaceFixture,
} from '../helpers/fixtures';

interface BridgeMessage {
  rooms: string[];
  event: string;
  payload: Record<string, unknown>;
}

const CHANNEL = `${env.REDIS_KEY_PREFIX}:realtime`;

let subscriber: Redis;
let received: BridgeMessage[] = [];
let fixture: WorkspaceFixture;

beforeAll(async () => {
  subscriber = createRedisConnection('test-realtime-sub');
  await subscriber.subscribe(CHANNEL);
  subscriber.on('message', (_channel: string, message: string) => {
    received.push(JSON.parse(message) as BridgeMessage);
  });
});

beforeEach(async () => {
  await resetDatabase();
  fixture = await createWorkspace();
  received = [];
});

afterAll(async () => {
  await subscriber.quit().catch(() => subscriber.disconnect());
  await closeDatabaseConnection();
});

/**
 * Waits for the events matching `match` to settle.
 *
 * Publishing is deliberately fire-and-forget — an event must never be able to
 * fail the change that caused it — so there is nothing to await on the emitting
 * side. Polling is therefore the honest way to observe it. The predicate
 * narrows to this test's own appointment or notification, because the suite
 * shares one Redis with anything else running against it.
 */
async function eventsFor(
  match: (message: BridgeMessage) => boolean,
  { expected = 1, timeoutMs = 3_000 } = {},
): Promise<BridgeMessage[]> {
  const deadline = Date.now() + timeoutMs;
  let matches = received.filter(match);
  while (matches.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    matches = received.filter(match);
  }
  return matches;
}

/** Nothing arrived, and nothing was going to: waits out the window first. */
async function noEventFor(match: (message: BridgeMessage) => boolean): Promise<boolean> {
  const matches = await eventsFor(match, { expected: 1, timeoutMs: 750 });
  return matches.length === 0;
}

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

async function book(startsAt: Date, staffProfileId: string, email = 'realtime@meetflow.test') {
  return createBooking({
    businessId: fixture.business.id,
    serviceId: fixture.service.id,
    staffProfileId,
    locationId: null,
    startsAt,
    timezone: 'UTC',
    customer: { firstName: 'Ada', lastName: 'Customer', email },
    source: 'PUBLIC',
    actor: { type: 'CUSTOMER', label: email },
  });
}

describe('staff.assigned', () => {
  it('is emitted when a booking gives an appointment to a provider', async () => {
    const { appointment } = await book(nextWeekdayAt(10), fixture.staffProfile.id);

    const [event] = await eventsFor(
      (message) =>
        message.event === 'staff.assigned' && message.payload.appointmentId === appointment.id,
    );

    expect(event).toBeDefined();
    expect(event!.payload).toMatchObject({
      appointmentId: appointment.id,
      publicId: appointment.publicId,
      staffProfileId: fixture.staffProfile.id,
    });
    // Workspace feed, the appointment's own room, and the provider's personal
    // room — so a staff member watching only their own diary still sees it.
    expect(event!.rooms).toEqual([
      Rooms.workspace(fixture.business.id),
      Rooms.appointment(appointment.id),
      Rooms.staff(fixture.staffProfile.id),
    ]);
  });

  it('is emitted again, with the previous provider, when an appointment is reassigned', async () => {
    const provider = await addProvider('Dr Locum');
    const { appointment } = await book(nextWeekdayAt(10), fixture.staffProfile.id);

    await rescheduleAppointment({
      businessId: fixture.business.id,
      appointmentId: appointment.id,
      newStartsAt: nextWeekdayAt(14),
      newStaffProfileId: provider.id,
      actor: { type: 'OWNER', label: 'owner@meetflow.test' },
    });

    const events = await eventsFor(
      (message) =>
        message.event === 'staff.assigned' &&
        message.payload.appointmentId === appointment.id &&
        message.payload.staffProfileId === provider.id,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.previousStaffProfileId).toBe(fixture.staffProfile.id);
    expect(events[0]!.rooms).toContain(Rooms.staff(provider.id));
  });

  it('is not emitted when somebody joins an existing group session', async () => {
    const group = await createWorkspace({ serviceCapacity: 4 });
    const startsAt = nextWeekdayAt(11);

    const first = await createBooking({
      businessId: group.business.id,
      serviceId: group.service.id,
      staffProfileId: group.staffProfile.id,
      locationId: null,
      startsAt,
      timezone: 'UTC',
      customer: { firstName: 'First', lastName: 'Attendee', email: 'first@meetflow.test' },
      source: 'PUBLIC',
      actor: { type: 'CUSTOMER', label: 'first@meetflow.test' },
    });
    const second = await createBooking({
      businessId: group.business.id,
      serviceId: group.service.id,
      staffProfileId: group.staffProfile.id,
      locationId: null,
      startsAt,
      timezone: 'UTC',
      customer: { firstName: 'Second', lastName: 'Attendee', email: 'second@meetflow.test' },
      source: 'PUBLIC',
      actor: { type: 'CUSTOMER', label: 'second@meetflow.test' },
    });

    // Both bookings are for the same session; the second one joined it.
    expect(second.appointment.id).toBe(first.appointment.id);
    expect(second.participant.role).toBe('ATTENDEE');

    // An attendee arriving is not a provider being assigned, so the class is
    // announced as assigned exactly once however full it gets.
    const events = await eventsFor(
      (message) =>
        message.event === 'staff.assigned' &&
        message.payload.appointmentId === first.appointment.id,
      { expected: 2, timeoutMs: 1_000 },
    );
    expect(events).toHaveLength(1);
  });
});

describe('notification.created', () => {
  it("announces a message in the recipient's own staff room", async () => {
    const provider = await addProvider('Dr Locum');

    const row = await enqueueNotification({
      businessId: fixture.business.id,
      type: 'STAFF_ASSIGNED',
      recipientType: 'STAFF',
      recipientUserId: provider.userId,
      recipientAddress: 'locum@meetflow.test',
      payload: { staffName: 'Dr Locum' },
    });

    const [event] = await eventsFor(
      (message) =>
        message.event === 'notification.created' && message.payload.notificationId === row!.id,
    );

    expect(event).toBeDefined();
    expect(event!.payload).toEqual({ notificationId: row!.id, type: 'STAFF_ASSIGNED' });
    // Their own room and nowhere else: a colleague's bell must not ring for it.
    expect(event!.rooms).toEqual([Rooms.staff(provider.id)]);
  });

  it('falls back to the workspace room for a member who has no staff profile', async () => {
    const user = await createUser();
    const role = await Role.findOne({ where: { businessId: fixture.business.id } });
    if (!role) throw new Error('fixture expected the workspace to have system roles');
    // A receptionist: an active member of the workspace who takes no
    // appointments, so there is no personal room to address.
    await Membership.create({
      userId: user.id,
      businessId: fixture.business.id,
      roleId: role.id,
      status: 'ACTIVE',
      invitedByUserId: null,
      invitedAt: null,
      joinedAt: new Date(),
    });

    const row = await enqueueNotification({
      businessId: fixture.business.id,
      type: 'OWNER_NEW_BOOKING',
      recipientType: 'OWNER',
      recipientUserId: user.id,
      recipientAddress: user.email,
      payload: {},
    });

    const [event] = await eventsFor(
      (message) =>
        message.event === 'notification.created' && message.payload.notificationId === row!.id,
    );

    expect(event!.rooms).toEqual([Rooms.workspace(fixture.business.id)]);
  });

  it('says nothing about a message addressed to a customer', async () => {
    const row = await enqueueNotification({
      businessId: fixture.business.id,
      type: 'BOOKING_CONFIRMATION',
      recipientType: 'CUSTOMER',
      recipientCustomerId: fixture.customer.id,
      recipientAddress: fixture.customer.email,
      payload: { customerName: 'Ada' },
    });

    // A customer holds no socket, and their confirmation is nobody else's
    // business — least of all every member of the workspace.
    expect(
      await noEventFor(
        (message) =>
          message.event === 'notification.created' && message.payload.notificationId === row!.id,
      ),
    ).toBe(true);
  });

  it('says nothing about a message that belongs to no workspace', async () => {
    const user = await createUser();

    const row = await enqueueNotification({
      type: 'PASSWORD_RESET',
      recipientType: 'ADMIN',
      recipientUserId: user.id,
      recipientAddress: user.email,
      payload: { firstName: 'Test', resetUrl: 'https://example.test/reset' },
    });

    expect(
      await noEventFor(
        (message) =>
          message.event === 'notification.created' && message.payload.notificationId === row!.id,
      ),
    ).toBe(true);
  });

  it('reaches the owner when a booking they did not take is queued for them', async () => {
    const provider = await addProvider('Dr Locum');

    const { appointment } = await book(nextWeekdayAt(10), provider.id);

    // The end-to-end shape: a booking commits, the owner's outbox row commits
    // with it, and the announcement follows the commit rather than the insert.
    const events = await eventsFor(
      (message) =>
        message.event === 'notification.created' &&
        message.payload.type === 'OWNER_NEW_BOOKING' &&
        message.rooms.includes(Rooms.staff(fixture.staffProfile.id)),
    );

    expect(events).toHaveLength(1);
    expect(appointment.staffProfileId).toBe(provider.id);
  });
});
