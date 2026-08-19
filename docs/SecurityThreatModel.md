# Security Threat Model

Threats specific to a multi-tenant scheduling product, and the control against
each. Where a control is partial or missing, this document says so.

## Assets

| Asset                                                    | Why it matters                                       |
| -------------------------------------------------------- | ---------------------------------------------------- |
| Customer PII (name, email, phone, appointment history)   | the most sensitive data in the system                |
| Tenant business data (services, pricing, staff, revenue) | competitively sensitive between tenants              |
| Credentials and session tokens                           | account takeover                                     |
| Booking capacity                                         | denial of service against a real business's diary    |
| Audit trail                                              | must be trustworthy to be useful in an investigation |

## Trust boundaries

```
anonymous internet ──► /api/v1/public/*        (no auth; tenant from a validated slug)
authenticated user ──► /api/v1/*               (membership-scoped)
platform admin     ──► /api/v1/admin/*         (platform scope, still tenant-scoped for tenant data)
worker process     ──► database + Redis        (no inbound network surface)
```

## Threats and controls

### Tenant breakout

An authenticated user reaching another workspace's data.

- Tenant id derived from an ACTIVE membership, never from client input.
- `X-Business-Id` only _selects_ among the caller's own memberships.
- Every query filtered by `businessId`; services take it as their first argument.
- `tenantOf()` throws rather than letting `undefined` silently drop the filter —
  Sequelize ignores undefined keys, which would turn a scoped query global.
- Cross-tenant access answers **404, not 403**, so endpoints are not existence
  oracles.
- Covered by `tests/integration/tenancy.test.ts` and cross-tenant cases in
  `booking.concurrency.test.ts`.

### Broken object-level authorisation (IDOR/BOLA)

Guessing or substituting an id.

- Internal UUIDs are never exposed on public surfaces; customer-facing links use
  130-bit random opaque ids (`apt_…`, `cus_…`, `atn_…`).
- Every fetch by id is tenant-scoped in the same query, not checked afterwards.
- Group attendees get their own participant `publicId`, so one attendee cannot
  act on another's place.

### Privilege escalation

Granting yourself permissions.

- Request bodies are `.strict()`: sending `platformRole` to `/auth/register` is a
  422, not a silently ignored field. (Verified in the auth smoke test.)
- Permissions are never carried in the access token — they are re-read per
  request, so a revoked role takes effect immediately.
- `STAFF` is minimal by default; broader access must be granted explicitly.
- DENY overrides always beat role grants.

### Credential attacks

Stuffing, brute force, enumeration.

- bcrypt cost 12; common-password denylist; server-side policy.
- Progressive lockout after 8 failures (15 minutes).
- Login rate limit keyed on **IP + submitted email**, so both spraying one
  password across many accounts and many passwords at one account are throttled.
- Uniform failure response and a dummy hash comparison for unknown accounts, so
  timing and wording do not reveal which addresses exist.
- Password reset always responds identically whether or not the address exists.
- Registration refuses duplicates without confirming the address is registered.

### Session theft

A stolen refresh token.

- Refresh tokens are opaque and stored only as SHA-256 digests — a database leak
  yields nothing usable.
- Rotation on every use, with reuse detection: replaying a rotated token revokes
  the entire family, logging out both the attacker and the victim. Losing a
  session is far cheaper than letting a stolen token mint credentials forever.
- Access tokens are 15 minutes and carry a `jti`.
- `logout-all` revokes the family, and live access tokens are checked against it.
- Refresh cookie is `httpOnly`, `sameSite=lax`, `secure` in production, and
  path-scoped to `/api/v1/auth`.
- Password change or reset revokes every session.

### Public booking abuse

Spam bookings, link enumeration, capacity denial of service.

- Tight per-IP limits on the public surface; tighter still on confirm.
- Booking-link slugs are operator-chosen but the surface is rate limited, and
  links carry `expiresAt` and `maxBookingsTotal`.
- Idempotency keys prevent replay from creating duplicates.
- Booking limits per customer per day and per staff per day.
- Minimum notice and maximum horizon bound what can be booked at all.

**Partial:** there is no CAPTCHA or proof-of-work on the public booking form. A
determined attacker with many IPs could still consume a small business's diary.
Mitigations available today are the per-link caps and per-customer daily limits;
a challenge on the confirm step is the natural next control.

