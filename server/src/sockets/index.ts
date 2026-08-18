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
 *
 * Session lifetime:
 *
 *   A socket is authenticated once, at the handshake, and then lives for hours.
 *   That makes it the longest-lived credential in the system, so revocation has
 *   to reach it twice: refused at connect (see `socketAuthMiddleware`) and
 *   closed while connected (see `disconnectRevokedSessions`).
 */
import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Op } from 'sequelize';
import { Server as SocketServer, type Socket } from 'socket.io';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { createRedisConnection } from '../config/redis';
import { Membership, RefreshToken, StaffProfile, User } from '../database/models';
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
  /** Token family (`sid`), so a revoked session can be found again later. */
  sessionId: string;
  businessIds: string[];
  staffProfileIds: string[];
}

/**
 * How often connected sockets are re-checked against their session family.
 *
 * A minute is the window in which a "log out everywhere" is still leaking
 * events to a socket that was already open. Shorter buys little — the person
 * pressing that button is minutes away from the incident at best — and the
 * sweep is one grouped query per instance regardless of how many sockets are
 * connected, so the cost is flat rather than per-socket.
 */
const SESSION_REVALIDATION_INTERVAL_MS = 60_000;

interface RealtimeMessage {
  rooms: string[];
  event: SocketEvent;
  payload: Record<string, unknown>;
}

let io: SocketServer | null = null;
let bridgeSubscriber: ReturnType<typeof createRedisConnection> | null = null;
let bridgePublisher: ReturnType<typeof createRedisConnection> | null = null;
let revalidationTimer: NodeJS.Timeout | null = null;

/**
 * Is this token family still a live session?
 *
 * DUPLICATED FROM `resolveAuth` in src/middleware/authenticate.ts, and the two
 * must stay in step: whatever counts as a live session for an HTTP request has
 * to count as one for a socket, or "log out everywhere" ends the API access and
 * leaves the event stream running. It is copied rather than shared because the
 * HTTP version lives inside a helper that is private to the request pipeline
 * and returns an Express `req.auth`; exporting that would drag the middleware's
 * error types into the socket layer for four lines of query. If you change the
 * revocation rule in either place, change it in both.
 */
async function isSessionLive(sessionId: string): Promise<boolean> {
  const liveTokens = await RefreshToken.count({
    where: { familyId: sessionId, revokedAt: { [Op.is]: null } },
  });
  return liveTokens > 0;
}

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

  // The signature proves we minted the token; it says nothing about the session
  // still existing. Logout-all revokes the whole family, and the access token it
  // was issued alongside stays cryptographically valid for up to its full TTL —
  // long enough for a signed-out (or stolen) client to keep watching a
  // workspace's diary in real time. Refuse the handshake instead.
  if (!(await isSessionLive(claims.sid))) {
    throw new Error('Your session has ended. Please sign in again.');
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
    sessionId: claims.sid,
    businessIds: memberships.map((membership) => membership.businessId),
    staffProfileIds: staffProfiles.map((profile) => profile.id),
  };
}

/**
 * The handshake gate, exported so it can be exercised on its own.
 *
 * `attachSocketServer` also stands up a Redis adapter and a bridge subscriber;
 * a test that only wants to know whether a token opens a socket should not have
 * to run Redis to find out, so the middleware is separable from the wiring.
 */
export function socketAuthMiddleware(socket: Socket, next: (error?: Error) => void): void {
  authenticateSocket(socket)
    .then((identity) => {
      socket.data.identity = identity;
      next();
    })
    .catch((error: unknown) => {
      log.warn({ err: error, socketId: socket.id }, 'socket authentication rejected');
      next(new Error('unauthorised'));
    });
}

/**
 * Closes sockets whose session family has been revoked since they connected.
 *
 * Refusing the handshake is only half the fix. The socket that matters is the
 * one that was *already* open when the user pressed "log out everywhere" — it
 * has been authenticated once and will otherwise keep receiving workspace
 * events until the client happens to disconnect, which for a background tab is
 * hours. This is deliberately a poll rather than a push: the revocation paths
 * live in the auth service and the admin module, and having each of them reach
 * into the realtime layer would put a socket dependency on every future one.
 * A sweep is a single query and cannot be forgotten by code that has not been
 * written yet.
 *
 * Local sockets only. Every API instance runs its own sweep over its own
 * connections, so the work is partitioned without any coordination — the same
 * reasoning as the `io.local` re-emit on the bridge channel.
 *
 * Returns the number of sockets closed, which is what the caller logs and what
 * the test asserts on.
 */
export async function disconnectRevokedSessions(server: SocketServer): Promise<number> {
  const bySession = new Map<string, Socket[]>();
  for (const socket of server.sockets.sockets.values()) {
    const identity = socket.data.identity as SocketIdentity | undefined;
    if (!identity) continue;
    const existing = bySession.get(identity.sessionId);
    if (existing) existing.push(socket);
    else bySession.set(identity.sessionId, [socket]);
  }
  if (bySession.size === 0) return 0;

  // One grouped query for every connected session, not one per socket: a
  // per-socket check would make the sweep's cost scale with the thing it is
  // meant to protect.
  const live = await RefreshToken.findAll({
    where: { familyId: { [Op.in]: [...bySession.keys()] }, revokedAt: { [Op.is]: null } },
    attributes: ['familyId'],
    group: ['familyId'],
  });
  const liveSessions = new Set(live.map((token) => token.familyId));

  let closed = 0;
  for (const [sessionId, sockets] of bySession) {
    if (liveSessions.has(sessionId)) continue;
    for (const socket of sockets) {
      // `true` closes the underlying transport rather than leaving a polling
      // connection to drain; the client sees a server-initiated disconnect and
      // its next HTTP call gets the matching 401, which is the signal to sign
      // out. No bespoke event is emitted for this — the client already has to
      // handle a disconnect it did not ask for.
      socket.disconnect(true);
      closed += 1;
    }
  }
  if (closed > 0) log.info({ closed }, 'closed sockets belonging to revoked sessions');
  return closed;
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

  io.use(socketAuthMiddleware);

  // Re-check open sockets against their session family. `unref` keeps this
  // timer from holding the process open on shutdown — a sweep that is one
  // minute late costs nothing, a process that will not exit costs a deploy.
  revalidationTimer = setInterval(() => {
    if (!io) return;
    void disconnectRevokedSessions(io).catch((error: unknown) => {
      // Never let a database blip stop the sweep from running again: throwing
      // out of a timer callback would take the process down with it.
      log.error({ err: error }, 'session revalidation sweep failed');
    });
  }, SESSION_REVALIDATION_INTERVAL_MS);
  revalidationTimer.unref();

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
  if (revalidationTimer) {
    clearInterval(revalidationTimer);
    revalidationTimer = null;
  }
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
