# API

Base path `/api/v1`. JSON only. Interactive reference at `/api/docs`, machine
contract at `/api/docs/openapi.json`, both generated from the same zod schemas
that validate requests at runtime — so the documentation cannot drift from the
implementation.

## Two surfaces

| Surface            | Auth         | Tenant context                    |
| ------------------ | ------------ | --------------------------------- |
| `/api/v1/public/*` | none         | resolved from a booking-link slug |
| `/api/v1/auth/*`   | none         | none                              |
| `/api/v1/*`        | bearer token | ACTIVE membership                 |

An unauthenticated request to an unknown path under `/api/v1` answers **401**,
not 404 — the management surface is deliberately not enumerable. The public
surface answers a normal 404.

## Envelope

```jsonc
// success
{ "data": { ... }, "meta": { "page": 1, "pageSize": 25, "totalItems": 92, "totalPages": 4, "hasNextPage": true } }

// failure
{ "error": { "code": "SLOT_UNAVAILABLE", "message": "That time is no longer available.",
             "details": [{ "field": "startsAt", "message": "..." }], "requestId": "…" } }
```

`requestId` appears on every error and in the `X-Request-Id` response header,
and is written into any audit record the request produced — so a user-reported
failure is directly greppable in the logs.

## Authentication

```http
POST /api/v1/auth/register     → 201 { user, accessToken, refreshToken, expiresIn }
POST /api/v1/auth/login        → 200 { user, accessToken, refreshToken, expiresIn }
POST /api/v1/auth/refresh      → 200 { … }      rotates the refresh token
POST /api/v1/auth/logout       → 204
POST /api/v1/auth/logout-all   → 200 { sessionsRevoked }
GET  /api/v1/auth/me           → 200 { user, memberships[], activeWorkspace }
```

Send `Authorization: Bearer <accessToken>`. The refresh token is also set as an
httpOnly cookie scoped to `/api/v1/auth`; browser clients can ignore the body
copy entirely.

Refresh tokens rotate on every use. **Presenting an already-rotated token
revokes the whole family** and returns `401 TOKEN_REVOKED` — a client must not
refresh concurrently from several tabs without coordinating.

## Choosing a workspace

Management endpoints need a tenant. Send:

```http
X-Business-Id: <businessId>
```

The header only _selects_ among workspaces you are an ACTIVE member of. A
workspace you do not belong to returns 404. With exactly one membership the
header is optional; with several it is required.

`GET /api/v1/auth/me` lists your memberships and, once a workspace is selected,
the exact permission strings you hold there — which is what the UI should gate
on.

## Endpoint map

| Prefix                                                               | Purpose                                                     |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `/workspaces`                                                        | create a workspace (authenticated, not tenant-scoped)       |
| `/workspace`                                                         | current workspace profile, settings, members, roles         |
| `/locations` `/teams` `/staff` `/services` `/resources` `/customers` | configuration CRUD                                          |
| `/availability`                                                      | business hours, staff rules, overrides, holidays, blackouts |
| `/booking-links`                                                     | public booking links                                        |
| `/appointments`                                                      | list, calendar, create, and the full lifecycle              |
| `/waitlist`                                                          | entries, notify, convert                                    |
| `/analytics` `/reports`                                              | metrics and exports                                         |
| `/public/*`                                                          | the unauthenticated booking surface                         |

### Appointment lifecycle

```http
POST /api/v1/appointments/:id/reschedule   { startsAt, staffProfileId?, locationId?, reason? }
POST /api/v1/appointments/:id/cancel       { reason? }
POST /api/v1/appointments/:id/approve
POST /api/v1/appointments/:id/reject       { reason? }
POST /api/v1/appointments/:id/check-in
POST /api/v1/appointments/:id/complete
POST /api/v1/appointments/:id/no-show
```

Explicit operations rather than a generic `PATCH { status }`, because each one
has its own policy checks, side effects and audit action. `PATCH /:id` edits
notes and title only — never times or status.

### Availability

```http
GET /api/v1/appointments/availability/slots
      ?serviceId=…&fromDate=2026-09-01&toDate=2026-09-14&timezone=Asia/Kolkata
      [&staffProfileId=…][&locationId=…][&explain=true]
```

`explain=true` also returns why candidate times were rejected and how providers
were ranked. Ranges are capped at `AVAILABILITY_MAX_RANGE_DAYS`; a truncated
result says `truncated: true` rather than implying the day is full.

## Public booking

```http
GET  /api/v1/public/booking-links/:slug
GET  /api/v1/public/booking-links/:slug/availability?serviceId=…&fromDate=…&toDate=…&timezone=…
POST /api/v1/public/booking-links/:slug/bookings
GET  /api/v1/public/appointments/:publicId
POST /api/v1/public/appointments/:publicId/reschedule
POST /api/v1/public/appointments/:publicId/cancel
```

Only opaque identifiers (`apt_…`) are exposed. Customer-initiated reschedule and
cancel are subject to the workspace's configured deadlines and may return
`422 POLICY_VIOLATION` with the deadline in `meta`.

## Idempotency

Send a key on booking confirmation:

```http
X-Idempotency-Key: 9f1c0f6e-…
```

- Same key, same payload → the original appointment is returned, not a second one.
- Same key, still processing → `409 IDEMPOTENCY_IN_PROGRESS`.
- Same key, **different** payload → `409 IDEMPOTENCY_KEY_REUSED`.

Records are durable for `IDEMPOTENCY_TTL_SECONDS` (default 24h).

## Pagination, filtering, sorting

List endpoints take `page` (from 1) and `pageSize` (max 100) and answer with the
`meta` block above. Date filters are ISO dates (`YYYY-MM-DD`) or ISO instants,
depending on whether the field is a calendar rule or a moment — the schema says
which.

## Rate limits

| Bucket                 | Default    | Keyed on             |
| ---------------------- | ---------- | -------------------- |
| authenticated API      | 300 / min  | user                 |
| public booking surface | 60 / min   | IP                   |
| availability search    | 120 / min  | IP                   |
| booking confirmation   | 15 / min   | IP                   |
| credentials            | 10 / 5 min | IP + submitted email |

Responses carry `X-RateLimit-Limit`, `-Remaining`, `-Reset`; a `429` also
carries `Retry-After`.

## Error codes

`VALIDATION_FAILED` · `UNAUTHENTICATED` · `INVALID_CREDENTIALS` · `TOKEN_EXPIRED`
· `TOKEN_INVALID` · `TOKEN_REVOKED` · `FORBIDDEN` · `PERMISSION_DENIED` ·
`NOT_FOUND` · `CONFLICT` · `ALREADY_EXISTS` · `SLOT_UNAVAILABLE` ·
`RESOURCE_UNAVAILABLE` · `CAPACITY_EXCEEDED` · `POLICY_VIOLATION` ·
`INVALID_STATE_TRANSITION` · `IDEMPOTENCY_KEY_REUSED` ·
`IDEMPOTENCY_IN_PROGRESS` · `RATE_LIMITED` · `DEPENDENCY_UNAVAILABLE` ·
`INTERNAL_ERROR`

Codes are stable and additive — clients should switch on `code`, never on
`message`.

## Postman

`docs/postman/MeetFlow.postman_collection.json` is generated from the same
OpenAPI document. Set `baseUrl`, run the login request, and the collection
captures `accessToken` and `businessId` for everything else.

Regenerate both after any API change:

```bash
npm --workspace server run contracts:export
```
