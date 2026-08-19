/**
 * Colleagues, at every role the product ships.
 *
 * Every other fixture in this directory registers an owner, so until now the
 * whole suite has only ever seen a workspace of one — and the four-role model,
 * whose entire purpose is that a Staff member sees less than a Manager, had no
 * end-to-end evidence behind it at all. This file is what closes that: it walks
 * the real invitation flow rather than writing a `memberships` row, so a spec
 * built on it can never pass against a state the product itself could not
 * produce.
 *
 * The order of operations is load-bearing and is not an accident of
 * convenience:
 *
 *  1. **The colleague registers before they are invited.** `POST
 *     /members/invite` will happily create an account for an unknown address,
 *     but it gives that account a password nobody holds — deliberately, so an
 *     intercepted invitation cannot be redeemed by whoever intercepted it. A
 *     spec that has to *sign in* as the invitee therefore has to bring an
 *     account whose password it chose. Inviting an address that already has an
 *     account attaches a membership and leaves the account untouched, which is
 *     exactly what is wanted here.
 *  2. **The invitee reads their own token back.** The emailed link never
 *     reaches a test, so `GET /members/invitations` stands in for the inbox. It
 *     re-mints the token for the signed-in account precisely so that a lost
 *     email cannot strand somebody, and that property is what makes it usable
 *     as a fixture.
 *  3. **Acceptance is what makes the membership real.** `requireTenant`
 *     resolves ACTIVE memberships only, so an invitee who has not accepted
 *     answers 404 on every management endpoint. Skipping step 3 yields a
 *     fixture that looks correct and can read nothing.
 *
 * One naming caveat, because it surprises people reading a failure: every
 * account these helpers mint carries the same person-name as `registerAccount`
 * gives an owner. Colleagues are told apart by their **email address**, which
 * is unique per run, and every spec here addresses them that way.
 */
import {
  apiCall,
  registerAccount,
  uniqueName,
  TEST_TIMEZONE,
  type AccountFixture,
  type OwnerFixture,
} from './api';

/**
 * The four roles workspace creation seeds.
 *
 * Sourced by key rather than by name: `SYSTEM_ROLE_TEMPLATES` in
 * server/src/modules/auth/permissions.ts is free to reword "Business Owner"
 * without that being a behaviour change, and a fixture matching on the label
 * would break on a copy edit.
 */
export type SystemRoleKey = 'BUSINESS_OWNER' | 'MANAGER' | 'RECEPTIONIST' | 'STAFF';

export interface WorkspaceRole {
  id: string;
  key: string;
  name: string;
}

export interface MemberFixture extends AccountFixture {
  businessId: string;
  /** The `memberships` row id — what `/members/:id` addresses. */
  membershipId: string;
  roleKey: SystemRoleKey;
  roleName: string;
}

/** A member who has also been made bookable, so appointments can land on them. */
export interface ProviderFixture extends MemberFixture {
  staffProfileId: string;
  /** Distinct per provider, so a diary row names *whose* booking it is. */
  staffName: string;
}

/** Any caller who can read the workspace's roles — an owner, or a manager. */
export type RoleReader = Pick<OwnerFixture, 'token' | 'businessId'>;

/**
 * One of the workspace's roles, by key.
 *
 * Read through the API rather than hard-coded, for the same reason no fixture
 * hard-codes an id: role rows are created per workspace by workspace creation,
 * so their ids belong to the run and not to the repository.
 *
 * Takes any caller holding `roles:read` rather than the owner specifically,
 * because a Manager may invite people too and has to name a role to do it.
 */
export async function roleFor(caller: RoleReader, key: SystemRoleKey): Promise<WorkspaceRole> {
  const roles = await apiCall<WorkspaceRole[]>('/api/v1/workspace/roles', {
    token: caller.token,
    businessId: caller.businessId,
  });

  const role = roles.find((candidate) => candidate.key === key);
  if (!role) {
    throw new Error(
      `Workspace ${caller.businessId} has no ${key} role. Creating a workspace seeds all four ` +
        `system roles, so this means that seeding changed — it offered: ` +
        `${roles.map((candidate) => candidate.key).join(', ') || '(none)'}.`,
    );
  }
  return role;
}

/**
 * A colleague inside `owner`'s workspace, holding `roleKey` and able to sign in.
 *
 * Both halves of the flow are asserted rather than assumed. An invitation that
 * came back in the wrong status, or an acceptance that did not activate the
 * membership, fails here with a sentence naming what happened — a spec that
 * discovered it three steps later would report a selector problem instead.
 */
