/**
 * JWT issuing and verification.
 *
 * Strategy (see docs/ADR/0001-jwt-strategy.md):
 *  - Short-lived **access token** (default 15m), stateless, carries only
 *    identity — never permissions. Permissions are re-read per request so a
 *    revoked role takes effect immediately instead of at token expiry.
 *  - Long-lived **refresh token**, opaque and random (not a JWT), stored only
 *    as a SHA-256 digest, rotated on every use, grouped into a family so that
 *    replaying a rotated token revokes every descendant.
 */
import { randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env';
import { ErrorCode, UnauthenticatedError } from '../../utils/errors';

/**
 * Access-token claims.
 *
 * Deliberately minimal. Putting roles or permissions in the token would make
 * them stale for up to the token's lifetime, which is exactly the window an
 * attacker wants after an admin revokes access.
 */
export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Token type discriminator; refuses a refresh token used as an access token. */
  typ: 'access';
  /** Session/rotation family, so logout-all can invalidate live access tokens. */
  sid: string;
  /**
   * Unique token id.
   *
   * Without it, two tokens minted for the same user inside the same second are
   * byte-identical (JWT `iat` has one-second resolution), which makes an
   * individual token impossible to identify in logs or to deny-list later.
   */
  jti: string;
  email: string;
  /** Platform role only — workspace authority comes from the membership. */
  role: 'ADMIN' | 'USER';
}

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

function durationToSeconds(value: string): number {
  const match = /^(\d+)([smhdw])?$/.exec(value);
  if (!match) throw new Error(`Unsupported duration "${value}"`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };
  return amount * (multipliers[unit] ?? 1);
}

export const ACCESS_TOKEN_TTL_SECONDS = durationToSeconds(env.JWT_ACCESS_EXPIRES_IN);
export const REFRESH_TOKEN_TTL_SECONDS = durationToSeconds(env.JWT_REFRESH_EXPIRES_IN);

export function signAccessToken(claims: Omit<AccessTokenClaims, 'typ' | 'jti'>): SignedAccessToken {
  const options: SignOptions = {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    algorithm: 'HS256',
    jwtid: randomUUID(),
  };
  const token = jwt.sign({ ...claims, typ: 'access' }, env.JWT_ACCESS_SECRET, options);
  return {
    token,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/**
 * Verifies an access token's signature, lifetime, issuer, audience and type.
 *
 * Errors are mapped to distinct codes so the client can tell "refresh me" from
 * "log in again", but the messages stay generic — a verification failure must
 * not describe *why* it failed in a way that helps forge a token.
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    });

    if (typeof payload === 'string' || payload === null) {
      throw new UnauthenticatedError('Invalid access token.', ErrorCode.TOKEN_INVALID);
    }
    const claims = payload as unknown as AccessTokenClaims;
    if (claims.typ !== 'access') {
      throw new UnauthenticatedError('Invalid access token.', ErrorCode.TOKEN_INVALID);
    }
    if (!claims.sub || !claims.sid) {
      throw new UnauthenticatedError('Invalid access token.', ErrorCode.TOKEN_INVALID);
    }
    return claims;
  } catch (error) {
    if (error instanceof UnauthenticatedError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthenticatedError('Your session has expired.', ErrorCode.TOKEN_EXPIRED);
    }
    throw new UnauthenticatedError('Invalid access token.', ErrorCode.TOKEN_INVALID);
  }
}

/** Extracts a bearer token, tolerating extra whitespace but nothing else. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}

/** Cookie used for the refresh token in browser clients. */
export const REFRESH_COOKIE_NAME = 'meetflow_rt';

/**
 * Cookie attributes for the refresh token.
 *
 * httpOnly keeps it away from XSS, sameSite=lax stops cross-site POSTs from
 * silently refreshing a session, and the path restriction means it is only ever
 * sent to the two endpoints that need it.
 */
export function refreshCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: env.APP_ENV === 'production',
    sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  };
}
