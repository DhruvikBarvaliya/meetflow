/**
 * Customer-portal request schemas.
 *
 * This is the contract for `/api/v1/me`, and it holds one invariant that is
 * stricter than anywhere else in the codebase: **nothing here names a
 * workspace, a customer or an appointment by an internal id.**
 *
 * The management surface can afford to accept a UUID because `requireTenant`
 * has already proven the caller belongs somewhere. The portal has no membership
 * to lean on — the caller is a person, not a member — so the only scope that
 * exists is "the Customer rows pointing at this user". A `businessId`, a
 * `customerId` or an appointment UUID in any of these schemas would be an
 * invitation to widen that scope from the outside, and `.strict()` turns an
 * attempt to smuggle one in into a loud 422 rather than a field that is
 * silently ignored today and honoured after some future refactor.
 *
 * Appointments are therefore addressed only by their opaque `apt_…` handle, the
 * same way the anonymous booking surface addresses them.
 */
import { z } from 'zod';
import { APPOINTMENT_STATUSES } from '../../database/models/Appointment';

/**
 * `publicId('apt')` mints `apt_` plus 26 characters of Crockford base32 with
 * I, L, O and U removed. Checking the exact shape here keeps malformed and
 * probing handles from reaching a database lookup at all.
 */
const appointmentPublicIdSchema = z
  .string()
  .trim()
  .regex(/^apt_[0-9A-HJKMNP-TV-Z]{26}$/, 'That is not a valid booking reference.');

/**
 * An instant, which must carry its offset (`Z` or `+05:30`). A bare local time
 * would be read in whichever zone the server happens to run in, and on this
 * surface the server's zone is never the customer's.
 */
const instantSchema = z
  .string()
  .datetime({
    offset: true,
    message: 'Use an ISO-8601 timestamp including its offset, e.g. 2026-03-01T09:00:00Z.',
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

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

export const bookingPublicIdParamsSchema = z
  .object({ publicId: appointmentPublicIdSchema })
  .strict();

// ---------------------------------------------------------------------------
// Listing bookings
// ---------------------------------------------------------------------------

/** Sourced from the model so the enum cannot drift from the CHECK constraint. */
const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);

/**
 * Which end of the person's history they are looking at.
 *
 * A dashboard asks two different questions of the same table — "what is coming
 * up?" and "what have I had?" — and they want opposite sort orders. Naming the
 * intent lets the service choose the order rather than making the client send a
 * `sort` parameter it would get wrong half the time.
 */
export const BOOKING_WINDOWS = ['UPCOMING', 'PAST', 'ALL'] as const;

export const listBookingsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    when: z.enum(BOOKING_WINDOWS).default('ALL'),
    status: appointmentStatusSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Changing one booking
// ---------------------------------------------------------------------------

/**
 * A customer moves the time and nothing else.
 *
 * Provider and location are deliberately not accepted, for the same reason the
 * anonymous surface refuses them: the appointment already names both, and
 * letting the person reassign them would turn a reschedule into a way to book
 * any provider in a workspace, outside whatever the booking link publishes.
 */
export const rescheduleBookingSchema = z
  .object({
    startsAt: instantSchema,
    reason: optionalText(500),
  })
  .strict();

export const cancelBookingSchema = z
  .object({
    reason: optionalText(500),
  })
  .strict();

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

/**
 * Minutes before the appointment, so every value must be positive. Duplicates
 * are folded and the list is sorted furthest-out first, which is both the order
 * reminders fire in and the order the UI renders them.
 *
 * Deliberately the same rule as the staff-facing address book applies to the
 * very same JSON column — two different normalisations writing to one column
 * would make the stored value depend on which surface last touched it.
 */
const reminderOffsetsSchema = z
  .array(z.number().int().positive().max(43_200))
  .max(10)
  .transform((offsets) => [...new Set(offsets)].sort((a, b) => b - a));

/**
 * No defaults anywhere: the service merges this over what is already stored, so
 * a default would quietly reset the switches the person left alone.
 */
export const updatePreferencesSchema = z
  .object({
    emailEnabled: z.boolean().optional(),
    smsEnabled: z.boolean().optional(),
    marketingOptIn: z.boolean().optional(),
    /** Null hands the schedule back to each workspace's own reminder policy. */
    reminderOffsetsMinutes: reminderOffsetsSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    'Provide at least one notification preference to change.',
  );

export type BookingPublicIdParams = z.infer<typeof bookingPublicIdParamsSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export type RescheduleBookingBody = z.infer<typeof rescheduleBookingSchema>;
export type CancelBookingBody = z.infer<typeof cancelBookingSchema>;
export type UpdatePreferencesBody = z.infer<typeof updatePreferencesSchema>;
