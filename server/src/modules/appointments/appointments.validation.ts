/**
 * Appointment request schemas.
 *
 * These are the single source of truth for the appointments contract: the
 * runtime validation, the generated OpenAPI document and the frontend's
 * generated types all derive from them, so the three cannot drift apart.
 *
 * Two decisions run through the whole file:
 *
 *  1. **Instants carry their offset.** Every time a client names a moment it
 *     must say which moment (`Z` or `+05:30`). A bare local string would be read
 *     in whichever zone the server happens to run in, and a booking placed an
 *     hour out is far worse than one refused.
 *  2. **The create body mirrors `CreateBookingInput` exactly.** The booking
 *     service owns the rules; this layer translates nothing, so there is no
 *     second definition of a booking to drift from the first.
 */
import { z } from 'zod';
import { APPOINTMENT_STATUSES } from '../../database/models/Appointment';
import { isIsoDate, isValidTimezone } from '../../utils/time';

const MS_PER_DAY = 86_400_000;

/**
 * How much of the diary one calendar request may span.
 *
 * A calendar view always has a visible window, so requiring one costs the client
 * nothing and stops a bare `GET /calendar` from scanning a workspace's entire
 * history. A quarter covers every month and week view with room to spare.
 */
const MAX_CALENDAR_RANGE_DAYS = 92;

const uuidSchema = z.string().uuid();

const instantSchema = z
  .string()
  .datetime({
    offset: true,
    message: 'Use an ISO-8601 timestamp including its offset, e.g. 2025-03-01T09:00:00Z.',
  })
  .transform((value) => new Date(value));

const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, 'Use a calendar date formatted YYYY-MM-DD.');

/**
 * A fixed offset such as `+05:30` is not a timezone: it cannot express DST, and
 * availability resolved against it would land an hour out twice a year.
 */
const timezoneSchema = z
  .string()
  .trim()
  .refine(isValidTimezone, 'Must be an IANA timezone identifier such as Asia/Kolkata.');

/** Query strings are text: only these two literals are a boolean. */
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * `?status=CONFIRMED&status=PENDING` arrives as an array, a lone `?status=`
 * as a bare string. Both normalise to an array so the query layer has one shape.
 */
const statusQuery = z
  .union([
    z.enum(APPOINTMENT_STATUSES),
    z.array(z.enum(APPOINTMENT_STATUSES)).min(1).max(APPOINTMENT_STATUSES.length),
  ])
  .transform((value) => (Array.isArray(value) ? value : [value]));

/**
 * Optional free text the client may also clear.
 *
 * An empty string collapses to null so every consumer has one "absent" value to
 * check instead of two.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

const reasonSchema = optionalText(500);
const noteSchema = optionalText(5000);

const paginationShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

/**
 * The filters the diary and the calendar share.
 *
 * `from`/`to` bound a window rather than a start time: an appointment that began
 * before the window and is still running belongs in it, which is what the query
 * layer's overlap test implements.
 */
const filterShape = {
  status: statusQuery.optional(),
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  staffProfileId: uuidSchema.optional(),
  serviceId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
  /** Free text across the booking reference, its title and the customer. */
  q: z.string().trim().min(1).max(120).optional(),
};

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

export const appointmentIdParamSchema = z.object({ id: uuidSchema }).strict();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listAppointmentsQuerySchema = z
  .object({ ...paginationShape, ...filterShape })
  .strict()
  .refine((query) => query.from === undefined || query.to === undefined || query.to > query.from, {
    path: ['to'],
    message: 'The end of the range must be after its start.',
  });

export const calendarQuerySchema = z
  .object({
    ...filterShape,
    // Required here, unlike the list: see MAX_CALENDAR_RANGE_DAYS above.
    from: instantSchema,
    to: instantSchema,
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.to <= query.from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'The end of the range must be after its start.',
      });
      return;
    }
    if (query.to.getTime() - query.from.getTime() > MAX_CALENDAR_RANGE_DAYS * MS_PER_DAY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: `A calendar window may span at most ${MAX_CALENDAR_RANGE_DAYS} days.`,
      });
    }
  });

