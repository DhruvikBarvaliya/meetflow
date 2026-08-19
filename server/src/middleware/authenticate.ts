/**
 * Access-token authentication.
 *
 * Establishes *who* is calling. It deliberately says nothing about which
 * workspace they may touch — that is `requireTenant`'s job, and separating the
 * two is what stops "logged in" from ever being mistaken for "authorised".
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Op } from 'sequelize';
import { env } from '../config/env';
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
    emailVerified: user.emailVerifiedAt !== null,
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

/**
 * Refuses a caller whose email address has never been confirmed.
 *
 * Applied to the tenant-scoped management API and the customer portal, and
 * deliberately **not** to `/api/v1/auth`. That asymmetry is the whole design:
 * the way out of this refusal is a link sent to the address in question, so a
 * caller who is turned away must still be able to sign in, see what state they
 * are in, ask for a new link, and use one. Blocking at login instead would put
 * the only recovery path behind the thing being recovered.
 *
 * Public booking is unaffected — it is unauthenticated, and a customer booking
 * an appointment has no MeetFlow account to verify.
 *
 * `ErrorCode.EMAIL_NOT_VERIFIED` rather than the generic permission code
 * because a client has to tell "you may not do this" from "do this one thing
 * first"; conflating them renders a dead end where a link belongs.
 */
export const requireVerifiedEmail: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (!req.auth) {
    next(new UnauthenticatedError());
    return;
  }
  // The switch exists so a private deployment can run without outbound mail.
  // `env.ts` refuses to start with it off in production.
  if (!env.REQUIRE_EMAIL_VERIFICATION || req.auth.emailVerified) {
    next();
    return;
  }
  next(
    new ForbiddenError(
      'Confirm your email address to finish setting up your account. We sent a link when you registered — ask for another if you no longer have it.',
      ErrorCode.EMAIL_NOT_VERIFIED,
    ),
  );
};