export async function inviteColleague(
  owner: OwnerFixture,
  roleKey: SystemRoleKey,
  prefix = roleKey.toLowerCase(),
): Promise<MemberFixture> {
  const role = await roleFor(owner, roleKey);
  // Registered first — see step 1 in the file header.
  const account = await registerAccount(prefix);

  const invited = await apiCall<{ id: string; status: string }>('/api/v1/members/invite', {
    method: 'POST',
    token: owner.token,
    businessId: owner.businessId,
    body: { email: account.email, roleId: role.id },
  });
  if (invited.status !== 'INVITED') {
    throw new Error(
      `Inviting ${account.email} as ${roleKey} produced a membership in status ` +
        `${invited.status}, not INVITED. An invitation that is already active would make every ` +
        'assertion below about acceptance meaningless.',
    );
  }

  const invitations = await apiCall<Array<{ membershipId: string; token: string }>>(
    // No workspace header: the invitee has no ACTIVE membership yet, which is
    // the whole reason this endpoint is mounted outside the tenant chain.
    '/api/v1/members/invitations',
    { token: account.token },
  );
  const invitation = invitations.find((entry) => entry.membershipId === invited.id);
  if (!invitation) {
    throw new Error(
      `${account.email} was invited as ${roleKey}, but GET /members/invitations did not offer ` +
        `membership ${invited.id} back to them. Without the token there is no way to accept, ` +
        'which is exactly the stranding this endpoint exists to prevent.',
    );
  }

  const accepted = await apiCall<{ status: string; role: { key: string } }>(
    '/api/v1/members/accept',
    { method: 'POST', token: account.token, body: { token: invitation.token } },
  );
  if (accepted.status !== 'ACTIVE') {
    throw new Error(
      `${account.email} accepted their invitation but the membership is ${accepted.status}, ` +
        'not ACTIVE. `requireTenant` resolves ACTIVE memberships only, so every management ' +
        'call this fixture is built for would answer 404.',
    );
  }

  return {
    ...account,
    businessId: owner.businessId,
    membershipId: invited.id,
    roleKey,
    roleName: role.name,
  };
}

/**
 * Makes a member bookable, so appointments can be assigned to them.
 *
 * Three steps, and dropping any one of them yields an empty slot grid rather
 * than an error — the single most confusing way for a booking spec to fail:
 *
 *  - a staff profile, which is the row an appointment is actually assigned to
 *    and the thing `appointments:read:own` narrows on;
 *  - a working week, because a provider with no hours is never offered;
 *  - a place on the service's roster. That last call is a PUT and replaces the
 *    whole set, so the owner's own profile has to be named again — leaving it
 *    out would silently unassign the owner and take their openings with it.
 *
 * `displayName` is always distinct from the member's account name. Every
 * fixture account shares one person-name (see the file header), and a diary
 * whose Provider column reads the same for two people cannot answer the
 * question these specs are asking.
 */
export async function makeProvider(
  owner: OwnerFixture,
  member: MemberFixture,
): Promise<ProviderFixture> {
  const ctx = { token: owner.token, businessId: owner.businessId };
  const staffName = uniqueName('Provider');

  const profile = await apiCall<{ id: string; displayName: string }>('/api/v1/staff', {
    ...ctx,
    method: 'POST',
    body: { membershipId: member.membershipId, displayName: staffName, timezone: TEST_TIMEZONE },
  });

  // The same Mon–Sat 09:00–17:00 week `createBookableWorkspace` gives the owner:
  // six days so that whichever weekday the suite runs on there is an opening
  // ahead, and identical to the owner's so that neither provider can be the
  // only one free at a given hour. Note that identical hours do *not* mean two
  // slots per time on the public page — Smart Match assigns each opening to one
  // person, which is why `fetchPublicSlots` takes a `staffProfileId`.
  await apiCall(`/api/v1/availability/staff/${profile.id}/rules`, {
    ...ctx,
    method: 'PUT',
    body: {
      rules: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '09:00',
        endTime: '17:00',
      })),
    },
  });

  await apiCall(`/api/v1/services/${owner.serviceId}/staff`, {
    ...ctx,
    method: 'PUT',
    body: { staffProfileIds: [owner.staffProfileId, profile.id] },
  });

  return { ...member, staffProfileId: profile.id, staffName: profile.displayName };
}
