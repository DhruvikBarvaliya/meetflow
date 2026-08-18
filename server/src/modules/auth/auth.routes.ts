/**
 * `/api/v1/auth`
 *
 * Every credential-handling route sits behind the tight `authRateLimit` bucket,
 * which is keyed on IP *and* submitted email so neither spraying one password
 * across many accounts nor many passwords at one account gets a free pass.
 */
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authRateLimit } from '../../middleware/rateLimit';
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

authRouter.post(
  '/register',
  authRateLimit,
  validate({ body: registerSchema }),
  controller.register,
);

authRouter.post('/login', authRateLimit, validate({ body: loginSchema }), controller.login);

// Refresh is rate limited too: it is the endpoint an attacker with a stolen
// token would hammer, and reuse detection is cheaper when it is not flooded.
authRouter.post('/refresh', authRateLimit, validate({ body: refreshSchema }), controller.refresh);

authRouter.post('/logout', validate({ body: refreshSchema }), controller.logout);

authRouter.post('/logout-all', authenticate, controller.logoutAll);

authRouter.get('/me', authenticate, controller.me);

authRouter.post(
  '/verify-email',
  authRateLimit,
  validate({ body: verifyEmailSchema }),
  controller.verifyEmail,
);

authRouter.post(
  '/password-reset/request',
  authRateLimit,
  validate({ body: requestPasswordResetSchema }),
  controller.requestPasswordReset,
);

authRouter.post(
  '/password-reset/confirm',
  authRateLimit,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);

authRouter.post(
  '/change-password',
  authenticate,
  authRateLimit,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);
