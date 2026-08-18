/**
 * Redis connectivity and the MeetFlow key registry.
 *
 * Redis provides caching, distributed rate limiting, advisory locks, the BullMQ
 * job backbone, the Socket.IO adapter and short-lived idempotency state.
 * It is deliberately NOT the system of record: every function that touches
 * cached data degrades to "cache miss" when Redis is unavailable, so a Redis
 * outage slows MeetFlow down without taking booking correctness with it.
 */
import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env';
import { createLogger } from './logger';

const log = createLogger('redis');

/**
 * Central registry of every Redis key MeetFlow writes.
 *
 * | namespace      | purpose                                   | TTL         | invalidation                    |
 * |----------------|-------------------------------------------|-------------|---------------------------------|
 * | cache:link     | public booking-link configuration         | configurable| on link/service/staff mutation  |
 * | cache:services | public service catalogue for a link       | configurable| on service mutation             |
 * | rl:*           | rate-limiter-flexible counters            | window       | natural expiry                  |
 * | lock:*         | advisory locks around slot/resource writes| ≤ 15s       | released by owner token         |
 * | idem:*         | public booking idempotency records        | IDEMPOTENCY | natural expiry                  |
 * | rr:*           | round-robin cursor cache (advisory only)  | 1h          | recomputed from DB on miss      |
 *
 * Values are JSON unless noted. Every key is written through `key()` so the
 * configured prefix keeps environments isolated on a shared Redis instance.
 */
export const RedisKeys = {
  bookingLinkConfig: (slug: string) => `cache:link:${slug}`,
  bookingLinkServices: (linkId: string) => `cache:services:${linkId}`,
  businessCacheTag: (businessId: string) => `cache:tag:business:${businessId}`,
  idempotency: (scope: string, key: string) => `idem:${scope}:${key}`,
  appointmentSlotLock: (businessId: string, staffId: string, startsAtIso: string) =>
    `lock:slot:${businessId}:${staffId}:${startsAtIso}`,
  resourceLock: (resourceId: string) => `lock:resource:${resourceId}`,
  waitlistEvaluationLock: (businessId: string, serviceId: string) =>
    `lock:waitlist:${businessId}:${serviceId}`,
  roundRobinCursor: (serviceId: string) => `rr:service:${serviceId}`,
  rateLimit: (bucket: string) => `rl:${bucket}`,
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

export async function cacheDelete(...rawKeys: string[]): Promise<void> {
  if (!isRedisReady() || rawKeys.length === 0) return;
  try {
    await redis.del(...rawKeys.map(key));
  } catch (error) {
    log.warn({ err: error, keys: rawKeys }, 'cache invalidation failed');
  }
}

/**
 * Invalidate by prefix using SCAN (never KEYS — KEYS blocks the server).
 * Used when a business-wide change makes a family of cached entries stale.
 */
export async function cacheDeleteByPrefix(rawPrefix: string): Promise<number> {
  if (!isRedisReady()) return 0;
  const match = `${key(rawPrefix)}*`;
  let cursor = '0';
  let removed = 0;
  try {
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (batch.length > 0) {
        removed += await redis.del(...batch);
      }
    } while (cursor !== '0');
  } catch (error) {
    log.warn({ err: error, prefix: rawPrefix }, 'prefix cache invalidation failed');
  }
  return removed;
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
