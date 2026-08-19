/**
 * Refusing to make requests to ourselves.
 *
 * A webhook endpoint is a URL a tenant supplies and MeetFlow's own server then
 * fetches. That is server-side request forgery by construction: whatever the
 * tenant writes, our process connects to, from inside whatever network we are
 * deployed in. `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * is the canonical example — on a cloud instance it answers with credentials,
 * and the delivery log helpfully captures the first kilobyte of the response
 * where the registrant can read it back.
 *
 * Two properties are needed, and only the second one actually protects
 * anything:
 *
 *  1. **Refuse at registration**, so an operator finds out immediately rather
 *     than from a delivery log. This is a usability feature.
 *  2. **Refuse at connect**, because between registering `evil.test` and the
 *     delivery firing, the name can be re-pointed at `127.0.0.1`. A check that
 *     runs at registration and a socket that is opened minutes later are two
 *     different questions, and DNS rebinding is precisely the technique for
 *     making the answers differ. So the address is validated inside the
 *     `lookup` the request itself uses — after resolution, before connect, on
 *     every attempt. That is the check that matters.
 *
 * `guardedLookup` is deliberately shaped as a drop-in for `dns.lookup`, which
 * is what `http.request({ lookup })` accepts, so the guard sits in the one
 * place the socket cannot be opened without passing through.
 *
 * What this does *not* do is stop a hostname that legitimately resolves to a
 * public address which then redirects to a private one. Redirects are not
 * followed — the delivery treats a 3xx as a failure like any other non-2xx —
 * so there is no second hop to guard.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { env } from '../config/env';
import { ValidationError } from './errors';

/**
 * The one way past all of this, and it does not exist in production.
 *
 * `WEBHOOK_ALLOW_PRIVATE_TARGETS` is rejected by `env.ts` when
 * `APP_ENV=production`, so a deployment cannot turn the guard off by
 * misconfiguration — the process refuses to start instead. Locally it is what
 * lets a developer deliver to a receiver on their own machine, and what lets
 * `webhooks.test.ts` assert delivery against a real HTTP server rather than a
 * mock that would assert nothing about delivery.
 */
function guardDisabled(): boolean {
  return env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
}

/*
 * The flag is read here and not inside `isBlockedAddress` /
 * `isBlockedHostname`, which stay pure. "Is 10.0.0.1 a private address" is a
 * fact and has one answer; "will MeetFlow connect to it" is a policy and has a
 * configurable one. Keeping them apart means the facts can be asserted without
 * the configuration in the way, and the two places that enforce the policy are
 * both visible in this file rather than hidden inside a predicate somebody
 * reuses later assuming it answers the first question.
 */

/**
 * Blocked IPv4 ranges, as [first octet-aligned prefix, mask bits].
 *
 * Every non-public range IANA defines, not only the three RFC 1918 ones. The
 * omissions are the interesting entries: `169.254.0.0/16` carries the cloud
 * metadata service on every major provider, `100.64.0.0/10` is carrier-grade
 * NAT and routes to somebody else's infrastructure, and `0.0.0.0/8` is
 * interpreted as "this host" by most stacks, so it reaches localhost by a name
 * that does not look like localhost.
 */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network" — resolves to the local host on Linux
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata at 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
];

