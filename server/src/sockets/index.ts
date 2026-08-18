/**
 * Socket.IO real-time layer.
 *
 * Authorisation model — the important part:
 *
 *   Clients never ask to join a room. The server derives every room from the
 *   authenticated identity at connection time (workspaces the user is an ACTIVE
 *   member of, plus their own staff room). There is no `join` event to abuse,
 *   so "socket room abuse" is prevented by construction rather than by a check
 *   that could be forgotten.
 *
 * Cross-process delivery:
 *
 *   API instances share a Redis adapter, so a broadcast on one reaches sockets
 *   on all of them. The worker process has no Socket.IO server, so it publishes
 *   onto a Redis bridge channel; each API instance re-emits that payload
 *   *locally only*, which delivers it exactly once per socket.
 */
import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as SocketServer, type Socket } from 'socket.io';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { createRedisConnection } from '../config/redis';
import { Membership, StaffProfile, User } from '../database/models';
import { verifyAccessToken } from '../modules/auth/tokens';

const log = createLogger('socket');

/** Server -> client event names. Mirrored in docs/SocketIOEvents.md. */
export const SocketEvents = {
  appointmentCreated: 'appointment.created',
  appointmentUpdated: 'appointment.updated',
  appointmentCancelled: 'appointment.cancelled',
  appointmentRescheduled: 'appointment.rescheduled',
  appointmentCompleted: 'appointment.completed',
  appointmentNoShow: 'appointment.no_show',
  availabilityUpdated: 'availability.updated',
  staffAssigned: 'staff.assigned',
  waitlistSlotAvailable: 'waitlist.slot_available',
  dashboardMetricsUpdated: 'dashboard.metrics_updated',
  notificationCreated: 'notification.created',
} as const;

export type SocketEvent = (typeof SocketEvents)[keyof typeof SocketEvents];

export const Rooms = {
  workspace: (businessId: string) => `workspace:${businessId}`,
  staff: (staffProfileId: string) => `staff:${staffProfileId}`,
  customer: (customerId: string) => `customer:${customerId}`,
  appointment: (appointmentId: string) => `appointment:${appointmentId}`,
} as const;

/** Redis channel used to bridge events emitted from the worker process. */
const BRIDGE_CHANNEL = `${env.REDIS_KEY_PREFIX}:realtime`;

interface SocketIdentity {
  userId: string;
  email: string;
  businessIds: string[];
  staffProfileIds: string[];
}

interface RealtimeMessage {
  rooms: string[];
  event: SocketEvent;
  payload: Record<string, unknown>;
}

let io: SocketServer | null = null;
let bridgeSubscriber: ReturnType<typeof createRedisConnection> | null = null;
let bridgePublisher: ReturnType<typeof createRedisConnection> | null = null;

async function authenticateSocket(socket: Socket): Promise<SocketIdentity> {
  const raw =
    (socket.handshake.auth as { token?: string } | undefined)?.token ??
    socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!raw) throw new Error('An access token is required to open a socket.');

  const claims = verifyAccessToken(raw);

  const user = await User.findByPk(claims.sub, { attributes: ['id', 'email', 'status'] });
  if (!user || user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
    throw new Error('This account is not active.');
  }

  // Rooms come from live membership rows, re-read on every connection, so a
  // member removed from a workspace cannot rejoin its room with an old token.
  const memberships = await Membership.findAll({
    where: { userId: user.id, status: 'ACTIVE' },
    attributes: ['id', 'businessId'],
  });
  const staffProfiles = await StaffProfile.findAll({
    where: { membershipId: memberships.map((membership) => membership.id) },
    attributes: ['id'],
  });

  return {
    userId: user.id,
    email: user.email,
    businessIds: memberships.map((membership) => membership.businessId),
    staffProfileIds: staffProfiles.map((profile) => profile.id),
  };
}

