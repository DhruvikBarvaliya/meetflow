/**
 * Authentication.
 *
 * Refresh-token rotation with reuse detection is the core of the design:
 * every refresh mints a new token and revokes the old one, and presenting an
 * already-rotated token is treated as evidence of theft — the whole token
 * family is revoked immediately, logging the attacker *and* the victim out.
 */
import { Op, type Transaction } from 'sequelize';
import { createLogger } from '../../config/logger';
import { sequelize } from '../../config/database';
import { Business, Customer, Membership, RefreshToken, Role, User } from '../../database/models';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../utils/errors';
import { newRefreshToken, newUuid, newVerificationToken, sha256 } from '../../utils/ids';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../../utils/password';
import { isValidTimezone } from '../../utils/time';
import { AuditActions, recordAudit } from '../audit/audit.service';
import { REFRESH_TOKEN_TTL_SECONDS, signAccessToken, type SignedAccessToken } from './tokens';

const log = createLogger('auth');

/**
 * Progressive lockout.
 *
 * `failedLoginCount` is a running total that survives a lockout. Only a
 * successful sign-in — or a completed password reset, which proves control of
 * the mailbox — clears it. Every `FAILURES_PER_LOCKOUT` further failures
 * therefore lands on the next rung of the ladder below, so an attacker who
 * politely waits out a lock finds the following one longer rather than
 * identical.
 *
 * This is the part that used to be missing. Zeroing the counter at lockout time
 * (which is what the code did while this comment already said "progressive")
 * made the ladder a permanently flat eight guesses per fifteen minutes — around
 * 768 guesses per account per day, sustainable indefinitely, which is well
 * inside the range where a weak password falls.
 *
 * The trade-off runs the other way too, and the schedule is chosen for it. A
 * legitimate user who has genuinely forgotten their password can climb these
 * rungs, so the ladder starts at fifteen minutes — short enough to simply wait
 * out — and is capped at twelve hours rather than growing without bound, so a
 * forgetful user is never locked out for longer than roughly a sleep. Past the
 * cap the ladder repeats. Self-service recovery is always available regardless
 * of position on the ladder: `resetPassword` clears the counter and the lock
 * together, and that flow is the intended escape hatch rather than a support
 * ticket.
 */
const FAILURES_PER_LOCKOUT = 8;
const LOCKOUT_LADDER_MINUTES = [15, 60, 360, 720] as const;

/**
 * The lock this failure has just earned, or null if it earns none.
 *
 * `failures` is the running total *including* the failure being recorded, so a
 * lock fires on each exact multiple of `FAILURES_PER_LOCKOUT` and the rung is
 * chosen by how many locks have already been served.
 */
function lockoutUntil(failures: number): Date | null {
  if (failures < FAILURES_PER_LOCKOUT || failures % FAILURES_PER_LOCKOUT !== 0) return null;
  const rung = Math.min(failures / FAILURES_PER_LOCKOUT - 1, LOCKOUT_LADDER_MINUTES.length - 1);
  return new Date(Date.now() + LOCKOUT_LADDER_MINUTES[rung]! * 60_000);
}

/**
 * A genuine bcrypt digest of a value nobody holds, compared against on a
 * sign-in for an address that has no account.
 *
 * It has to be a *parseable* digest. The literal that used to sit inline at the
 * call site ('$2a$12$invalid…') is 63 characters, and bcryptjs rejects anything
 * that is not exactly 60 outright — so the comparison returned false in well
 * under a millisecond while a real account cost ~300ms of key stretching. The
 * comment claiming constant time was, in practice, describing a clean
 * account-enumeration oracle readable off a stopwatch, and enumerating live
 * addresses is the first half of a password-spraying run.
 *
 * Started at import and awaited per call: computing it eagerly costs one hash
 * per process rather than one per unknown-address sign-in, and the promise has
 * always resolved long before the first request lands.
 */
const DUMMY_PASSWORD_HASH: Promise<string> = hashPassword(newRefreshToken());

export interface RequestMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuthResult {
  user: Record<string, unknown>;
  accessToken: string;
  /** Raw refresh token. Returned to the caller once and never stored in clear. */
  refreshToken: string;
  expiresIn: number;
  expiresAt: Date;
}

