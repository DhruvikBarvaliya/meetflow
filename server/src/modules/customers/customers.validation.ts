/**
 * Customer request schemas.
 *
 * These are the contract for `/api/v1/customers`: the runtime validation, the
 * generated OpenAPI document and the frontend's generated types all derive from
 * them, so the three cannot drift apart.
 *
 * Four groups of fields are deliberately absent from every body and must stay
 * that way:
 *
 *  - `businessId` — the tenant is resolved from the caller's membership;
 *    accepting one here would be an authorisation hole with a schema in front.
 *  - `publicId` — the opaque handle customers see in links is minted by the
 *    server, never chosen by a caller.
 *  - `userId` — linking a customer record to a login is an identity decision,
 *    not an address-book edit.
 *  - `totalBookings`, `completedCount`, `cancelledCount`, `noShowCount`,
 *    `firstAppointmentAt`, `lastAppointmentAt` — maintained by the booking
 *    lifecycle. They are read-only here, and `.strict()` turns an attempt to
 *    fake a booking history into a 422 rather than a silent overwrite.
 */
import { z } from 'zod';
import { CUSTOMER_STATUSES } from '../../database/models/Customer';
import { isValidTimezone } from '../../utils/time';

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

export const customerStatusSchema = z.enum(CUSTOMER_STATUSES);

/**
 * A customer's reminders are rendered against their own calendar day, so the
 * zone must be a named IANA identifier. A fixed offset such as `+05:30` cannot
 * express DST and would misdate every reminder twice a year.
 */
export const customerTimezoneSchema = z
  .string()
  .trim()
  .refine(isValidTimezone, 'Must be an IANA timezone identifier such as Asia/Kolkata.');

/**
 * Lowercased at the boundary even though the column is `citext`: the duplicate
 * pre-check runs through Sequelize, and `Ada@Example.com` must resolve to the
 * one record already stored as `ada@example.com` rather than a second one.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Enter a valid email address.');

const firstNameSchema = z.string().trim().min(1, 'A first name is required.').max(100);
const lastNameSchema = optionalText(100);
const phoneSchema = z.string().trim().min(5).max(30).nullable().optional();
const notesSchema = optionalText(5000);

const localeSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, 'Use a BCP 47 tag such as en or en-US.');

/**
 * Case-folded because the tag filter is an exact-match containment test against
 * the gin index: without folding, `VIP` and `vip` become two tags that no single
 * query can find together.
 */
const tagSchema = z.string().trim().toLowerCase().min(1).max(40);

const tagsSchema = z
  .array(tagSchema)
  .max(25, 'A customer can carry at most 25 tags.')
  .transform((tags) => [...new Set(tags)]);

/**
 * Minutes before the appointment, so every value must be positive. Duplicates
 * are folded and the list is sorted furthest-out first, which is both the order
 * reminders fire in and the order the UI renders.
 */
const reminderOffsetsSchema = z
  .array(z.number().int().positive().max(43_200))
  .max(10)
  .transform((offsets) => [...new Set(offsets)].sort((a, b) => b - a));

/**
 * Create-time preferences. The defaults mirror the column default so a caller
 * who sends `{ smsEnabled: true }` still gets a complete object — a partial one
 * would leave `emailEnabled` undefined, which every consumer would read as
 * "email disabled" and silently stop confirming their bookings.
 */
const communicationPreferencesSchema = z
  .object({
    emailEnabled: z.boolean().default(true),
    smsEnabled: z.boolean().default(false),
    marketingOptIn: z.boolean().default(false),
    reminderOffsetsMinutes: reminderOffsetsSchema.optional(),
  })
  .strict();

/**
 * Patch-time preferences: no defaults, because the service merges this over the
 * stored object. Defaulting here would reset the flags the caller left out.
 */
const communicationPreferencesPatchSchema = z
  .object({
    emailEnabled: z.boolean().optional(),
    smsEnabled: z.boolean().optional(),
    marketingOptIn: z.boolean().optional(),
    reminderOffsetsMinutes: reminderOffsetsSchema.optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    'Provide at least one communication preference to change.',
  );

export const customerIdParamSchema = z.object({ id: z.string().uuid() }).strict();

export const listCustomersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    /** Matched against first name, last name and email. */
    search: z.string().trim().min(1).max(120).optional(),
    status: customerStatusSchema.optional(),
    tag: tagSchema.optional(),
  })
  .strict();

export const listCustomerAppointmentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const createCustomerSchema = z
  .object({
    firstName: firstNameSchema,
    lastName: lastNameSchema,
    email: emailSchema,
    phone: phoneSchema,
    // Omitted rather than defaulted: the service inherits the workspace zone and
    // locale, which are far better guesses than the columns' UTC / en-US.
    timezone: customerTimezoneSchema.optional(),
    locale: localeSchema.optional(),
    notes: notesSchema,
    tags: tagsSchema.optional(),
    preferredStaffProfileId: z.string().uuid().nullable().optional(),
    preferredLocationId: z.string().uuid().nullable().optional(),
    communicationPreferences: communicationPreferencesSchema.optional(),
    status: customerStatusSchema.optional(),
  })
  .strict();

export const updateCustomerSchema = z
  .object({
    firstName: firstNameSchema.optional(),
    lastName: lastNameSchema,
    email: emailSchema.optional(),
    phone: phoneSchema,
    timezone: customerTimezoneSchema.optional(),
    locale: localeSchema.optional(),
    notes: notesSchema,
    tags: tagsSchema.optional(),
    preferredStaffProfileId: z.string().uuid().nullable().optional(),
    preferredLocationId: z.string().uuid().nullable().optional(),
    communicationPreferences: communicationPreferencesPatchSchema.optional(),
    status: customerStatusSchema.optional(),
  })
  .strict()
  // An empty patch would write an audit row describing no change at all.
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update.');

export type CustomerIdParams = z.infer<typeof customerIdParamSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;
export type ListCustomerAppointmentsQuery = z.infer<typeof listCustomerAppointmentsQuerySchema>;
export type CreateCustomerBody = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerBody = z.infer<typeof updateCustomerSchema>;
