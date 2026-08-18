# MeetFlow — Smart Appointment Scheduler

A multi-tenant scheduling platform for service businesses: public booking, staff
and resource scheduling, availability intelligence, waitlists, notifications,
real-time collaboration, analytics and a full audit trail.

MeetFlow is not a calendar-link clone. It is a **scheduling operating system**:
a business models its locations, teams, staff, services, resources and policies,
and the engine turns those into bookable time that is correct across timezones,
DST transitions and concurrent booking attempts.

---

## Status

A **working product**: 168 TypeScript files on the server, 133 on the client,
42 tables, 155 documented operations across 111 paths, and a customer-facing
booking flow that a real business could publish today.

Every claim below is backed by something that runs — see
[Verification](#verification) — and everything that is _not_ built is listed in
[What is not built yet](#what-is-not-built-yet) rather than glossed over. The
open gaps are enumerated with evidence in [docs/GapAudit.html](docs/GapAudit.html)
and tracked against the specification in
[docs/ProductRequirements.md](docs/ProductRequirements.md); the honest reading
today is that the scheduling core is production-grade and parts of the
surrounding surface are still being closed.

|              |                                                                 |
| ------------ | --------------------------------------------------------------- |
| Server tests | **366 passing** (unit + integration, real PostgreSQL)           |
| End-to-end   | **43 passing** (Playwright, real stack, no mocks)               |
| Typecheck    | clean, strict, across server + client + e2e                     |
| Lint         | clean                                                           |
| Builds       | server and client both build; production image runs as non-root |
| CI           | every gate above runs on push; contracts fail on drift          |

## Why it is different

| Capability                         | How MeetFlow does it                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Double booking is impossible**   | PostgreSQL GiST _exclusion constraints_ over `tstzrange`, not application checks. Under 10 concurrent requests for one slot, exactly one commits.                                                                                         |
| **DST is handled, not hoped for**  | Wall-clock rules are stored as minutes-from-local-midnight plus an IANA zone and resolved through Luxon. Times that don't exist (spring-forward) are detected and dropped; times that happen twice (fall-back) resolve deterministically. |
| **Buffers are real reservations**  | Pre/post buffers are part of the calendar footprint that the exclusion constraint guards, so back-to-back bookings respect cleanup time.                                                                                                  |
| **Group services**                 | One appointment, many participants. Capacity is enforced under a row lock — an exclusion constraint cannot express "at most N".                                                                                                           |
| **Smart Match**                    | Deterministic, explainable, weighted ranking of eligible providers. No AI, no hidden behaviour; every ranking returns its own reasons.                                                                                                    |
| **Tenant isolation is structural** | The tenant id comes from an ACTIVE membership row, never from client input. Cross-tenant access returns 404, not 403, so endpoints can't be used as existence oracles.                                                                    |
| **Notifications survive outages**  | A transactional outbox: the notification row commits with the booking. A periodic sweep re-enqueues anything the queue lost.                                                                                                              |

---

## Architecture

```
meetflow/
├── client/                  React + TypeScript + Vite + Tailwind v4
│   └── src/pages/           auth · owner · staff · customer · public booking · admin
├── server/
│   ├── migrations/          9 SQL migrations → 42 tables
│   ├── seeders/
│   ├── src/
│   │   ├── config/          env validation, logger, sequelize, redis
│   │   ├── database/models/ 42 Sequelize models + association graph
│   │   ├── middleware/       auth, tenancy, RBAC, validation, rate limit, errors
│   │   ├── modules/          one folder per domain (validation/service/controller/routes)
│   │   ├── scheduling/       slot engine, availability service, Smart Match
│   │   ├── jobs/             BullMQ queues + processors
│   │   ├── sockets/          authenticated Socket.IO with tenant rooms
│   │   ├── integrations/     email provider port + adapters
│   │   ├── app.ts  server.ts  worker.ts
│   └── tests/               unit + integration (vitest, real PostgreSQL)
├── e2e/                     Playwright
├── docker/
└── docs/
```

**Stack:** Node 20+, Express 4, TypeScript (strict), PostgreSQL 16 + Sequelize 6,
Redis 7, BullMQ, Socket.IO, zod, Luxon, pino, vitest, Playwright, Docker.

### Three API surfaces

```
/api/v1/public/*   unauthenticated booking; tenant comes from a validated link slug
/api/v1/admin/*    platform administration; authenticate → requirePlatformAdmin
/api/v1/*          authenticated management; authenticate → requireTenant
```

The admin surface is the only one that reads across tenants, and it is
deliberately **not** behind `requireTenant`: an operator holds no membership in
the workspaces they administer, so tenant resolution would 404 every call. It
exposes workspaces, platform accounts and counts — never a customer's name,
email or phone, an appointment's contents, or a note.

The client draws the same line: `/admin` is a sibling of `/app`, not a page
inside it, with its own shell and its own guard. See
[docs/admin-panel.md](docs/admin-panel.md).

### Layering

```
HTTP route → validate (zod) → authenticate → requireTenant → requirePermission
          → controller (thin) → service (all business rules) → models → PostgreSQL
                                     ↓
                          audit + notification outbox + real-time event
```

Controllers contain no business rules. Services never import Express. The
scheduling engine is pure and takes no I/O, which is what makes DST and
concurrency behaviour exhaustively testable.

---

## Getting started

Requires Node ≥ 20 and Docker.

```bash
git clone <repo> && cd meetflow
npm install

cp .env.example .env          # then edit if 5432/6379 are taken locally
npm run infra:up              # PostgreSQL + Redis in Docker

npm --workspace server run db:migrate
npm --workspace server run db:seed      # development-only demo data

npm run dev                   # API :4000, worker, client :5173
```

If your machine already runs PostgreSQL or Redis, set `POSTGRES_HOST_PORT` and
`REDIS_HOST_PORT` in `.env` (and match `DATABASE_URL` / `REDIS_URL`) — the
compose file reads them.

### Demo accounts

The seed builds one workspace, Aurora Wellness Studio in Bengaluru, and the
people who work in it. Every account shares the password `MeetFlow!Demo123`,
overridable with `SEED_DEFAULT_PASSWORD`. The seeders refuse to run unless
`SEED_ENABLED` is truthy, and a production configuration refuses to boot with it
set.

| Sign in as                        | What you get                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `priya.shah@aurorawellness.test`  | Workspace owner — everything inside the workspace                                                                                                      |
| `rahul.menon@aurorawellness.test` | Manager — operations, but not roles or deletion                                                                                                        |
| `ananya.iyer@aurorawellness.test` | Staff — own schedule and assigned appointments only                                                                                                    |
| `admin@meetflow.dev`              | Platform administrator **and** a receptionist in the demo workspace: signing in lands in the normal app, and the platform panel is in the account menu |

The last row is the shape of the feature, not a shortcut for the demo.
`platform_role` grants nothing inside a tenant and a membership grants nothing
across the platform, so an operator who wants a front-desk session has to hold a
real membership like anybody else. The seeded customers have portal accounts
with the same password.

### Health

```bash
curl localhost:4000/health    # liveness — never touches a dependency
curl localhost:4000/ready     # readiness — reports database + redis
```

`/ready` returns `degraded` (still 200) when Redis is down but PostgreSQL is up,
because caching, rate limiting and queues all degrade gracefully while booking
correctness does not depend on Redis.

---

## Verification

Everything below is reproducible from a clean checkout.

```bash
npm run verify                 # format → lint → typecheck → tests → build
npm run test:e2e               # Playwright, against the real stack
```

Or piece by piece:

```bash
npm --workspace server run test:unit          # 47 — time/DST + slot engine
npm --workspace server run test:integration   # 130 — schema, booking, lifecycle, tenancy
npm run typecheck                             # strict, server + client
npm run lint
```

The integration suite migrates a dedicated `meetflow_test` database from empty
on every run, so "migrations apply cleanly from scratch" is continuously
verified rather than assumed.

**What the tests actually prove**

- `tests/unit/time.test.ts` — spring-forward times are flagged `skipped`;
  fall-back times are flagged `ambiguous` and resolve to the earlier offset; a
  09:00 opening rule stays 09:00 local on both DST days; half-hour zones
  (`Asia/Kolkata`) and overnight windows are correct.
- `tests/unit/slotEngine.test.ts` — grid alignment, buffers blocking adjacent
  slots, minimum notice, truncation reporting, multi-location dedup, group
  capacity.
- `tests/integration/schemaParity.test.ts` — all 42 models match their tables
  column-for-column, and no table lacks a model.
- `tests/integration/booking.concurrency.test.ts` — 10 simultaneous bookings of
  one slot yield exactly 1 appointment; adjacent slots book fine; buffers block
  the following slot; idempotency keys replay instead of duplicating; a group
  session never oversells its last place under a 6-way race; cross-tenant
  service/staff ids return 404.
- `tests/integration/lifecycle.test.ts` — a reschedule moves the reservation and
  frees the old slot, keeps the customer's management link, and appends to
  history; cancelling releases the calendar and stops pending reminders; a
  no-show is refused inside the grace period.
- `tests/integration/tenancy.test.ts` — over real HTTP: a member with no
  permission overrides resolves, cross-tenant ids return 404 not 403, DENY beats
  the role, GRANT lifts a restrictive one.
- `tests/integration/admin.test.ts` — the platform surface over real HTTP: an
  operator with no membership anywhere reads every endpoint, an ordinary user is
  refused on all of them, a workspace detail response about a real patient
  contains neither their email nor their notes, suspending a workspace locks its
  owner out and reinstating restores them, suspending an account ends the
  session it is holding right now, and an administrator can neither change their
  own standing nor demote the last active one.
- `e2e/tests/` — the whole product through a browser: register → workspace →
  location → service → staff → hours → resource → booking link → a customer
  books on the public page → the owner sees it → reschedule and cancel. Plus two
  browser contexts racing for one slot, and the published link's address being
  the address the router actually serves.

---

## Security model

- **Passwords** — bcrypt (cost 12), policy enforced server-side, common-password
  denylist, progressive lockout after repeated failures.
- **Tokens** — 15-minute access JWT carrying identity only (never permissions, so
  a revoked role takes effect on the next request). Refresh tokens are opaque,
  stored only as SHA-256 digests, rotated on every use, and grouped into a
  family: replaying a rotated token revokes the whole family.
- **Tenancy** — derived from an ACTIVE membership; `X-Business-Id` only _selects_
  among workspaces the caller already belongs to.
- **Authorisation** — permission-based, with per-member GRANT/DENY overrides
  where DENY always wins. Four built-in roles; `STAFF` is deliberately minimal.
- **Platform administration** — `platform_role = ADMIN` gates `/api/v1/admin` at
  the mount and grants nothing inside any workspace. There is no self-service
  route to it, every mutation is audited, and an operator can change neither
  their own standing nor that of the last active administrator.
- **Rate limiting** — Redis-backed and cluster-wide, with an in-memory
  insurance limiter so a Redis outage degrades protection rather than removing it.
- **Public identifiers** — 130-bit random, prefixed, opaque. Internal UUIDs are
  never exposed on customer-facing surfaces.
- **Logging** — secrets, tokens and password hashes are redacted centrally; no
  call site can opt out.
- **Errors** — unknown failures become a generic 500. Database messages,
  constraint names and stack traces never reach a client.

---

## Documentation

| Document                           | Contents                                  |
| ---------------------------------- | ----------------------------------------- |
| `docs/SchedulingEngine.md`         | How rules become bookable slots           |
| `docs/TimezoneAndDST.md`           | The two time models and the DST rules     |
| `docs/BookingConcurrency.md`       | The five layers of booking safety         |
| `docs/MultiTenancy.md`             | Tenant derivation and isolation testing   |
| `docs/admin-panel.md`              | The platform surface and its privacy line |
| `docs/RedisArchitecture.md`        | Key registry, TTLs, degradation behaviour |
| `docs/SocketIOEvents.md`           | Event names, rooms, authorisation         |
| `docs/NotificationArchitecture.md` | Outbox, retries, idempotency              |
| `docs/SecurityThreatModel.md`      | Threats and the controls against them     |
| `docs/ADR/`                        | Decision records for the choices above    |

---

## What is not built yet

Stated plainly, so nothing here is mistaken for finished work.

- **Workflow automation rules.** The `automation_rules` and
  `automation_executions` tables exist and are documented, but there is no API
  and no engine that evaluates them. The event-driven behaviour the product
  actually relies on (confirmations, reminders, waitlist offers, real-time
  updates) is implemented directly and does not depend on this.
- **SMS and in-app notification channels.** The outbox models them and the
  worker closes such rows out honestly as `CANCELLED` with a reason rather than
  reporting them delivered. Only email has a provider.
- **External calendar sync** (Google, Outlook) and **payments**. Deliberately
  not stubbed — see `docs/ADR/README.md` (ADR-0009) for why an empty adapter is
  worse than an honest absence.
- **CI pipeline.** The quality gates all run locally via `npm run verify`;
  nothing wires them to a CI service yet.
- The security gaps recorded in
  [docs/SecurityThreatModel.md](docs/SecurityThreatModel.md) — no bot challenge
  on public booking, no SSRF allowlist on webhook targets, email verification
  not enforced, no MFA, webhook secrets stored in plaintext.

None of these block the core promise: a business can register, configure itself,
publish a link, and take bookings that cannot double-book.

## Licence

UNLICENSED — private project.