function v4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedV4(address: string): boolean {
  const value = v4ToInt(address);
  if (value === null) return true; // unparseable is not a thing to connect to
  return BLOCKED_V4.some(([prefix, bits]) => {
    const base = v4ToInt(prefix);
    if (base === null) return false;
    // `>>> 0` because a 32-bit mask with bits === 0 would shift by 32, which JS
    // treats as a shift by 0; no /0 entry exists above, but the coercion keeps
    // the arithmetic unsigned either way.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

/**
 * Expands an IPv6 address to its sixteen bytes.
 *
 * Hand-rolled rather than pulled in, because the only thing needed is a prefix
 * comparison and every dependency that does this also does forty other things.
 */
function v6ToBytes(address: string): number[] | null {
  const zone = address.indexOf('%');
  const bare = zone === -1 ? address : address.slice(0, zone);

  const [head, tail] = bare.split('::');
  if (tail !== undefined && bare.split('::').length > 2) return null;

  function groupsOf(section: string): number[] | null {
    if (section === '') return [];
    const out: number[] = [];
    for (const piece of section.split(':')) {
      // A trailing IPv4 form: ::ffff:127.0.0.1 and friends.
      if (piece.includes('.')) {
        const value = v4ToInt(piece);
        if (value === null) return null;
        out.push((value >>> 16) & 0xffff, value & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  }

  const left = groupsOf(head ?? '');
  const right = tail === undefined ? [] : groupsOf(tail);
  if (left === null || right === null) return null;

  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;

  const groups = [...left, ...Array<number>(tail === undefined ? 0 : missing).fill(0), ...right];
  if (groups.length !== 8) return null;

  return groups.flatMap((group) => [(group >>> 8) & 0xff, group & 0xff]);
}

function isBlockedV6(address: string): boolean {
  const bytes = v6ToBytes(address);
  if (bytes === null) return true;

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) both carry a v4
  // address in the low four bytes. Checking only the v6 prefix would let
  // `::ffff:127.0.0.1` through as "some v6 address we do not recognise", which
  // is the single most common way this check is got wrong.
  const isV4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isNat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (isV4Mapped || isNat64) {
    return isBlockedV4(bytes.slice(12).join('.'));
  }

  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (bytes[0] === 0x01 && bytes.slice(1, 8).every((byte) => byte === 0)) return true; // 100::/64 discard

  return false;
}

/** Whether MeetFlow is willing to open a socket to this address. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  return true;
}

/**
 * Hostnames refused without resolving them at all.
 *
 * Belt and braces: each of these normally resolves into a range blocked above,
 * but `.internal` and `.local` are also whatever a given network says they are,
 * and a split-horizon resolver can point them at a public-looking address that
 * is nonetheless somebody's intranet.
 */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const BLOCKED_HOSTS = ['localhost', 'metadata.google.internal'];

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.includes(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * A `dns.lookup` that refuses to hand back an address we will not connect to.
 *
 * Shaped exactly like `dns.lookup` so it can be passed to
 * `http.request({ lookup })`, which is the point: the check then happens on the
 * resolution the socket actually uses, on every attempt, rather than on an
 * earlier resolution of the same name that may since have changed.
 *
 * `all: true` is handled because the http agent may ask for every address; a
 * name that resolves to one public and one private address is refused outright
 * rather than filtered down to the public one, since a resolver returning both
 * is already behaving in a way worth refusing.
 */
export const guardedLookup: LookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void => {
  if (guardDisabled()) {
    dnsLookup(hostname, options as never, callback as never);
    return;
  }

  if (isBlockedHostname(hostname)) {
    callback(blockedError(hostname), '');
    return;
  }

  dnsLookup(hostname, options as never, (err: unknown, address: unknown, family?: unknown) => {
    if (err) {
      callback(err as NodeJS.ErrnoException, '');
      return;
    }

    const addresses: string[] = Array.isArray(address)
      ? (address as LookupAddress[]).map((entry) => entry.address)
      : [address as string];

    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      callback(blockedError(hostname), '');
      return;
    }

    callback(null, address as string | LookupAddress[], family as number | undefined);
  });
};

function blockedError(hostname: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `Refusing to connect to ${hostname}: it resolves to an address inside a private or reserved range.`,
  );
  error.code = 'EBLOCKEDADDRESS';
  return error;
}

/**
 * Checks a URL at the point somebody types it, so the refusal is immediate.
 *
 * Resolution is deliberately *not* part of this: a name that does not resolve
 * yet is a legitimate thing to register — a staging endpoint that is not
 * deployed, a DNS record propagating — and refusing it here would make the
 * registration form dependent on the resolver's current mood. What cannot be
 * registered is a URL naming a private address or an obviously internal host
 * outright, which is the case an operator actually gets wrong. Everything else
 * is caught at connect by `guardedLookup`, which is where it has to be caught
 * anyway.
 */
export function assertDeliverableUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError('Enter a complete URL, including the scheme.', [
      { field: 'url', message: 'Not a valid URL.' },
    ]);
  }

  if (guardDisabled()) return;

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (isBlockedHostname(hostname) || (isIP(hostname) !== 0 && isBlockedAddress(hostname))) {
    throw new ValidationError(
      'That address is inside a private or reserved range, so MeetFlow will not send deliveries to it. Use a publicly reachable URL.',
      [{ field: 'url', message: 'Private, loopback and link-local addresses are not accepted.' }],
    );
  }
}
