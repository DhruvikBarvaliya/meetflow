/**
 * Location request schemas.
 *
 * These are the single source of truth for the locations contract: the runtime
 * validation, the generated OpenAPI document and the frontend's generated types
 * all derive from them, so the three cannot drift apart.
 */
import { z } from 'zod';
import { LOCATION_TYPES } from '../../database/models/Location';
import { isValidTimezone } from '../../utils/time';

/**
 * A location resolves its own slots against its own calendar day, so the zone
 * must be a named IANA identifier. A fixed offset such as `+05:30` cannot
 * express DST and would silently misplace every slot twice a year.
 */
export const locationTimezoneSchema = z
  .string()
  .trim()
  .refine(isValidTimezone, 'Must be an IANA timezone identifier such as Asia/Kolkata.');

export const locationTypeSchema = z.enum(LOCATION_TYPES);

/**
 * Optional free text that the client may also clear.
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

/** Query strings are text: only these two literals are a boolean. */
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

const nameSchema = z.string().trim().min(1, 'A location name is required.').max(160);

// Matches what slugify() produces, so a caller-supplied slug is stored verbatim
// rather than being quietly rewritten into something they never chose.
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.');

const countryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Use the two-letter ISO 3166-1 alpha-2 code, e.g. IN.')
  .toUpperCase()
  .nullable()
  .optional();

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email('Enter a valid email address.')
  .nullable()
  .optional();

const phoneSchema = z.string().trim().min(5).max(30).nullable().optional();

const virtualMeetingUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url('Enter a full URL including the scheme, e.g. https://meet.example.com/room.')
  .nullable()
  .optional();

/** NULL capacity means the site imposes no concurrency cap of its own. */
const capacitySchema = z.number().int().positive().max(100_000).nullable().optional();

const sortOrderSchema = z.number().int().min(0).max(100_000);

export const locationIdParamSchema = z.object({ id: z.string().uuid() }).strict();

export const listLocationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    isActive: booleanQuery.optional(),
    type: locationTypeSchema.optional(),
  })
  .strict();

export const createLocationSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema.optional(),
    type: locationTypeSchema.default('PHYSICAL'),
    description: optionalText(2000),
    addressLine1: optionalText(200),
    addressLine2: optionalText(200),
    city: optionalText(120),
    state: optionalText(120),
    postalCode: optionalText(20),
    countryCode: countryCodeSchema,
    // Omitted rather than defaulted here: the service inherits the workspace
    // zone, which is a far better guess than the column's UTC default.
    timezone: locationTimezoneSchema.optional(),
    phone: phoneSchema,
    email: emailSchema,
    virtualMeetingUrl: virtualMeetingUrlSchema,
    capacity: capacitySchema,
    sortOrder: sortOrderSchema.default(0),
    isActive: z.boolean().default(true),
  })
  // strict(): a stray `businessId` in the body must be a loud 422, never a
  // silently ignored attempt to write into another tenant.
  .strict();

export const updateLocationSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    type: locationTypeSchema.optional(),
    description: optionalText(2000),
    addressLine1: optionalText(200),
    addressLine2: optionalText(200),
    city: optionalText(120),
    state: optionalText(120),
    postalCode: optionalText(20),
    countryCode: countryCodeSchema,
    timezone: locationTimezoneSchema.optional(),
    phone: phoneSchema,
    email: emailSchema,
    virtualMeetingUrl: virtualMeetingUrlSchema,
    capacity: capacitySchema,
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  // An empty patch would write an audit row describing no change at all.
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to update.');

export type LocationIdParams = z.infer<typeof locationIdParamSchema>;
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;
export type CreateLocationBody = z.infer<typeof createLocationSchema>;
export type UpdateLocationBody = z.infer<typeof updateLocationSchema>;