export const availabilitySlotsQuerySchema = z
  .object({
    serviceId: uuidSchema,
    /** Omitted, the search considers every provider assigned to the service. */
    staffProfileId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    fromDate: isoDateSchema,
    toDate: isoDateSchema,
    /** The zone the requested calendar days are read in. */
    timezone: timezoneSchema,
    /** Returns the Smart Match scores behind each provider choice. */
    explain: booleanQuery.optional(),
  })
  .strict()
  .refine((query) => query.toDate >= query.fromDate, {
    path: ['toDate'],
    message: 'The end of the range cannot precede its start.',
  });

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/**
 * Mirrors `CreateBookingInput['customer']`.
 *
 * `id` names someone already in this workspace; the booking service resolves it
 * under the tenant filter and answers 404 for anybody else's customer. The name
 * and address stay required either way because that is the contract the booking
 * service is written against, and restating it here rather than filling it in
 * from a lookup keeps this layer a pass-through with nothing of its own to drift.
 */
const bookingCustomerSchema = z
  .object({
    id: uuidSchema.nullable().optional(),
    firstName: z.string().trim().min(1, 'A first name is required.').max(120),
    lastName: z.string().trim().max(120).nullable().optional(),
    email: z.string().trim().toLowerCase().max(254).email('Enter a valid email address.'),
    phone: z.string().trim().min(5).max(30).nullable().optional(),
  })
  .strict();

export const createAppointmentSchema = z
  .object({
    serviceId: uuidSchema,
    /**
     * Required, unlike the public surface: staff-side booking is deliberate
     * assignment, not Smart Match. `GET /availability/slots` names the provider
     * for each offered time, so the client already holds this.
     */
    staffProfileId: uuidSchema,
    locationId: uuidSchema.nullable().optional(),
    startsAt: instantSchema,
    /** The customer's own zone, echoed back in their confirmation. */
    timezone: timezoneSchema,
    customer: bookingCustomerSchema,
    customerNotes: noteSchema,
    /**
     * Answers to the booking link's questions, kept opaque: the questions are
     * per-workspace configuration, so there is no fixed shape to validate here.
     */
    answers: z.record(z.unknown()).optional(),
    // internalNotes is deliberately absent. The private operator note is
    // governed by appointments:notes:manage, which POST / does not require; it
    // is written through PATCH /:id, where that permission is enforced per
    // field. Accepting it here would let appointments:create write it unchecked.
  })
  // strict(): a stray `businessId` in the body must be a loud 422, never a
  // silently ignored attempt to write into another tenant.
  .strict();

// ---------------------------------------------------------------------------
// Amendments
// ---------------------------------------------------------------------------

/**
 * Notes and the display title only.
 *
 * Times and status are absent by design: moving an appointment must go through
 * `POST /:id/reschedule`, which re-verifies the slot and moves the underlying
 * reservations, and status must go through the lifecycle routes, which enforce
 * the state machine. A PATCH that could write either would bypass both.
 */
export const updateAppointmentSchema = z
  .object({
    title: optionalText(200),
    customerNotes: noteSchema,
    internalNotes: noteSchema,
  })
  .strict()
  // An empty patch would write an audit row describing no change at all.
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update.');

export const rescheduleAppointmentSchema = z
  .object({
    startsAt: instantSchema,
    /** Omitted keeps the current provider; the lifecycle re-verifies either way. */
    staffProfileId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    reason: reasonSchema,
  })
  .strict();

/**
 * Cancelling and rejecting both take the same optional explanation, which is
 * copied into the status history and into the customer's email.
 */
const reasonBodySchema = z.object({ reason: reasonSchema }).strict().default({});

export const cancelAppointmentSchema = reasonBodySchema;
export const rejectAppointmentSchema = reasonBodySchema;

/**
 * A transition that carries no payload. Still validated, and still strict, so a
 * client that thinks it is sending something is told that it is not.
 */
export const emptyBodySchema = z.object({}).strict().default({});

export type AppointmentIdParams = z.infer<typeof appointmentIdParamSchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;
export type AvailabilitySlotsQuery = z.infer<typeof availabilitySlotsQuerySchema>;
export type CreateAppointmentBody = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentBody = z.infer<typeof updateAppointmentSchema>;
export type RescheduleAppointmentBody = z.infer<typeof rescheduleAppointmentSchema>;
export type ReasonBody = z.infer<typeof reasonBodySchema>;
