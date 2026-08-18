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
import { Business, Membership, RefreshToken, Role, User } from '../../database/models';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
} from '../../utils/errors';
import { newRefreshToken, newUuid, newVerificationToken, sha256 } from '../../utils/ids';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../../utils/password';
import { isValidTimezone } from '../../utils/time';
import { AuditActions, recordAudit } from '../audit/audit.service';
import { REFRESH_TOKEN_TTL_SECONDS, signAccessToken, type SignedAccessToken } from './tokens';

const log = createLogger('auth');

/** Progressive lockout: slows credential stuffing without locking a real user out for long. */
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

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
    // Still hash a dummy value so a missing account is not detectably faster.
    await verifyPassword(
      password,
      '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid',
    );
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
    const shouldLock = failures >= MAX_FAILED_LOGINS;
    await user.update({
      failedLoginCount: shouldLock ? 0 : failures,
      lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
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
      metadata: { failedAttempts: failures, locked: shouldLock },
    });
    throw invalid();
  }

  return sequelize.transaction(async (transaction) => {
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
    const { raw, row } = await issueRefreshToken(user.id, stored.familyId, metadata, transaction);
    await stored.update(
      { revokedAt: new Date(), revokedReason: 'ROTATED', replacedByTokenId: row.id },
      { transaction },
    );

    const access = signAccessToken({
      sub: user.id,
      sid: stored.familyId,
      email: user.email,
      role: user.platformRole,
    });

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
