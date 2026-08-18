/**
 * Public waitlist request schemas.
 *
 * The contract for the two unauthenticated waitlist paths: joining a list from
 * a booking link, and claiming the opening an offer email announced. The same
 * two rules that shape publicBooking.validation.ts shape these, for the same
 * reason — this is tenant data behind no login at all:
 *
 *  1. **No tenant identifier is accepted anywhere.** There is no `businessId`
 *     and no `customerId` in any body, param or query. The workspace comes from
 *     the slug being booked or from the entry the handle names, and `.strict()`
 *     turns an attempt to smuggle one in into a loud 422 rather than a silently
 *     ignored field a later refactor might start honouring.
 *  2. **Existing records are addressed only by their opaque handle.** An entry
 *     is named by its `wlt_…` id, never by its UUID, so the shape of the path
 *     itself refuses an internal id.
 *
 * Three further fields are absent from the join body and their absence is the
 * point. `priority` decides who is served first, and a queue where the customer
 * picks their own place is not a queue. `notifyChannel` would let somebody join
 * a list that can never reach them. And every column the matcher owns — status,
 * the hold, the notification counters — is unwritable from here, so nobody can
 * hand themselves an opening by asking for one.
 */
import { z } from 'zod';
import { MINUTES_PER_DAY, isIsoDate, isValidTimezone } from '../../utils/time';

const uuidSchema = z.string().uuid();

/**
 * `publicId('wlt')` mints `wlt_` plus 26 characters of Crockford base32 with
 * I, L, O and U removed. Validating the exact shape keeps malformed and probing
 * ids from reaching the database at all.
 */
const waitlistPublicIdSchema = z
  .string()
  .trim()
  .regex(/^wlt_[0-9A-HJKMNP-TV-Z]{26}$/, 'That is not a valid waitlist reference.');

/**
 * A named IANA zone. The window is stored as local dates and minutes, so a
 * fixed offset such as `+05:30` — which cannot express DST — would misplace
 * "weekday afternoons" twice a year.
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

/**
 * The person asking to be waitlisted, as they describe themselves.
 *
 * Deliberately absent: any customer identifier. A caller who could name an
 * existing customer row could attach a waitlist request — and the offer email
 * it eventually produces — to somebody else's record. The service matches on
 * the submitted email inside the tenant instead, exactly as booking does.
 */
const publicCustomerSchema = z
  .object({
    firstName: z.string().trim().min(1, 'A first name is required.').max(100),
    lastName: optionalText(100),
    // Lowercased at the boundary so `Ada@Example.com` resolves to the record
    // already stored as `ada@example.com` rather than creating a second one.
    email: z.string().trim().toLowerCase().min(3).max(254).email('Enter a valid email address.'),
    phone: z.string().trim().min(5).max(30).nullable().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

export const waitlistPublicIdParamsSchema = z.object({ publicId: waitlistPublicIdSchema }).strict();

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export const joinWaitlistSchema = z
  .object({
    serviceId: uuidSchema,
    /** Only honoured when the link lets customers choose their provider. */
    staffProfileId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    earliestDate: isoDateSchema,
    latestDate: isoDateSchema,
    earliestMinute: earliestMinuteSchema.default(0),
    latestMinute: latestMinuteSchema.default(MINUTES_PER_DAY - 1),
    daysOfWeek: daysOfWeekSchema.default([]),
    /**
     * Required here, unlike on the management surface. There is no stored
     * customer record to inherit a zone from — the person may not exist in this
     * workspace yet — and falling through to the column default would make the
     * window UTC, which is wrong everywhere but one meridian and invisible
     * until the wrong slots start being offered.
     */
    timezone: timezoneSchema,
    customer: publicCustomerSchema,
    note: optionalText(2000),
  })
  .strict()
  .refine((entry) => entry.latestDate >= entry.earliestDate, {
    path: ['latestDate'],
    message: 'The end of the window cannot precede its start.',
  })
  .refine((entry) => entry.latestMinute > entry.earliestMinute, {
    path: ['latestMinute'],
    message: 'The end of the daily window must be after its start.',
  });

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * A claim carries no payload: what is being accepted is the opening already
 * held against the entry, and nothing a caller sends can change which one that
 * is. Still validated, and still strict, so a client that thinks it is sending
 * something — a different time, a different service — is told that it is not.
 */
export const claimWaitlistOfferSchema = z.object({}).strict().default({});

export type WaitlistPublicIdParams = z.infer<typeof waitlistPublicIdParamsSchema>;
export type JoinWaitlistBody = z.infer<typeof joinWaitlistSchema>;
