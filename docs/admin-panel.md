# Platform administration

MeetFlow does two jobs, and they belong to different people. A workspace runs
its own diary, customers and catalogue. Somebody else runs the deployment those
workspaces sit on, and answers questions the workspace cannot: is the
notification queue moving, which accounts hold the keys to this installation,
why did that workspace stop taking bookings. The platform admin panel is the
second job and nothing else.

> An operator administers the deployment. They do not work inside a customer's
> business.

## The line it draws

| Platform operations — `/admin`                            | Tenant operations — `/app`                          |
| --------------------------------------------------------- | --------------------------------------------------- |
| Which workspaces exist, how large they are, who owns them | The diary, the customers, the catalogue             |
| Which accounts hold credentials, and their standing       | Members, roles and permissions inside one workspace |
| The audit trail across every workspace, in one ordering   | Its own reports, analytics and exports              |
| PostgreSQL, Redis and the notification outbox             | Booking policy, opening hours, services, pricing    |

Both surfaces are reached with the same account. Platform administration is a
property of a user — `users.platform_role = 'ADMIN'` — not a separate login, and
it grants nothing inside any tenant. The seeded demo operator
(`admin@meetflow.dev`) also holds an ordinary **receptionist** membership in the
demo workspace, so signing in lands in the normal app and the panel is reached
from the account menu. That is the honest shape of the feature: the platform
role opens `/admin`, the membership opens the diary, and neither implies the
other.

## Why it is a separate surface

`/api/v1/admin` is a third router beside the public booking routes and the
authenticated management routes. It is mounted behind
`authenticate → apiRateLimit → requirePlatformAdmin → requireVerifiedEmail`, and
pointedly **not** behind `requireTenant`.

The operator check runs before the verification one on purpose: somebody who is
not an operator is told that and nothing about the state of their own account on
a URL they have no business on. An operator whose own address is unconfirmed is
refused too — it is the highest-value account in the system and the last place
to make an exception.

An operator holds no membership in the workspaces they administer, and tenant
resolution refuses a request without one — with a 404, so it cannot be used to
probe which workspace ids exist. Mounted on the management router, every admin
call would therefore 404. That is the whole reason for the third router, and the
reason a workspace id is an ordinary path parameter here when on the tenant
surface it would be an authorisation hole. The authorisation a membership would
otherwise carry is done in exactly one place instead: the mount.

Three consequences worth knowing:

- The guard sits on the router, not on each route, so an endpoint added later
  cannot ship unguarded. Nothing in `admin.routes.ts` declares its own
  authorisation.
- The surface is terminated by its own 404 handler, so an unknown `/admin` path
  cannot fall through into the management router and answer whatever the
  caller's memberships happen to imply.
- A signed-in user who is not an operator is refused with **403** on every path,
  and the client refuses the whole `/admin` route tree on the same single bit.

## The privacy boundary

This is the part of the design that matters most.

**The admin surface exposes workspaces, platform accounts and counts. It never
exposes customer names, emails or phone numbers, appointment contents, or
notes.** An operator running the platform has no business reading a clinic's
patient list. A support question about a double booking is answered by that
workspace's own owner, inside their own workspace.

The boundary is not a filter, and there is no middleware that strips fields.
Every admin response is assembled by a builder in
`server/src/modules/admin/admin.service.ts` that names each field it emits, so a
column added to `customers` or `appointments` tomorrow cannot arrive in an admin
payload by accident — somebody has to type it out there first, where the
decision is visible in review. A workspace's detail response can say that a
clinic holds two customers and took eleven thousand bookings; it has no field
that could name one of them.

Because a response _shape_ cannot be unit-tested into safety, it is asserted end
to end. `server/tests/integration/admin.test.ts` seeds a workspace that really
does hold a patient record — a real email, a real name, a real note — then
serialises the actual HTTP response and looks for them:

```ts
const serialised = JSON.stringify(response.body);
expect(serialised).not.toContain(PATIENT.email);
expect(serialised).not.toContain(PATIENT.firstName);
expect(serialised).not.toContain(PATIENT.notes);
```

A second test does the same for appointment notes across the workspace detail,
the workspace directory and the overview. If a customer's email ever appears in
a workspace detail response, that test fails, and the failure is not cosmetic:
it means an operator can read a clinic's patient list.

Two related decisions follow the same line:

- A workspace's `recentActivity` carries the action, the entity type and the
  actor, but **not** the audit row's `metadata`. Metadata is written by every
  module in the product, and its contents are the workspace's business.
- `/admin/audit-logs` does return `metadata`, because a forensic feed without it
  answers very little. What keeps that safe is the discipline in the tenant
  modules that write those rows: they record identifiers, changed field _names_
  and flags such as `hasNote` or `hasCustomerNote` rather than the values. The
  trail records that a customer's address changed, not what it changed to. That
  is the one place where the boundary is held by the writer rather than by the
  admin builder, so a new audit call site is where to look if it is ever
  weakened.

## Becoming an administrator

There is deliberately **no self-service route**. Nothing in registration,
invitation or workspace creation can set `platform_role`; request bodies are
`.strict()`, so sending `platformRole` to `/auth/register` is a 422 rather than
a silently accepted field. An administrator is made in exactly two ways:

1. Directly in the database — which is how the first one on a fresh deployment
   is made.
2. By an existing administrator, through the panel
   (`PATCH /admin/users/:id/platform-role`), which writes an audit row.

The first administrator:

```sql
UPDATE users
   SET platform_role = 'ADMIN',
       updated_at    = now()
 WHERE email      = 'operator@example.com'
   AND deleted_at IS NULL;
```

`email` is `citext`, so the match is case-insensitive. `updated_at` is set
explicitly because nothing in the schema maintains it — there is no trigger, the
application does it, and a hand-written statement has to do the same. The
account does not need to sign in again: the access token carries identity only,
and the platform role is re-read from the row on every request.

Who holds it now:

```sql
SELECT email, status, last_login_at
  FROM users
 WHERE platform_role = 'ADMIN' AND deleted_at IS NULL
 ORDER BY email;
```

## The self-protection rules

Three refusals live in the service layer, all answering **409 Conflict**. They
are enforcements rather than conveniences: the panel disables the corresponding
controls, but only so an operator is not offered an action that cannot work.

| Rule                                                    | Why it exists                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| An operator may not change **their own account status** | Suspending yourself locks you out of the only surface that could reinstate you. Nothing in the product can undo it.                       |
| An operator may not change **their own platform role**  | The same shape: an administrator who demotes themselves cannot promote themselves back.                                                   |
| The **last active administrator** may not be demoted    | A deployment with no administrator has no way back in except a hand-written `UPDATE`. This keeps that from being one careless click away. |

The last-admin check is taken inside the transaction that performs the demotion,
over `SELECT … FOR UPDATE` rather than `count(*)` — PostgreSQL refuses row
locking on an aggregate, and an unlocked count is exactly the race the guard
exists to close. Two operators each demoting the other would both read "there is
still another administrator" and both commit. The rows are locked in `id` order
so those two transactions queue instead of deadlocking on each other; the second
re-reads after the first commits, and correctly refuses.

Two things the rules deliberately do **not** cover, because neither is
unrecoverable:

- An operator may demote or suspend a _different_ administrator.
- An administrator whose status is not `ACTIVE` does not count towards the
  last-admin check. Demoting a suspended administrator takes away nothing that
  was there.

## What suspending a workspace does

`PATCH /admin/workspaces/:id/status` moves a workspace between `ACTIVE`,
`SUSPENDED` and `ARCHIVED`, with an optional `reason` stored in the audit row.

