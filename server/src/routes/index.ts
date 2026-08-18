/**
 * API v1 router.
 *
 * Two surfaces are kept deliberately separate:
 *
 *   /api/v1/public/*  — unauthenticated booking. Tenant context comes from a
 *                       validated booking-link slug, IP rate limits are tight,
 *                       and only opaque public identifiers are ever exposed.
 *   /api/v1/*         — authenticated management. Mounted behind
 *                       `authenticate -> apiRateLimit -> requireTenant`, so no
 *                       handler can reach data without a proven membership.
 *
 * Mount order is load-bearing and is therefore all in this one file:
 *
 *   1. auth            (unauthenticated)
 *   2. /public/*       (unauthenticated) — terminated by its own 404 so an
 *                      unknown public path can never fall through into the
 *                      authenticated chain and answer a misleading 401
 *   3. management      (guarded at the router, not per route)
 */
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { notFoundHandler } from '../middleware/errorHandler';
import { apiRateLimit, publicRateLimit } from '../middleware/rateLimit';
import { requireTenant } from '../middleware/tenant';
import { analyticsRouter, reportsRouter } from '../modules/analytics/analytics.routes';
import { appointmentsRouter } from '../modules/appointments/appointments.routes';
import { authRouter } from '../modules/auth/auth.routes';
import { availabilityRouter } from '../modules/availability/availability.routes';
import { bookingLinksRouter } from '../modules/bookingLinks/bookingLinks.routes';
import { businessesRouter, workspaceCreationRouter } from '../modules/businesses/business.routes';
import { customersRouter } from '../modules/customers/customers.routes';
import { locationsRouter } from '../modules/locations/locations.routes';
import { resourcesRouter } from '../modules/resources/resources.routes';
import { servicesRouter } from '../modules/services/services.routes';
import { publicBookingRouter } from '../modules/publicBooking/publicBooking.routes';
import { staffRouter } from '../modules/staff/staff.routes';
import { teamsRouter } from '../modules/teams/teams.routes';
import { waitlistRouter } from '../modules/waitlist/waitlist.routes';

export const apiRouter = Router();

/** Public booking surface. Feature routers mount onto this. */
export const publicRouter = Router();
publicRouter.use(publicRateLimit);

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

// Workspace creation: authenticated, but deliberately not tenant-scoped —
// a user creating their first workspace has no membership yet.
apiRouter.use(workspaceCreationRouter);

// --- 2. Public booking surface --------------------------------------------
publicRouter.use(publicBookingRouter);
// Terminator: an unknown public path must 404 here rather than falling through
// into the authenticated chain below and answering a misleading 401.
publicRouter.use(notFoundHandler);
apiRouter.use('/public', publicRouter);

// --- 3. Authenticated management surface ----------------------------------
managementRouter.use('/workspace', businessesRouter);
managementRouter.use('/locations', locationsRouter);
managementRouter.use('/teams', teamsRouter);
managementRouter.use('/staff', staffRouter);
managementRouter.use('/services', servicesRouter);
managementRouter.use('/resources', resourcesRouter);
managementRouter.use('/customers', customersRouter);
managementRouter.use('/availability', availabilityRouter);
managementRouter.use('/booking-links', bookingLinksRouter);
managementRouter.use('/appointments', appointmentsRouter);
managementRouter.use('/waitlist', waitlistRouter);
managementRouter.use('/analytics', analyticsRouter);
managementRouter.use('/reports', reportsRouter);

apiRouter.use(managementRouter);
