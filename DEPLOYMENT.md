# Deployment

MeetFlow deploys as three stateless processes plus two managed data stores.

| Process | Command                    | Scaling                |
| ------- | -------------------------- | ---------------------- |
| API     | `node dist/server.js`      | horizontal; stateless  |
| Worker  | `node dist/worker.js`      | horizontal; stateless  |
| Client  | static bundle behind nginx | CDN or any static host |

| Store         | Notes                                                     |
| ------------- | --------------------------------------------------------- |
| PostgreSQL 16 | source of truth; needs `pgcrypto`, `btree_gist`, `citext` |
| Redis 7       | cache, rate limits, locks, queues, socket adapter         |

## Build

```bash
docker build -f docker/server.Dockerfile --target production -t meetflow-server:$TAG .
docker build -f docker/client.Dockerfile --target production -t meetflow-client:$TAG .
```

The client bundle is built with `VITE_API_BASE_URL` and `VITE_SOCKET_URL` baked
in at build time — a client image is therefore environment-specific.

## Configuration

Start from `.env.production.example`. Supply values through your platform's
secret manager; never bake them into an image.

Production configuration is validated at boot and the process **refuses to
start** if any of the following is true:

- `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET` is shorter than 32 characters,
  still contains a placeholder, or the two are equal
- `SEED_ENABLED=true`
- `RATE_LIMIT_ENABLED=false`
- `LOG_PRETTY=true`
- any CORS or socket origin is `*` or `http://`

This is deliberate: each of those quietly turns a hardened deployment into an
open one, and failing fast at boot is better than discovering it in an incident.

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Behind a load balancer set `TRUST_PROXY=true`, otherwise every per-IP rate limit
collapses onto the proxy's address.

## Release order

```
1. migrate    docker run --rm <server-image> npx sequelize-cli db:migrate
2. deploy API + worker  (rolling)
3. deploy client
```

Migrations run as a separate step, never on application boot. Two reasons:
several API instances starting at once would race, and a failed migration should
stop a release rather than crash-loop a fleet.

In production the API additionally refuses to start if `sequelize_meta` is
missing, so "someone forgot to migrate" surfaces at boot rather than as the
first 500.

Write migrations to be backwards compatible with the currently running version
(add columns nullable, backfill, then tighten in a later release) so a rolling
deploy never has old code meeting new schema it cannot handle.

## Health and orchestration

| Endpoint  | Use       | Behaviour                                                                     |
| --------- | --------- | ----------------------------------------------------------------------------- |
| `/health` | liveness  | never touches a dependency — a database blip must not kill healthy pods       |
| `/ready`  | readiness | 200 `ready`, 200 `degraded` (Redis down), 503 `unavailable` (PostgreSQL down) |

`degraded` intentionally still returns 200: caching, rate limiting and queues
degrade gracefully, so the instance can serve correct traffic without Redis.

Shutdown is graceful on `SIGTERM`: stop accepting connections, drain in-flight
requests (15s budget), then close sockets, queues, database and Redis. Give the
orchestrator a `terminationGracePeriodSeconds` above 20.

## Worker

Run at least one worker. Without it, bookings still succeed but emails,
reminders and webhooks queue indefinitely.

`RUN_WORKER_IN_API` must stay `false` in production — it exists only so local
development can run one process.

Repeatable jobs use fixed `jobId`s, so scaling workers does not duplicate the
schedule.

## Backups

- PostgreSQL: point-in-time recovery. It holds everything that matters.
- Redis: not a backup target. Losing it delays queued work; the outbox sweep
  re-enqueues anything whose job was lost.

## Scaling notes

- API and worker hold no business-critical in-memory state.
- Socket.IO uses the Redis adapter, so any instance can serve any socket.
- Set `DB_POOL_MAX` with the total in mind: `instances × pool ≤ database limit`.
- The expensive read is availability search; it is bounded by
  `AVAILABILITY_MAX_RANGE_DAYS` and `AVAILABILITY_MAX_SLOTS` and rate limited.

## Rollback

Application rollback is a redeploy of the previous image.

Schema rollback is not automatic. `db:migrate:undo` exists and every migration
has a `down`, but a rollback that drops a column loses data. Prefer rolling
forward with a corrective migration.

## Before going live

- [ ] Real, distinct JWT secrets from a secret manager
- [ ] `DB_SSL=true`, TLS to Redis (`rediss://`)
- [ ] `TRUST_PROXY=true` behind the load balancer
- [ ] Exact https origins in `CORS_ORIGINS` and `SOCKET_ORIGIN`
- [ ] `EMAIL_PROVIDER=smtp` with verified sender and SPF/DKIM
- [ ] `SEED_ENABLED=false`
- [ ] Migrations applied
- [ ] At least one worker running
- [ ] Backups and PITR verified by an actual restore
- [ ] Log aggregation collecting the JSON stream
- [ ] Alerts on `/ready`, notification `FAILED` count, and queue depth
- [ ] `/api/docs` gated or disabled (see the known gaps in
      `docs/SecurityThreatModel.md`)
