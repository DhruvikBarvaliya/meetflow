/**
 * Workspace membership — who belongs to a tenant, and with what authority.
 *
 * This module is the only writer of `memberships` outside workspace creation,
 * which makes it the surface that hands out authority. Four invariants govern
 * every function here, and the last three matter more than the happy path.
 *
 *  1. **`businessId` is always the first parameter and always comes from the
 *     caller's membership.** A membership, role or permission row belonging to
 *     another workspace must be indistinguishable from one that does not
 *     exist, so every miss raises NotFoundError — never a 403, which would
 *     confirm the id is real. Assigning a `Role` from another workspace is a
 *     cross-tenant write and answers 404 for the same reason.
 *
 *  2. **A workspace can never be left without an administrator.** The owner's
 *     membership cannot be demoted, suspended or removed; nobody can edit their
 *     own membership; and the last member who effectively holds `roles:manage`
 *     cannot be stripped of it. Each of those is one of the three ways a
 *     workspace could otherwise lock itself out permanently, with nothing in
 *     the product able to undo it.
 *
 *  3. **An invitation names an email address, never a user id.** The address is
 *     resolved to an account here, and one is created when there is none. That
 *     keeps this surface from becoming an oracle for which accounts exist on
 *     the platform, and it is why a duplicate invitation is a 409 rather than a
 *     second row: the unique index on (user_id, business_id) is partial on
 *     `deleted_at IS NULL`, so it only refuses *live* memberships and a removed
 *     member is free to be invited back.
 *
 *  4. **Access is revoked by the membership row, not by a session.** Removing
 *     or suspending someone deliberately does not touch their refresh tokens:
 *     those are platform-wide and the person may belong to other workspaces.
 *     `requireTenant` re-reads the membership on every single request and
 *     caches nothing, so the change lands on the caller's very next call.
 */
