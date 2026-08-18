/**
 * Request augmentation.
 *
 * `req.auth` and `req.tenant` are populated exclusively by the authenticate and
 * tenant middlewares. Nothing else in the codebase may assign to them, and no
 * handler may read a tenant id from the body, query or a header — that is what
 * keeps tenant isolation a server-side decision.
 */
import type { AuthContext, PublicBookingContext, TenantContext } from '../modules/auth/context';

declare global {
  namespace Express {
    interface Request {
      // NOTE: `id` is intentionally NOT declared here. pino-http already
      // augments Express.Request with `id: ReqId` (string | number); declaring
      // a narrower `string` would conflict with it. Use `requestIdOf(req)` from
      // middleware/requestContext.ts wherever the id is needed as a string.

      /** Present once `authenticate` has run successfully. */
      auth?: AuthContext;
      /** Present once `requireTenant` has resolved an active membership. */
      tenant?: TenantContext;
      /** Present on public booking routes after the link has been validated. */
      publicBooking?: PublicBookingContext;
      /** Millisecond timestamp captured when the request entered the app. */
      startedAt?: number;
    }
  }
}

export {};
