# Changelog

Notable changes to MeetFlow. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver once the
first release is cut.

## [Unreleased]

### Added

**Foundation**

- Repository scaffold: npm workspaces (`server`, `client`, `e2e`), strict
  TypeScript, ESLint, Prettier, EditorConfig, dependency-free secret scanner.
- Startup configuration validation that refuses to boot on invalid settings, with
  extra production guards (placeholder secrets, seeds enabled, rate limiting off,
  pretty logging, non-HTTPS origins).
- Structured logging (pino) with central redaction of credentials and tokens.
- Docker compose stack for PostgreSQL and Redis with configurable host ports.

**Database**

- 9 migrations creating 42 tables, with `pgcrypto`, `btree_gist` and `citext`.
- GiST exclusion constraints on `appointment_staff` and `appointment_resources`
  that make double-booking impossible at the database level.
- 42 Sequelize models and a complete association graph.
- Schema-parity test suite comparing every model against `information_schema`.

**Scheduling**

- DST-safe time layer: wall-clock rules stored as minutes + IANA zone, with
  explicit detection of nonexistent (spring-forward) and ambiguous (fall-back)
  local times.
- Pure slot engine: grid alignment, buffers, minimum notice, booking horizon,
  conflict skipping, group capacity, truncation reporting and an explain mode.
- Availability service resolving business hours, staff rules, overrides,
  holidays and blackouts across multiple timezones.
- Smart Match: deterministic, explainable provider ranking.

**Booking**

- Atomic booking with durable idempotency keys, advisory locks, live
  re-validation, database exclusion constraints and row-locked group capacity.
- Create-or-join semantics for group sessions with a single-retry race recovery.
- Resource reservation with per-candidate savepoints.
- Full lifecycle: reschedule, cancel, approve, reject, check-in, complete,
  no-show — with an explicit transition table and immutable history.

**Platform**

- JWT auth with rotating opaque refresh tokens and family-wide reuse detection.
- Permission-based RBAC with four built-in roles and per-member GRANT/DENY
  overrides.
- Tenant isolation derived from membership, with 404-not-403 semantics.
- Append-only audit log with actor, tenant, entity and request correlation.
- Transactional notification outbox with reminders, retries and a recovery sweep.
- BullMQ queues, worker process and periodic maintenance jobs.
- Authenticated Socket.IO with membership-derived rooms and a worker→API bridge.
- Public booking API, waitlist, analytics and CSV reporting.
- OpenAPI 3.0 document and Postman collection generated from the same zod
  schemas that validate requests. CI regenerates both and fails on any diff, so
  the count here is deliberately not restated — a hand-maintained figure is
  exactly the kind of claim that goes stale unnoticed.
- Deterministic development seed data for a complete demo workspace.
- Production Dockerfiles for the API, worker and client.

**Operating surfaces**

- **Platform administration** (`/api/v1/admin`, `/admin` in the client): the
  tenant register, the account register, a cross-workspace audit feed and
  dependency health. Not tenant-scoped, and shaped so it cannot return customer
  data.
- **Memberships** (`/api/v1/members`): invite by email, accept, change role,
  remove, and per-member GRANT/DENY permission overrides. Until this landed, a
  workspace could not gain a second member without editing the database by hand,
  which left three of the four roles unreachable.
- **Tenant audit trail** (`/api/v1/audit-logs`): a business can read its own
  trail, filtered and paginated. Eighteen services had been writing rows that
  only a platform operator could read.
- **Webhooks** (`/api/v1/webhooks`): endpoint management, a signed test send,
  delivery history, and the fan-out wired into the appointment lifecycle. The
  delivery machinery already existed and had no caller; this makes it reachable.
- **Customer portal** (`/api/v1/me`): a customer signs in and sees their own
  bookings across every workspace that knows them, and can cancel or reschedule
  through the same lifecycle service every other surface uses.
- **CI**: the repository's own `verify` gate, a contract-drift check, end-to-end
  tests, image builds and the secret scanner, all on every push.

### Fixed

- **Group bookings silently rolled back.** Catching a duplicate-key error inside
  a transaction left PostgreSQL's transaction aborted, so the commit became a
  rollback with no error raised. Notification and resource writes that swallow
  constraint violations now run inside SAVEPOINTs.
- **Every tenant-scoped route returned 404.** A `required: true` on a nested
  include promoted the permission-override LEFT JOIN to an INNER JOIN, excluding
  every member without overrides. Covered by `tests/integration/tenancy.test.ts`.
- **Migrations failed on constraint names.** Table-level constraints named
  `<table>_<column>_check` collided with the names PostgreSQL generates for
  inline column checks.
- **Test runs migrated the development database.** The sequelize-cli `test`
  environment fell back to `DATABASE_URL`; it now honours only
  `TEST_DATABASE_URL`.
- **Seeders were never discovered.** sequelize-cli v6 finds `.cjs` migrations but
  only `.js` seeders.
- **Access tokens could be byte-identical.** Two tokens minted for one user in
  the same second were indistinguishable; a `jti` claim now makes each unique.

### Security

- `/api/docs` is no longer mounted in production, where it would have
  enumerated the management surface without authentication.
- **HTML injection into outgoing email.** The escaping pass ran on an
  already-substituted body, so it escaped placeholders that no longer existed
  and then interpolated the values raw into markup. A customer's own first name,
  typed into a public booking form, reached the recipient as live HTML.
- **Password spraying was unthrottled.** The credential bucket keyed on
  `IP|email`, so one host trying one password against many accounts spent a
  single point in each of many separate buckets and was never refused. A per-IP
  bucket now sits in front of it, and credential buckets alone fail closed.
- **Sockets survived "log out everywhere".** The handshake re-read the user and
  membership but never the token family, so a revoked session kept receiving
  live workspace events until its access token expired.
- **A production deploy on defaults sent no email at all**, while marking every
  confirmation and reminder as sent. The console transport is now refused in
  production, alongside the existing guards.
- **Account lockout never escalated.** Eight failures bought fifteen minutes and
  reset the counter, so every fifteen minutes bought eight more indefinitely.

### Known gaps

Tracked honestly in [docs/SecurityThreatModel.md](docs/SecurityThreatModel.md):
no bot challenge on public booking, no SSRF protection on webhook targets,
email verification not enforced, no MFA, webhook signing secrets stored in
plaintext, and no automated dependency/container scanning in CI.