function buildResult(user: User, access: SignedAccessToken, refreshToken: string): AuthResult {
  return {
    user: user.toPublicJSON(),
    accessToken: access.token,
    refreshToken,
    expiresIn: access.expiresInSeconds,
    expiresAt: access.expiresAt,
  };
}

/**
 * Issues a refresh token belonging to `familyId`, storing only its digest.
 * A new family is started at login; a rotation continues the existing one.
 */
async function issueRefreshToken(
  userId: string,
  familyId: string,
  metadata: RequestMetadata,
  transaction?: Transaction,
): Promise<{ raw: string; row: RefreshToken }> {
  const raw = newRefreshToken();
  const row = await RefreshToken.create(
    {
      userId,
      tokenHash: sha256(raw),
      familyId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      userAgent: metadata.userAgent?.slice(0, 500) ?? null,
      ipAddress: metadata.ipAddress ?? null,
      revokedAt: null,
      revokedReason: null,
      replacedByTokenId: null,
    },
    { transaction },
  );
  return { raw, row };
}

async function revokeFamily(
  familyId: string,
  reason: 'REUSE_DETECTED' | 'LOGOUT_ALL' | 'PASSWORD_CHANGED' | 'ADMIN_REVOKED',
  transaction?: Transaction,
): Promise<number> {
  const [count] = await RefreshToken.update(
    { revokedAt: new Date(), revokedReason: reason },
    { where: { familyId, revokedAt: { [Op.is]: null } }, transaction },
  );
  return count;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  timezone?: string;
}

