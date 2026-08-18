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

## Known gaps

Stated plainly rather than omitted:

1. **No CAPTCHA / bot challenge** on public booking (above).
2. **No SSRF protection** on webhook target URLs (above).
3. **Email verification is not enforced** — an unverified account can still use
   the API. The flow exists; the gate does not.
4. **No 2FA / MFA.**
5. **Signing secrets are stored in plaintext** in `webhook_endpoints`. They
   should be encrypted at rest with a KMS-managed key.
6. **No automated dependency or container scanning** in the repository yet
   (`npm audit`, Trivy or equivalent should run in CI).
7. ~~**`/api/docs` is unauthenticated**~~ — **closed.** The docs router is no
   longer mounted when `APP_ENV=production`; the contract is generated for
   production consumers with `npm run contracts:export` instead.

Each is a deliberate, recorded gap, not an oversight.
