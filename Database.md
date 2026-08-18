# Database

PostgreSQL 16 is the source of truth. 42 tables across 9 migrations.

## Extensions

| Extension    | Why                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pgcrypto`   | `gen_random_uuid()` for server-side primary keys                                                                                                  |
| `btree_gist` | lets a GiST exclusion constraint combine `=` on a uuid with `&&` on a `tstzrange` — this is what makes genuine double-booking prevention possible |
| `citext`     | case-insensitive emails, so `Ada@x.com` and `ada@x.com` cannot become two accounts                                                                |

## Conventions

- **Primary keys** — `uuid` with `gen_random_uuid()`. Never exposed on public
  surfaces; customer-facing links use opaque `public_id` columns instead.
- **Names** — `snake_case` columns, plural tables. Models use camelCase
  attributes with Sequelize's `underscored: true`.
- **Time** — every instant is `timestamptz`. Wall-clock rules are stored as
  minutes-from-local-midnight plus an IANA zone (see `docs/TimezoneAndDST.md`).
- **Money** — integer minor units (paise, cents) plus a `char(3)` currency.
  Never a float.
- **Enums** — `text` with a `CHECK` constraint rather than a native PostgreSQL
  enum type. Just as safe, far easier to evolve.
- **Soft delete** — `deleted_at` on configuration tables that may be referenced
  by history. Appointments are never deleted: `CANCELLED` / `REJECTED` are real
  lifecycle states that reporting and audit depend on.
- **Uniqueness with soft delete** — partial unique indexes
  (`WHERE deleted_at IS NULL`) so a deleted record releases its slug or email.

### A naming trap worth knowing

Never name a table constraint `<table>_<column>_check`. PostgreSQL generates
exactly that name for inline column `CHECK`s, and the collision fails the
migration. This bit three constraints during development; they are now
`*_scope_target_check`, `*_capacity_limit_check`, and so on.

## Table groups

| Migration                       | Tables                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `…000000-enable-extensions`     | —                                                                                                                                                                                                                                           |
| `…000100-create-identity`       | `users`, `refresh_tokens`, `permissions`                                                                                                                                                                                                    |
| `…000200-create-business`       | `businesses`, `business_settings`, `roles`, `role_permissions`, `memberships`, `membership_permissions`                                                                                                                                     |
| `…000300-create-organisation`   | `locations`, `teams`, `staff_profiles`, `team_members`                                                                                                                                                                                      |
| `…000400-create-catalog`        | `service_categories`, `services`, `service_staff`, `service_locations`, `resources`, `service_resource_requirements`                                                                                                                        |
| `…000500-create-availability`   | `business_hours`, `staff_availability_rules`, `availability_overrides`, `holidays`, `blackout_periods`                                                                                                                                      |
| `…000600-create-booking`        | `customers`, `booking_links`, `booking_link_services`, `appointments`, `appointment_staff`, `appointment_participants`, `appointment_resources`, `appointment_status_history`, `reschedule_history`, `waitlist_entries`, `idempotency_keys` |
| `…000700-create-notifications`  | `notification_templates`, `notifications`, `automation_rules`, `automation_executions`                                                                                                                                                      |
| `…000800-create-audit-webhooks` | `audit_logs`, `webhook_endpoints`, `webhook_deliveries`                                                                                                                                                                                     |

## The constraints that carry the product

### No double booking

```sql
ALTER TABLE appointment_staff
  ADD CONSTRAINT appointment_staff_no_overlap
  EXCLUDE USING gist (
    staff_profile_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (is_blocking);
```

The stored range is the **buffered** window, so preparation and cleanup time are
enforced by the same constraint. `'[)'` makes back-to-back bookings legal.
Cancelling sets `is_blocking = false` — freeing the calendar while keeping the
assignment auditable.

`appointment_resources` carries the equivalent on `resource_id`, predicated on
`is_active AND is_exclusive`. `is_exclusive` mirrors `resources.capacity = 1` at
reservation time; shared resources are counted under a row lock instead, because
an exclusion constraint cannot express "at most N".

### Scope integrity

`availability_overrides` and `blackout_periods` have a `scope` column plus
exactly one populated foreign key. A `CHECK` ties them together, so a row can
never be silently applied to the wrong kind of entity.

### Booking integrity

- `appointments_time_check` — `ends_at > starts_at`
- `appointments_buffer_check` — buffers always bracket the appointment window
- `appointments_capacity_limit_check` — `booked_count <= capacity`
- `appointments_idempotency_unique` — one appointment per `(business_id, key)`

### Tenant integrity

Every tenant-owned table has `business_id` with `ON DELETE CASCADE`. Uniqueness
is scoped to the tenant: `(business_id, email)` for customers,
`(business_id, slug)` for services, locations and resources. Booking-link slugs
are globally unique because they are the public URL path.

## Indexing

Built for the actual access patterns, not speculatively:

| Query                            | Index                                                                    |
| -------------------------------- | ------------------------------------------------------------------------ |
| workspace diary by date          | `(business_id, starts_at)`, `(business_id, status, starts_at)`           |
| a provider's day                 | `(staff_profile_id, starts_at)` partial on not-null                      |
| a customer's history             | `(customer_id, starts_at DESC)`                                          |
| reminder sweep / "starting soon" | `(starts_at)` partial on active statuses                                 |
| public link lookup               | unique `(slug)` partial on not-deleted                                   |
| notification worker claim        | `(scheduled_for)` partial on `status = 'PENDING'`                        |
| waitlist eligibility             | `(service_id, status, earliest_date, latest_date, priority, created_at)` |
| audit browsing                   | `(business_id, created_at DESC)`, `(entity_type, entity_id)`             |
| blackout overlap                 | GiST `(business_id, tstzrange(starts_at, ends_at))`                      |
| customer tags                    | GIN `(tags)`                                                             |

Partial indexes are used heavily: indexing only the active rows keeps the hot
indexes small when most history is terminal.

## Migrations

Authored as plain SQL inside `.cjs` files so constraints and indexes are exact
and reviewable, and so they run in a container with no TypeScript toolchain.

```bash
npm --workspace server run db:migrate
npm --workspace server run db:migrate:status
npm --workspace server run db:migrate:undo
```

Every migration has a working `down`. The integration suite migrates a separate
`meetflow_test` database from empty on every run, so "migrations apply cleanly
from scratch" is verified continuously rather than assumed.

**Seeders must be `.js`, not `.cjs`.** sequelize-cli v6 discovers `.cjs`
migrations but only `.js` seeders — a genuinely surprising asymmetry that
silently reports "No seeders found".

## Model parity

`tests/integration/schemaParity.test.ts` compares every registered model against
`information_schema` and fails on any drift: a column the model does not
declare, an attribute with no backing column, or a nullability disagreement that
would fail at runtime. It also asserts no table lacks a model.

This is what makes it safe to change the schema: forgetting to update a model is
a red test, not a mysterious production error.
