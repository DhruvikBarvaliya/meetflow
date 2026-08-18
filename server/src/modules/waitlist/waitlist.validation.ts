/**
 * Waitlist request schemas.
 *
 * These are the contract for `/api/v1/waitlist`: the runtime validation, the
 * generated OpenAPI document and the frontend's generated types all derive from
 * them, so the three cannot drift apart.
 *
 * Three groups of fields are deliberately absent from every body:
 *
 *  - `businessId` — the tenant comes from the caller's proven membership, so
 *    accepting one here would be an authorisation hole with a schema in front.
 *  - `publicId` — the opaque handle the claim link is built from is minted by
 *    the server, never chosen by a caller.
 *  - `status`, `notifiedAt`, `notificationCount`, `holdExpiresAt`,
 *    `heldSlotStartsAt`, `convertedAppointmentId` — the matcher and the
 *    lifecycle own these. `.strict()` turns an attempt to hand yourself a hold,
 *    or to mark an entry converted without a booking behind it, into a 422.
 */
import { z } from 'zod';
import { WAITLIST_NOTIFY_CHANNELS, WAITLIST_STATUSES } from '../../database/models/WaitlistEntry';
import { MINUTES_PER_DAY, isIsoDate, isValidTimezone } from '../../utils/time';

const uuidSchema = z.string().uuid();

const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, 'Use a calendar date formatted YYYY-MM-DD.');

/**
 * The desired window is stored as local dates and minutes, so the zone that
 * gives them meaning must be a named IANA identifier. A fixed offset such as
 * `+05:30` cannot express DST and would misplace the window twice a year.
 */
const timezoneSchema = z
  .string()
  .trim()
  .refine(isValidTimezone, 'Must be an IANA timezone identifier such as Asia/Kolkata.');

/** An instant must say which instant; a bare local string would be read in the server's zone. */
const instantSchema = z
  .string()
  .datetime({
    offset: true,
    message: 'Use an ISO-8601 timestamp including its offset, e.g. 2025-03-01T09:00:00Z.',
  })
  .transform((value) => new Date(value));

/**
 * Optional free text the client may also clear. An empty string collapses to
 * null so every consumer has one "absent" value to test instead of two.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

// Bounds mirror the column CHECKs: the start is a minute of the day, the end
// may be 1440 to mean "up to midnight".
const earliestMinuteSchema = z
  .number()
  .int()
  .min(0)
  .max(MINUTES_PER_DAY - 1);
const latestMinuteSchema = z.number().int().min(1).max(MINUTES_PER_DAY);

/** Sunday = 0 … Saturday = 6. Empty means "any weekday is acceptable". */
const daysOfWeekSchema = z
  .array(z.number().int().min(0).max(6))
  .max(7)
  .refine((days) => new Set(days).size === days.length, 'List each weekday at most once.');

/** Lower is served first; ties fall back to arrival order. */
const prioritySchema = z.number().int().min(0).max(1000);

const notifyChannelSchema = z.enum(WAITLIST_NOTIFY_CHANNELS);
const statusSchema = z.enum(WAITLIST_STATUSES);

export const waitlistIdParamSchema = z.object({ id: uuidSchema }).strict();

export const listWaitlistQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    status: statusSchema.optional(),
    serviceId: uuidSchema.optional(),
  })
  .strict();

export const createWaitlistEntrySchema = z
  .object({
    /** An existing customer of this workspace; a foreign id answers 404. */
    customerId: uuidSchema,
    serviceId: uuidSchema,
    /** NULL = no preference. A value narrows which openings qualify. */
    staffProfileId: uuidSchema.nullable().optional(),
    locationId: uuidSchema.nullable().optional(),
    earliestDate: isoDateSchema,
    latestDate: isoDateSchema,
    earliestMinute: earliestMinuteSchema.default(0),
    latestMinute: latestMinuteSchema.default(MINUTES_PER_DAY - 1),
    daysOfWeek: daysOfWeekSchema.default([]),
    // Omitted rather than defaulted here: the service inherits the customer's
    // own zone, which is a far better guess than the column's UTC default.
    timezone: timezoneSchema.optional(),
    priority: prioritySchema.default(100),
    notifyChannel: notifyChannelSchema.default('EMAIL'),
    /** When the request itself lapses, whether or not a slot ever opened. */
    expiresAt: instantSchema.nullable().optional(),
    note: optionalText(2000),
  })
  // strict(): a stray `businessId` in the body must be a loud 422, never a
  // silently ignored attempt to write into another tenant.
  .strict()
  .refine((entry) => entry.latestDate >= entry.earliestDate, {
    path: ['latestDate'],
    message: 'The end of the window cannot precede its start.',
  })
  .refine((entry) => entry.latestMinute > entry.earliestMinute, {
    path: ['latestMinute'],
    message: 'The end of the daily window must be after its start.',
  });

/**
 * `customerId` and `serviceId` are absent by design.
 *
 * Either would turn this entry into a different request, and the partial unique
 * index on (business, customer, service) among live rows makes that a collision
 * rather than an edit. Moving a person to another service is a new entry.
 *
 * Cross-field coherence (dates and minutes) cannot be checked here because a
 * patch may carry one half of a pair; the service validates the merged window.
 */
export const updateWaitlistEntrySchema = z
  .object({
    staffProfileId: uuidSchema.nullable().optional(),
    locationId: uuidSchema.nullable().optional(),
    earliestDate: isoDateSchema.optional(),
    latestDate: isoDateSchema.optional(),
    earliestMinute: earliestMinuteSchema.optional(),
    latestMinute: latestMinuteSchema.optional(),
    daysOfWeek: daysOfWeekSchema.optional(),
    timezone: timezoneSchema.optional(),
    priority: prioritySchema.optional(),
    notifyChannel: notifyChannelSchema.optional(),
    expiresAt: instantSchema.nullable().optional(),
    note: optionalText(2000),
  })
  .strict()
  // An empty patch would write an audit row describing no change at all.
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update.');

/**
 * A re-offer carries no payload. Still validated, and still strict, so a client
 * that thinks it is sending something is told that it is not.
 */
export const notifyWaitlistEntrySchema = z.object({}).strict().default({});

/**
 * The time being converted into a booking.
 *
 * Only the instant is accepted: the service, the customer and any staff or
 * location preference are read from the entry, so a conversion cannot quietly
 * book something other than what the customer asked for.
 */
export const convertWaitlistEntrySchema = z.object({ startsAt: instantSchema }).strict();

export type WaitlistIdParams = z.infer<typeof waitlistIdParamSchema>;
export type ListWaitlistQuery = z.infer<typeof listWaitlistQuerySchema>;
export type CreateWaitlistEntryBody = z.infer<typeof createWaitlistEntrySchema>;
export type UpdateWaitlistEntryBody = z.infer<typeof updateWaitlistEntrySchema>;
export type ConvertWaitlistEntryBody = z.infer<typeof convertWaitlistEntrySchema>;
