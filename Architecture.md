# Architecture

## Shape

A modular monolith. One deployable API, one worker, one SPA, one database.
Microservices were rejected deliberately: the hardest problems here — booking
concurrency and tenant isolation — are _easier_ inside a single transactional
boundary, and splitting them across services would trade a solved problem for a
distributed one.

```
                    ┌──────────────┐
   browser ────────►│  React SPA   │
                    └──────┬───────┘
                           │ REST + WebSocket
                    ┌──────▼───────┐        ┌──────────────┐
                    │  Express API │◄──────►│    Redis     │
                    └──────┬───────┘        │ cache, locks │
                           │                │ queues, adapter
                    ┌──────▼───────┐        └──────▲───────┘
                    │  PostgreSQL  │               │
                    │ source of    │        ┌──────┴───────┐
                    │ truth        │◄───────│    Worker    │
                    └──────────────┘        │ email, hooks │
                                            └──────────────┘
```

The API and the worker share the same code and models but never the same
process in production: a burst of reminder emails must not slow down a customer
trying to book.

## Layers

```
route         path, method, middleware chain
  ↓
validate      zod schema — coercion and rejection happen once, at the boundary
  ↓
authenticate  who is calling
  ↓
requireTenant which workspace (from membership, never from input)
  ↓
requirePermission  may they do this here
  ↓
controller    thin: read validated input, call service, shape response
  ↓
service       all business rules; takes businessId as its first argument;
              never imports Express
  ↓
model         Sequelize; PostgreSQL holds the invariants
```

Two rules keep this honest:

- **Controllers contain no business rules.** If a controller has an `if` about
  domain state, it belongs in a service.
- **Services never import Express.** That is what lets jobs, sockets and tests
  call them directly.

## Where correctness lives

| Concern                 | Enforced by                                    | Not by                |
| ----------------------- | ---------------------------------------------- | --------------------- |
| No double booking       | PostgreSQL exclusion constraints               | application checks    |
| Group capacity          | row lock + CHECK constraint                    | optimistic counting   |
| Tenant isolation        | membership-derived `businessId` on every query | client-supplied ids   |
| Idempotency             | unique `(scope, key)` row                      | Redis alone           |
| Notification durability | outbox row in the same transaction             | fire-and-forget sends |
| Timezone correctness    | IANA zone + Luxon resolution                   | stored offsets        |

The pattern is consistent: the database enforces anything whose violation would
corrupt state; the application layer exists to give a good error before it gets
that far.

## Pure core

The scheduling engine (`slotEngine.ts`, `smartMatch.ts`) performs no I/O and
reads no clock — `now` is a parameter. Everything subtle about buffers, DST,
notice periods, grid alignment and ranking is therefore testable in
milliseconds, without a database. `availability.service.ts` is the only part
that touches Sequelize, and its job is purely to load configuration and resolve
wall-clock rules into instants.

## Module layout

Each domain module is a folder of four files:

```
modules/<domain>/
  <domain>.validation.ts   zod schemas — the contract
  <domain>.service.ts      business rules
  <domain>.controller.ts   HTTP glue
  <domain>.routes.ts       router, guards, rate limits
```

Routers are mounted centrally in `routes/index.ts`, where the guard chain is
applied to the _router_ rather than to each route, so a new endpoint cannot ship
unauthenticated by omission.

## Two API surfaces

- `/api/v1/public/*` — unauthenticated. Tenant comes from a validated booking
  link slug. Tight per-IP limits, opaque identifiers only, terminated by its own
  404 handler so nothing falls through into the authenticated chain.
- `/api/v1/*` — authenticated and tenant-scoped. Unknown paths answer 401 rather
  than 404, so the endpoint list is not enumerable.

## Integration boundaries

External systems sit behind ports, so the core never depends on a vendor:

- `EmailProvider` — `console` and `smtp` adapters today.
- Webhooks — HMAC-signed outbound delivery with retries and auto-disable.
- Calendar sync — deliberately _not_ stubbed (see ADR-0009). The booking engine
  is kept free of vendor coupling so an adapter can be added without touching it.

## Failure behaviour

| Dependency down | Effect                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------- |
| Redis           | slower; no real-time; per-process rate limits; notifications delayed. Booking still correct. |
| Worker          | bookings succeed; emails and webhooks queue until a worker returns.                          |
| PostgreSQL      | `/ready` fails and the instance is pulled from the load balancer.                            |
| Mail provider   | notifications retry with backoff, then land in `FAILED` with the error kept.                 |

## Scaling

- API and worker are stateless and horizontally scalable.
- No global in-memory state for anything business-critical — rate limits, locks
  and socket fan-out all go through Redis.
- Socket.IO uses the Redis adapter; the worker reaches sockets through a Redis
  bridge that each API instance re-emits locally exactly once.
- The hot paths (availability search, calendar queries, dashboards) are bounded
  and indexed; every list endpoint is paginated.
