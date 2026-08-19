# Multi-tenancy

A **business** is the tenant boundary. Every tenant-owned table carries
`business_id`, and cross-tenant access is treated as a release-blocking defect.

## The one rule

> The tenant a request operates on is derived from an ACTIVE membership row,
> never from client input.

A client may _indicate_ which of their own workspaces they are acting in, via
the `X-Business-Id` header. That value is only ever used to **select among
memberships the caller already has**:

```ts
Membership.findOne({
  where: { userId, status: 'ACTIVE', ...(businessId ? { businessId } : {}) },
  include: [{ model: Business, where: { status: 'ACTIVE' }, required: true }, …],
})
```

An id for a workspace the user does not belong to matches nothing, and the
request is refused. Header absent and exactly one membership → that workspace.
Header absent with several → the client is asked to choose.

## 404, not 403

Cross-tenant access answers **404 Not Found**.

A 403 confirms the record exists, which turns any tenant-scoped endpoint into an
existence oracle: an attacker enumerates ids and learns which ones are real from
the status code alone. `TenantMismatchError` therefore extends the 404 path, and
"no membership" and "membership in a different workspace" are indistinguishable
from outside.

The same reasoning applies to the management surface as a whole: an
unauthenticated request to an unknown `/api/v1/*` path answers 401 rather than
404, so the endpoint list cannot be probed. The public surface answers a normal
404, because it has nothing to hide.

## Where the scope is applied

`req.tenant.businessId` is the only tenant identifier any query may use.

Service functions take `businessId` as their **first parameter** rather than
reading it from a request, which keeps them usable from jobs and sockets and
makes an unscoped query visually obvious in review.

`tenantOf(req)` throws if `requireTenant` did not run. This matters more than it
looks: reading `req.tenant?.businessId` into a Sequelize `where` clause would
pass `undefined`, and Sequelize **drops undefined keys** — silently turning a
tenant-scoped query into a global one. Failing loudly is the point.

## Authorisation is separate from tenancy

Three distinct questions, answered by three distinct middlewares:

- `requireTenant` — _which workspace_ is this request in?
- `requireVerifiedEmail` — has this account _confirmed the address_ it was
  opened with?
- `requirePermission` — _may this member_ perform this action there?

Holding `appointments:cancel` says nothing about which tenant's appointments are
reachable. Conflating the two is how "admin in workspace A" becomes "admin
everywhere".

The verification gate runs **after** tenant resolution on the management
surface, and the order matters: reversed, an invited colleague who has signed in
but not yet accepted is told to confirm an address that no link was ever sent to,
when their next step is to accept the invitation. Behind tenant resolution they
get the 404 that has always meant "no active membership here". See
[SecurityThreatModel.md](SecurityThreatModel.md#email-verification--closed).

### Permissions

Role-based, per business, with per-member overrides:

```
effective = role permissions
          + membership GRANT overrides
          − membership DENY overrides      (DENY always wins)
```

Overrides exist so "this staff member must not see revenue" does not require
cloning an entire role.

Permissions are re-read on **every request**, never cached and never embedded in
the access token — a revoked role takes effect on the next call rather than when
a 15-minute token happens to expire.

Built-in roles: `BUSINESS_OWNER` (everything), `MANAGER` (operations, not roles
or deletion), `RECEPTIONIST` (diary and customers, no configuration), `STAFF`
(deliberately minimal — own schedule and assigned appointments only).

`:own` permissions are _narrower_, not additional: `appointments:read:own` sees
only assigned appointments, and `appointments:read` is what widens that.

## Data that is deliberately not shared

The same person booking with two businesses is **two customer records**. The
unique index is `(business_id, email)`, not `email`. Tenants never share
customer rows, history, notes or preferences.

Roles are per-business too (`business_id IS NULL` is reserved for the built-in
templates cloned at workspace creation), so one workspace cannot see or edit
another's roles.

## Public booking context

Public endpoints have no membership. Tenant context comes from a validated
booking-link slug: the slug resolves to an active, non-expired link, which
yields the `business_id`. The caller never supplies a tenant id and can only
influence _which public, active link_ they open.

## Testing

Cross-tenant tests are release blockers, not nice-to-haves.
`booking.concurrency.test.ts` currently proves:

- booking with this tenant's `business_id` and another tenant's `service_id` → 404
- booking with another tenant's `staff_profile_id` → 404
- the same email in two workspaces produces two isolated customer records

Every CRUD module scopes all reads, updates, counts and deletes by
`tenantOf(req).businessId`; the module contract makes an unscoped query a review
failure.
