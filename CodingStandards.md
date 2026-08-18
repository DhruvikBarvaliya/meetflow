# Coding Standards

Rules that exist because breaking them has actually caused a bug in this
codebase, not because a linter suggested them.

## TypeScript

Strict mode, everywhere. `any` is an ESLint **error**, not a warning. Use
`unknown` and narrow, or define the type.

`noUncheckedIndexedAccess` is on: `array[0]` is `T | undefined`. Handle it.

`import type` for type-only imports — enforced by
`@typescript-eslint/consistent-type-imports`.

## Layering

```
controller  →  service  →  model
```

- **Controllers contain no business rules.** If a controller has an `if` about
  domain state, it belongs in a service.
- **Services never import Express.** That is what lets jobs, sockets and tests
  call them directly. A service takes plain arguments and returns plain data.
- **`businessId` is a service's first parameter.** Not a request, not a context
  object. It makes an unscoped query visually obvious in review.

## Tenant scoping

Every query — find, count, update, destroy — filters by `businessId`.

Read it from `tenantOf(req)`, never from the body, query or a header.

```ts
// wrong — Sequelize DROPS undefined keys, so this silently queries every tenant
where: { id, businessId: req.tenant?.businessId }

// right — throws if requireTenant did not run
const { businessId } = tenantOf(req);
where: { id, businessId }
```

Cross-tenant misses return `NotFoundError`, never `ForbiddenError`. A 403
confirms the record exists.

## Transactions

- Anything spanning more than one table runs in `sequelize.transaction`.
- Audit records and notification outbox rows go **inside** the transaction they
  describe.
- Real-time events and webhooks are emitted **after** the commit.

**Catching a constraint violation inside a transaction requires a SAVEPOINT.**
In PostgreSQL a failed statement aborts the whole transaction; the `catch`
succeeds, execution continues, and the eventual `COMMIT` silently becomes a
`ROLLBACK`. This cost real debugging time here.

```ts
// wrong — poisons the caller's transaction; the whole booking is discarded
try {
  await Row.create(values, { transaction });
} catch (e) {
  if (isDuplicate(e)) return null;
  throw e;
}

// right — only the savepoint rolls back
try {
  await sequelize.transaction({ transaction }, (sp) => Row.create(values, { transaction: sp }));
} catch (e) {
  if (isDuplicate(e)) return null;
  throw e;
}
```

## Time

- An **instant** is a `Date` / `timestamptz`, always UTC.
- A **wall-clock rule** is minutes-from-local-midnight plus an IANA zone.
- Convert only through `utils/time.ts`. Manual offset arithmetic is banned.
- `addMinutes` is exact elapsed time — correct for durations, wrong for moving a
  recurring rule.
- Overlap tests are half-open `[start, end)`, matching the database.

## Errors

- Throw an `AppError` subclass with a stable `ErrorCode`. Never `throw new Error`
  for something a client should see.
- Never let a database message, constraint name, SQL fragment or stack trace
  reach a response. `errorHandler` is the only place that shapes an HTTP error.
- Translate integrity violations into domain errors **in the service**, so
  non-HTTP callers get the same meaningful failure.

## Validation

Every route uses `validate({ body, params, query })`. Object bodies use
`.strict()` so an unexpected field is a loud 422 rather than a silently ignored
privilege-escalation attempt.

Validation belongs at the boundary; services may assume their inputs are shaped.

## Async

Every async route handler is wrapped in `asyncHandler`. Express 4 does not catch
rejected promises — an unwrapped handler hangs the request instead of reaching
the error middleware.

## Logging

- `createLogger('component')`, never `console`.
- Secrets are redacted centrally; do not add a call site that assumes otherwise.
- Log objects, not interpolated strings: `log.info({ appointmentId }, 'booked')`.
- Errors go under the `err` key so the serializer picks them up.

## Naming

- Files: `camelCase.ts`; React components `PascalCase.tsx`.
- Modules: `<domain>.{validation,service,controller,routes}.ts`.
- Sequelize associations always declare an explicit `as` — pluralisation
  guesswork ends up in `include` clauses and in the JSON the API returns.
- Booleans read as assertions: `isBookable`, `requiresApproval`, `isBlocking`.

## Comments

Explain **why**, never **what**.

```ts
// bad
// increment the booked count
appointment.bookedCount += 1;

// good
// Row-locked above: two customers claiming the last place must serialise here,
// because an exclusion constraint cannot express "at most N".
```

Comment the non-obvious: a denormalised column, a deliberate 404, a savepoint, a
constraint name, an ordering that matters. Delete comments that restate code.

## Tests

- Unit tests for anything pure — the scheduling engine has no excuse for a
  database.
- Integration tests for anything whose guarantee lives in PostgreSQL:
  constraints, transactions, concurrency, tenant scoping.
- Assert the **consequence**, not the mechanism: "the old slot is bookable
  again", not "`update` was called".
- Never weaken an assertion to make a test pass. If a test fails, either the
  code is wrong or the test is; decide which, fix that, and keep the coverage.

## Frontend

- No fake or placeholder metrics, ever. Every number on screen comes from a real
  API response.
- Design tokens, not hard-coded colours; both themes must work.
- Accessible by default: real labels, keyboard paths, visible focus, contrast.
- Loading, empty and error states are part of the feature, not a follow-up.
- Optimistic updates only where a failure is safely reversible.

## Quality gates

Before commit: `format`, `lint`, `typecheck`, unit tests, secret scan.
Before push: add integration tests, both builds, and migration validation.

`--no-verify` is not a workflow. If a hook fails, fix the cause.
