/**
 * API v1 router.
 *
 * Four surfaces are kept deliberately separate:
 *
 *   /api/v1/public/*  — unauthenticated booking. Tenant context comes from a
 *                       validated booking-link slug, IP rate limits are tight,
 *                       and only opaque public identifiers are ever exposed.
 *   /api/v1/admin/*   — platform administration, and the only surface that
 *                       reads across tenants. Mounted behind
 *                       `authenticate -> apiRateLimit -> requirePlatformAdmin`
 *                       and pointedly not behind `requireTenant`.
 *   /api/v1/me/*      — the customer's own bookings and contact preferences.
 *                       Authenticated, and pointedly not behind `requireTenant`
 *                       either — see the note on `customerRouter` below.
 *   /api/v1/*         — authenticated management. Mounted behind
 *                       `authenticate -> apiRateLimit -> requireTenant`, so no
 *                       handler can reach data without a proven membership.
 *
 * Mount order is load-bearing and is therefore all in this one file:
 *
 *   1. auth            (unauthenticated)
 *   2. the untenanted routers that declare their own full paths — workspace
 *      creation and invitation acceptance. Both are authenticated and both must
 *      be mounted before the management router, for the reason given at each
 *      one: `requireTenant` resolves an *ACTIVE* membership, and neither caller
 *      has one yet
 *   3. /public/*       (unauthenticated) — terminated by its own 404 so an
 *                      unknown public path can never fall through into the
 *                      authenticated chain and answer a misleading 401
 *   4. /admin/*        (platform admin) — must be mounted before the management
 *                      router, which carries no path prefix and would otherwise
 *                      swallow these requests into tenant resolution
 *   5. /me/*           (customer) — before the management router for exactly
 *                      the same reason as /admin, and terminated by its own 404
 *                      the same way
 *   6. management      (guarded at the router, not per route)
 *
 * Everything in steps 2 to 5 exists because of one property of step 6: the
 * management router is mounted at *no path prefix*, so it matches every path
 * under /api/v1. Anything registered after it is unreachable behind tenant
 * resolution. If you add a surface whose callers may hold no ACTIVE membership,
 * it belongs above that line.
 */
import { Router } from 'express';
import { authenticate, requirePlatformAdmin } from '../middleware/authenticate';
import { notFoundHandler } from '../middleware/errorHandler';
import { apiRateLimit, publicRateLimit } from '../middleware/rateLimit';
import { requireTenant } from '../middleware/tenant';
import { adminRouter } from '../modules/admin/admin.routes';
import { analyticsRouter, reportsRouter } from '../modules/analytics/analytics.routes';
import { appointmentsRouter } from '../modules/appointments/appointments.routes';
import { auditRouter } from '../modules/audit/audit.routes';
import { authRouter } from '../modules/auth/auth.routes';
import { availabilityRouter } from '../modules/availability/availability.routes';
import { bookingLinksRouter } from '../modules/bookingLinks/bookingLinks.routes';
import { businessesRouter, workspaceCreationRouter } from '../modules/businesses/business.routes';
import { customersRouter } from '../modules/customers/customers.routes';
import { customerPortalRouter } from '../modules/customers/portal.routes';
import { locationsRouter } from '../modules/locations/locations.routes';
import { memberInvitesRouter, membersRouter } from '../modules/members/members.routes';
import { resourcesRouter } from '../modules/resources/resources.routes';
import { servicesRouter } from '../modules/services/services.routes';
import { publicBookingRouter } from '../modules/publicBooking/publicBooking.routes';
import { publicWaitlistRouter } from '../modules/waitlist/publicWaitlist.routes';
import { staffRouter } from '../modules/staff/staff.routes';
import { teamsRouter } from '../modules/teams/teams.routes';
import { waitlistRouter } from '../modules/waitlist/waitlist.routes';
import { notificationTemplatesRouter } from '../modules/notifications/templates.routes';
import { webhooksRouter } from '../modules/webhooks/webhooks.routes';

export const apiRouter = Router();

/** Public booking surface. Feature routers mount onto this. */
export const publicRouter = Router();
publicRouter.use(publicRateLimit);

/**
 * Platform administration surface.
 *
 * A third router rather than another mount on `managementRouter`, and the
 * difference is `requireTenant`. A platform admin holds no membership in the
 * workspaces they administer, and tenant resolution refuses a request without
 * one — with a 404, so it cannot be used to probe which workspaces exist. Every
 * call to this surface would therefore 404 if it went through the management
 * chain. That is the whole reason it is a separate router, and the reason a
 * workspace id is an ordinary path parameter over there.
 *
 * The guard is applied to the router rather than to each route, for the same
 * reason the management surface does it: a new endpoint cannot accidentally
 * ship unguarded. Nothing in admin.routes.ts declares its own authorisation,
 * which is deliberate and documented there — this line is the only thing
 * standing between a cross-tenant read and every signed-in user.
 */
export const platformRouter = Router();
platformRouter.use(authenticate, apiRateLimit, requirePlatformAdmin);

