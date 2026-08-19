/**
 * Encryption of the one secret MeetFlow has to be able to read back.
 *
 * A webhook signing secret cannot be hashed — every delivery computes an HMAC
 * with it — so it is encrypted instead. The properties worth asserting are the
 * ones whose absence is silent:
 *
 *  - a sealed value does not contain the plaintext (the whole point);
 *  - two seals of the same secret differ (a deterministic ciphertext tells an
 *    attacker with a dump which endpoints share a secret);
 *  - a ciphertext moved to another row will not open (otherwise database write
 *    access is enough to steal a neighbour's secret and read it back through
 *    your own endpoint's create response);
 *  - a value written before encryption existed still reads back, so turning
 *    the key on is a deployment step and not an outage.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/config/env';

// The key is inlined rather than held in a `const` above: `vi.mock` is hoisted
// to the top of the file, so a variable declared here would not exist yet when
// the factory runs.
vi.mock('../../src/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    env: {
      ...actual.env,
      WEBHOOK_SECRET_ENCRYPTION_KEY: 'a-test-key-that-is-long-enough-to-pass-validation',
    },
  };
});

import { openSecret, sealSecret } from '../../src/utils/secretBox';

const ROW = '11111111-1111-4111-8111-111111111111';
const OTHER_ROW = '22222222-2222-4222-8222-222222222222';

describe('sealSecret / openSecret', () => {
  it('round-trips', () => {
    const secret = 'whsec_0123456789abcdef';
    expect(openSecret(sealSecret(secret, ROW), ROW)).toBe(secret);
  });

  it('does not leave the plaintext in the stored value', () => {
    const sealed = sealSecret('whsec_correcthorsebatterystaple', ROW);
    expect(sealed).not.toContain('correcthorsebatterystaple');
    expect(sealed.startsWith('v1.')).toBe(true);
  });

  it('produces a different ciphertext every time', () => {
    // A fresh IV per seal. Without it, identical secrets produce identical
    // ciphertexts, and anybody holding a dump can see which endpoints share
    // one without decrypting anything.
    const first = sealSecret('whsec_same', ROW);
    const second = sealSecret('whsec_same', ROW);
    expect(first).not.toBe(second);
    expect(openSecret(first, ROW)).toBe(openSecret(second, ROW));
  });

  it('refuses a ciphertext moved to another row', () => {
    // The additional authenticated data is the row id. Without it, write access
    // to the table is enough to paste a neighbour's secret onto your own
    // endpoint and read it back through your own create response.
    const sealed = sealSecret('whsec_theirs', ROW);
    expect(() => openSecret(sealed, OTHER_ROW)).toThrow();
  });

  it('refuses a tampered ciphertext rather than decrypting to something else', () => {
    // GCM's tag is what makes this a refusal instead of garbage. CBC would
    // return plausible-looking bytes and sign deliveries with them.
    const sealed = sealSecret('whsec_original', ROW);
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString('base64');
    expect(() => openSecret(parts.join('.'), ROW)).toThrow();
  });

  it('reads a value written before encryption existed', () => {
    // No version prefix means a legacy plaintext row. Returning it unchanged is
    // what makes enabling the key a deployment step rather than a migration
    // with every existing endpoint broken until it completes.
    expect(openSecret('whsec_written_before_all_this', ROW)).toBe('whsec_written_before_all_this');
  });

  it('refuses a shape it cannot parse rather than guessing', () => {
    expect(() => openSecret('v1.only-one-part', ROW)).toThrow(/cannot read/i);
  });
});
