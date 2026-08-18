/**
 * Appointments HTTP layer.
 *
 * Controllers stay thin: read validated input, take the tenant from the proven
 * membership, call the domain, shape the response. Nothing about booking or the
 * lifecycle is reimplemented here — `booking.service.ts` and
 * `lifecycle.service.ts` own those rules, and this file is the door to them.
 *
 * Two things are settled at this boundary and only here:
 *
 *  - **Who is acting.** The lifecycle stamps an actor type onto every history
 *    row, and "the owner cancelled this" is a materially different fact from
 *    "a receptionist cancelled this".
 *  - **Whether they may see the appointment at all.** The lifecycle scopes by
 *    tenant but knows nothing about permissions, so visibility is established
 *    here before an id is handed to it.
 */
import type { Request, Response } from 'express';
import type { Appointment } from '../../database/models';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { searchAvailability } from '../../scheduling/availability.service';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import { PERMISSIONS, type SystemRoleKey } from '../auth/permissions';
import * as appointmentService from './appointments.service';
import {
  appointmentIdParamSchema,
  availabilitySlotsQuerySchema,
  calendarQuerySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  listAppointmentsQuerySchema,
  rejectAppointmentSchema,
  rescheduleAppointmentSchema,
  updateAppointmentSchema,
} from './appointments.validation';
import { createBooking } from './booking.service';
import {
  approveAppointment,
  cancelAppointment,
  checkInAppointment,
  completeAppointment,
  markNoShow,
  rejectAppointment,
  rescheduleAppointment,
  type LifecycleActor,
  type LifecycleMetadata,
} from './lifecycle.service';

/**
 * The header a client repeats a booking under. Already in the CORS allowlist and
 * the log redaction list; the body stays strict so the key cannot arrive twice
 * by two different routes.
 */
const IDEMPOTENCY_HEADER = 'x-idempotency-key';

/** Tied to the role catalogue so a renamed key breaks the build, not the audit. */
const OWNER_ROLE_KEY: SystemRoleKey = 'BUSINESS_OWNER';

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

/** The acting principal, in the shape the booking and lifecycle services model. */
function actorOf(req: Request): { type: 'OWNER' | 'STAFF'; userId: string; label: string } {
  if (!req.auth) throw new UnauthenticatedError();
  return {
    type: tenantOf(req).roleKey === OWNER_ROLE_KEY ? 'OWNER' : 'STAFF',
    userId: req.auth.userId,
    label: req.auth.email,
  };
}

/**
 * The actor for a note or title edit.
 *
 * Both capabilities are resolved here, from the same effective permission set
 * `requireAnyPermission` used, because neither can be declared on the route:
 * which one a PATCH needs depends on the fields its body carries.
 */
function editorOf(req: Request): appointmentService.AppointmentActor {
  if (!req.auth) throw new UnauthenticatedError();
  const tenant = tenantOf(req);
  return {
    userId: req.auth.userId,
    email: req.auth.email,
    canUpdateDetails: tenant.permissions.has(PERMISSIONS.APPOINTMENTS_UPDATE),
    canManageNotes: tenant.permissions.has(PERMISSIONS.APPOINTMENTS_NOTES_MANAGE),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const list = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const filters = query(req, listAppointmentsQuerySchema);
  const { rows, totalItems } = await appointmentService.listAppointments(
    tenant.businessId,
    appointmentService.scopeOf(tenant),
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const calendar = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const filters = query(req, calendarQuerySchema);
  const { events, truncated } = await appointmentService.listCalendar(
    tenant.businessId,
    appointmentService.scopeOf(tenant),
    filters,
  );
  // Not a page: a calendar window is the unit the client asked for, so the
  // window it got back is echoed with it.
  sendSuccess(res, events, 200, {
    from: filters.from,
    to: filters.to,
    count: events.length,
    truncated,
  });
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const { id } = params(req, appointmentIdParamSchema);
  const detail = await appointmentService.getAppointment(
    tenant.businessId,
    appointmentService.scopeOf(tenant),
    id,
  );
  sendSuccess(res, detail);
});

export const slots = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const filters = query(req, availabilitySlotsQuerySchema);

  const result = await searchAvailability({
    businessId: tenant.businessId,
    businessTimezone: tenant.businessTimezone,
    serviceId: filters.serviceId,
    staffProfileId: filters.staffProfileId ?? null,
    locationId: filters.locationId ?? null,
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    timezone: filters.timezone,
    explain: filters.explain ?? false,
  });

  sendSuccess(res, result);
});

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export const create = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const input = body(req, createAppointmentSchema);
  const actor = actorOf(req);

  const result = await createBooking({
    businessId: tenant.businessId,
    serviceId: input.serviceId,
    staffProfileId: input.staffProfileId,
    locationId: input.locationId ?? null,
    startsAt: input.startsAt,
    timezone: input.timezone,
    customer: {
      id: input.customer.id ?? null,
      firstName: input.customer.firstName,
      lastName: input.customer.lastName ?? null,
      email: input.customer.email,
      phone: input.customer.phone ?? null,
    },
    // Reporting splits on this, and "the owner put it in" is worth telling apart
    // from "the front desk put it in".
    source: actor.type === 'OWNER' ? 'OWNER' : 'STAFF',
    customerNotes: input.customerNotes ?? null,
    answers: input.answers ?? {},
    idempotencyKey: req.header(IDEMPOTENCY_HEADER) ?? null,
    actor,
    requestMetadata: metadataOf(req),
  });

  sendCreated(
    res,
    {
      appointment: result.appointment,
      participant: {
        id: result.participant.id,
        publicId: result.participant.publicId,
        role: result.participant.role,
        status: result.participant.status,
      },
      customer: {
        id: result.customer.id,
        publicId: result.customer.publicId,
        firstName: result.customer.firstName,
        lastName: result.customer.lastName,
        email: result.customer.email,
      },
    },
    // A retried request answers with the original booking, not a second one.
    { replayed: result.replayed },
  );
});

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