### Double booking / race conditions

Covered in depth in `BookingConcurrency.md`: PostgreSQL exclusion constraints
are the authority, with idempotency, advisory locks, revalidation and row locks
layered above.

### Socket abuse

Joining another tenant's room.

- No client-initiated `join` exists. Rooms are derived from memberships re-read
  at handshake.
- Handshake requires a valid access token; suspended accounts are refused.
- Payload size bounded (100 KB).

### Webhook abuse

Forged or replayed deliveries against a subscriber.

- HMAC-SHA256 over `timestamp.body`, sent as `X-MeetFlow-Signature: v1=…`, so a
  receiver can verify authenticity _and_ freshness.
- Per-endpoint signing secret, returned exactly once at creation and never
  echoed by a read API.
- Unique `(endpoint_id, event_id)` prevents double-notifying a subscriber.
- Endpoints auto-disable after 20 consecutive failures.
- Requests are timeout-bounded and response capture is truncated.

**Partial:** outbound URLs are not validated against private address ranges, so
a tenant could point a webhook at an internal host (SSRF). An allowlist/denylist
on resolved IPs is required before exposing webhooks to untrusted tenants.

### Sensitive data disclosure

- Central log redaction of passwords, tokens, secrets, cookies, auth headers.
- Password hashes excluded by a Sequelize `defaultScope`, so a forgotten
  `attributes` list cannot leak one; auth flows opt in explicitly.
- Unknown errors become a generic 500 in production — no SQL, constraint names,
  paths or stack traces reach a client.
- Audit metadata is sanitised and size-bounded before it is written.
- `helmet` security headers; CORS restricted to explicit origins, with wildcards
  and `http://` rejected outright in production.

### Configuration failure

- Startup validation refuses to boot on invalid config.
- Production additionally rejects: placeholder JWT secrets, identical access and
  refresh secrets, `SEED_ENABLED=true`, disabled rate limiting, pretty logging,
  and non-HTTPS origins.
- Secret scanner runs in the pre-commit gate.

### Insider / accidental damage

- Append-only audit log with actor, tenant, action, entity, request id and IP.
- No application code updates or deletes audit rows.
- Destructive operations require an explicit `*_MANAGE` permission and refuse
  when active appointments still reference the record.

## Dependency advisories

Accepted advisories and why, so a reader who runs `npm audit` and finds red is
not left guessing whether anyone looked.

`npm audit --omit=dev` reports **3 vulnerabilities (1 high, 2 moderate)** as of
2026-08-19. Dev dependencies are excluded because they never reach a deployed
artefact; the numbers below are what actually ships.

### `nodemailer` — 1 high, eight advisories (accepted, not fixed)

