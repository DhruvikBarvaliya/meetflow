/**
 * The progressive account lockout ladder, against real PostgreSQL.
 *
 * This file exists because the lockout had no test at all, and that absence is
 * what let a comment saying "progressive lockout" sit on top of a flat one. The
 * old code zeroed `failedLoginCount` at the moment it applied a lock, so every
 * fifteen minutes bought a fresh eight guesses — forever, at the same price.
 * Nothing about that is visible from a single round of failures, which is why
 * the load-bearing assertion here is the *second* round: the lock it produces
 * must be strictly longer than the first, and it is the only assertion in this
 * file that the old implementation fails.
 *
 * The lockout is enforced in the service, not the HTTP layer, so these go
 * straight at `login()` — the same choice lifecycle.test.ts makes. Rate limiting
 * is deliberately left off here (the suite default); the per-IP ceiling is a
 * separate mechanism with its own file, and mixing the two would make it
 * ambiguous which one refused a request.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { User } from '../../src/database/models';
import { login } from '../../src/modules/auth/auth.service';
import { ErrorCode } from '../../src/utils/errors';
import {
  TEST_PASSWORD,
  closeDatabaseConnection,
  createUser,
  resetDatabase,
} from '../helpers/fixtures';

/** Mirrors FAILURES_PER_LOCKOUT in auth.service.ts. */
const FAILURES_PER_LOCKOUT = 8;
const WRONG_PASSWORD = 'Wr0ngPassword!2026';

const metadata = { requestId: 'lockout-test', ipAddress: null, userAgent: null };

let user: User;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser({ email: `lockout-${Date.now()}@meetflow.test` });
});

afterAll(async () => {
  await closeDatabaseConnection();
});

/** One failed sign-in. Returns the error so the caller can assert on its code. */
async function failOnce(): Promise<{ code: unknown; statusCode: unknown }> {
  try {
    await login(user.email, WRONG_PASSWORD, metadata);
  } catch (error) {
    const appError = error as { code: unknown; statusCode: unknown };
    return { code: appError.code, statusCode: appError.statusCode };
  }
  throw new Error('expected the sign-in to be refused');
}

async function failTimes(count: number): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) {
    await failOnce();
  }
}

/** The stored lock, in minutes from now — the shape the ladder is asserted on. */
async function lockMinutesRemaining(): Promise<number | null> {
  const stored = await User.findByPk(user.id);
  if (!stored?.lockedUntil) return null;
  return (stored.lockedUntil.getTime() - Date.now()) / 60_000;
}

/** Pretends the standing lock has run out, without waiting fifteen real minutes. */
async function expireLock(): Promise<void> {
  await User.update({ lockedUntil: new Date(Date.now() - 1_000) }, { where: { id: user.id } });
}

describe('account lockout', () => {
  it('locks the account after the configured run of failures', async () => {
    await failTimes(FAILURES_PER_LOCKOUT - 1);

    // Still open one attempt short of the threshold: the run has to be complete.
    expect(await lockMinutesRemaining()).toBeNull();

    const locking = await failOnce();
    expect(locking.code).toBe(ErrorCode.INVALID_CREDENTIALS);

    const remaining = await lockMinutesRemaining();
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(14);
    expect(remaining!).toBeLessThanOrEqual(15);
  });

  it('refuses the CORRECT password while the lock stands', async () => {
    await failTimes(FAILURES_PER_LOCKOUT);

    // The whole point of a lockout: knowing the password is not enough during
    // the cool-off, otherwise the attacker's final correct guess still wins.
    await expect(login(user.email, TEST_PASSWORD, metadata)).rejects.toMatchObject({
      statusCode: 403,
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('restores access once the lock expires', async () => {
    await failTimes(FAILURES_PER_LOCKOUT);
    await expireLock();

    const result = await login(user.email, TEST_PASSWORD, metadata);
    expect(result.accessToken).toBeTruthy();
  });

  it('makes the second lock strictly longer than the first', async () => {
    await failTimes(FAILURES_PER_LOCKOUT);
    const firstLock = await lockMinutesRemaining();
    expect(firstLock).not.toBeNull();

    // Wait it out, exactly as an attacker pacing themselves would.
    await expireLock();

    await failTimes(FAILURES_PER_LOCKOUT);
    const secondLock = await lockMinutesRemaining();
    expect(secondLock).not.toBeNull();

    // The regression assertion. Under the old code the counter was zeroed at
    // lockout, so this second lock was identical to the first and the attacker
    // paid a flat fifteen minutes per eight guesses indefinitely.
    expect(secondLock!).toBeGreaterThan(firstLock!);
    expect(secondLock!).toBeGreaterThan(59);
    expect(secondLock!).toBeLessThanOrEqual(60);

    // The failure count is cumulative — that is the state the ladder climbs.
    const stored = await User.findByPk(user.id);
    expect(stored!.failedLoginCount).toBe(FAILURES_PER_LOCKOUT * 2);
  });

  it('escalates again on the third round and then holds at the cap', async () => {
    const observed: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      await failTimes(FAILURES_PER_LOCKOUT);
      observed.push(Math.ceil((await lockMinutesRemaining())!));
      await expireLock();
    }

    // 15m, 1h, 6h, 12h, then capped — a forgetful user is never locked out for
    // longer than roughly a night's sleep, however long the attack runs.
    expect(observed).toEqual([15, 60, 360, 720, 720]);
  });

  it('clears the ladder on a successful sign-in', async () => {
    await failTimes(FAILURES_PER_LOCKOUT - 1);
    expect((await User.findByPk(user.id))!.failedLoginCount).toBe(FAILURES_PER_LOCKOUT - 1);

    await login(user.email, TEST_PASSWORD, metadata);

    const afterSuccess = await User.findByPk(user.id);
    expect(afterSuccess!.failedLoginCount).toBe(0);
    expect(afterSuccess!.lockedUntil).toBeNull();

    // And the next lock starts from the bottom rung again, not from where the
    // user left off — someone who mistypes, succeeds, then mistypes again is
    // not treated as an attacker mid-run.
    await failTimes(FAILURES_PER_LOCKOUT);
    const remaining = await lockMinutesRemaining();
    expect(remaining!).toBeGreaterThan(14);
    expect(remaining!).toBeLessThanOrEqual(15);
  });
});

describe('failed sign-in', () => {
  it('does not answer faster for an address with no account', async () => {
    // Not a micro-benchmark. bcrypt at cost 12 is ~300ms, while the placeholder
    // digest this path used to compare against was 63 characters long and so
    // rejected on length in under a millisecond — a hundredfold gap, readable
    // off a stopwatch, that told an attacker exactly which addresses were worth
    // spraying. A 100ms floor separates those two worlds with enormous margin
    // and does not depend on how fast the machine running the suite is.
    const knownStarted = Date.now();
    await failOnce();
    const knownMs = Date.now() - knownStarted;

    const unknownStarted = Date.now();
    await expect(
      login('nobody-at-all@meetflow.test', WRONG_PASSWORD, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
    const unknownMs = Date.now() - unknownStarted;

    expect(unknownMs).toBeGreaterThan(100);
    expect(unknownMs).toBeGreaterThan(knownMs / 2);
  });
});