export function attachSocketServer(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    path: '/socket.io',
    cors: { origin: env.SOCKET_ORIGIN, credentials: true },
    // Bounded payloads: a socket must not be a way around the HTTP body limit.
    maxHttpBufferSize: 100_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  const pubClient = createRedisConnection('socket-pub');
  const subClient = createRedisConnection('socket-sub');
  io.adapter(createAdapter(pubClient, subClient));

  io.use((socket, next) => {
    authenticateSocket(socket)
      .then((identity) => {
        socket.data.identity = identity;
        next();
      })
      .catch((error: unknown) => {
        log.warn({ err: error, socketId: socket.id }, 'socket authentication rejected');
        next(new Error('unauthorised'));
      });
  });

  io.on('connection', (socket) => {
    const identity = socket.data.identity as SocketIdentity;

    for (const businessId of identity.businessIds) socket.join(Rooms.workspace(businessId));
    for (const staffProfileId of identity.staffProfileIds) socket.join(Rooms.staff(staffProfileId));

    log.debug(
      { socketId: socket.id, userId: identity.userId, rooms: [...socket.rooms] },
      'socket connected',
    );

    socket.emit('connection.ready', {
      userId: identity.userId,
      workspaces: identity.businessIds,
      staffProfiles: identity.staffProfileIds,
    });

    socket.on('disconnect', (reason) => {
      log.debug({ socketId: socket.id, reason }, 'socket disconnected');
    });

    socket.on('error', (error: Error) => {
      log.error({ err: error, socketId: socket.id }, 'socket error');
    });
  });

  // Re-emit events published by the worker, locally only — the adapter has
  // already delivered nothing for these, and every instance does the same, so
  // each socket receives the event exactly once.
  bridgeSubscriber = createRedisConnection('realtime-bridge-sub');
  void bridgeSubscriber.subscribe(BRIDGE_CHANNEL).catch((error: unknown) => {
    log.error({ err: error }, 'failed to subscribe to the realtime bridge');
  });
  bridgeSubscriber.on('message', (_channel: string, message: string) => {
    if (!io) return;
    try {
      const parsed = JSON.parse(message) as RealtimeMessage;
      for (const room of parsed.rooms) {
        io.local.to(room).emit(parsed.event, parsed.payload);
      }
    } catch (error) {
      log.error({ err: error }, 'malformed realtime bridge message');
    }
  });

  log.info('Socket.IO server attached');
  return io;
}

/**
 * Publishes a real-time event.
 *
 * Safe to call from anywhere. In an API process it broadcasts through the
 * adapter; in the worker it goes onto the Redis bridge. Never throws — a
 * failed notification must not roll back the business change that caused it,
 * which has already been persisted by the time this is called.
 */
export function emitRealtime(
  rooms: string[],
  event: SocketEvent,
  payload: Record<string, unknown>,
): void {
  if (rooms.length === 0) return;

  try {
    if (io) {
      for (const room of rooms) io.to(room).emit(event, payload);
      return;
    }
    bridgePublisher ??= createRedisConnection('realtime-bridge-pub');
    void bridgePublisher.publish(BRIDGE_CHANNEL, JSON.stringify({ rooms, event, payload }));
  } catch (error) {
    log.error({ err: error, event, rooms }, 'failed to publish realtime event');
  }
}

/** Convenience wrapper for the common "tell this workspace" case. */
export function emitToWorkspace(
  businessId: string,
  event: SocketEvent,
  payload: Record<string, unknown>,
): void {
  emitRealtime([Rooms.workspace(businessId)], event, payload);
}

/**
 * Emits to a workspace and, when the appointment has a provider, to that
 * provider's personal room — so a staff member sees their own diary change
 * even if their client is not subscribed to the whole workspace feed.
 */
export function emitAppointmentEvent(
  event: SocketEvent,
  input: { businessId: string; staffProfileId?: string | null; appointmentId: string },
  payload: Record<string, unknown>,
): void {
  const rooms = [Rooms.workspace(input.businessId), Rooms.appointment(input.appointmentId)];
  if (input.staffProfileId) rooms.push(Rooms.staff(input.staffProfileId));
  emitRealtime(rooms, event, payload);
}

export function getSocketServer(): SocketServer | null {
  return io;
}

export async function closeSocketServer(): Promise<void> {
  if (bridgeSubscriber) {
    await bridgeSubscriber.quit().catch(() => bridgeSubscriber?.disconnect());
    bridgeSubscriber = null;
  }
  if (bridgePublisher) {
    await bridgePublisher.quit().catch(() => bridgePublisher?.disconnect());
    bridgePublisher = null;
  }
  if (io) {
    await io.close();
    io = null;
    log.info('Socket.IO server closed');
  }
}
