/**
 * `/api/v1/analytics` and `/api/v1/reports`
 *
 * Two routers from one module because they are one capability seen twice: the
 * analytics surface aggregates the appointment table, the report surface lists
 * it, and both are read-only views of exactly the same rows.
 *
 * Both mount on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to reporting — the permission each route needs and the
 * schema each request must satisfy. `requirePermission` runs before `validate`
 * so a caller who may not see the numbers at all learns nothing from the shape
 * of the validation errors.
 *
 * The export declares `reports:read` *and* `reports:export`. `requirePermission`
 * demands every key listed, which is the intended reading: an export is a read
 * that leaves the building, so it needs the permission to read and the separate
 * permission to take a copy. Roles that may study a report on screen without
 * being able to download the workspace's customer list are the reason the two
 * permissions exist apart.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as analyticsController from './analytics.controller';
import { analyticsRangeQuerySchema } from './analytics.validation';
import * as reportsController from './reports.controller';
import { appointmentExportQuerySchema, appointmentReportQuerySchema } from './reports.validation';

export const analyticsRouter = Router();

const analyticsRead = requirePermission(PERMISSIONS.ANALYTICS_READ);
const analyticsWindow = validate({ query: analyticsRangeQuerySchema });

analyticsRouter.get('/overview', analyticsRead, analyticsWindow, analyticsController.overview);
analyticsRouter.get('/trends', analyticsRead, analyticsWindow, analyticsController.trends);
analyticsRouter.get('/staff', analyticsRead, analyticsWindow, analyticsController.staff);
analyticsRouter.get('/services', analyticsRead, analyticsWindow, analyticsController.services);
analyticsRouter.get('/locations', analyticsRead, analyticsWindow, analyticsController.locations);
analyticsRouter.get('/peak-times', analyticsRead, analyticsWindow, analyticsController.peakTimes);
analyticsRouter.get('/customers', analyticsRead, analyticsWindow, analyticsController.customers);

export const reportsRouter = Router();

reportsRouter.get(
  '/appointments',
  requirePermission(PERMISSIONS.REPORTS_READ),
  validate({ query: appointmentReportQuerySchema }),
  reportsController.appointments,
);

// A distinct literal path, not a `:format` parameter: the extension is what
// makes a browser save the response as a spreadsheet rather than render it, and
// it is the only other representation this report has.
reportsRouter.get(
  '/appointments.csv',
  requirePermission(PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT),
  validate({ query: appointmentExportQuerySchema }),
  reportsController.exportAppointments,
);
