# Contributing

## Setup

See [LOCAL_SETUP.md](LOCAL_SETUP.md). In short: `npm install`,
`cp .env.example .env`, `npm run infra:up`, `db:migrate`, `db:seed`, `npm run dev`.

## Branching

`develop` is the integration branch; `main` is release. Work on
`feature/<short-name>`, `fix/<short-name>` or `chore/<short-name>` and open a PR
into `develop`.

## Before you commit

```bash
npm run format
npm run lint
npm run typecheck
npm --workspace server run test:unit
npm run secretscan
```

## Before you push

```bash
npm test              # unit + integration (needs PostgreSQL)
npm run build         # server + client
npm run test:e2e      # where practical
```

`npm run verify` chains the important ones.

Do not use `--no-verify`. If a gate fails, fix the cause — a bypassed gate is
how a broken migration reaches someone else's machine.

## What a change looks like

MeetFlow is built in vertical slices. A feature is not done because an endpoint
exists; it is done when it works end to end:

```
migration → model → service → API → validation → OpenAPI → frontend service → UI → tests
```

**When you change an API, change all of it in the same PR:** backend handler,
zod schema, generated OpenAPI + Postman (`npm --workspace server run
contracts:export`), frontend types and calls, tests, and the docs that describe
it. A PR that updates the handler and nothing else will be sent back.

## Tests

- Pure logic → unit test. The scheduling engine takes `now` as a parameter
  precisely so it never needs a database.
- Anything guaranteed by PostgreSQL (constraints, transactions, concurrency,
  tenant scoping) → integration test against the real database.
- Assert the consequence, not the mechanism.
- Never weaken an assertion to get green. Decide whether the code or the test is
  wrong, fix that one, and keep the coverage.

New behaviour ships with a test. A bug fix ships with the regression test that
would have caught it.

## Migrations

- Never edit a migration that has been merged — add a new one.
- Every migration needs a working `down`.
- Write them backwards compatible with the running version (add nullable,
  backfill, tighten later) so a rolling deploy is safe.
- Update the model _and_ run the schema-parity test.
- Seeders are `.js`, migrations are `.cjs` — sequelize-cli only discovers
  seeders with a `.js` extension.

## Code review checklist

- Is every query tenant-scoped?
- Does a cross-tenant miss return 404 rather than 403?
- Is the route's permission the narrowest one that works?
- Are constraint violations caught inside a transaction wrapped in a SAVEPOINT?
- Are events emitted after commit, never inside it?
- Do comments explain _why_?
- Is there a test that fails without this change?

## Security

Do not open a public issue for a vulnerability. Report it privately to the
maintainers. Known, accepted gaps are listed in
[docs/SecurityThreatModel.md](docs/SecurityThreatModel.md) — adding to that list
honestly is preferred over quietly shipping a partial control.