| Status      | Effect                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ACTIVE`    | Members work normally; the public booking pages take bookings.                                                           |
| `SUSPENDED` | Every member is refused by the management API on their very next request, and the public booking pages take no bookings. |
| `ARCHIVED`  | Identical enforcement to suspended. It is how a workspace is retired, and the panel offers only reinstatement from it.   |

Both stops are structural rather than a new check. `requireTenant` resolves a
membership by joining through `businesses` with `status = 'ACTIVE'`, and the
public booking service resolves a booking link the same way, so a workspace that
is not active simply stops resolving — within one request, for everybody.

**Nothing is deleted.** No row is removed, no appointment is cancelled, no
membership is touched. Reinstating restores access in full, and everything that
happened while the workspace was out of service is still there. The integration
suite demonstrates exactly that round trip over real HTTP: the owner's request
succeeds, the workspace is suspended, the same request 404s, the workspace is
reinstated, the request succeeds again.

Suspending a workspace notifies nobody. The owner finds out when access stops.

## What suspending an account does

`PATCH /admin/users/:id/status` sets `ACTIVE`, `SUSPENDED` or `DEACTIVATED`.

Suspending or deactivating revokes **every live refresh token** the account
holds, in the same transaction as the status change. Without that the person
keeps a working session until their refresh token happens to expire. The access
token already in their browser dies too — at its very next call rather than at
its fifteen-minute expiry — because `authenticate` re-reads the user row on
every request and refuses `SUSPENDED` and `DEACTIVATED` accounts. Sign-in is
refused from the same moment.

`SUSPENDED` and `DEACTIVATED` do the same thing. The difference is what the next
operator reads: suspended is an account under review, deactivated is one that is
finished with. Both are fully reversible, and neither deletes anything —
memberships, history and audit trail are untouched.

Reinstating does not restore sessions. The account can sign in again, on each
device, from its next attempt.

`INVITED` exists in the schema but is not a status an operator can set. It is a
state the invitation flow puts an account into and that accepting an invitation
takes it out of; set by hand it would produce an account waiting for an
invitation that will never arrive, and nothing in the product would resolve
that.

## Audit

Every mutation on this surface writes an audit row in the same transaction as
the change, with `actorType: 'USER'` and the operator's id and email:

| Action                              | Scope                                  |
| ----------------------------------- | -------------------------------------- |
| `platform.workspace_status_changed` | carries the `businessId` it applies to |
| `platform.user_status_changed`      | `businessId: null`                     |
| `platform.user_role_changed`        | `businessId: null`                     |

The workspace action carries the business id, so it joins that workspace's own
trail and appears in the last twenty rows shown on its detail page here. The two
account actions belong to no tenant, and nothing scoped to a workspace can
surface them.

The trail itself is readable from this surface only: there is no tenant-facing
audit endpoint in the product, and a workspace cannot currently read its own
history.

## Endpoints

All responses use the standard `{ data, meta? }` envelope. List endpoints take
`page` and `pageSize`; `pageSize` is capped at 100, and the client fixes it at 20.

| Method  | Path                             | Returns                                                                                                                          |
| ------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/admin/overview`                | Platform counts, a zero-filled fourteen-day booking series in UTC days, and the five busiest workspaces of the last 30 days      |
| `GET`   | `/admin/workspaces`              | The workspace directory. `search` (name or slug), `status`, `sort` = `newest` \| `oldest` \| `name` \| `appointments`            |
| `GET`   | `/admin/workspaces/:id`          | One workspace: profile, members, appointment mix by status, its last 20 audit rows                                               |
| `PATCH` | `/admin/workspaces/:id/status`   | `{ status, reason? }` → the updated workspace                                                                                    |
| `GET`   | `/admin/users`                   | The account register. `search` (email or name), `status`, `platformRole`, `sort` = `newest` \| `oldest` \| `name` \| `lastLogin` |
| `GET`   | `/admin/users/:id`               | One account: contact fields, lockout state, live session count, every membership                                                 |
| `PATCH` | `/admin/users/:id/status`        | `{ status }` → the updated account                                                                                               |
| `PATCH` | `/admin/users/:id/platform-role` | `{ platformRole }` → the updated account                                                                                         |
| `GET`   | `/admin/audit-logs`              | The trail across every workspace, newest first. `businessId`, `action`, `actorUserId`, `entityType`, `from`, `to`                |
| `GET`   | `/admin/health`                  | Database, Redis, notification outbox and process figures                                                                         |