/**
 * Customer surface.
 *
 * A fourth router, and it exists for the mirror image of the reason the
 * platform one does. An operator has no membership because they stand *above*
 * every workspace; a customer has none because they stand outside all of them —
 * they are a person who appears in one or more workspaces' address books, tied
 * to their account by `Customer.userId`. Neither identity can satisfy
 * `requireTenant`, which resolves an ACTIVE membership and answers 404 when
 * there is none. Behind the management chain this surface would 404 for exactly
 * the people it is built for, so `requireTenant` is deliberately absent here.
 *
 * There is no `requirePermission` here either, and its absence is equally
 * deliberate: permissions hang off a role attached to a membership, so a
 * customer has nothing to evaluate. The authorisation *is* the scope —
 * portal.service.ts resolves the caller's own `Customer` rows from the access
 * token and filters every query on them inside the WHERE clause, so a foreign
 * booking reference and a nonexistent one are the same 404.
 *
 * Mounted before `apiRouter.use(managementRouter)`, exactly as /admin is: the
 * management router carries no path prefix, matches /me as readily as anything
 * else, and reached first would drag every one of these requests into tenant
 * resolution.
 */
export const customerRouter = Router();
customerRouter.use(authenticate, apiRateLimit);

/**
 * Authenticated management surface.
 *
 * The guard is applied to the router rather than to each route, so a new
 * endpoint cannot accidentally ship unauthenticated.
 *
 * Consequence, and it is intentional: an unauthenticated request to an unknown
 * path under `/api/v1` answers 401 rather than 404, so the management surface
 * cannot be probed to discover which endpoints exist.
 */
export const managementRouter = Router();
managementRouter.use(authenticate, apiRateLimit, requireTenant);

// --- 1. Unauthenticated auth endpoints ------------------------------------
apiRouter.use('/auth', authRouter);

// --- 2. Authenticated, but with no workspace to resolve yet ----------------
//
// Both routers below declare their own full paths and apply their own
// `authenticate` and `apiRateLimit`, because they sit outside the management
// chain that would otherwise supply them.

// Workspace creation: authenticated, but deliberately not tenant-scoped —
// a user creating their first workspace has no membership yet.
apiRouter.use(workspaceCreationRouter);

// Invitation listing and acceptance, for the same reason in reverse: an invited
// person's membership exists but is INVITED, and `requireTenant` resolves only
// ACTIVE ones. Mounted after the management router these two paths would 404
// for every invitee, leaving them permanently unable to join the workspace that
// invited them. The rest of `/members` is tenant-scoped and mounts below.
apiRouter.use(memberInvitesRouter);

// --- 3. Public booking surface --------------------------------------------
publicRouter.use(publicBookingRouter);
// Claiming a waitlist offer belongs here rather than on the management surface:
// the person clicking the link in the offer email is a customer who may have no
// account at all, and they are addressed — as everywhere on this surface — by an
// opaque handle rather than by a row id. Unmounted, the link in every offer
// email leads nowhere, which is exactly what it did before this line existed.
publicRouter.use(publicWaitlistRouter);
// Terminator: an unknown public path must 404 here rather than falling through
// into the authenticated chain below and answering a misleading 401.
publicRouter.use(notFoundHandler);
apiRouter.use('/public', publicRouter);

// --- 4. Platform administration surface -----------------------------------
platformRouter.use(adminRouter);
// Terminator, as on the public surface: an unknown /admin path must 404 for an
// operator who has already cleared the guard, rather than falling through to
// the management router and answering whatever their own memberships imply.
platformRouter.use(notFoundHandler);
// Mounted before `apiRouter.use(managementRouter)` below, and that ordering is
// the point: the management router is mounted at no path prefix, so it matches
// /admin as readily as anything else. Reached first, it would apply
// `requireTenant` to every admin request and 404 the lot.
apiRouter.use('/admin', platformRouter);

// --- 5. Customer surface ---------------------------------------------------
customerRouter.use(customerPortalRouter);
// Terminator, as on the two surfaces above: an unknown /me path must 404 for a
// signed-in customer rather than falling through into tenant resolution, which
// would answer 404 for a quite different reason — "you belong to no workspace"
// — and make a typo look like a permissions problem.
customerRouter.use(notFoundHandler);
// Before the management router, for the same structural reason /admin is.
apiRouter.use('/me', customerRouter);

// --- 6. Authenticated management surface ----------------------------------
managementRouter.use('/workspace', businessesRouter);
managementRouter.use('/locations', locationsRouter);
managementRouter.use('/teams', teamsRouter);
managementRouter.use('/staff', staffRouter);
// `GET /members` supersedes `GET /workspace/members` — pagination, search,
// status and role filters, and a serialiser that names every field it emits —
// but the older path still answers and still returns its unpaginated array. The
// overlap is deliberate rather than accidental: retiring a path any client may
// already call is a breaking change and belongs to a release note, not to a
// wiring commit. Both are documented, with the contract saying which is which.
managementRouter.use('/members', membersRouter);
managementRouter.use('/services', servicesRouter);
managementRouter.use('/resources', resourcesRouter);
managementRouter.use('/customers', customersRouter);
managementRouter.use('/availability', availabilityRouter);
managementRouter.use('/booking-links', bookingLinksRouter);
managementRouter.use('/appointments', appointmentsRouter);
managementRouter.use('/waitlist', waitlistRouter);
managementRouter.use('/webhooks', webhooksRouter);
managementRouter.use('/notification-templates', notificationTemplatesRouter);
managementRouter.use('/analytics', analyticsRouter);
managementRouter.use('/reports', reportsRouter);
managementRouter.use('/audit-logs', auditRouter);

apiRouter.use(managementRouter);
