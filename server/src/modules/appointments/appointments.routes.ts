/**
 * `/api/v1/appointments`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to appointments: the permission each verb needs and the
 * schema each request must satisfy.
 *
 * The permission check runs before `validate` so a caller who may not see the
 * diary at all learns nothing from the shape of the validation errors.
 *
 * Two of the declarations need explaining:
 *
 *  - **Reads use `requireAnyPermission`.** `appointments:read` and
 *    `appointments:read:own` are the same capability at two widths, and the
 *    router cannot choose between them: which rows a member may see is a
 *    property of the rows, not of the route. It lets both through and the query
 *    layer narrows to the member's own diary — and answers 404, never 403, for
 *    anything outside it.
 *  - **PATCH uses `requireAnyPermission` too.** `appointments:update` covers the
 *    booking's own details, `appointments:notes:manage` covers the private
 *    commentary; the STAFF role holds the second without the first. Which of the
 *    two a request needs depends on the fields its body carries, so the router
 *    admits either and the service enforces per field.
 *
 * Route order is load-bearing: `/calendar` is a single segment and would
 * otherwise be swallowed by `/:id`.
 */
import { Router } from 'express';
import { requireAnyPermission, requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './appointments.controller';
import {
  appointmentIdParamSchema,
  availabilitySlotsQuerySchema,
  calendarQuerySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  emptyBodySchema,
  listAppointmentsQuerySchema,
  rejectAppointmentSchema,
  rescheduleAppointmentSchema,
  updateAppointmentSchema,
} from './appointments.validation';

export const appointmentsRouter = Router();

const READ_PERMISSIONS = [
  PERMISSIONS.APPOINTMENTS_READ,
  PERMISSIONS.APPOINTMENTS_READ_OWN,
] as const;

appointmentsRouter.get(
  '/',
  requireAnyPermission(...READ_PERMISSIONS),
  validate({ query: listAppointmentsQuerySchema }),
  controller.list,
);

appointmentsRouter.get(
  '/calendar',
  requireAnyPermission(...READ_PERMISSIONS),
  validate({ query: calendarQuerySchema }),
  controller.calendar,
);

// Reading what *could* be booked is an availability question, not a diary one,
// so it is gated on availability:read — the permission every role that can see
// the rota already holds.
appointmentsRouter.get(
  '/availability/slots',
  requirePermission(PERMISSIONS.AVAILABILITY_READ),
  validate({ query: availabilitySlotsQuerySchema }),
  controller.slots,
);

appointmentsRouter.post(
  '/',
  requirePermission(PERMISSIONS.APPOINTMENTS_CREATE),
  validate({ body: createAppointmentSchema }),
  controller.create,
);

appointmentsRouter.get(
  '/:id',
  requireAnyPermission(...READ_PERMISSIONS),
  validate({ params: appointmentIdParamSchema }),
  controller.get,
);

appointmentsRouter.patch(
  '/:id',
  requireAnyPermission(PERMISSIONS.APPOINTMENTS_UPDATE, PERMISSIONS.APPOINTMENTS_NOTES_MANAGE),
  validate({ params: appointmentIdParamSchema, body: updateAppointmentSchema }),
  controller.update,
);

appointmentsRouter.post(
  '/:id/reschedule',
  requirePermission(PERMISSIONS.APPOINTMENTS_RESCHEDULE),
  validate({ params: appointmentIdParamSchema, body: rescheduleAppointmentSchema }),
  controller.reschedule,
);

appointmentsRouter.post(
  '/:id/cancel',
  requirePermission(PERMISSIONS.APPOINTMENTS_CANCEL),
  validate({ params: appointmentIdParamSchema, body: cancelAppointmentSchema }),
  controller.cancel,
);

appointmentsRouter.post(
  '/:id/approve',
  requirePermission(PERMISSIONS.APPOINTMENTS_APPROVE),
  validate({ params: appointmentIdParamSchema, body: emptyBodySchema }),
  controller.approve,
);

// Rejecting is the other half of approving, so it needs the same permission:
// a member who may admit a pending booking may also turn it away.
appointmentsRouter.post(
  '/:id/reject',
  requirePermission(PERMISSIONS.APPOINTMENTS_APPROVE),
  validate({ params: appointmentIdParamSchema, body: rejectAppointmentSchema }),
  controller.reject,
);

// Check-in is the first step of seeing an appointment through, which is what
// appointments:complete grants — and it is the permission the STAFF role holds
// for the appointments they are running.
appointmentsRouter.post(
  '/:id/check-in',
  requirePermission(PERMISSIONS.APPOINTMENTS_COMPLETE),
  validate({ params: appointmentIdParamSchema, body: emptyBodySchema }),
  controller.checkIn,
);

appointmentsRouter.post(
  '/:id/complete',
  requirePermission(PERMISSIONS.APPOINTMENTS_COMPLETE),
  validate({ params: appointmentIdParamSchema, body: emptyBodySchema }),
  controller.complete,
);

appointmentsRouter.post(
  '/:id/no-show',
  requirePermission(PERMISSIONS.APPOINTMENTS_NO_SHOW),
  validate({ params: appointmentIdParamSchema, body: emptyBodySchema }),
  controller.noShow,
);