Behaviour that is easy to assume wrongly:

- An unknown workspace or account id answers **404**, on the `PATCH` routes as
  well as the reads, and for soft-deleted rows too. A workspace that has been
  removed is no longer administrable and must be indistinguishable from one that
  never existed.
- `search` escapes `%` and `_` before it is bound, so searching for `%` finds
  workspaces containing a literal percent sign rather than every workspace on
  the platform.
- `from` and `to` on the audit feed are inclusive calendar dates (`YYYY-MM-DD`)
  cut in UTC inside the statement, so "1 March to 1 March" is the whole of that
  day regardless of how the connection happens to be configured.
- `/admin/health` always answers **200**, even when PostgreSQL is unreachable. A
  503 would take the one page that could explain an outage down with the outage,
  so the state is carried by `database.ok` and `redis.ok` rather than by the
  status code. When PostgreSQL is down the outbox counts degrade to zeros and
  the `database` block carries the real story.
- Nothing on this surface reads `X-Business-Id`. The shared client interceptor
  attaches it to every credentialed call and it rides along harmlessly; there is
  no `requireTenant` here to read it.

## The screens

| Route                   | What it is for                                                                    |
| ----------------------- | --------------------------------------------------------------------------------- |
| `/admin`                | Overview — live counts, the fourteen-day booking series, the busiest workspaces   |
| `/admin/workspaces`     | The tenant register, filterable and sortable                                      |
| `/admin/workspaces/:id` | One workspace seen from outside it, and the lifecycle controls                    |
| `/admin/users`          | The account register — platform accounts, never customers                         |
| `/admin/users/:id`      | One account, its memberships, and the two decisions an operator can take about it |
| `/admin/audit`          | The whole trail in one ordering, with a detail drawer                             |
| `/admin/health`         | Dependencies and the notification backlog                                         |

The panel has its own shell, deliberately not nested inside the tenant frame: a
view that spans every workspace has no business wearing a workspace switcher and
a sidebar filtered by permissions the operator does not hold. A banner inside the
sticky region says which surface this is and never scrolls away, and "Back to my
workspace" appears only when the operator actually holds a membership.

Filters on the register and audit screens live in the query string rather than in
component state, because the most common thing an operator does with a filtered
view is send it to a colleague. `/admin/audit?businessId=…` is how the workspace
detail page hands an investigation over.

## What this does not do yet

Stated plainly, so nothing here is mistaken for finished work.

- **No billing, plans or quotas.** A workspace has a lifecycle status and nothing
  commercial attached to it.
- **No impersonation.** There is no way for an operator to act as a member of a
  workspace, and no support sign-in. Reproducing a front-desk session means
  holding a real membership, the way the seeded demo operator does.
- **No cross-workspace data export.** The CSV export in the product is
  tenant-scoped and lives on the reports surface; nothing here exports anything.
- **No email to workspace owners from the panel.** A suspension is silent. The
  `reason` recorded with it is for the audit trail, not for them.
- **No filter for platform-level audit rows.** `businessId` is typed as a uuid,
  so there is no value that expresses "belongs to no workspace". The audit screen
  narrows the page in hand instead, and says so on screen.
- **No standalone session revocation.** Signing an account out everywhere is a
  side effect of suspending it; there is no control that does only that.
- **No workspace deletion.** `ARCHIVED` is as far as the lifecycle goes, which is
  deliberate — nothing on this surface destroys a tenant's data.
