/**
 * Auth HTTP layer.
 *
 * Controllers stay thin: read validated input, call the service, shape the
 * response. All business rules live in auth.service.ts.
 */
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { requestIdOf } from '../../middleware/requestContext';
import { UnauthenticatedError } from '../../utils/errors';
import { PASSWORD_POLICY } from '../../utils/password';
import { asyncHandler, sendCreated, sendNoContent, sendSuccess } from '../../utils/http';
import {
  enqueueEmailVerification,
  enqueuePasswordReset,
} from '../notifications/notification.service';
import * as authService from './auth.service';
import type {
  ChangePasswordBody,
  LoginBody,
  RefreshBody,
  RegisterBody,
  ResetPasswordBody,
} from './auth.validation';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from './tokens';

function metadataOf(req: Request): authService.RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

/**
 * Sets the refresh token as an httpOnly cookie *and* returns it in the body.
 *
 * Browser clients use the cookie (immune to XSS token theft); native and
 * server-to-server clients, which have no cookie jar, use the body value.
 */
function issueSession(res: Response, result: authService.AuthResult): Record<string, unknown> {
  res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions());
  return {
    user: result.user,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    tokenType: 'Bearer',
    expiresIn: result.expiresIn,
    expiresAt: result.expiresAt,
  };
}

function refreshTokenFrom(req: Request): string {
  const fromBody = (req.body as RefreshBody | undefined)?.refreshToken;
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
  const token = fromBody ?? fromCookie;
  if (!token) {
    throw new UnauthenticatedError('A refresh token is required.');
  }
  return token;
}

export const register = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as RegisterBody;
  const result = await authService.register(input, metadataOf(req));

  // Queued, not sent inline: a slow mail provider must not slow registration,
  // and a failed send must not roll back a created account.
  await enqueueEmailVerification({
    userId: (result.user as { id: string }).id,
    email: input.email,
    firstName: input.firstName,
    token: result.emailVerificationToken,
  });

  sendCreated(res, issueSession(res, result));
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body as LoginBody;
  const result = await authService.login(email, password, metadataOf(req));
  sendSuccess(res, issueSession(res, result));
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.refresh(refreshTokenFrom(req), metadataOf(req));
  sendSuccess(res, issueSession(res, result));
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const token =
    (req.body as RefreshBody | undefined)?.refreshToken ??
    (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
  if (token) {
    await authService.logout(token, metadataOf(req));
  }
  res.clearCookie(REFRESH_COOKIE_NAME, { ...refreshCookieOptions(), maxAge: undefined });
  sendNoContent(res);
});

export const logoutAll = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw new UnauthenticatedError();
  const revoked = await authService.logoutAllSessions(req.auth.userId, metadataOf(req));
  res.clearCookie(REFRESH_COOKIE_NAME, { ...refreshCookieOptions(), maxAge: undefined });
  sendSuccess(res, { sessionsRevoked: revoked });
});

/**
 * The user, the workspaces they belong to, and — when one of them has been
 * resolved for this request — what they may actually do in it.
 *
 * `activeWorkspace.permissions` is the server's own effective set: the role's
 * grants with per-member GRANT and DENY overrides already applied, by the same
 * `resolveEffectivePermissions` every `requirePermission` check runs through.
 * That makes this endpoint authoritative for what the UI shows, and it is meant
 * to be: any table the client keeps of its own is a second answer that can
 * disagree with the first, and a client-side copy of the role catalogue cannot
 * see overrides at all — so it would show a member controls the server will
 * refuse, and hide ones it would allow. The mirror in the client is redundant
 * from here and is due for deletion.
 *
 * Null is a real answer, not a failure: the route resolves tenant context
 * optionally, so a user with no membership — or one who belongs to several and
 * has not named which — gets their memberships back and nothing more. That list
 * is how a client learns which id to send as `X-Business-Id`.
 */
export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw new UnauthenticatedError();
  const [memberships, customerProfiles] = await Promise.all([
    authService.listMemberships(req.auth.userId),
    authService.countCustomerProfiles(req.auth.userId),
  ]);
  sendSuccess(res, {
    user: {
      id: req.auth.userId,
      email: req.auth.email,
      platformRole: req.auth.platformRole,
    },
    memberships,
    // Lets the client tell a new owner apart from a customer when neither
    // holds a membership. Without it the only signal is an absence, and an
    // absence routes both people to the same wrong place.
    customerProfiles,
    activeWorkspace: req.tenant
      ? {
          businessId: req.tenant.businessId,
          businessSlug: req.tenant.businessSlug,
          timezone: req.tenant.businessTimezone,
          roleKey: req.tenant.roleKey,
          staffProfileId: req.tenant.staffProfileId,
          permissions: [...req.tenant.permissions].sort(),
        }
      : null,
  });
});

export const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body as { token: string };
  await authService.verifyEmail(token, metadataOf(req));
  sendSuccess(res, { verified: true });
});

export const requestPasswordReset = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  const result = await authService.requestPasswordReset(email, metadataOf(req));
  if (result) {
    await enqueuePasswordReset({
      userId: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName,
      token: result.token,
    });
  }
  // Always the same answer, whether or not the address exists — this endpoint
  // must not be usable to discover which people have accounts.
  sendSuccess(res, {
    message: 'If that email address has an account, a reset link is on its way.',
  });
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, password } = req.body as ResetPasswordBody;
  await authService.resetPassword(token, password, metadataOf(req));
  res.clearCookie(REFRESH_COOKIE_NAME, { ...refreshCookieOptions(), maxAge: undefined });
  sendSuccess(res, { message: 'Your password has been changed. Please sign in again.' });
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw new UnauthenticatedError();
  const { currentPassword, newPassword } = req.body as ChangePasswordBody;
  await authService.changePassword(req.auth.userId, currentPassword, newPassword, metadataOf(req));
  res.clearCookie(REFRESH_COOKIE_NAME, { ...refreshCookieOptions(), maxAge: undefined });
  sendSuccess(res, { message: 'Your password has been changed. Please sign in again.' });
});

/** Exposed so the client can render exactly the rules the server enforces. */
export const passwordPolicy = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, { ...PASSWORD_POLICY, appUrl: env.PUBLIC_APP_URL });
});
