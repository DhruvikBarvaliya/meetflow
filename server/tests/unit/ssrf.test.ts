/**
 * The address guard in front of webhook delivery.
 *
 * A webhook URL is a string a tenant types and MeetFlow's own server then
 * connects to, from inside whatever network it is deployed in. Every
 * assertion here is a URL somebody would actually try.
 *
 * The IPv6 cases are the ones worth reading. `::ffff:127.0.0.1` is loopback
 * written as an IPv6 address, and a guard that pattern-matches on v6 prefixes
 * alone waves it through as "some address we do not recognise" — which is the
 * single most common way this check is got wrong, and the reason the mapped and
 * NAT64 forms are unwrapped rather than treated as v6.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/config/env';

/**
 * The guard as production runs it.
 *
 * `tests/setup.ts` turns `WEBHOOK_ALLOW_PRIVATE_TARGETS` on for the suite, so
 * that `webhooks.test.ts` can deliver to a real receiver on 127.0.0.1. This
 * file is about the guard itself, so it forces the flag back off — otherwise
 * every assertion below would pass for the wrong reason, which is the one
 * outcome a security test must never have.
 */
vi.mock('../../src/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return { ...actual, env: { ...actual.env, WEBHOOK_ALLOW_PRIVATE_TARGETS: false } };
});

import {
  assertDeliverableUrl,
  guardedLookup,
  isBlockedAddress,
  isBlockedHostname,
} from '../../src/utils/ssrf';

