/**
 * `/api/v1/auth`
 *
 * Every credential-handling route sits behind `credentialRateLimit`, which is a
 * pair of buckets and not one: a per-IP+email bucket that stops many passwords
 * being tried at one account, and a wider per-IP bucket that stops one password
 * being tried at many accounts. Either alone leaves the other attack wide open,
 * so routes here mount the pair — never a single bucket by name.
 *
 * `/logout` takes the per-IP bucket only. It carries no email, so the per-email
 * resolver would collapse every logout from an address into one shared
 * "anonymous" bucket and throttle a busy office far harder than intended; what
 * it actually needs protecting from is bulk probing of the unauthenticated
 * token lookup it performs, which is a per-IP concern.
 */
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authIpRateLimit, credentialRateLimit } from '../../middleware/rateLimit';
import { optionalTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import * as controller from './auth.controller';
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.validation';

export const authRouter = Router();

authRouter.get('/password-policy', controller.passwordPolicy);

// Registration needs the per-IP bucket as much as login does: without it a
// single host can create accounts without bound, because each new address it
// submits opens a fresh per-email bucket.
authRouter.post(
  '/register',
  credentialRateLimit,
  validate({ body: registerSchema }),
  controller.register,
);

authRouter.post('/login', credentialRateLimit, validate({ body: loginSchema }), controller.login);

// Refresh is rate limited too: it is the endpoint an attacker with a stolen
// token would hammer, and reuse detection is cheaper when it is not flooded.
authRouter.post(
  '/refresh',
  credentialRateLimit,
  validate({ body: refreshSchema }),
  controller.refresh,
);

authRouter.post('/logout', authIpRateLimit, validate({ body: refreshSchema }), controller.logout);

authRouter.post('/logout-all', authenticate, controller.logoutAll);

/**
 * `optionalTenant`, never `requireTenant`.
 *
 * This router is mounted straight onto `apiRouter`, above the management chain,
 * so nothing here passes through tenant resolution on its own. Without this
 * line `req.tenant` is unset on every single request and `activeWorkspace` is
 * unconditionally null — which is what made the field's documented condition
 * unsatisfiable and left the client mirroring the role catalogue itself.
 *
 * `requireTenant` is the wrong tool: it answers 404 to anyone without an ACTIVE
 * membership, and this endpoint must keep answering for exactly those callers —
 * a customer, or an invitee who has not accepted yet. The optional variant
 * resolves a workspace when the caller has one and says nothing when they do
 * not.
 */
authRouter.get('/me', authenticate, optionalTenant, controller.me);

authRouter.post(
  '/verify-email',
  credentialRateLimit,
  validate({ body: verifyEmailSchema }),
  controller.verifyEmail,
);

authRouter.post(
  '/password-reset/request',
  credentialRateLimit,
  validate({ body: requestPasswordResetSchema }),
  controller.requestPasswordReset,
);

authRouter.post(
  '/password-reset/confirm',
  credentialRateLimit,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);

authRouter.post(
  '/change-password',
  authenticate,
  credentialRateLimit,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);