npm counts the package once at its worst severity. The eight advisories behind
that single line are led by
[GHSA-mm7p-fcc7-pg87](https://github.com/advisories/GHSA-mm7p-fcc7-pg87)
(**high** — "email to an unintended domain" via an address-parsing
interpretation conflict), with
[GHSA-rcmh-qjqh-p98v](https://github.com/advisories/GHSA-rcmh-qjqh-p98v)
(addressparser DoS on recursion) and six injection/bypass issues in
`envelope.size`, transport `name` (EHLO/HELO CRLF), `List-*` header comments,
`jsonTransport`, message-level `raw`, and OAuth2 token-fetch TLS validation.

**Exposure — most of the vulnerable surface is not reachable from this
product.** `SmtpEmailProvider` in
`server/src/integrations/email/emailProvider.ts` is the only nodemailer call
site, and it passes exactly `from`, `to`, `subject`, `text` and `html`. It never
sets `envelope`, `list`, `raw`, a transport `name`, or attachments; it never
uses `jsonTransport`; and `auth` is plain SMTP user/password, never OAuth2. Six
of the eight advisories therefore have no path to them at all.

The two that do touch a live path are the address-parsing pair, and both are
bounded before nodemailer sees anything. `to` is always a single address read
from `notifications.recipient_address`, and every ingress that can put an
address there — registration, member invite, customer create/update, public
booking, public waitlist, location contact — runs it through a Zod schema that
trims, lower-cases, applies `.email()` and caps the length: `.max(254)`
everywhere except the member invite, which is `.max(255)` to agree with its
unique index. The schemas are per-module rather than one shared constant, so
the caps differ by a byte and only `auth`, `customers` and the two public
surfaces also carry `.min(3)` — none of which changes the property relied on
here, which is that no unvalidated string reaches the column. A multi-`@`
address, a CRLF, or a string long enough to matter for the recursive-parse DoS
is a 422 at the edge and never becomes a row. Residual risk is a workspace
operator, already authenticated, mailing an address of their own choosing —
which they can do by typing it into any mail client.

**Why it is not fixed:** the only remedy is `nodemailer@9`, a major version
whose `createTransport` options and `SentMessageInfo` shape both changed. That
is a breaking upgrade to the one integration standing between this product and
every customer-facing email, and it is not worth taking blind while the
reachable surface is a validated single recipient.

**Revisit when any of these becomes true:**

- the email adapter starts passing `attachments`, `envelope`, `list`, `raw`,
  `headers`, or a custom transport `name`;
- SMTP auth moves to OAuth2 (Gmail/Microsoft 365 relays require it);
- an address reaches `to` from anywhere that is not the validated schema above —
  a bulk import, an admin free-text field, a reply-to derived from a request;
- a further advisory lands on a `6.x` path this product _does_ use.

Until then this is an accepted risk, re-checked whenever `npm audit` is run.

### `uuid` via `sequelize` — 2 moderate (accepted, not fixed)

[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq): a
missing buffer bounds check in `uuid` v3/v5/v6 **when a `buf` argument is
supplied**. Sequelize touches `uuid` in exactly one place
(`lib/utils.js`), to produce `UUIDV1`/`UUIDV4` column defaults — never v3, v5 or
v6, and never with a buffer — so the vulnerable branch is unreachable from any
call this product makes. `npm audit fix --force` would
resolve it by installing `sequelize@3.30.0` — a downgrade of five major
versions, which is not a fix. Revisit when Sequelize 6 bumps its own `uuid`
range, or at the Sequelize 7 upgrade.

## Known gaps

Stated plainly rather than omitted:

1. **No CAPTCHA / bot challenge** on public booking (above). Closing this needs
   an account with a challenge provider, so it is blocked on a decision rather
   than on work.
2. **Email verification is not enforced** — an unverified account can still use
   the API. The flow exists; the gate does not. Turning it on is a product
   decision about existing accounts, not only a code change.
3. **No 2FA / MFA.**
4. **Signing secrets are not protected against host compromise.** They are now
   encrypted at rest (below), but with a key from the process environment, so
   anything that can read that environment can decrypt. A KMS-managed key with
   per-request unwrapping is the next step.
5. ~~**No SSRF protection** on webhook target URLs~~ — **closed.** See below.
6. ~~**Signing secrets are stored in plaintext**~~ — **closed**, with the
   caveat in 4. See below.
7. ~~**No automated dependency or container scanning**~~ — **closed.** The
   `dependencies` job runs `scripts/audit-gate.mjs`, and the `docker` job scans
   both built images with Trivy at HIGH and CRITICAL. See below.
8. ~~**`/api/docs` is unauthenticated**~~ — **closed.** The docs router is no
   longer mounted when `APP_ENV=production`; the contract is generated for
   production consumers with `npm run contracts:export` instead.

Each open item is a deliberate, recorded gap, not an oversight.

### SSRF on webhook delivery — closed

A webhook URL is a string a tenant types and MeetFlow's own server then
connects to, from inside whatever network it is deployed in.
`http://169.254.169.254/latest/meta-data/iam/security-credentials/` is the
canonical target: on a cloud instance it answers with credentials, and the
delivery record captures the first 2 KB of the response where whoever
registered the endpoint can read it back.

`utils/ssrf.ts` refuses it in two places, and only the second one is a security
control:

| Where                                        | What it is for                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `assertDeliverableUrl`, on create and update | Usability. The operator is told at the form rather than from a delivery log. Names are **not** resolved. |
| `guardedLookup`, passed to `http.request`    | The control. Runs on the resolution the socket is actually opened with, on every attempt.                |

The split matters because a check at registration and a socket opened minutes
later are two different questions, and DNS rebinding is the technique for making
the answers differ. `node:http`/`node:https` are used rather than `fetch`
precisely because they accept a `lookup`; `fetch` offers no equivalent hook
without an undici `Agent`, and validating the URL beforehand would leave exactly
that window open. Redirects are not followed, so there is no second hop to
guard.

Blocked: loopback, `0.0.0.0/8`, all three RFC 1918 ranges, carrier-grade NAT,
link-local (which is where the metadata service lives), the documentation and
benchmarking ranges, multicast and reserved space; and on the IPv6 side the
unspecified and loopback addresses, unique-local, link-local, multicast and
documentation prefixes. IPv4-mapped (`::ffff:127.0.0.1`) and NAT64 addresses are
unwrapped and checked as IPv4, which is the case a prefix-matching guard
usually misses. `localhost`, `*.local`, `*.internal`, `*.home.arpa` and
`metadata.google.internal` are refused without resolving at all.

`WEBHOOK_ALLOW_PRIVATE_TARGETS` turns the guard off for local development and
for the integration suite, which starts a real HTTP receiver on 127.0.0.1
because asserting delivery against a mock asserts nothing about delivery.
`env.ts` **rejects the flag when `APP_ENV=production`** — the process refuses to
start rather than running unguarded — so it cannot be enabled by
misconfiguration. `ssrf.test.ts` and `webhookSsrf.test.ts` both force it back
off, so neither can pass for the wrong reason.

### Webhook signing secrets at rest — closed

Every other secret MeetFlow stores is a digest: passwords are hashed, refresh
tokens are stored as SHA-256, and nothing needs the original back. A webhook
signing secret is the exception — every delivery computes an HMAC with it — so
it has to be recoverable, and hashing is not available.

It is therefore encrypted with **AES-256-GCM** by a getter/setter pair on the
model attribute, so `endpoint.signingSecret` is plaintext everywhere in the
application and only the column holds ciphertext. Putting it in the service
instead would mean the one call site that forgets is the one that leaks, with
nothing in a read to reveal it.

Three details are the substance rather than the decoration:

- **GCM, not CBC.** The tag authenticates the ciphertext, so a row somebody
  edited fails to open rather than decrypting to something else and signing
  deliveries the recipient rejects for reasons nobody can trace.
- **The endpoint id is bound in as additional authenticated data.** Without it,
  write access to the table is enough to paste a neighbour's ciphertext onto
  your own endpoint and read the secret back through your own create response.
- **A value with no `v1.` prefix is returned unchanged.** Rows written before
  this existed keep working, so enabling the key is a deployment step rather
  than a migration with every endpoint broken until it finishes.

`WEBHOOK_SECRET_ENCRYPTION_KEY` is **required in production** — `env.ts` refuses
to start without it — and optional elsewhere, so a local checkout needs no
configuration. The test suite sets it, which means `webhooks.test.ts` signs with
a secret that has genuinely been through the round trip and asserts the raw
column is ciphertext; without that the suite would exercise only the plaintext
path and prove nothing about the encrypted one.

**What this buys, precisely.** It defends against the database alone being lost
— a stolen dump, a snapshot on the wrong bucket, a read-only SQL injection, a
support engineer with a psql prompt. It does **not** defend against the host
being compromised, because the key is in the process environment. That is gap 4
above, and it is stated rather than glossed.

### Dependency and container scanning — closed

Two jobs, and the npm one is shaped around the failure mode that makes most
audit gates worthless. `npm audit --audit-level=high` goes red on day one for
advisories somebody has already reviewed and accepted, stays red, and within a
week a red build is the normal state — at which point a genuinely new advisory
arrives into a build nobody looks at twice.

`scripts/audit-gate.mjs` therefore fails on advisories that are **new**.
Everything currently accepted is listed in `.audit-allowlist.json` with its
reason and the date it was accepted, and:

- an advisory not on that list fails the build, with no override flag — the only
  way to silence one is a commit somebody reviews;
- an entry for an advisory that no longer appears **also** fails, because a
  stale exemption pre-approves a finding nobody has read, and because the list
  should describe the tree.

Trivy scans both production images at HIGH and CRITICAL with `ignore-unfixed`,
for the same reason: an advisory with no fixed version is not something the
build can act on, and failing on it produces the red-forever state above.
