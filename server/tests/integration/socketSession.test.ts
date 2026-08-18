/**
 * "Log out everywhere" must reach the realtime layer, against real PostgreSQL.
 *
 * This file exists because it did not. `authenticateSocket` re-read the user
 * and their memberships on every connection — so a suspended account or a
 * removed member was handled — but never looked at the session family. Logging
 * out of every device therefore ended the API access and left the event stream
 * running: a signed-out (or stolen) client kept receiving a workspace's live
 * diary until its access token happened to expire, and a socket that was
 * *already* open kept receiving it indefinitely, because a socket authenticates
 * once and then lives for hours.
 *
 * The harness is deliberately smaller than the real server. `attachSocketServer`
 * also stands up the Redis adapter and the worker bridge, and neither has
 * anything to do with who may open a socket; requiring Redis to answer that
 * question would make this file the reason the suite needs another service. So
 * it wires `socketAuthMiddleware` — the exact function production wires — onto
 * a bare Socket.IO server on an ephemeral port and drives it with a real
 * client over a real websocket. Everything the assertions depend on (token
 * signing, the users and refresh_tokens tables, `logoutAllSessions`) is the
 * production code path.
 *
 * `socket.io-client` is not a server dependency and is not added as one: it is
 * already installed in the workspace by `client`, which is the actual consumer
 * of this API. The alternative was hand-rolling the Engine.IO polling
 * handshake over `fetch`, which would test our reading of the protocol rather
 * than our middleware.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RefreshToken, type User } from '../../src/database/models';
import { login, logoutAllSessions } from '../../src/modules/auth/auth.service';
import { disconnectRevokedSessions, socketAuthMiddleware } from '../../src/sockets';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  resetDatabase,
} from '../helpers/fixtures';

const metadata = { requestId: 'socket-session-test', ipAddress: null, userAgent: null };

let httpServer: HttpServer;
let socketServer: SocketServer;
let origin: string;
let user: User;

/** Clients opened by a test, closed in afterEach so no socket outlives its case. */
const openClients: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = createServer();
  socketServer = new SocketServer(httpServer, { path: '/socket.io' });
  socketServer.use(socketAuthMiddleware);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetDatabase();
  user = await createUser({ email: `socket-${Date.now()}@meetflow.test` });
});

afterEach(() => {
  for (const client of openClients.splice(0)) client.close();
});

afterAll(async () => {
  await socketServer.close();
  await closeDatabaseConnection();
});

/** A real sign-in, so the access token and its token family are genuine. */
async function signIn(): Promise<string> {
  const result = await login(user.email, TEST_PASSWORD, metadata);
  return result.accessToken;
}

/**
 * Attempts one handshake.
 *
 * Resolves with the connected client, or rejects with the middleware's error —
 * exactly the two outcomes a browser client sees.
 */
function openSocket(token: string): Promise<ClientSocket> {
  const client = connectClient(origin, {
    auth: { token },
    transports: ['websocket'],
    // No reconnection: a refused handshake must fail the test promise once,
    // not retry in the background for the rest of the run.
    reconnection: false,
    timeout: 5_000,
  });
  openClients.push(client);

  return new Promise<ClientSocket>((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('connect_error', (error: Error) => reject(error));
  });
}

/** Resolves when the server closes `client`, or rejects after `timeoutMs`. */
function awaitDisconnect(client: ClientSocket, timeoutMs = 5_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the socket was never disconnected')),
      timeoutMs,
    );
    client.once('disconnect', (reason: string) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

describe('socket handshake', () => {
  it('opens a socket for a live session', async () => {
    // The control. Without it a broken harness would "pass" every revocation
    // assertion below by refusing everything.
    const client = await openSocket(await signIn());
    expect(client.connected).toBe(true);
  });

  it('refuses a socket after the session family is logged out everywhere', async () => {
    const token = await signIn();
    await logoutAllSessions(user.id, metadata);

    // The regression assertion. The token is still perfectly valid — correctly
    // signed, unexpired, for an ACTIVE user who is still a member of every
    // workspace — and that is precisely why re-reading the user and their
    // memberships was not enough. Only the session family knows it is dead.
    await expect(openSocket(token)).rejects.toThrow('unauthorised');
  });

  it('refuses a socket after a password change kills the family', async () => {
    const token = await signIn();
    // Same mechanism, different trigger: `resetPassword` and `changePassword`
    // revoke every live token for the user. A socket surviving a password
    // change after a compromise is the same leak wearing a different hat.
    await RefreshToken.update(
      { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
      { where: { userId: user.id } },
    );

    await expect(openSocket(token)).rejects.toThrow('unauthorised');
  });

  it('still refuses a token that was never signed by us', async () => {
    await expect(openSocket('not.a.token')).rejects.toThrow('unauthorised');
  });
});

describe('session revalidation sweep', () => {
  it('closes a socket that was already open when its session was revoked', async () => {
    const client = await openSocket(await signIn());
    expect(client.connected).toBe(true);

    // The leak the handshake check alone does not close: this socket was
    // authenticated before the logout and will otherwise keep receiving
    // workspace events for as long as the tab stays open.
    await logoutAllSessions(user.id, metadata);
    const disconnected = awaitDisconnect(client);

    expect(await disconnectRevokedSessions(socketServer)).toBe(1);
    expect(await disconnected).toBe('io server disconnect');
  });

  it('leaves live sessions connected', async () => {
    const client = await openSocket(await signIn());

    expect(await disconnectRevokedSessions(socketServer)).toBe(0);
    expect(client.connected).toBe(true);
  });

  it('closes every socket of a revoked session and nobody else’s', async () => {
    // Two tabs on the revoked session, one on a session that stays live: the
    // sweep groups by family, so this is the case that catches a lookup that
    // disconnects by user, or that stops at the first socket it finds.
    const doomedToken = await signIn();
    const firstTab = await openSocket(doomedToken);
    const secondTab = await openSocket(doomedToken);

    const survivor = await createUser({ email: `survivor-${Date.now()}@meetflow.test` });
    const survivingClient = await openSocket(
      (await login(survivor.email, TEST_PASSWORD, metadata)).accessToken,
    );

    await logoutAllSessions(user.id, metadata);
    const bothClosed = Promise.all([awaitDisconnect(firstTab), awaitDisconnect(secondTab)]);

    expect(await disconnectRevokedSessions(socketServer)).toBe(2);
    await bothClosed;
    expect(survivingClient.connected).toBe(true);
  });
});
