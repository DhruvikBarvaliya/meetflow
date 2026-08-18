/**
 * Access-token authentication.
 *
 * Establishes *who* is calling. It deliberately says nothing about which
 * workspace they may touch — that is `requireTenant`'s job, and separating the
 * two is what stops "logged in" from ever being mistaken for "authorised".
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Op } from 'sequelize';
import { User } from '../database/models';
import { ErrorCode, ForbiddenError, UnauthenticatedError } from '../utils/errors';
import { RefreshToken } from '../database/models';
import { extractBearerToken, verifyAccessToken } from '../modules/auth/tokens';

async function resolveAuth(token: string): Promise<Request['auth']> {
  const claims = verifyAccessToken(token);

  // The token proves the claims were signed by us; it does not prove the
  // account is still usable. Suspended and deleted accounts must lose access
  // immediately, not when their 15-minute token happens to expire.
  const user = await User.findByPk(claims.sub);
  if (!user) {
    throw new UnauthenticatedError('This account no longer exists.', ErrorCode.TOKEN_INVALID);
  }
  if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
    throw new ForbiddenError('This account is not active.');
  }

  // Logout-all revokes the whole token family. Honouring that here is what
  // makes a global sign-out effective against live access tokens rather than
  // only against future refreshes.
  const liveSession = await RefreshToken.count({
    where: { familyId: claims.sid, revokedAt: { [Op.is]: null } },
  });
  if (liveSession === 0) {
    throw new UnauthenticatedError(
      'Your session has ended. Please sign in again.',
      ErrorCode.TOKEN_REVOKED,
    );
  }

  return {
    userId: user.id,
    email: user.email,
    platformRole: user.platformRole,
    sessionId: claims.sid,
    isPlatformAdmin: user.platformRole === 'ADMIN',
  };
}

/** Rejects the request unless a valid access token is present. */
export const authenticate: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const token = extractBearerToken(req.header('authorization'));
    if (!token) {
      throw new UnauthenticatedError('An access token is required for this endpoint.');
    }
    req.auth = await resolveAuth(token);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Populates `req.auth` when a token is present and valid, and continues
 * anonymously otherwise. Used on public booking routes, where a signed-in
 * customer gets a personalised experience but anonymous booking still works.
 */
export const optionalAuthenticate: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const token = extractBearerToken(req.header('authorization'));
  if (!token) {
    next();
    return;
  }
  try {
    req.auth = await resolveAuth(token);
  } catch {
    // An invalid token on an optional route is simply "not signed in"; failing
    // the request would break anonymous booking for anyone with a stale token.
  }
  next();
};

/** Platform administration endpoints. Never a substitute for tenant scoping. */
export const requirePlatformAdmin: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (!req.auth) {
    next(new UnauthenticatedError());
    return;
  }
  if (!req.auth.isPlatformAdmin) {
    next(new ForbiddenError('This endpoint requires platform administrator access.'));
    return;
  }
  next();
};