export const update = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const { id } = params(req, appointmentIdParamSchema);

  const updated = await appointmentService.updateAppointmentNotes(
    tenant.businessId,
    appointmentService.scopeOf(tenant),
    id,
    body(req, updateAppointmentSchema),
    editorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, updated);
});

export const reschedule = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const { id } = params(req, appointmentIdParamSchema);
  const input = body(req, rescheduleAppointmentSchema);

  await appointmentService.assertAppointmentVisible(
    tenant.businessId,
    appointmentService.scopeOf(tenant),
    id,
  );

  const updated = await rescheduleAppointment({
    businessId: tenant.businessId,
    appointmentId: id,
    newStartsAt: input.startsAt,
    // null means "leave it as it is" to the lifecycle, which is exactly what an
    // omitted field means here.
    newStaffProfileId: input.staffProfileId ?? null,
    newLocationId: input.locationId ?? null,
    reason: input.reason ?? null,
    actor: actorOf(req),
    metadata: metadataOf(req),
    // The reschedule deadline and the "customers may reschedule online" switch
    // are the workspace's policy towards its customers, not a limit on the
    // workspace acting for a customer who has just phoned in.
    enforceCustomerPolicy: false,
  });
  sendSuccess(res, updated);
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const { id } = params(req, appointmentIdParamSchema);
  const { reason } = body(req, cancelAppointmentSchema);

  await appointmentService.assertAppointmentVisible(
    tenant.businessId,
    appointmentService.scopeOf(tenant),
    id,
  );

  const updated = await cancelAppointment({
    businessId: tenant.businessId,
    appointmentId: id,
    reason: reason ?? null,
    actor: actorOf(req),
    metadata: metadataOf(req),
    enforceCustomerPolicy: false,
  });
  sendSuccess(res, updated);
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

/**
 * The five plain transitions differ only in which lifecycle function they call
 * and whether they carry an explanation, so they share one handler rather than
 * five near-identical copies that could drift apart on the scoping check.
 */
type TransitionRunner = (input: {
  businessId: string;
  appointmentId: string;
  actor: LifecycleActor;
  metadata?: LifecycleMetadata;
  reason?: string | null;
}) => Promise<Appointment>;

function transitionHandler(run: TransitionRunner, readReason?: (req: Request) => string | null) {
  return asyncHandler(async (req: Request, res: Response) => {
    const tenant = tenantOf(req);
    const { id } = params(req, appointmentIdParamSchema);

    await appointmentService.assertAppointmentVisible(
      tenant.businessId,
      appointmentService.scopeOf(tenant),
      id,
    );

    const updated = await run({
      businessId: tenant.businessId,
      appointmentId: id,
      actor: actorOf(req),
      metadata: metadataOf(req),
      ...(readReason ? { reason: readReason(req) } : {}),
    });
    sendSuccess(res, updated);
  });
}

export const approve = transitionHandler(approveAppointment);

export const reject = transitionHandler(
  rejectAppointment,
  (req) => body(req, rejectAppointmentSchema).reason ?? null,
);

export const checkIn = transitionHandler(checkInAppointment);

export const complete = transitionHandler(completeAppointment);

export const noShow = transitionHandler(markNoShow);
