/**
 * Public booking request schemas.
 *
 * This is the contract for `/api/v1/public`, the only unauthenticated surface
 * that reaches tenant data. Two rules shape every schema here:
 *
 *  1. **No tenant identifier is accepted anywhere.** There is no `businessId`,
 *     no `bookingLinkId` and no `customerId` in any body, param or query. The
 *     workspace is derived from the slug in the path, and `.strict()` turns an
 *     attempt to smuggle one in into a loud 422 rather than a silently ignored
 *     field that a later refactor might start honouring.
 *  2. **Only opaque public identifiers are accepted for existing records.** An
 *     appointment is addressed by its `apt_…` handle, never by its UUID, so the
 *     shape of the path itself refuses an internal id.
 *
 * Service, staff and location ids *are* UUIDs, because the booking form has to
 * name what it is booking. They are checked against the offering the link
 * actually publishes before any of them reaches a query.
 */
import { z } from 'zod';
import { isIsoDate, isValidTimezone } from '../../utils/time';

const uuidSchema = z.string().uuid();

/**
 * Matches what `slugify()` produces — the slug is the entire public URL path,
 * so anything outside this alphabet cannot address a link and is rejected
 * before it becomes a database lookup.
 */
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.');

/**
 * `publicId('apt')` mints `apt_` plus 26 characters of Crockford base32 with
 * I, L, O and U removed. Validating the exact shape keeps malformed and
 * probing ids from reaching the database at all.
 */
const appointmentPublicIdSchema = z
  .string()
  .trim()
  .regex(/^apt_[0-9A-HJKMNP-TV-Z]{26}$/, 'That is not a valid appointment reference.');

/**
 * A named IANA zone. A fixed offset such as `+05:30` cannot express DST and
 * would misplace every slot twice a year.
 */
const timezoneSchema = z
  .string()
  .trim()
  .refine(isValidTimezone, 'Must be an IANA timezone identifier such as Asia/Kolkata.');

const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, 'Use a calendar date formatted YYYY-MM-DD.');

/**
 * An instant, which must carry its offset (`Z` or `+05:30`). A bare local time
 * would be read in whichever zone the server happens to run in — and on this
 * surface the server's zone is never the customer's.
 */
const instantSchema = z
  .string()
  .datetime({
    offset: true,
    message: 'Use an ISO-8601 timestamp including its offset, e.g. 2025-03-01T09:00:00Z.',
  })
  .transform((value) => new Date(value));

/**
 * Optional free text the client may also omit. An empty string collapses to
 * null so every consumer has one "absent" value to check instead of two.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

/** Mirrors the cap the booking-link form itself enforces on question count. */
const MAX_ANSWERS = 30;

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

export const bookingLinkSlugParamsSchema = z.object({ slug: slugSchema }).strict();

export const appointmentPublicIdParamsSchema = z
  .object({ publicId: appointmentPublicIdSchema })
  .strict();

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export const publicAvailabilityQuerySchema = z
  .object({
    serviceId: uuidSchema,
    /** Only honoured when the link lets customers choose their provider. */
    staffProfileId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    fromDate: isoDateSchema,
    toDate: isoDateSchema,
    /**
     * The customer's own zone. It bounds the search to their calendar days, so
     * "next Tuesday" means their Tuesday and not the workspace's.
     */
    timezone: timezoneSchema,
  })
  .strict()
  .refine((value) => value.toDate >= value.fromDate, {
    path: ['toDate'],
    message: 'The end of the range cannot precede its start.',
  });

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/**
 * The person booking, as they describe themselves.
 *
 * Deliberately absent: any customer identifier. A caller who could name an
 * existing customer row could attach their booking — and the confirmation
 * email — to somebody else's record. The booking service matches on the
 * submitted email inside the tenant instead.
 */
const publicCustomerSchema = z
  .object({
    firstName: z.string().trim().min(1, 'A first name is required.').max(100),
    lastName: optionalText(100),
    // Lowercased at the boundary: the customer lookup runs through Sequelize,
    // and `Ada@Example.com` must resolve to the record already stored as
    // `ada@example.com` rather than creating a second one.
    email: z.string().trim().toLowerCase().min(3).max(254).email('Enter a valid email address.'),
    phone: z.string().trim().min(5).max(30).nullable().optional(),
  })
  .strict();

export const createPublicBookingSchema = z
  .object({
    serviceId: uuidSchema,
    /** Omitted when the customer has no preference; the engine then assigns. */
    staffProfileId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    startsAt: instantSchema,
    timezone: timezoneSchema,
    customer: publicCustomerSchema,
    customerNotes: optionalText(2000),
    /**
     * Answers to the link's own questions, keyed by question key. Only the
     * count is bounded here — the keys, types and permitted options depend on
     * the link being booked, so the service checks them against its published
     * questions and drops anything it did not ask for.
     */
    answers: z
      .record(z.unknown())
      .refine(
        (value) => Object.keys(value).length <= MAX_ANSWERS,
        `A booking form asks at most ${MAX_ANSWERS} questions.`,
      )
      .default({}),
  })
  .strict();

// ---------------------------------------------------------------------------
// Managing an existing appointment
// ---------------------------------------------------------------------------

/**
 * A customer moves the time and nothing else.
 *
 * Provider and location are deliberately not accepted: the appointment already
 * names them, and letting an unauthenticated caller reassign it would turn the
 * manage link into a way to book any provider in the workspace outside the
 * offering its booking link publishes.
 */
export const reschedulePublicAppointmentSchema = z
  .object({
    startsAt: instantSchema,
    reason: optionalText(500),
  })
  .strict();

export const cancelPublicAppointmentSchema = z
  .object({
    reason: optionalText(500),
  })
  .strict();

export type BookingLinkSlugParams = z.infer<typeof bookingLinkSlugParamsSchema>;
export type AppointmentPublicIdParams = z.infer<typeof appointmentPublicIdParamsSchema>;
export type PublicAvailabilityQuery = z.infer<typeof publicAvailabilityQuerySchema>;
export type CreatePublicBookingBody = z.infer<typeof createPublicBookingSchema>;
export type ReschedulePublicAppointmentBody = z.infer<typeof reschedulePublicAppointmentSchema>;
export type CancelPublicAppointmentBody = z.infer<typeof cancelPublicAppointmentSchema>;