describe('isBlockedAddress — IPv4', () => {
  it('refuses loopback in every disguise', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    // Still 127/8, and the form a scanner tries second.
    expect(isBlockedAddress('127.1.2.3')).toBe(true);
    // 0.0.0.0/8 reaches the local host on Linux under a name that does not
    // look like localhost at all.
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
  });

  it('refuses the cloud metadata service', () => {
    // The reason this file exists. On AWS, GCP and Azure this address answers
    // with instance credentials, and the delivery log captures the response
    // where whoever registered the endpoint can read it back.
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
  });

  it('refuses every private range, not only the famous one', () => {
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    // Carrier-grade NAT: not private, but it routes into somebody else's
    // infrastructure rather than the public internet.
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
  });

  it('allows the addresses on either side of a private range', () => {
    // The off-by-one that a hand-written mask gets wrong. 172.16/12 ends at
    // 172.31.255.255, so both of these are public and must stay reachable.
    expect(isBlockedAddress('172.15.255.255')).toBe(false);
    expect(isBlockedAddress('172.32.0.0')).toBe(false);
    expect(isBlockedAddress('9.255.255.255')).toBe(false);
    expect(isBlockedAddress('11.0.0.0')).toBe(false);
  });

  it('allows ordinary public addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
  });

  it('refuses anything it cannot parse', () => {
    // Fail closed. An address the guard does not understand is not one to open
    // a socket to on the grounds that no rule matched it.
    expect(isBlockedAddress('not-an-address')).toBe(true);
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('isBlockedAddress — IPv6', () => {
  it('refuses loopback and the unspecified address', () => {
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('::')).toBe(true);
  });

  it('unwraps IPv4-mapped addresses rather than treating them as v6', () => {
    // Loopback, written the way a guard that only looks at v6 prefixes misses.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    // And a mapped *public* address is still allowed, so the unwrapping is a
    // real check rather than a blanket refusal of the form.
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('unwraps NAT64 the same way', () => {
    expect(isBlockedAddress('64:ff9b::127.0.0.1')).toBe(true);
    expect(isBlockedAddress('64:ff9b::8.8.8.8')).toBe(false);
  });

  it('refuses unique-local, link-local and multicast', () => {
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('ff02::1')).toBe(true);
    expect(isBlockedAddress('2001:db8::1')).toBe(true);
  });

  it('allows ordinary public v6 addresses', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('ignores a zone index rather than choking on it', () => {
    expect(isBlockedAddress('fe80::1%eth0')).toBe(true);
  });
});

describe('isBlockedHostname', () => {
  it('refuses the names that mean "here" without resolving them', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('LOCALHOST')).toBe(true);
    // A fully-qualified name with the root dot is the same name.
    expect(isBlockedHostname('localhost.')).toBe(true);
    expect(isBlockedHostname('anything.localhost')).toBe(true);
    expect(isBlockedHostname('printer.local')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
    expect(isBlockedHostname('db.internal')).toBe(true);
  });

  it('allows an ordinary public name', () => {
    expect(isBlockedHostname('hooks.example.com')).toBe(false);
    // Not fooled by a substring: this is a public name that merely contains
    // one of the blocked words.
    expect(isBlockedHostname('localhost.example.com')).toBe(false);
    expect(isBlockedHostname('internal.example.com')).toBe(false);
  });
});

describe('assertDeliverableUrl', () => {
  it('accepts a public URL', () => {
    expect(() => assertDeliverableUrl('https://hooks.example.com/meetflow')).not.toThrow();
    expect(() => assertDeliverableUrl('http://93.184.216.34:8080/hook')).not.toThrow();
  });

  it('refuses a private or loopback address, and says why', () => {
    expect(() => assertDeliverableUrl('http://127.0.0.1:3000/hook')).toThrow(
      /private or reserved range/i,
    );
    expect(() => assertDeliverableUrl('http://169.254.169.254/latest/meta-data/')).toThrow();
    expect(() => assertDeliverableUrl('http://localhost:4000/hook')).toThrow();
    expect(() => assertDeliverableUrl('http://[::1]:4000/hook')).toThrow();
  });

  it('does not resolve names, so an endpoint that is not deployed yet can be registered', () => {
    // Deliberate: a staging URL whose DNS has not propagated is a legitimate
    // thing to register, and making the form depend on the resolver's current
    // mood would refuse it. The connect-time guard catches it either way, which
    // is where it has to be caught anyway.
    expect(() => assertDeliverableUrl('https://not-deployed-yet.example.com/hook')).not.toThrow();
  });

  it('refuses a URL it cannot parse', () => {
    expect(() => assertDeliverableUrl('not a url')).toThrow(/complete URL/i);
  });
});

describe('guardedLookup', () => {
  /**
   * `dns.lookup` returns an IP literal without touching the network, so these
   * exercise the *resolution* branch — the one that runs at connect time —
   * deterministically and offline. A test that needed a real name resolving to
   * a private address would be a test that fails on a train.
   */
  function resolve(
    hostname: string,
  ): Promise<{ error: NodeJS.ErrnoException | null; address: unknown }> {
    return new Promise((done) => {
      guardedLookup(hostname, { family: 0 }, (error, address) => done({ error, address }));
    });
  }

  it('refuses a name that means "here" before it resolves anything', async () => {
    const { error } = await resolve('localhost');
    expect(error?.code).toBe('EBLOCKEDADDRESS');
  });

  it('refuses a resolution that lands inside a blocked range', async () => {
    // This is the check that defeats DNS rebinding: it runs on the address the
    // socket is about to be opened to, not on one resolved minutes earlier.
    for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1']) {
      const { error } = await resolve(address);
      expect(error?.code, `${address} should have been refused`).toBe('EBLOCKEDADDRESS');
    }
  });

  it('lets a public address through', async () => {
    const { error, address } = await resolve('8.8.8.8');
    expect(error).toBeNull();
    expect(address).toBe('8.8.8.8');
  });

  it('refuses the whole set when any resolved address is blocked', async () => {
    // `all: true` is what an agent asks for when it wants every candidate. A
    // resolver answering with one public and one private address is already
    // behaving oddly enough to refuse outright rather than filter.
    const { error } = await new Promise<{ error: NodeJS.ErrnoException | null }>((done) => {
      guardedLookup('127.0.0.1', { all: true, family: 0 }, (err) => done({ error: err }));
    });
    expect(error?.code).toBe('EBLOCKEDADDRESS');
  });
});