import crypto from 'node:crypto';
import { Op, type Includeable, type Transaction } from 'sequelize';
import { sequelize } from '../../config/database';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import {
  Appointment,
  AppointmentStaff,
  Business,
  Membership,
  MembershipPermission,
  Permission,
  Role,
  RolePermission,
  StaffProfile,
  User,
} from '../../database/models';
import { ACTIVE_APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import type { MembershipStatus } from '../../database/models/Membership';
import type { PermissionEffect } from '../../database/models/MembershipPermission';
import { ConflictError, ErrorCode, InternalError, NotFoundError } from '../../utils/errors';
import { newRefreshToken, newVerificationToken, safeEqual, sha256 } from '../../utils/ids';
import { hashPassword } from '../../utils/password';
import { AuditActions, recordAudit } from '../audit/audit.service';
import type { RequestMetadata } from '../auth/auth.service';
import { PERMISSIONS, resolveEffectivePermissions } from '../auth/permissions';
import { enqueueNotification, type EnqueueInput } from '../notifications/notification.service';
import type {
  InviteMemberBody,
  ListMembersQuery,
  ReplaceMemberPermissionsBody,
  UpdateMemberBody,
} from './members.validation';

const log = createLogger('members');

export interface MemberActor {
  userId: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Invitation tokens
// ---------------------------------------------------------------------------

/**
 * How long an emailed invitation stays usable.
 *
 * Two weeks rather than the hour a password reset gets: an invitation competes
 * with annual leave and an unread inbox, and the failure mode of an expired one
 * is a colleague who has to ask to be invited again. It is bounded rather than
 * eternal because the token travels by email, which is the least trustworthy
 * channel the product uses.
 */
const INVITATION_TTL_MS = 14 * 24 * 60 * 60_000;

const INVITATION_TOKEN_VERSION = 'v1';

/**
 * The key invitation tokens are signed with.
 *
 * Derived from the refresh secret rather than used directly, so a token minted
 * here can never be confused with — or substituted for — anything else signed
 * with that key. The label is part of the derivation, which is what separates
 * the two domains; rotating `JWT_REFRESH_SECRET` invalidates outstanding
 * invitations along with outstanding sessions, which is the correct blast
 * radius for a compromised signing key.
 *
 * A stateless token rather than a stored one: `memberships` has no column to
 * hold a digest, and the row itself already carries every piece of state a
 * stored token would have provided. Replay is closed by the membership's own
 * status — acceptance moves it out of INVITED, and a second attempt then finds
 * nothing to accept.
 */
const INVITATION_TOKEN_KEY = crypto
  .createHmac('sha256', env.JWT_REFRESH_SECRET)
  .update('meetflow:membership-invitation:v1')
  .digest();

function signInvitationToken(membershipId: string, issuedAt: number): string {
  const payload = `${INVITATION_TOKEN_VERSION}.${membershipId}.${issuedAt}`;
  const mac = crypto.createHmac('sha256', INVITATION_TOKEN_KEY).update(payload).digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${mac}`;
}

/**
 * The membership a token names, or null for anything that fails to verify.
 *
 * Deliberately returns one undifferentiated null for a bad signature, a
 * malformed token and an expired one. Telling those apart would let a caller
 * probe which membership ids exist by watching the failure change shape.
 */
function readInvitationToken(token: string): string | null {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const payload = Buffer.from(token.slice(0, separator), 'base64url').toString('utf8');
  const expected = crypto
    .createHmac('sha256', INVITATION_TOKEN_KEY)
    .update(payload)
    .digest('base64url');
  // Constant-time: a plain `===` on a MAC leaks its prefix through timing,
  // which is enough to forge one byte at a time.
  if (!safeEqual(token.slice(separator + 1), expected)) return null;

  const [version, membershipId, issuedAtRaw] = payload.split('.');
  if (version !== INVITATION_TOKEN_VERSION || !membershipId || !issuedAtRaw) return null;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > INVITATION_TTL_MS) return null;

  return membershipId;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Every field a member payload may contain, named one by one.
 *
 * The same discipline admin.service.ts applies to its builders, and for the
 * same reason: this response carries colleagues' contact details, so a column
 * added to `users` tomorrow must not be able to arrive here by accident. It has
 * to be typed out below, where the decision is visible in review.
 */
export interface MemberView {
  id: string;
  status: MembershipStatus;
  /** True for the account in `businesses.owner_user_id`, which cannot be edited. */
  isOwner: boolean;
  invitedAt: Date | null;
  joinedAt: Date | null;
  createdAt: Date;
  removedAt: Date | null;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    fullName: string;
    avatarUrl: string | null;
    status: string;
  };
  role: { id: string; key: string; name: string };
  staffProfile: { id: string; displayName: string; isBookable: boolean; isActive: boolean } | null;
}

export interface MemberPage {
  rows: MemberView[];
  page: number;
  pageSize: number;
  totalItems: number;
}

export interface MemberPermissionsView {
  membershipId: string;
  role: { id: string; key: string; name: string };
  /** What the role grants, before any per-member exception. */
  rolePermissions: string[];
  overrides: Array<{ permission: string; effect: PermissionEffect }>;
  /** Role grants plus GRANTs minus DENYs — what the middleware will enforce. */
  effectivePermissions: string[];
}

export interface InvitationView {
  membershipId: string;
  businessId: string;
  businessName: string;
  businessSlug: string;
  role: { id: string; key: string; name: string };
  invitedAt: Date | null;
  /** Re-issued on read, so an invitation survives a lost email. */
  token: string;
}

/**
 * The three joins a member payload is assembled from.
 *
 * Built by a function rather than held as a constant so the user join can carry
 * the search predicate: a person is looked up by name or address, and a
 * membership row has neither.
 */
function memberIncludes(searchTerm?: string): Includeable[] {
  return [
    {
      model: User,
      as: 'user',
      required: true,
      attributes: ['id', 'email', 'firstName', 'lastName', 'avatarUrl', 'status'],
      ...(searchTerm
        ? {
            where: {
              [Op.or]: [
                { email: { [Op.iLike]: searchTerm } },
                { firstName: { [Op.iLike]: searchTerm } },
                { lastName: { [Op.iLike]: searchTerm } },
              ],
            },
          }
        : {}),
    },
    { model: Role, as: 'role', required: true, attributes: ['id', 'key', 'name'] },
    {
      model: StaffProfile,
      as: 'staffProfile',
      required: false,
      attributes: ['id', 'displayName', 'isBookable', 'isActive'],
    },
  ];
}

function toMemberView(membership: Membership, ownerUserId: string): MemberView {
  const user = membership.get('user') as User;
  const role = membership.get('role') as Role;
  const staffProfile = membership.get('staffProfile') as StaffProfile | null | undefined;

  return {
    id: membership.id,
    status: membership.status,
    isOwner: user.id === ownerUserId,
    invitedAt: membership.invitedAt,
    joinedAt: membership.joinedAt,
    createdAt: membership.createdAt,
    removedAt: membership.deletedAt,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      status: user.status,
    },
    role: { id: role.id, key: role.key, name: role.name },
    staffProfile: staffProfile
      ? {
          id: staffProfile.id,
          displayName: staffProfile.displayName,
          isBookable: staffProfile.isBookable,
          isActive: staffProfile.isActive,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Loading and tenant scoping
// ---------------------------------------------------------------------------

/**
 * `%` and `_` are wildcards to LIKE, so an unescaped search term of "%" would
 * match every member instead of the one the user is looking for.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * The only way a membership is ever loaded for a mutation. Scoping on
 * businessId here is what makes everything downstream tenant-safe, and the
 * paranoid default is what keeps an already-removed member out of reach.
 */
async function findMemberOrFail(
  businessId: string,
  membershipId: string,
  transaction?: Transaction,
): Promise<Membership> {
  const membership = await Membership.findOne({
    where: { id: membershipId, businessId },
    include: memberIncludes(),
    transaction,
  });
  if (!membership) throw new NotFoundError('Member');
  return membership;
}

async function findBusinessOrFail(
  businessId: string,
  transaction?: Transaction,
): Promise<Business> {
  const business = await Business.findByPk(businessId, {
    // `timezone` and `status` are read as well as `ownerUserId`: an invitation
    // creates the invitee's account in the workspace's zone rather than UTC,
    // and acceptance refuses a workspace that is no longer active. A column
    // that is not selected reads as `undefined` at runtime while the model's
    // declaration still types it as present, which is a bug the compiler
    // cannot see.
    attributes: ['id', 'name', 'slug', 'timezone', 'status', 'ownerUserId'],
    transaction,
  });
  if (!business) throw new NotFoundError('Workspace');
  return business;
}

/** A role from another workspace, or a global template, is not assignable here. */
async function findAssignableRoleOrFail(
  businessId: string,
  roleId: string,
  transaction: Transaction,
): Promise<Role> {
  // `businessId` is a uuid, so this predicate also excludes the built-in
  // templates, whose business_id is NULL — those are cloned into a workspace at
  // creation and are never assigned directly.
  const role = await Role.findOne({
    where: { id: roleId, businessId },
    attributes: ['id', 'key', 'name'],
    transaction,
  });
  if (!role) throw new NotFoundError('Role');
  return role;
}

// ---------------------------------------------------------------------------
// Lock-out guards
// ---------------------------------------------------------------------------

/**
 * The owner is the one account the workspace cannot function without: they are
 * `businesses.owner_user_id`, the row is ON DELETE RESTRICT, and no other
 * surface in the product can restore an owner who has been demoted out of their
 * own workspace.
 */
function assertNotOwner(membership: Membership, business: Business, action: string): void {
  if (membership.userId !== business.ownerUserId) return;
  throw new ConflictError(
    `The workspace owner's membership cannot be ${action}. Transfer ownership first.`,
    ErrorCode.CONFLICT,
  );
}

/**
 * Same reasoning as the platform-admin self-guards in admin.service.ts: an
 * administrator who demotes or removes themselves loses the only surface that
 * could put it back, and nothing in the product can undo it.
 */
function assertNotSelf(membership: Membership, actor: MemberActor, action: string): void {
  if (membership.userId !== actor.userId) return;
  throw new ConflictError(
    `You cannot ${action} your own membership. Ask another member with the right to manage roles.`,
    ErrorCode.CONFLICT,
  );
}

async function rolesManagePermissionId(transaction: Transaction): Promise<string> {
  const permission = await Permission.findOne({
    where: { key: PERMISSIONS.ROLES_MANAGE },
    attributes: ['id'],
    transaction,
  });
  if (!permission) {
    // Seeded by `ensurePermissionsSeeded` before the first role is ever
    // created, so its absence is a broken deployment, not a client error.
    throw new InternalError('The permission catalogue is missing roles:manage.');
  }
  return permission.id;
}

/** Whether one membership would effectively hold `roles:manage` in a given shape. */
async function holdsRolesManage(
  membershipId: string,
  roleId: string,
  status: MembershipStatus,
  transaction: Transaction,
): Promise<boolean> {
  // Only an ACTIVE membership can exercise anything: `requireTenant` refuses
  // every other status outright, so an INVITED or SUSPENDED member is not one
  // of the accounts that can still administer the workspace.
  if (status !== 'ACTIVE') return false;

  const permissionId = await rolesManagePermissionId(transaction);

  // The override beats the role in both directions, exactly as
  // `resolveEffectivePermissions` resolves it.
  const override = await MembershipPermission.findOne({
    where: { membershipId, permissionId },
    transaction,
  });
  if (override) return override.effect === 'GRANT';

  const granted = await RolePermission.findOne({
    where: { roleId, permissionId },
    transaction,
  });
  return granted !== null;
}

/**
 * Every ACTIVE membership that effectively holds `roles:manage`, with the rows
 * locked.
 *
 * `SELECT ... FOR UPDATE`, not `count(*)`: PostgreSQL refuses row locking on an
 * aggregate, and an unlocked count is exactly the race this guard exists to
 * close. Two administrators each demoting the other would both read "there is
 * still another administrator" and both commit, leaving the workspace with
 * nobody able to manage roles and no way back in — the workspace-scoped twin of
 * the last-platform-admin race that `updatePlatformRole` closes.
 *
 * The lock is taken over every active membership in a deterministic `id` order,
 * which is what stops those two transactions from deadlocking on each other.
 * The second one blocks; when it is released it re-reads under READ COMMITTED,
 * sees the first demotion, and correctly refuses.
 *
 * The locking statement carries no include: Sequelize would push the joined
 * tables into `FOR UPDATE OF`, which PostgreSQL rejects on an outer join. The
 * grant and override lookups below are therefore separate reads — safe, because
 * the membership rows they are interpreted against are already held.
 */
async function lockRolesManageHolders(
  businessId: string,
  transaction: Transaction,
): Promise<Set<string>> {
  const active = await Membership.findAll({
    where: { businessId, status: 'ACTIVE' },
    attributes: ['id', 'roleId'],
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (active.length === 0) return new Set();

  const permissionId = await rolesManagePermissionId(transaction);

  const grants = await RolePermission.findAll({
    where: { permissionId, roleId: { [Op.in]: active.map((row) => row.roleId) } },
    attributes: ['roleId'],
    transaction,
  });
  const grantingRoles = new Set(grants.map((row) => row.roleId));

  const overrides = await MembershipPermission.findAll({
    where: { permissionId, membershipId: { [Op.in]: active.map((row) => row.id) } },
    transaction,
  });
  const overrideByMembership = new Map(
    overrides.map((row) => [row.membershipId, row.effect] as const),
  );

  const holders = new Set<string>();
  for (const membership of active) {
    const override = overrideByMembership.get(membership.id);
    const holds = override ? override === 'GRANT' : grantingRoles.has(membership.roleId);
    if (holds) holders.add(membership.id);
  }
  return holders;
}

/**
 * Refuses a change that would take `roles:manage` away from the last member who
 * has it.
 *
 * `willStillHold` is what the membership looks like *after* the change, so a
 * role swap between two roles that both grant it never takes the lock at all.
 */
async function assertRolesManageSurvives(
  businessId: string,
  membershipId: string,
  willStillHold: boolean,
  transaction: Transaction,
): Promise<void> {
  if (willStillHold) return;

  const holders = await lockRolesManageHolders(businessId, transaction);
  // Somebody who never held it cannot be the last one holding it.
  if (!holders.has(membershipId)) return;

  holders.delete(membershipId);
  if (holders.size === 0) {
    throw new ConflictError(
      'This is the last member who can manage roles. Grant roles:manage to another ' +
        'active member first, or the workspace would be left unable to administer itself.',
      ErrorCode.CONFLICT,
    );
  }
}

/**
 * Appointments that still need this person on the calendar.
 *
 * `endsAt` rather than `startsAt`: an appointment running right now still needs
 * the person delivering it. Mirrors the guard `deleteStaffProfile` applies,
 * because removal soft-deletes the same profile and would otherwise leave a
 * booked customer with a provider nobody can resolve.
 */
async function countBlockingAppointments(
  businessId: string,
  staffProfileId: string,
  transaction: Transaction,
): Promise<number> {
  return Appointment.count({
    where: {
      businessId,
      status: { [Op.in]: [...ACTIVE_APPOINTMENT_STATUSES] },
      endsAt: { [Op.gt]: new Date() },
      [Op.or]: [
        { staffProfileId },
        // Collective bookings name their providers only in appointment_staff,
        // so testing the primary column alone would let a member be removed out
        // from under a panel that is still on the books.
        //
        // Spelled with the physical column name: Sequelize emits a `$alias.x$`
        // reference verbatim rather than mapping the model attribute to its
        // field, so `staffProfileId` here would generate a column that does not
        // exist.
        { '$staffReservations.staff_profile_id$': staffProfileId },
      ],
    },
    include: [
      { model: AppointmentStaff, as: 'staffReservations', attributes: [], required: false },
    ],
    // The join can match an appointment twice (primary column *and* a
    // reservation row); without this the operator would be told to clear more
    // appointments than exist.
    distinct: true,
    transaction,
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listMembers(
  businessId: string,
  options: ListMembersQuery,
): Promise<MemberPage> {
  const business = await findBusinessOrFail(businessId);
  const term = options.search ? `%${escapeLike(options.search)}%` : null;

  const { rows, count } = await Membership.findAndCountAll({
    where: {
      businessId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.roleId ? { roleId: options.roleId } : {}),
    },
    include: memberIncludes(term ?? undefined),
    // Removed members are soft-deleted rows; `paranoid: false` is the only way
    // back to them, and it is opt-in so the default answer is "who is here now".
    paranoid: !options.includeRemoved,
    order: [['createdAt', 'ASC']],
    limit: options.pageSize,
    offset: (options.page - 1) * options.pageSize,
    // findAndCountAll counts joined rows without it, and the staff-profile
    // include would inflate the total for anyone who has one.
    distinct: true,
  });

  return {
    rows: rows.map((membership) => toMemberView(membership, business.ownerUserId)),
    page: options.page,
    pageSize: options.pageSize,
    totalItems: count,
  };
}

export async function getMemberPermissions(
  businessId: string,
  membershipId: string,
): Promise<MemberPermissionsView> {
  const membership = await findMemberOrFail(businessId, membershipId);
  const role = membership.get('role') as Role;

  const [roleWithGrants, overrideRows] = await Promise.all([
    // Through the `permissions` alias rather than the join table: RolePermission
    // is declared only as a `through` model and carries no association of its
    // own, so an include on it resolves to nothing.
    Role.findOne({
      where: { id: role.id, businessId },
      include: [
        {
          model: Permission,
          as: 'permissions',
          through: { attributes: [] },
          attributes: ['key'],
        },
      ],
    }),
    MembershipPermission.findAll({
      where: { membershipId: membership.id },
      include: [{ model: Permission, as: 'permission', required: true, attributes: ['key'] }],
    }),
  ]);

  const overrides = overrideRows
    .map((row) => ({
      permission: (row.get('permission') as Permission).key,
      effect: row.effect,
    }))
    .sort((a, b) => a.permission.localeCompare(b.permission));

  const granted = ((roleWithGrants?.get('permissions') as Permission[] | undefined) ?? [])
    .map((permission) => permission.key)
    .sort((a, b) => a.localeCompare(b));
  const effective = resolveEffectivePermissions(
    granted,
    overrides.map((override) => ({ permissionKey: override.permission, effect: override.effect })),
  );

  return {
    membershipId: membership.id,
    role: { id: role.id, key: role.key, name: role.name },
    rolePermissions: granted,
    overrides,
    effectivePermissions: [...effective].sort(),
  };
}

// ---------------------------------------------------------------------------
// Invitation
// ---------------------------------------------------------------------------

/**
 * The outbox's `type` column is free text on purpose (see the Notification
 * model), but `EnqueueInput['type']` is narrowed to the template keys that ship
 * with the product. There is no invitation template: the subject and body are
 * rendered below and passed in, which makes template resolution unreachable for
 * this message. The widening therefore only names the event on the row, where
 * support and the notification history read it.
 */
const INVITATION_NOTIFICATION_TYPE = 'MEMBERSHIP_INVITATION' as EnqueueInput['type'];

function invitationEmail(input: {
  recipientFirstName: string;
  inviterLabel: string;
  businessName: string;
  roleName: string;
  acceptUrl: string;
  passwordSetupUrl: string | null;
}): { subject: string; body: string } {
  const lines = [
    `Hi ${input.recipientFirstName},`,
    '',
    `${input.inviterLabel} has invited you to join ${input.businessName} on MeetFlow as ` +
      `${input.roleName}.`,
    '',
  ];

  if (input.passwordSetupUrl) {
    // A brand-new account has no password anybody knows, so the set-password
    // step has to come first or the accept link leads to a sign-in they cannot
    // complete.
    lines.push(
      'Your account has been created for you. Choose a password to sign in:',
      input.passwordSetupUrl,
      '',
      'Then accept your invitation:',
    );
  } else {
    lines.push('Accept your invitation:');
  }

  lines.push(
    input.acceptUrl,
    '',
    'This invitation expires in 14 days. If you were not expecting it, you can ignore ' +
      'this message — nothing changes until you accept.',
  );

  return {
    subject: `You have been invited to join ${input.businessName} on MeetFlow`,
    body: lines.join('\n'),
  };
}

/**
 * Invites an email address into the workspace.
 *
 * The address, not a user id, is the input — see invariant 3 at the top of this
 * file. Three cases fall out of that, and all three are one transaction with
 * the audit row and the queued notification, so a rolled-back invitation can
 * never leave an orphaned account or send an email about a membership that does
 * not exist:
 *
 *  - **no account** — a user row is created in INVITED status with a password
 *    nobody holds, plus a single-use token so the invitee can choose a real
 *    one. Registration refuses an address that already has a row, so without
 *    that token the account would be permanently unreachable;
 *  - **an existing account** — a membership is attached to it and the account
 *    is left completely untouched. An invitation must not be able to rewrite
 *    somebody's name, status or password;
 *  - **an existing live membership** — 409. The partial unique index would
 *    refuse the row anyway; answering the conflict here makes it a readable
 *    error rather than a constraint violation surfacing as a 500.
 */
export async function inviteMember(
  businessId: string,
  input: InviteMemberBody,
  actor: MemberActor,
  metadata: RequestMetadata,
): Promise<MemberView> {
  const created = await sequelize.transaction(async (transaction) => {
    const business = await findBusinessOrFail(businessId, transaction);
    const role = await findAssignableRoleOrFail(businessId, input.roleId, transaction);

    // Default scope excludes the secret columns, which is exactly right: this
    // path reads the account to decide whether to create one, and never needs
    // to see a hash. The paranoid default matches the partial unique index on
    // `users (email) WHERE deleted_at IS NULL`, so a soft-deleted account does
    // not block a fresh one for the same address.
    const existingUser = await User.findOne({ where: { email: input.email }, transaction });

    let passwordSetupToken: string | null = null;
    let user = existingUser;

    if (!user) {
      passwordSetupToken = newVerificationToken();
      user = await User.create(
        {
          email: input.email,
          // An unguessable value nobody holds, so the account cannot be signed
          // into until the invitee sets a password of their own. Same idiom as
          // the dummy hash auth.service.ts compares against for unknown
          // addresses.
          passwordHash: await hashPassword(newRefreshToken()),
          // The invitee has not told us their name yet. Whatever the inviter
          // typed is a stand-in until they sign in and correct it.
          firstName: input.firstName ?? input.email.split('@')[0] ?? 'New',
          lastName: input.lastName ?? 'Member',
          phone: null,
          avatarUrl: null,
          // INVITED, not ACTIVE: the address has not been proven yet. Both
          // `login` and `authenticate` allow it — only SUSPENDED and
          // DEACTIVATED are refused — so the invitee can still complete the
          // flow, and accepting promotes the account the way `verifyEmail`
          // does.
          status: 'INVITED',
          timezone: business.timezone,
          emailVerifiedAt: null,
          emailVerificationTokenHash: null,
          emailVerificationSentAt: null,
          // Reusing the password-reset columns rather than inventing a parallel
          // token: the security property wanted here is identical — prove
          // control of the mailbox, then set a password — and
          // `/auth/password-reset/confirm` already validates, clears and audits
          // exactly this token. The window is the invitation's, not the reset
          // flow's one hour, because it is an invitation that is being waited
          // on.
          passwordResetTokenHash: sha256(passwordSetupToken),
          passwordResetExpiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          lastLoginAt: null,
          lockedUntil: null,
        },
        { transaction },
      );
    }

    const live = await Membership.findOne({
      where: { businessId, userId: user.id },
      attributes: ['id', 'status'],
      transaction,
    });
    if (live) {
      throw new ConflictError(
        live.status === 'INVITED'
          ? 'That person has already been invited to this workspace.'
          : 'That person is already a member of this workspace.',
        ErrorCode.ALREADY_EXISTS,
        { status: live.status },
      );
    }

    const invitedAt = new Date();
    const membership = await Membership.create(
      {
        userId: user.id,
        businessId,
        roleId: role.id,
        status: 'INVITED',
        invitedByUserId: actor.userId,
        invitedAt,
        // Set by acceptance, so "invited but never joined" stays visible.
        joinedAt: null,
      },
      { transaction },
    );

    const token = signInvitationToken(membership.id, invitedAt.getTime());
    const acceptUrl = `${env.PUBLIC_APP_URL}/invitations/accept?token=${encodeURIComponent(token)}`;
    const { subject, body } = invitationEmail({
      recipientFirstName: user.firstName,
      inviterLabel: actor.email,
      businessName: business.name,
      roleName: role.name,
      acceptUrl,
      passwordSetupUrl: passwordSetupToken
        ? `${env.PUBLIC_APP_URL}/reset-password?token=${encodeURIComponent(passwordSetupToken)}`
        : null,
    });

    await enqueueNotification(
      {
        businessId,
        type: INVITATION_NOTIFICATION_TYPE,
        recipientType: 'STAFF',
        recipientUserId: user.id,
        recipientAddress: user.email,
        subject,
        body,
        // The URLs are deliberately absent: the outbox row is readable by
        // anyone with `notifications:read`, and the payload would hand them a
        // token that accepts on somebody else's behalf. They live only in the
        // rendered body, which goes to the invitee's mailbox.
        payload: { businessName: business.name, roleName: role.name },
        // One email per membership row. A re-invitation after removal creates a
        // new row and therefore a new key, which is what lets a returning
        // colleague be emailed again.
        dedupeKey: `membership-invitation:${membership.id}`,
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.MEMBERSHIP_INVITED,
        entityType: 'membership',
        entityId: membership.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          email: user.email,
          userId: user.id,
          roleId: role.id,
          roleKey: role.key,
          accountCreated: existingUser === null,
        },
      },
      { transaction },
    );

    log.info(
      { businessId, membershipId: membership.id, roleKey: role.key, accountCreated: !existingUser },
      'member invited',
    );
    return membership.id;
  });

  return getMember(businessId, created);
}

/** Re-reads a membership through the standard includes, for a mutation's reply. */
async function getMember(businessId: string, membershipId: string): Promise<MemberView> {
  const [business, membership] = await Promise.all([
    findBusinessOrFail(businessId),
    findMemberOrFail(businessId, membershipId),
  ]);
  return toMemberView(membership, business.ownerUserId);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateMember(
  businessId: string,
  membershipId: string,
  input: UpdateMemberBody,
  actor: MemberActor,
  metadata: RequestMetadata,
): Promise<MemberView> {
  await sequelize.transaction(async (transaction) => {
    const membership = await findMemberOrFail(businessId, membershipId, transaction);
    const business = await findBusinessOrFail(businessId, transaction);

    // The parameter is a membership id, so unlike the platform-admin guards
    // these two checks can only run once the row is loaded — the id alone says
    // nothing about whose membership it is.
    assertNotSelf(membership, actor, 'change');
    assertNotOwner(membership, business, 'changed');

    if (input.status !== undefined && membership.status === 'INVITED') {
      // Activating an invitation from this side would grant a live membership
      // to somebody who never accepted it — including whoever actually owns a
      // mistyped address. Acceptance is the only path from INVITED, and
      // withdrawing an invitation is `DELETE /members/:id`.
      throw new ConflictError(
        'That invitation has not been accepted yet. It becomes active when the invited ' +
          'person accepts it, and can be withdrawn by removing them.',
        ErrorCode.INVALID_STATE_TRANSITION,
      );
    }

    const before = { roleId: membership.roleId, status: membership.status };

    const role =
      input.roleId !== undefined && input.roleId !== membership.roleId
        ? await findAssignableRoleOrFail(businessId, input.roleId, transaction)
        : null;

    const nextRoleId = role?.id ?? membership.roleId;
    const nextStatus = input.status ?? membership.status;

    await assertRolesManageSurvives(
      businessId,
      membership.id,
      await holdsRolesManage(membership.id, nextRoleId, nextStatus, transaction),
      transaction,
    );

    await membership.update(
      {
        ...(role ? { roleId: role.id } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      { transaction },
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.MEMBERSHIP_UPDATED,
        entityType: 'membership',
        entityId: membership.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          targetUserId: membership.userId,
          before,
          after: { roleId: membership.roleId, status: membership.status },
        },
      },
      { transaction },
    );

    log.info(
      {
        businessId,
        membershipId: membership.id,
        before,
        after: { roleId: nextRoleId, status: nextStatus },
      },
      'membership updated',
    );
  });

  return getMember(businessId, membershipId);
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

export async function removeMember(
  businessId: string,
  membershipId: string,
  actor: MemberActor,
  metadata: RequestMetadata,
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const membership = await findMemberOrFail(businessId, membershipId, transaction);
    const business = await findBusinessOrFail(businessId, transaction);

    assertNotSelf(membership, actor, 'remove');
    assertNotOwner(membership, business, 'removed');

    await assertRolesManageSurvives(businessId, membership.id, false, transaction);

    const staffProfile = membership.get('staffProfile') as StaffProfile | null | undefined;
    if (staffProfile) {
      const blocking = await countBlockingAppointments(businessId, staffProfile.id, transaction);
      if (blocking > 0) {
        throw new ConflictError(
          `This member still has ${blocking} upcoming appointment${blocking === 1 ? '' : 's'}. ` +
            'Reassign or cancel them, or suspend the member instead.',
          ErrorCode.CONFLICT,
          { activeAppointments: blocking },
        );
      }

      // Soft-deleted with the membership, and in the same transaction. The
      // staff module reads this state deliberately: `createStaffProfile`
      // refuses a REMOVED member outright, and its duplicate check mirrors the
      // partial unique index on (business_id, user_id) so that a returning
      // colleague can be re-onboarded. Leaving the profile live would both keep
      // a departed person bookable and make re-onboarding them impossible.
      await staffProfile.destroy({ transaction });
    }

    const previousStatus = membership.status;

    // Status *and* soft delete. The status makes the row self-describing for
    // anyone reading history; the soft delete is what releases the partial
    // unique index on (user_id, business_id) so the same person can be invited
    // back later. Permission overrides are left attached — they belong to this
    // membership's history, and a re-invitation creates a new row that starts
    // from its role alone.
    await membership.update({ status: 'REMOVED' }, { transaction });
    await membership.destroy({ transaction });

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        action: AuditActions.MEMBERSHIP_REMOVED,
        entityType: 'membership',
        entityId: membership.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          targetUserId: membership.userId,
          previousStatus,
          roleId: membership.roleId,
          staffProfileDeleted: staffProfile?.id ?? null,
        },
      },
      { transaction },
    );

    log.info({ businessId, membershipId: membership.id }, 'member removed');
  });
}

// ---------------------------------------------------------------------------
// Per-member permission overrides
// ---------------------------------------------------------------------------

export async function replaceMemberPermissions(
  businessId: string,
  membershipId: string,
  input: ReplaceMemberPermissionsBody,
  actor: MemberActor,
  metadata: RequestMetadata,
): Promise<MemberPermissionsView> {
  await sequelize.transaction(async (transaction) => {
    const membership = await findMemberOrFail(businessId, membershipId, transaction);
    const business = await findBusinessOrFail(businessId, transaction);

    assertNotSelf(membership, actor, 'change the permissions on');
    // A DENY on the owner is the single fastest way to lock a workspace out of
    // its own administration, and a GRANT adds nothing to a role that already
    // carries the whole catalogue.
    assertNotOwner(membership, business, 'overridden');

    const keys = input.overrides.map((override) => override.permission);
    const permissions =
      keys.length > 0
        ? await Permission.findAll({
            where: { key: { [Op.in]: keys } },
            attributes: ['id', 'key'],
            transaction,
          })
        : [];
    const permissionIdByKey = new Map(permissions.map((row) => [row.key, row.id] as const));

    if (permissionIdByKey.size !== new Set(keys).size) {
      // The schema only accepts keys from the catalogue, so a miss means the
      // `permissions` table is behind the code — a deployment fault, not
      // something the caller can fix by sending different input.
      throw new InternalError('The permission catalogue is out of date on this deployment.');
    }

    const before = await MembershipPermission.findAll({
      where: { membershipId: membership.id },
      include: [{ model: Permission, as: 'permission', required: true, attributes: ['key'] }],
      transaction,
    });

    // Replace, never merge: see the schema. The table has no updated_at, and
    // flipping an effect is modelled as delete plus insert so the effect and
    // its timestamp stay consistent.
    await MembershipPermission.destroy({
      where: { membershipId: membership.id },
      transaction,
    });

    if (input.overrides.length > 0) {
      await MembershipPermission.bulkCreate(
        input.overrides.map((override) => ({
          membershipId: membership.id,
          permissionId: permissionIdByKey.get(override.permission) as string,
          effect: override.effect,
        })),
        { transaction },
      );
    }

    // Evaluated against the rows just written, so a DENY on roles:manage is
    // caught by exactly the same guard as a demotion.
    await assertRolesManageSurvives(
      businessId,
      membership.id,
      await holdsRolesManage(membership.id, membership.roleId, membership.status, transaction),
      transaction,
    );

    await recordAudit(
      {
        businessId,
        actorType: 'USER',
        actorUserId: actor.userId,
        actorLabel: actor.email,
        // No membership-permission action exists in the catalogue;
        // MEMBERSHIP_UPDATED keeps the entity type honest and the metadata says
        // what actually changed.
        action: AuditActions.MEMBERSHIP_UPDATED,
        entityType: 'membership',
        entityId: membership.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: {
          change: 'permission_overrides_replaced',
          targetUserId: membership.userId,
          before: before.map((row) => ({
            permission: (row.get('permission') as Permission).key,
            effect: row.effect,
          })),
          after: input.overrides,
        },
      },
      { transaction },
    );

    log.info(
      { businessId, membershipId: membership.id, overrides: input.overrides.length },
      'membership permission overrides replaced',
    );
  });

  return getMemberPermissions(businessId, membershipId);
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/**
 * The caller's outstanding invitations, across every workspace.
 *
 * Deliberately not tenant-scoped and deliberately not permission-guarded: an
 * invitee has no membership to resolve a tenant from yet, and the only rows
 * this can ever return are the ones addressed to the caller's own account.
 *
 * Each row carries a freshly minted token. Handing somebody their own
 * invitation token discloses nothing they were not already sent by email, and
 * it is what stops a lost or filtered message from stranding a member
 * permanently — the failure this whole module exists to remove.
 */
export async function listInvitations(userId: string): Promise<InvitationView[]> {
  const memberships = await Membership.findAll({
    where: { userId, status: 'INVITED' },
    include: [
      {
        model: Business,
        as: 'business',
        required: true,
        where: { status: 'ACTIVE' },
        attributes: ['id', 'name', 'slug'],
      },
      { model: Role, as: 'role', required: true, attributes: ['id', 'key', 'name'] },
    ],
    order: [['createdAt', 'DESC']],
  });

  return memberships.map((membership) => {
    const business = membership.get('business') as Business;
    const role = membership.get('role') as Role;
    // Bound to `invitedAt`, exactly as the emailed token was, so both expire
    // together rather than the listing minting an invitation that never ages.
    const issuedAt = (membership.invitedAt ?? membership.createdAt).getTime();
    return {
      membershipId: membership.id,
      businessId: business.id,
      businessName: business.name,
      businessSlug: business.slug,
      role: { id: role.id, key: role.key, name: role.name },
      invitedAt: membership.invitedAt,
      token: signInvitationToken(membership.id, issuedAt),
    };
  });
}

/**
 * Accepts an invitation and turns it into a live membership.
 *
 * Two independent proofs are required and neither is sufficient alone: the
 * token proves the invitation was issued by this deployment and names which one
 * is being accepted, and the bearer session proves the caller is the account it
 * was addressed to. That is why the endpoint is authenticated despite taking a
 * secret — a token intercepted in the invitee's mailbox still cannot be
 * redeemed without their password.
 *
 * Everything that fails answers 404 with the same message. An invitation
 * addressed to somebody else, one already accepted, one withdrawn and one that
 * never existed must be indistinguishable, or the endpoint becomes a probe for
 * which memberships exist.
 */
export async function acceptInvitation(
  userId: string,
  token: string,
  metadata: RequestMetadata,
): Promise<InvitationView & { status: MembershipStatus }> {
  const membershipId = readInvitationToken(token);
  if (!membershipId) throw new NotFoundError('Invitation');

  const accepted = await sequelize.transaction(async (transaction) => {
    const membership = await Membership.findOne({
      where: { id: membershipId, userId, status: 'INVITED' },
      include: [
        {
          model: Business,
          as: 'business',
          required: true,
          attributes: ['id', 'name', 'slug', 'status'],
        },
        { model: Role, as: 'role', required: true, attributes: ['id', 'key', 'name'] },
      ],
      transaction,
    });
    if (!membership) throw new NotFoundError('Invitation');

    const business = membership.get('business') as Business;
    if (business.status !== 'ACTIVE') {
      throw new ConflictError(
        'That workspace is not currently active. Ask its owner to reactivate it.',
        ErrorCode.CONFLICT,
      );
    }

    await membership.update({ status: 'ACTIVE', joinedAt: new Date() }, { transaction });

    // Accepting proves control of the mailbox the invitation was sent to, which
    // is the same thing email verification proves. `verifyEmail` promotes an
    // INVITED account for exactly that reason; mirroring it here stops an
    // invited colleague being left in a status they can never leave, because
    // nothing ever sent them a verification link.
    const user = await User.findByPk(membership.userId, { transaction });
    if (user && user.status === 'INVITED') {
      await user.update({ status: 'ACTIVE' }, { transaction });
    }

    await recordAudit(
      {
        businessId: business.id,
        actorType: 'USER',
        actorUserId: userId,
        actorLabel: user?.email ?? null,
        action: AuditActions.MEMBERSHIP_UPDATED,
        entityType: 'membership',
        entityId: membership.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { change: 'invitation_accepted', roleId: membership.roleId },
      },
      { transaction },
    );

    log.info(
      { businessId: business.id, membershipId: membership.id },
      'membership invitation accepted',
    );

    const role = membership.get('role') as Role;
    return {
      membershipId: membership.id,
      businessId: business.id,
      businessName: business.name,
      businessSlug: business.slug,
      role: { id: role.id, key: role.key, name: role.name },
      invitedAt: membership.invitedAt,
      // Spent: the membership has left INVITED, so replaying it finds nothing.
      token,
      status: membership.status,
    };
  });

  return accepted;
}