export async function register(
  input: RegisterInput,
  metadata: RequestMetadata,
): Promise<AuthResult & { emailVerificationToken: string }> {
  const strength = checkPasswordStrength(input.password);
  if (!strength.valid) {
    throw new ValidationError(
      'That password does not meet the security policy.',
      strength.problems.map((message) => ({ field: 'password', message })),
    );
  }
  if (input.timezone && !isValidTimezone(input.timezone)) {
    throw new ValidationError('Invalid timezone.', [
      { field: 'timezone', message: 'Must be an IANA timezone identifier such as Asia/Kolkata.' },
    ]);
  }

  const email = input.email.trim().toLowerCase();
  const existing = await User.findOne({ where: { email }, paranoid: false });
  if (existing) {
    // Registration is a public endpoint, so it must not confirm which addresses
    // already have accounts beyond what the UX genuinely requires.
    throw new ConflictError(
      'That email address cannot be used to register.',
      ErrorCode.ALREADY_EXISTS,
    );
  }

  const verificationToken = newVerificationToken();

  const result = await sequelize.transaction(async (transaction) => {
    const user = await User.create(
      {
        email,
        passwordHash: await hashPassword(input.password),
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        phone: input.phone?.trim() ?? null,
        avatarUrl: null,
        timezone: input.timezone ?? 'UTC',
        emailVerifiedAt: null,
        emailVerificationTokenHash: sha256(verificationToken),
        emailVerificationSentAt: new Date(),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        lastLoginAt: null,
        lockedUntil: null,
      },
      { transaction },
    );

    const familyId = newUuid();
    const { raw } = await issueRefreshToken(user.id, familyId, metadata, transaction);
    const access = signAccessToken({
      sub: user.id,
      sid: familyId,
      email: user.email,
      role: user.platformRole,
    });

    await recordAudit(
      {
        actorType: 'USER',
        actorUserId: user.id,
        actorLabel: user.email,
        action: AuditActions.USER_REGISTERED,
        entityType: 'user',
        entityId: user.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
      },
      { transaction },
    );

    return buildResult(user, access, raw);
  });

  return { ...result, emailVerificationToken: verificationToken };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function login(
  email: string,
  password: string,
  metadata: RequestMetadata,
): Promise<AuthResult> {
  const normalised = email.trim().toLowerCase();
  const user = await User.scope('withSecrets').findOne({ where: { email: normalised } });

  // Identical response whether the account is missing or the password is wrong.
  const invalid = () =>
    new UnauthenticatedError('Incorrect email address or password.', ErrorCode.INVALID_CREDENTIALS);

  if (!user) {
    // Burn the same bcrypt work a real account would have cost, so a missing
    // account is not detectably faster. See DUMMY_PASSWORD_HASH.
    await verifyPassword(password, await DUMMY_PASSWORD_HASH);
    await recordAudit({
      actorType: 'PUBLIC',
      actorLabel: normalised,
      action: AuditActions.USER_LOGIN_FAILED,
      entityType: 'user',
      requestId: metadata.requestId,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      metadata: { reason: 'unknown_account' },
    });
    throw invalid();
  }

  if (user.isLocked) {
    await recordAudit({
      actorType: 'USER',
      actorUserId: user.id,
      actorLabel: user.email,
      action: AuditActions.USER_LOGIN_BLOCKED,
      entityType: 'user',
      entityId: user.id,
      requestId: metadata.requestId,
      ipAddress: metadata.ipAddress,
      metadata: { lockedUntil: user.lockedUntil },
    });
    throw new ForbiddenError(
      'This account is temporarily locked after too many failed sign-in attempts. Try again shortly.',
      ErrorCode.FORBIDDEN,
      { lockedUntil: user.lockedUntil },
    );
  }

  if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
    throw new ForbiddenError('This account is not active. Contact your administrator.');
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash);
  if (!passwordMatches) {
    const failures = user.failedLoginCount + 1;
    const lockedUntil = lockoutUntil(failures);
    await user.update({
      // The count is never reset here — that is what makes the ladder escalate.
      failedLoginCount: failures,
      // Safe to clear on a non-locking failure: an *unexpired* lock never
      // reaches this line, because `user.isLocked` above returns first. The
      // only lock that can be standing here is one that has already run out.
      lockedUntil,
    });
    await recordAudit({
      actorType: 'USER',
      actorUserId: user.id,
      actorLabel: user.email,
      action: AuditActions.USER_LOGIN_FAILED,
      entityType: 'user',
      entityId: user.id,
      requestId: metadata.requestId,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      metadata: { failedAttempts: failures, locked: lockedUntil !== null, lockedUntil },
    });
    throw invalid();
  }

  return sequelize.transaction(async (transaction) => {
    // The only place the lockout ladder is reset. Proving knowledge of the
    // password is the single event that says the preceding failures were a
    // human misremembering rather than someone guessing.
    await user.update(
      { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      { transaction },
    );

    const familyId = newUuid();
    const { raw } = await issueRefreshToken(user.id, familyId, metadata, transaction);
    const access = signAccessToken({
      sub: user.id,
      sid: familyId,
      email: user.email,
      role: user.platformRole,
    });

    await recordAudit(
      {
        actorType: 'USER',
        actorUserId: user.id,
        actorLabel: user.email,
        action: AuditActions.USER_LOGIN_SUCCEEDED,
        entityType: 'user',
        entityId: user.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
      },
      { transaction },
    );

    return buildResult(user, access, raw);
  });
}

// ---------------------------------------------------------------------------
// Refresh (rotation + reuse detection)
// ---------------------------------------------------------------------------

export async function refresh(
  presentedToken: string,
  metadata: RequestMetadata,
): Promise<AuthResult> {
  const tokenHash = sha256(presentedToken);
  const stored = await RefreshToken.findOne({ where: { tokenHash } });

  if (!stored) {
    throw new UnauthenticatedError(
      'Invalid session. Please sign in again.',
      ErrorCode.TOKEN_INVALID,
    );
  }

  if (stored.revokedAt !== null) {
    // The token was already rotated or revoked, yet someone still holds it.
    // Either it leaked, or a client raced itself; both are handled the same
    // way — burn the family. Losing a session is far cheaper than allowing a
    // stolen token to mint fresh credentials indefinitely.
    const revoked = await revokeFamily(stored.familyId, 'REUSE_DETECTED');
    log.warn(
      { userId: stored.userId, familyId: stored.familyId, revoked },
      'refresh token reuse detected — family revoked',
    );
    await recordAudit({
      actorType: 'USER',
      actorUserId: stored.userId,
      action: AuditActions.USER_TOKEN_REUSE_DETECTED,
      entityType: 'refresh_token',
      entityId: stored.id,
      requestId: metadata.requestId,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      metadata: { familyId: stored.familyId, sessionsRevoked: revoked },
    });
    throw new UnauthenticatedError(
      'Your session was ended for security reasons. Please sign in again.',
      ErrorCode.TOKEN_REVOKED,
    );
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    await stored.update({ revokedAt: new Date(), revokedReason: 'EXPIRED' });
    throw new UnauthenticatedError('Your session has expired.', ErrorCode.TOKEN_EXPIRED);
  }

  const user = await User.findByPk(stored.userId);
  if (!user || user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
    await revokeFamily(stored.familyId, 'ADMIN_REVOKED');
    throw new UnauthenticatedError('This account is no longer active.', ErrorCode.TOKEN_REVOKED);
  }

  return sequelize.transaction(async (transaction) => {
    /*
     * Spend the presented token with a conditional UPDATE, before minting its
     * replacement.
     *
     * The check above reads `revokedAt` and this writes it, and between the two
     * another request holding the same token can do exactly the same thing.
     * With a plain `update()` both won: five parallel refreshes of one token
     * returned five live tokens in one family, nobody was logged out, and the
     * reuse detection that is supposed to catch a stolen token never fired —
     * so a thief racing the legitimate user got a working session and no alarm.
     * The client's single-flight guard hid it, which is precisely why it needs
     * closing here as well: the server cannot depend on a client behaving.
     *
     * `WHERE id = … AND revoked_at IS NULL` makes the spend atomic. PostgreSQL
     * serialises the two updates on the row, and the loser's count comes back
     * zero.
     */
    const [spent] = await RefreshToken.update(
      { revokedAt: new Date(), revokedReason: 'ROTATED' },
      { where: { id: stored.id, revokedAt: { [Op.is]: null } }, transaction },
    );

    if (spent === 0) {
      /*
       * Someone else spent it in the moment between the read and this write.
       *
       * Deliberately NOT treated as reuse. Theft is a token presented after it
       * was rotated — caught by the `revokedAt !== null` branch above, which
       * burns the family. This is the same token arriving twice at once, which
       * is a client refreshing from several tabs, and burning the family for
       * that would log a legitimate user out for having two windows open.
       * Refusing this one attempt is enough; the winner's token is live and the
       * client will pick it up.
       */
      log.info(
        { userId: stored.userId, familyId: stored.familyId },
        'refresh lost the rotation race — refused without burning the family',
      );
      throw new UnauthenticatedError(
        'That session token has already been used. Please try again.',
        ErrorCode.TOKEN_REVOKED,
      );
    }

    const { raw, row } = await issueRefreshToken(user.id, stored.familyId, metadata, transaction);
    await stored.update({ replacedByTokenId: row.id }, { transaction });

    const access = signAccessToken({
      sub: user.id,
      sid: stored.familyId,
      email: user.email,
      role: user.platformRole,
    });

    // Inside the transaction, like every other audit row that describes a
    // change: the rotation and the record of it commit together or not at all.
    //
    // A successful refresh is worth recording even though nothing "happened" to
    // the account. Reuse detection already writes a row, and on its own that
    // leaves an investigator with the alarm and none of the history: which
    // device had been rotating this family, from which address, and how
    // recently. The pair is what makes a burnt family readable after the fact.
    await recordAudit(
      {
        actorType: 'USER',
        actorUserId: user.id,
        actorLabel: user.email,
        action: AuditActions.USER_TOKEN_REFRESHED,
        entityType: 'refresh_token',
        // The token that now exists, not the one being retired — the row names
        // the session as it stands after the call.
        entityId: row.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        metadata: { familyId: stored.familyId, rotatedFrom: stored.id },
      },
      { transaction },
    );

    return buildResult(user, access, raw);
  });
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function logout(presentedToken: string, metadata: RequestMetadata): Promise<void> {
  const stored = await RefreshToken.findOne({ where: { tokenHash: sha256(presentedToken) } });
  // Logging out with an unknown or already-dead token is a success: the caller
  // asked for the session to be gone, and it is.
  if (!stored || stored.revokedAt !== null) return;

  await stored.update({ revokedAt: new Date(), revokedReason: 'LOGOUT' });
  await recordAudit({
    actorType: 'USER',
    actorUserId: stored.userId,
    action: AuditActions.USER_LOGGED_OUT,
    entityType: 'refresh_token',
    entityId: stored.id,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
  });
}

export async function logoutAllSessions(
  userId: string,
  metadata: RequestMetadata,
): Promise<number> {
  const [count] = await RefreshToken.update(
    { revokedAt: new Date(), revokedReason: 'LOGOUT_ALL' },
    { where: { userId, revokedAt: { [Op.is]: null } } },
  );
  await recordAudit({
    actorType: 'USER',
    actorUserId: userId,
    action: AuditActions.USER_LOGGED_OUT_ALL,
    entityType: 'user',
    entityId: userId,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
    metadata: { sessionsRevoked: count },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Email verification and password management
// ---------------------------------------------------------------------------

/** How long a fresh verification link must wait behind the last one. */
const VERIFICATION_RESEND_COOLDOWN_MS = 60_000;

export interface ResendOutcome {
  /** Present only when a new link was actually issued. */
  token: string | null;
  firstName: string;
  email: string;
  userId: string;
}

/**
 * Issues a fresh verification link, or declines to without saying so.
 *
 * Enforcement makes this endpoint load-bearing rather than a convenience: the
 * only way past the gate is a link, so an account whose link was lost has no
 * other route back. That also makes it the obvious thing to abuse, hence the
 * cooldown — a caller holding a valid session can otherwise mail-bomb the
 * address on the account, which for a mistyped registration is a stranger's
 * inbox.
 *
 * Returns `token: null` for an account that is already verified and for one
 * inside the cooldown, and the controller answers the same 202 either way. The
 * caller is authenticated, so this is not an enumeration defence; it is a
 * refusal to confirm *timing*, and it keeps the endpoint from becoming a way to
 * ask "has this account verified yet" repeatedly.
 *
 * A new token replaces the old one. Two live links for one address means the
 * first one somebody clicks wins and the other silently fails, which reads to
 * the user as "the link is broken".
 */
export async function resendEmailVerification(
  userId: string,
  metadata: RequestMetadata,
): Promise<ResendOutcome> {
  const user = await User.scope('withSecrets').findByPk(userId);
  if (!user) throw new NotFoundError('Account');

  const base = { firstName: user.firstName, email: user.email, userId: user.id };
  if (user.emailVerifiedAt !== null) return { ...base, token: null };

  const lastSent = user.emailVerificationSentAt?.getTime() ?? 0;
  if (Date.now() - lastSent < VERIFICATION_RESEND_COOLDOWN_MS) {
    log.info({ userId }, 'verification resend declined — inside the cooldown');
    return { ...base, token: null };
  }

  const token = newVerificationToken();
  await user.update({
    emailVerificationTokenHash: sha256(token),
    emailVerificationSentAt: new Date(),
  });

  await recordAudit({
    actorType: 'USER',
    actorUserId: user.id,
    actorLabel: user.email,
    action: AuditActions.USER_EMAIL_VERIFICATION_RESENT,
    entityType: 'user',
    entityId: user.id,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
  });

  return { ...base, token };
}

export async function verifyEmail(token: string, metadata: RequestMetadata): Promise<void> {
  const user = await User.scope('withSecrets').findOne({
    where: { emailVerificationTokenHash: sha256(token) },
  });
  if (!user) {
    throw new ValidationError('That verification link is invalid or has already been used.');
  }

  await user.update({
    emailVerifiedAt: new Date(),
    emailVerificationTokenHash: null,
    status: user.status === 'INVITED' ? 'ACTIVE' : user.status,
  });

  await recordAudit({
    actorType: 'USER',
    actorUserId: user.id,
    actorLabel: user.email,
    action: AuditActions.USER_EMAIL_VERIFIED,
    entityType: 'user',
    entityId: user.id,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
  });
}

/**
 * Starts a password reset.
 *
 * Always resolves, and always in comparable time, whether or not the address
 * exists — otherwise this endpoint becomes an account-enumeration oracle. The
 * token is returned to the caller (the notification layer), never to the client.
 */
export async function requestPasswordReset(
  email: string,
  metadata: RequestMetadata,
): Promise<{ user: User; token: string } | null> {
  const user = await User.findOne({ where: { email: email.trim().toLowerCase() } });
  if (!user) return null;

  const token = newVerificationToken();
  await user.update({
    passwordResetTokenHash: sha256(token),
    passwordResetExpiresAt: new Date(Date.now() + 60 * 60_000),
  });

  await recordAudit({
    actorType: 'USER',
    actorUserId: user.id,
    actorLabel: user.email,
    action: AuditActions.USER_PASSWORD_RESET_REQUESTED,
    entityType: 'user',
    entityId: user.id,
    requestId: metadata.requestId,
    ipAddress: metadata.ipAddress,
  });

  return { user, token };
}

export async function resetPassword(
  token: string,
  newPassword: string,
  metadata: RequestMetadata,
): Promise<void> {
  const strength = checkPasswordStrength(newPassword);
  if (!strength.valid) {
    throw new ValidationError(
      'That password does not meet the security policy.',
      strength.problems.map((message) => ({ field: 'password', message })),
    );
  }

  const user = await User.scope('withSecrets').findOne({
    where: { passwordResetTokenHash: sha256(token) },
  });
  if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() < Date.now()) {
    throw new ValidationError('That reset link is invalid or has expired.');
  }

  await sequelize.transaction(async (transaction) => {
    await user.update(
      {
        passwordHash: await hashPassword(newPassword),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
      },
      { transaction },
    );
    // A password change invalidates every existing session: if the reset was
    // triggered by a compromise, the attacker's sessions must die with it.
    await RefreshToken.update(
      { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
      { where: { userId: user.id, revokedAt: { [Op.is]: null } }, transaction },
    );
    await recordAudit(
      {
        actorType: 'USER',
        actorUserId: user.id,
        actorLabel: user.email,
        action: AuditActions.USER_PASSWORD_RESET_COMPLETED,
        entityType: 'user',
        entityId: user.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
      },
      { transaction },
    );
  });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  metadata: RequestMetadata,
): Promise<void> {
  const user = await User.scope('withSecrets').findByPk(userId);
  if (!user) throw new UnauthenticatedError();

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new ValidationError('Your current password is incorrect.', [
      { field: 'currentPassword', message: 'Incorrect password.' },
    ]);
  }

  const strength = checkPasswordStrength(newPassword);
  if (!strength.valid) {
    throw new ValidationError(
      'That password does not meet the security policy.',
      strength.problems.map((message) => ({ field: 'newPassword', message })),
    );
  }

  await sequelize.transaction(async (transaction) => {
    await user.update({ passwordHash: await hashPassword(newPassword) }, { transaction });
    await RefreshToken.update(
      { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
      { where: { userId: user.id, revokedAt: { [Op.is]: null } }, transaction },
    );
    await recordAudit(
      {
        actorType: 'USER',
        actorUserId: user.id,
        actorLabel: user.email,
        action: AuditActions.USER_PASSWORD_CHANGED,
        entityType: 'user',
        entityId: user.id,
        requestId: metadata.requestId,
        ipAddress: metadata.ipAddress,
      },
      { transaction },
    );
  });
}

// ---------------------------------------------------------------------------
// Session introspection
// ---------------------------------------------------------------------------

/** The workspaces a user belongs to — drives the workspace switcher. */
export async function listMemberships(userId: string): Promise<
  Array<{
    membershipId: string;
    businessId: string;
    businessName: string;
    businessSlug: string;
    timezone: string;
    roleKey: string;
    roleName: string;
    status: string;
  }>
> {
  const memberships = await Membership.findAll({
    where: { userId, status: 'ACTIVE' },
    include: [
      { model: Business, as: 'business', required: true, where: { status: 'ACTIVE' } },
      { model: Role, as: 'role', required: true },
    ],
    order: [['createdAt', 'ASC']],
  });

  return memberships.map((membership) => {
    const business = membership.get('business') as Business;
    const role = membership.get('role') as Role;
    return {
      membershipId: membership.id,
      businessId: business.id,
      businessName: business.name,
      businessSlug: business.slug,
      timezone: business.timezone,
      roleKey: role.key,
      roleName: role.name,
      status: membership.status,
    };
  });
}

/**
 * How many workspaces hold a customer record for this person.
 *
 * `/auth/me` reports it because "this user has no membership" is ambiguous on
 * its own: it describes a brand-new owner who has not created their workspace
 * yet *and* a customer who will never have one. The client has to route those
 * two people to opposite places — onboarding, or their own bookings — and
 * guessing from the absence sent every new registrant into the customer portal.
 *
 * Deliberately a count rather than the records themselves. The routing decision
 * needs only "is this person a customer anywhere", and `/auth/me` is on the
 * critical path of every page load, so it must not become a second way to read
 * customer data.
 */
export async function countCustomerProfiles(userId: string): Promise<number> {
  return Customer.count({
    where: { userId },
    include: [{ model: Business, as: 'business', required: true, where: { status: 'ACTIVE' } }],
  });
}
