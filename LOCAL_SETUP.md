# Local Setup

## Prerequisites

- Node ≥ 20.11 and npm ≥ 10
- Docker (for PostgreSQL and Redis)
- Git

No local PostgreSQL or Redis install is needed — the compose file provides both.

## First run

```bash
git clone <repo> && cd meetflow
npm install

cp .env.example .env
npm run infra:up                          # PostgreSQL + Redis containers

npm --workspace server run db:migrate
SEED_ENABLED=true npm --workspace server run db:seed

npm run dev                               # API :4000, worker, client :5173
```

Verify:

```bash
curl localhost:4000/health
curl localhost:4000/ready
```

## Port conflicts

If your machine already runs PostgreSQL or Redis, the containers will be
shadowed by the local service and you will see
`password authentication failed for user "meetflow"`.

Fix it in `.env` — the compose file reads these:

```bash
POSTGRES_HOST_PORT=15432
REDIS_HOST_PORT=16379
DATABASE_URL=postgres://meetflow:meetflow@localhost:15432/meetflow_dev
DB_PORT=15432
REDIS_URL=redis://localhost:16379
```

Then recreate the containers so the new mapping takes effect:

```bash
docker compose up -d --force-recreate postgres redis
```

Check what is actually published with `docker compose ps`.

## Everyday commands

| Command                           | Does                                           |
| --------------------------------- | ---------------------------------------------- |
| `npm run dev`                     | API + worker + client with hot reload          |
| `npm run dev:server`              | API only                                       |
| `npm run dev:worker`              | worker only                                    |
| `npm run typecheck`               | strict TypeScript, server + client             |
| `npm run lint` / `lint:fix`       | ESLint                                         |
| `npm run format`                  | Prettier                                       |
| `npm test`                        | server unit + integration                      |
| `npm run test:e2e`                | Playwright                                     |
| `npm run verify`                  | format check → lint → typecheck → test → build |
| `npm run infra:up` / `infra:down` | start / stop PostgreSQL + Redis                |

Database:

| Command             | Does                                          |
| ------------------- | --------------------------------------------- |
| `db:migrate`        | apply pending migrations                      |
| `db:migrate:status` | show what has run                             |
| `db:migrate:undo`   | roll back the last migration                  |
| `db:seed`           | load demo data (requires `SEED_ENABLED=true`) |
| `db:reset`          | undo all → migrate → seed                     |

## Tests

Unit tests need nothing running:

```bash
npm --workspace server run test:unit
```

Integration tests need PostgreSQL. They use a **separate** `meetflow_test`
database, created by `docker/postgres/init/01-create-test-database.sql` on first
volume initialisation, and migrate it from empty on every run — so they also
continuously prove that migrations apply cleanly from scratch.

```bash
npm --workspace server run test:integration
```

They never touch `meetflow_dev`: the sequelize-cli `test` environment ignores
`DATABASE_URL` entirely and only honours `TEST_DATABASE_URL`.

If the test database is missing (an older volume), create it once:

```bash
docker exec meetflow-postgres psql -U meetflow -d postgres \
  -c "CREATE DATABASE meetflow_test OWNER meetflow;"
```

## Emails in development

`EMAIL_PROVIDER=console` renders every message into the structured log instead
of sending it. The notification row is still written, claimed by the worker and
transitioned to `SENT`, so the whole pipeline is exercised — you just read the
email in your terminal.

To test real delivery, set `EMAIL_PROVIDER=smtp` and the `SMTP_*` values
(Mailpit or Mailhog on localhost works well).

## Resetting everything

```bash
docker compose down -v          # also deletes the database volume
npm run infra:up
npm --workspace server run db:migrate
SEED_ENABLED=true npm --workspace server run db:seed
```

## Troubleshooting

**`Invalid environment configuration — refusing to start`**
The startup validator lists exactly which variables are wrong. This is
intentional: MeetFlow will not boot on a half-configured environment.

**`Migration table sequelize_meta is missing`**
Production-only guard. Run `db:migrate` before starting the API.

**Every tenant-scoped request returns 404**
The `X-Business-Id` header names a workspace you are not an ACTIVE member of, or
you have several memberships and sent no header. `GET /api/v1/auth/me` lists the
workspaces you belong to.

**Redis errors in the log but requests still work**
Expected. Caching, rate limiting and queues degrade gracefully; `/ready` will
report `degraded`. Booking correctness does not depend on Redis.
