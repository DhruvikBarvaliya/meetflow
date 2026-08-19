/**
 * Redis connectivity and the MeetFlow key registry.
 *
 * Redis provides caching, distributed rate limiting, advisory locks, the BullMQ
 * job backbone and the Socket.IO adapter. It is deliberately NOT the system of
 * record: every function that touches cached data degrades to "cache miss" when
 * Redis is unavailable, so a Redis outage slows MeetFlow down without taking
 * booking correctness with it.
 *
 * Idempotency is the clearest case of that rule and is deliberately absent from
 * this file: `idempotency_keys` in PostgreSQL is claimed by a unique index and
 * read back inside the booking transaction, so a retry is answered correctly
 * whatever Redis is doing. A Redis fast path in front of it could only be an
 * advisory hint, and one that is wrong during exactly the outage a retry storm
 * happens in.
 */
import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env';
import { createLogger } from './logger';

const log = createLogger('redis');

/**
 * Central registry of every Redis key MeetFlow writes.
 *
 * | namespace     | purpose                              | TTL          | invalidation                  |
 * |---------------|--------------------------------------|--------------|-------------------------------|
 * | cache:link    | public booking-link configuration    | configurable | dropped by key when a link,   |
 * |               |                                      |              | service or assignment changes |
 * | lock:slot     | advisory lock around one slot        | ≤ 10s        | released by owner token       |
 * | lock:waitlist | serialises waitlist evaluation       | ≤ 15s        | released by owner token       |
 * | rl:*          | rate-limiter counters, whose prefix  | window       | natural expiry                |
 * |               | `middleware/rateLimit.ts` composes   |              |                               |
 * |               | itself — the limiter wants a prefix, |              |                               |
 * |               | not a finished key                   |              |                               |
 *
 * Values are JSON unless noted. Every key is written through `key()` so the
 * configured prefix keeps environments isolated on a shared Redis instance.
 * Nothing is listed here that nothing writes: a builder with no callers reads
 * as a guarantee the system makes and does not.
 */
export const RedisKeys = {
  bookingLinkConfig: (slug: string) => `cache:link:${slug}`,
  appointmentSlotLock: (businessId: string, staffId: string, startsAtIso: string) =>
    `lock:slot:${businessId}:${staffId}:${startsAtIso}`,
  waitlistEvaluationLock: (businessId: string, serviceId: string) =>
    `lock:waitlist:${businessId}:${serviceId}`,
} as const;

/** Applies the environment prefix. All access goes through this. */
export function key(raw: string): string {
  return `${env.REDIS_KEY_PREFIX}:${raw}`;
}

function baseOptions(role: string): RedisOptions {
  return {
    lazyConnect: false,
    enableOfflineQueue: true,
    connectionName: `meetflow-${role}`,
    // Bounded backoff: keep reconnecting, never hammer the server.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    reconnectOnError: (error) => {
      // A failover promotes a replica; reconnecting resolves READONLY errors.
      if (error.message.includes('READONLY')) return 2;
      return false;
    },
  };
}

function attachLifecycleLogging(client: Redis, role: string): Redis {
  let reportedDown = false;
  client.on('error', (error: Error) => {
    // Log the first failure per outage; reconnection storms must not flood.
    if (!reportedDown) {
      reportedDown = true;
      log.error({ err: error, role }, 'Redis connection error');
    }
  });
  client.on('ready', () => {
    if (reportedDown) log.info({ role }, 'Redis connection recovered');
    reportedDown = false;
  });
  return client;
}

/** Shared client for cache, locks, idempotency and rate limiting. */
export const redis = attachLifecycleLogging(new Redis(env.REDIS_URL, baseOptions('app')), 'app');

/**
 * BullMQ and the Socket.IO adapter each need their own connection.
 * BullMQ additionally requires `maxRetriesPerRequest: null` for blocking reads.
 */
export function createRedisConnection(role: string, overrides: RedisOptions = {}): Redis {
  return attachLifecycleLogging(
    new Redis(env.REDIS_URL, {
      ...baseOptions(role),
      maxRetriesPerRequest: null,
      ...overrides,
    }),
    role,
  );
}

export function isRedisReady(): boolean {
  return redis.status === 'ready';
}

export async function redisHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await redis.ping();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'unknown redis error',
    };
  }
}

// ---------------------------------------------------------------------------
// Cache helpers — every one of these treats a Redis failure as a cache miss.
// ---------------------------------------------------------------------------

export async function cacheGet<T>(rawKey: string): Promise<T | null> {
  if (!isRedisReady()) return null;
  try {
    const value = await redis.get(key(rawKey));
    return value ? (JSON.parse(value) as T) : null;
  } catch (error) {
    log.warn({ err: error, key: rawKey }, 'cache read failed — treating as miss');
    return null;
  }
}

export async function cacheSet(rawKey: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!isRedisReady() || ttlSeconds <= 0) return;
  try {
    await redis.set(key(rawKey), JSON.stringify(value), 'EX', ttlSeconds);
  } catch (error) {
    log.warn({ err: error, key: rawKey }, 'cache write failed — continuing without cache');
  }
}

/**
 * Drops entries by exact key.
 *
 * The only cached family MeetFlow keeps is one page per booking-link slug, and
 * a workspace's slugs are one indexed query away in PostgreSQL — so the keys to
 * delete are always knowable, and a `SCAN` over a keyspace that is mostly BullMQ
 * and rate-limiter entries would be a slower way of finding a handful of them.
 * That is why there is no prefix-deletion helper here to reach for.
 *
 * Failure is swallowed: an invalidation that raised would fail the edit that
 * triggered it, and a stale page is a far smaller problem than an operator who
 * cannot change a price. Entries carry a TTL for exactly this reason.
 */
export async function cacheDelete(...rawKeys: string[]): Promise<void> {
  if (!isRedisReady() || rawKeys.length === 0) return;
  try {
    await redis.del(...rawKeys.map(key));
  } catch (error) {
    log.warn({ err: error, keys: rawKeys }, 'cache invalidation failed — entries will expire');
  }
}

// ---------------------------------------------------------------------------
// Advisory distributed lock.
// ---------------------------------------------------------------------------

/**
 * Releases a lock only if this caller still owns it. Without the ownership
 * check, a lock that expired mid-work would be deleted out from under whoever
 * acquired it next.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export interface LockHandle {
  release(): Promise<void>;
}

/**
 * Best-effort mutual exclusion.
 *
 * IMPORTANT: this is an optimisation that reduces contention and wasted work,
 * never the sole integrity mechanism. Correctness is always enforced again
 * inside the database transaction (row locks + unique/exclusion constraints),
 * so a lost lock cannot produce a double booking.
 */
export async function acquireLock(
  rawKey: string,
  ttlMs = 10_000,
  { retries = 20, retryDelayMs = 50 } = {},
): Promise<LockHandle | null> {
  if (!isRedisReady()) return null;
  const lockKey = key(rawKey);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
      if (result === 'OK') {
        return {
          release: async () => {
            try {
              await redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
            } catch (error) {
              log.warn({ err: error, key: rawKey }, 'lock release failed — will expire via TTL');
            }
          },
        };
      }
    } catch (error) {
      log.warn({ err: error, key: rawKey }, 'lock acquisition failed — proceeding unlocked');
      return null;
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return null;
}

/** Runs `fn` while holding `rawKey`, releasing the lock on every exit path. */
export async function withLock<T>(rawKey: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireLock(rawKey, ttlMs);
  try {
    return await fn();
  } finally {
    await handle?.release();
  }
}

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
    log.info('Redis connection closed');
  } catch {
    redis.disconnect();
  }
}
